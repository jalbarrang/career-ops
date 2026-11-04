/**
 * Shape the verdicts of the core's own CV check commands for the /cv panel.
 *
 * The panel runs `packages/cli/src/commands/platform/doctor.ts`, `packages/cli/src/commands/cv/cv-sync-check.ts` and `packages/cli/src/commands/cv/verify-cv-facts.ts` —
 * the SAME commands the CLI runs — and renders what they say. Nothing here
 * decides whether a CV is good: that judgement lives in those scripts, and a
 * second opinion in the web app is exactly the drift apps/web/AGENTS.md rule 1
 * warns about. This module only normalizes their exit codes and output into
 * one row shape so three differently-written commands land in one list.
 *
 * Plain .ts, no I/O, no `@/` aliases — `node --test` imports it directly.
 *
 * @typedef {"pass" | "warn" | "fail" | "skip"} CheckStatus
 * @typedef {{ id: string, label: string, status: CheckStatus, summary: string, details: string[] }} ReviewCheck
 */

// packages/cli/src/commands/platform/doctor.ts prints one long warning per problem, with a "→ fix it like this"
// continuation line. Its `--json` arrays are the machine-readable half, so the
// per-line cap here is only about keeping a pathological CV from dumping
// thousands of rows into the panel.
const MAX_DETAILS = 40;

/** `=== career-ops sync check ===` style banners are decoration, not findings. */
const BANNER = /^={2,}.*={2,}$/;

/**
 * The line that answers "did it pass?" in each command's own wording. Preferred
 * over the first line because a failing fact gate leads with a `⚠️` config
 * notice and only then states its verdict.
 */
const VERDICT = /^(?:CV fact check (?:passed|failed)|All checks passed|ERRORS \(\d+\)|WARNINGS \(\d+\))/;

/** A warning the command chose to emit without failing — "0 warnings" must not match. */
const WARNING_MARK = /⚠️|^WARNING:|^WARNINGS \(\d+\)/m;

/**
 * Merge stdout and stderr into de-duplicated, trimmed, non-empty lines.
 *
 * The cap matters: a CV whose fact gate rejects hundreds of claims would
 * otherwise serialize all of them into the response. The truncated tail is
 * announced rather than silently dropped, so a cut list is never mistaken for
 * the complete set of findings.
 *
 * @param {string} [stdout]
 * @param {string} [stderr]
 * @returns {string[]}
 */
/** One row in the review panel. */
export interface ReviewCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "skip";
  summary: string;
  details: string[];
}

/** The fields packages/cli/src/commands/platform/doctor.ts's --json payload exposes that this panel reads. */
export interface DoctorReport {
  missing?: string[];
  warnings?: string[];
  unpersonalized?: Array<{ path?: string; reason?: string }>;
}

/** One command run, as the panel receives it. */
export interface CheckRun {
  id: string;
  label: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string | null;
  unavailable?: string | null;
}

export function toDetailLines(stdout: string = "", stderr: string = ""): string[] {
  const lines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .filter((line) => !BANNER.test(line.trim()));

  const seen = new Set<string>();
  const kept: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(key);
  }

  if (kept.length <= MAX_DETAILS) return kept;
  const shown = kept.slice(0, MAX_DETAILS - 1);
  shown.push(`… ${kept.length - shown.length} more finding(s) not shown`);
  return shown;
}

/**
 * Turn one command's run into a panel row.
 *
 * `exitCode` is the ONLY source of the verdict: these commands signal failure
 * by exit status, and their human-readable summaries are free to be reworded
 * upstream without the panel claiming a pass the script did not give.
 *
 * @param {object} run
 * @param {string} run.id
 * @param {string} run.label
 * @param {number | null} [run.exitCode]
 * @param {string} [run.stdout]
 * @param {string} [run.stderr]
 * @param {string | null} [run.error] - Set when the command could not be run at all.
 * @param {string | null} [run.unavailable] - Why this check does not apply right now.
 * @returns {ReviewCheck}
 */
export function summarizeCheck({ id, label, exitCode = null, stdout = "", stderr = "", error = null, unavailable = null }: CheckRun): ReviewCheck {
  if (unavailable) {
    return { id, label, status: "skip", summary: unavailable, details: [] };
  }

  const details = toDetailLines(stdout, stderr);

  if (error || exitCode === null) {
    return { id, label, status: "fail", summary: error || "The check could not run", details };
  }

  const verdict = details.find((line) => VERDICT.test(line)) ?? details[0] ?? "";
  const status = exitCode === 0 ? (WARNING_MARK.test(`${stdout}\n${stderr}`) ? "warn" : "pass") : "fail";

  return { id, label, status, summary: verdict, details: details.filter((line) => line !== verdict) };
}

/**
 * `packages/cli/src/commands/platform/doctor.ts --json` reports structure the other two commands do not: a cv.md
 * whose Experience heading it cannot find, a personalization file still on the
 * shipped template, a missing prerequisite. Its three arrays already say which
 * problem is which, so they are read structurally instead of as text.
 *
 * `unpersonalized` DUPLICATES a warning: doctor puts the same finding in
 * `warnings` (with its "→ fix it like this" line) and again in
 * `unpersonalized` as `{path, reason}`. The warning is the fuller text, so a
 * profile entry already covered by one is dropped instead of counted twice.
 *
 * @param {{ missing?: string[], warnings?: string[], unpersonalized?: { path?: string, reason?: string }[] }} [doctor]
 * @param {string} [label]
 * @returns {ReviewCheck}
 */
export function summarizeDoctor(doctor: DoctorReport = {}, label: string = "Setup & CV structure"): ReviewCheck {
  const missing = Array.isArray(doctor.missing) ? doctor.missing : [];
  const warnings = Array.isArray(doctor.warnings) ? doctor.warnings : [];
  const unpersonalized = Array.isArray(doctor.unpersonalized) ? doctor.unpersonalized : [];

  const uncoveredProfiles = unpersonalized.filter((entry) => {
    const entryPath = entry?.path;
    if (!entryPath) return true;
    return !warnings.some((warning) => String(warning).startsWith(`${entryPath} `));
  });

  const details = [
    ...missing.map((file) => `missing: ${file}`),
    // A doctor warning spans lines: the finding, then a "→ how to fix it".
    ...warnings.flatMap((warning) => String(warning).split(/\r?\n/)),
    ...uncoveredProfiles.map((entry) => `${entry?.path ?? "profile"}: ${entry?.reason ?? "still on the template"}`),
  ]
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const status = missing.length > 0 ? "fail" : details.length > 0 ? "warn" : "pass";
  const summary =
    missing.length > 0
      ? `Setup incomplete — ${missing.length} file(s) missing`
      : details.length > 0
        ? `${details.length} thing(s) to review`
        : "Setup complete";

  return { id: "doctor", label, status, summary, details };
}

/**
 * One line for the panel header. Failures outrank warnings, and a run where
 * every check was inapplicable must not read as a pass.
 *
 * @param {ReviewCheck[]} [checks]
 * @returns {string}
 */
export function reviewHeadline(checks: readonly ReviewCheck[] = []): string {
  const failed = checks.filter((check) => check.status === "fail").length;
  if (failed > 0) return `${failed} check(s) failed`;
  const warned = checks.filter((check) => check.status === "warn").length;
  if (warned > 0) return `${warned} check(s) need a look`;
  const ran = checks.filter((check) => check.status !== "skip").length;
  return ran > 0 ? "All checks passed" : "No checks ran";
}
