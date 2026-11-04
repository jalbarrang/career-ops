import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { rootScriptEnv } from "@/lib/core/root-env.ts";
import { summarizeCheck, summarizeDoctor, reviewHeadline } from "@/lib/cv-review.ts";

// The three commands the CLI would run before trusting a CV, run here so the
// editor can show their verdicts instead of letting the user discover a broken
// heading at PDF time. Each is orchestrated, never reimplemented (web/AGENTS.md
// rule 1): they read the user's own cv.md / config/profile.yml.
const TIMEOUT_MS = 20_000;

type RunResult = { exitCode: number | null; stdout: string; stderr: string; error: string | null };

function runRootScript(root: string, nameNoExt: string, args: string[]): Promise<RunResult> {
  const script = rootScript(nameNoExt);
  if (!fs.existsSync(script)) {
    return Promise.resolve({ exitCode: null, stdout: "", stderr: "", error: `${path.basename(script)} is not in this checkout` });
  }
  return new Promise((resolve) => {
    execFile(
      "bun",
      [script, ...args],
      { cwd: root, env: rootScriptEnv(root), timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // A non-zero exit is a verdict, not a transport failure — `err` is only
        // an error when the process could not be started or was killed.
        const code = typeof err?.code === "number" ? err.code : err ? null : 0;
        resolve({
          exitCode: code,
          stdout: stdout || "",
          stderr: stderr || "",
          error: err && code === null ? err.message : null,
        });
      },
    );
  });
}

function parseDoctorJson(stdout: string) {
  try {
    const last = stdout.trim().split("\n").pop() || "{}";
    return JSON.parse(last);
  } catch {
    return null;
  }
}

export async function GET() {
  const root = careerOpsRoot();
  const cv = path.join(root, "cv.md");
  const hasCv = fs.existsSync(cv);

  const [doctor, sync, facts] = await Promise.all([
    runRootScript(root, "doctor", ["--json"]),
    runRootScript(root, "cv-sync-check", []),
    hasCv
      ? runRootScript(root, "verify-cv-facts", [cv])
      : Promise.resolve({ exitCode: null, stdout: "", stderr: "", error: null }),
  ]);

  const doctorJson = parseDoctorJson(doctor.stdout);
  const checks = [
    // The doctor's JSON is the whole point of running it; if it printed
    // something unparseable the run failed and summarizeCheck reports that.
    doctorJson
      ? summarizeDoctor(doctorJson)
      : summarizeCheck({
          id: "doctor",
          label: "Setup & CV structure",
          exitCode: doctor.exitCode,
          stdout: doctor.stdout,
          stderr: doctor.stderr,
          error: doctor.error || "doctor.ts did not print its JSON",
        }),
    summarizeCheck({
      id: "sync",
      label: "Setup consistency",
      exitCode: sync.exitCode,
      stdout: sync.stdout,
      stderr: sync.stderr,
      error: sync.error,
    }),
    // cv.md is both the document and the source here, so the claim-by-claim
    // comparison is trivially satisfied; what this still buys is the part that
    // is NOT a comparison — the forbidden/advisory phrase rules from
    // config/cv-facts.json, and a hard failure when that config is unreadable.
    summarizeCheck({
      id: "facts",
      label: "Fact gate (banned claims)",
      exitCode: facts.exitCode,
      stdout: facts.stdout,
      stderr: facts.stderr,
      error: facts.error,
      unavailable: hasCv ? null : "No cv.md yet — save one first.",
    }),
  ];

  return Response.json({ checks, headline: reviewHeadline(checks), ranAt: new Date().toISOString() });
}
