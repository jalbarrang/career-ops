import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { rootScriptEnv } from "@/lib/core/root-env.mjs";
import { buildReviewInput, parseImportPreview, summarizeImportRun } from "@/lib/cv-import.mjs";

// The web review queue over `career-profile.mjs import --review`.
//
// The importer is the only thing that decides ids, evidence, merge rules and
// the write (under the pipeline lock). This route runs it — GET for the preview
// it prints, POST replaying the user's answers into its own stdin prompt loop —
// so there is no second implementation of the import to drift from the core.
const RUN_TIMEOUT_MS = 60_000;

function profilePath(): string {
  return path.join(careerOpsRoot(), "data", "career-profile.yml");
}

/** Fingerprint what the queue was built from, so a stale answer set is refused. */
function cvFingerprint(): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(path.join(careerOpsRoot(), "cv.md"))).digest("hex");
  } catch {
    return null;
  }
}

type RunResult = { code: number | null; stdout: string; stderr: string; error: string | null };

function runPreview(script: string, root: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [script, "import"],
      { cwd: root, env: rootScriptEnv(root), timeout: RUN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = typeof err?.code === "number" ? err.code : err ? null : 0;
        resolve({
          code,
          stdout: stdout || "",
          stderr: stderr || "",
          error: err && code === null ? err.message : null,
        });
      },
    );
  });
}

function runReview(script: string, root: string, input: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [script, "import", "--review"], { cwd: root, env: rootScriptEnv(root) });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, error: "The importer did not finish in time" });
    }, RUN_TIMEOUT_MS);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, error: null });
    });

    // The whole decision set at once, then EOF: the importer's readline loop
    // sees `done` on the next ask() and finishes, saving what was approved.
    child.stdin.end(input);
  });
}

export async function GET() {
  const root = careerOpsRoot();
  const script = rootScript("career-profile");
  if (!fs.existsSync(script)) {
    return Response.json({ error: "career-profile.mjs is not in this checkout" }, { status: 501 });
  }

  const run = await runPreview(script, root);
  const preview = parseImportPreview(run.stdout);

  if (run.error) {
    return Response.json({ error: run.error }, { status: 500 });
  }
  // The importer refuses a missing cv.md itself; that message is the useful one.
  if (!preview.parsed) {
    const message = (run.stderr || run.stdout).trim().split("\n").filter(Boolean).at(-1) || "Could not read the import preview";
    return Response.json({ error: message }, { status: 422 });
  }

  return Response.json({
    ...preview,
    cvFingerprint: cvFingerprint(),
    profileExists: fs.existsSync(profilePath()),
  });
}

export async function POST({ request }: { request: Request }) {
  let body: { decisions?: unknown; cvFingerprint?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  if (!Array.isArray(body.decisions)) {
    return Response.json({ error: "decisions required" }, { status: 400 });
  }

  // The answers map onto prompts positionally, so they are only valid for the
  // exact cv.md they were collected from. Between preview and save a run of a
  // mode, a git checkout or an editor save can change it.
  const current = cvFingerprint();
  if (current === null) {
    return Response.json({ error: "cv.md is missing" }, { status: 422 });
  }
  if (typeof body.cvFingerprint === "string" && body.cvFingerprint !== current) {
    return Response.json({ error: "cv.md changed since the preview — reload to review it again" }, { status: 409 });
  }

  const root = careerOpsRoot();
  const script = rootScript("career-profile");
  if (!fs.existsSync(script)) {
    return Response.json({ error: "career-profile.mjs is not in this checkout" }, { status: 501 });
  }

  // Re-parse from the same command the decisions came from: positions are what
  // this route trusts, and the candidate list is the only thing that can tell
  // which ones a skipped heading swallows.
  const preview = await runPreview(script, root);
  const parsed = parseImportPreview(preview.stdout);
  if (!parsed.parsed) {
    return Response.json({ error: "Could not rebuild the preview this queue was built from — reload and try again" }, { status: 409 });
  }

  const decisions = body.decisions.slice(0, parsed.candidates.length) as ({ action: "approve" | "skip" | "edit"; text?: string } | undefined)[];
  const { stdin, swallowed } = buildReviewInput(parsed.candidates, decisions);

  const run = await runReview(script, root, stdin);
  const summary = summarizeImportRun(run.stdout);

  if (run.error || run.code === null) {
    return Response.json({ error: run.error || "The importer could not run" }, { status: 500 });
  }
  if (run.code !== 0) {
    return Response.json({ error: summary, details: run.stderr.trim().split("\n").filter(Boolean) }, { status: 422 });
  }

  // Under schema v2 the importer classifies the block itself: the company line,
  // the role line and the date range land in one company with one role, each
  // keeping the CV line it came from. There is nothing left for the web to patch
  // afterwards — a correction belongs in the builder, on a real field.
  return Response.json({
    ok: true,
    summary,
    swallowed,
    profileExists: fs.existsSync(profilePath()),
  });
}
