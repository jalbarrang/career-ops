// evaluate-persist.ts — persist an evaluation the agent returned in an envelope.
//
// The evaluate worker runs read-only (#2185): job postings are untrusted data,
// so handing that run Write/Bash would let a posting aim the tools. The worker
// therefore returns the finished report inside `<<report-md>> … <</report-md>>`
// and the BACKEND writes it through the same scripts the CLI uses:
//
//   packages/cli/src/commands/tracker/reserve-report-num.ts  → the 3-digit number
//   packages/cli/src/commands/evaluation/persist-evaluation-report.ts → reports/{num}-{slug}-{date}.md + the TSV row
//   packages/cli/src/commands/tracker/merge-tracker.ts       → data/applications.md
//
// Same artifacts, same order, byte-identical to a CLI evaluation — only the
// writer moved out of the untrusted context.
import { spawn } from "node:child_process";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { companySlug } from "@/lib/company-slug.ts";
import { localISODate } from "@/lib/followups";


/** What persistence produced, or why it could not run. */
export interface PersistResult {
  ok: boolean;
  num?: string;
  reportFile?: string;
  error?: string;
}

function field(markdown: string, label: string): string | null {
  const match = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i").exec(markdown);
  return match ? match[1].trim() : null;
}

/** `# Evaluation: Acme — Engineer` (em dash, en dash or hyphen). */
function heading(markdown: string): { company: string; role: string } | null {
  const match = /^#\s+(?:Evaluation:\s*)?(.+?)\s+[—–-]\s+(.+)$/m.exec(markdown);
  if (!match) return null;
  const company = match[1].trim();
  const role = match[2].trim();
  return company && role ? { company, role } : null;
}

function runScript(scriptPath: string, args: string[], dataRoot: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // spawn, not promisified execFile: execFile has no `input` option, so the
    // child would read an empty stdin and fail on "invalid JSON" with nothing
    // on stderr to say why.
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: dataRoot,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve(stdout);
      reject(new Error(stderr.trim() || `${scriptPath} exited ${code}`));
    });
    child.stdin.end(input ?? "");
  });
}

/**
 * Persist one evaluation report.
 *
 * @param markdown - The report the worker emitted.
 * @param url - The posting URL the run evaluated.
 */
export async function persistEvaluation(markdown: string, url: string): Promise<PersistResult> {
  // Scripts live in the engine checkout (#524); reports/ and batch/ live in the
  // data root, which is the child's cwd.
  const dataRoot = careerOpsRoot();
  const head = heading(markdown);
  if (!head) return { ok: false, error: "the report has no `# Evaluation: Company — Role` heading" };
  const score = field(markdown, "Score");
  if (!score) return { ok: false, error: "the report has no **Score:** line" };

  let num: string;
  try {
    num = (await runScript(rootScript("reserve-report-num"), [], dataRoot)).trim().match(/\d{3}/)?.[0] ?? "";
  } catch (error) {
    return { ok: false, error: `could not reserve a report number: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!num) return { ok: false, error: "packages/cli/src/commands/tracker/reserve-report-num.ts printed no number" };

  const today = localISODate();
  const slug = companySlug(head.company)?.slug ?? "evaluation";
  const reportFile = `${num}-${slug}-${today}.md`;
  const payload = JSON.stringify({
    markdown,
    num,
    today,
    company: head.company,
    role: head.role,
    score,
    reportFile,
    notes: "web evaluation",
    via: null,
    url,
  });

  try {
    await runScript(rootScript("persist-evaluation-report"), [], dataRoot, payload);
  } catch (error) {
    return { ok: false, error: `could not write the report: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    await runScript(rootScript("merge-tracker"), [], dataRoot);
  } catch (error) {
    return { ok: false, error: `the report was written but the tracker merge failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  return { ok: true, num, reportFile };
}
