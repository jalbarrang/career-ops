import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { rootScriptEnv } from "@/lib/core/root-env.mjs";
import { resolveCodeRoot } from "@/lib/core/code-root.mjs";
import { resolveCvTemplate } from "@/lib/core/cv-template.mjs";
import { buildCvPayload, candidateFromProfileConfig, cvFileStem } from "@/lib/cv-generation.mjs";
import { ensureShape } from "@/lib/cv-profile.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Render a CV from selected career-profile facts.
//
// Everything that decides whether the document is valid belongs to the core:
// `build-cv-html.mjs` validates the payload against lib/cv-payload-schema.mjs,
// and `generate-pdf.mjs` runs the fact gate, the section-order guard and the
// page check. This route assembles the payload, hands it over, and reports what
// came back — it never bypasses a gate and never adds --skip-fact-check.
//
// That matters for the boundary the user chose (cv.md stays the master): a fact
// that exists only in the library is not a source the gate knows, so the PDF
// step refuses it and says which claim. The fix is to get it into cv.md, not to
// silence the gate here.
const BUILD_TIMEOUT_MS = 60_000;
const PDF_TIMEOUT_MS = 180_000;

type RunResult = { code: number | null; stdout: string; stderr: string; error: string | null };

function run(script: string, args: string[], cwd: string, timeout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile("node", [script, ...args], { cwd, env: rootScriptEnv(cwd), timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = typeof err?.code === "number" ? err.code : err ? null : 0;
      resolve({ code, stdout: stdout || "", stderr: stderr || "", error: err && code === null ? err.message : null });
    });
  });
}

/** Never overwrite a previous render: `cv-acme-2026-10-30.html`, `…-2.html`, … */
function uniquePath(dir: string, stem: string, ext: string): string {
  let candidate = path.join(dir, `${stem}${ext}`);
  for (let i = 2; existsSync(candidate); i += 1) candidate = path.join(dir, `${stem}-${i}${ext}`);
  return candidate;
}

function readYamlIfPresent(file: string): unknown {
  try {
    return yaml.load(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function errorLines(runResult: RunResult): string[] {
  return `${runResult.stdout}\n${runResult.stderr}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 40);
}

export async function POST(req: Request) {
  let body: { selection?: unknown; label?: unknown; format?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.selection || typeof body.selection !== "object" || Array.isArray(body.selection)) {
    return Response.json({ error: "selection required" }, { status: 400 });
  }
  const format = body.format === "pdf" ? "pdf" : "html";
  const label = typeof body.label === "string" ? body.label : "";

  const root = careerOpsRoot();
  const profileFile = path.join(root, "data", "career-profile.yml");
  if (!existsSync(profileFile)) {
    return Response.json({ error: "No career profile yet — import or add facts first." }, { status: 422 });
  }

  let profile: ReturnType<typeof ensureShape>;
  try {
    profile = ensureShape(yaml.load(readFileSync(profileFile, "utf8")));
  } catch (error) {
    return Response.json({ error: `career-profile.yml could not be read: ${(error as Error).message}` }, { status: 422 });
  }

  const candidate = candidateFromProfileConfig(readYamlIfPresent(path.join(root, "config", "profile.yml")) ?? {});
  const built = buildCvPayload({ profile, candidate, selection: body.selection as Parameters<typeof buildCvPayload>[0]["selection"] });

  // A selected role that cannot render is a CV missing a job. Preview may show
  // that with a warning; the PDF is the artifact that gets sent, so it refuses.
  if (format === "pdf" && built.gaps.length > 0) {
    return Response.json({ error: "Some selected roles cannot render yet", gaps: built.gaps, warnings: built.warnings }, { status: 422 });
  }
  if (!built.payload.experience && !built.payload.summary && !built.payload.projects) {
    return Response.json({ error: "Nothing selected to render", warnings: built.warnings }, { status: 422 });
  }

  const outDir = path.join(root, "output");
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    return Response.json({ error: "could not create the output directory" }, { status: 500 });
  }

  const stem = cvFileStem(label || String(candidate.name ?? "cv"));
  const htmlPath = uniquePath(outDir, stem, ".html");

  let scratch = "";
  try {
    scratch = mkdtempSync(path.join(os.tmpdir(), "career-ops-cv-"));
    const payloadPath = path.join(scratch, "payload.json");
    writeFileSync(payloadPath, `${JSON.stringify(built.payload, null, 2)}\n`, "utf8");

    const template = await resolveCvTemplate(root).catch(() => "");
    // `resolveCvTemplate` answers relative to the ENGINE CHECKOUT, not the data
    // root — templates/ ships with the code, while cv.md and the profile live in
    // the data root. Resolving it against `root` pointed at
    // <data-root>/templates/cv-template.html, which does not exist, and every
    // render failed on a missing template (found by an e2e run, not by the unit
    // tests: both roots are the same directory on a default install).
    const codeRoot = resolveCodeRoot(process.cwd(), process.env);
    const templateArg = template ? [path.isAbsolute(template) ? template : path.join(codeRoot, template)] : [];

    const html = await run(rootScript("build-cv-html"), [payloadPath, htmlPath, ...templateArg], root, BUILD_TIMEOUT_MS);
    if (html.code !== 0) {
      return Response.json(
        { error: "The core rejected this CV payload", details: errorLines(html), gaps: built.gaps, warnings: built.warnings },
        { status: 422 },
      );
    }

    const htmlBody = readFileSync(htmlPath, "utf8");

    if (format === "html") {
      return Response.json({
        ok: true,
        html: htmlBody,
        htmlPath: path.relative(root, htmlPath),
        gaps: built.gaps,
        warnings: built.warnings,
        counts: built.counts,
      });
    }

    const pdfPath = uniquePath(outDir, stem, ".pdf");
    const pdf = await run(rootScript("generate-pdf"), [htmlPath, pdfPath], root, PDF_TIMEOUT_MS);
    if (pdf.code !== 0) {
      return Response.json(
        {
          error: "The core refused to render this CV",
          details: errorLines(pdf),
          htmlPath: path.relative(root, htmlPath),
          gaps: built.gaps,
          warnings: built.warnings,
        },
        { status: 422 },
      );
    }

    return Response.json({
      ok: true,
      htmlPath: path.relative(root, htmlPath),
      pdfPath: path.relative(root, pdfPath),
      messages: errorLines(pdf).slice(-6),
      gaps: built.gaps,
      warnings: built.warnings,
      counts: built.counts,
    });
  } catch (error) {
    return Response.json({ error: `generation failed: ${(error as Error).message}` }, { status: 500 });
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // Temp dir outside the user's tree; failing to clean up must not fail a
        // render that already wrote its output.
      }
    }
  }
}
