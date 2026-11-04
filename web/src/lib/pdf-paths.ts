/**
 * pdf-paths.ts — deterministic scratch + final paths for a web "pdf" run (#2172).
 *
 * Plain .ts (same pattern as clean-chips.ts / tracker-table.ts) so this can
 * be unit-tested with `node --test`, no TypeScript build step. `careerOpsRoot`
 * and `findReportFile` are passed in rather than imported from career-ops.ts,
 * keeping this module free of TypeScript dependencies.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { getProfilePath } from "@/lib/core/profile-path.ts";

/**
 * Lowercase, non-alphanumeric runs -> single hyphen, trimmed.
 * @param {string} s
 * @returns {string}
 */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Both paths the backend owns for one pdf run. */
export interface PdfPaths {
  /** Where the backend writes the tailored HTML parsed out of the agent's envelope (#2185). */
  html: string;
  /** Where the backend renders the final PDF (output/cv-{candidate}-{company}-{date}.pdf). */
  finalPdf: string;
}

/**
 * Precompute the scratch HTML and final PDF paths for a
 * "pdf" run, so the agent never chooses its own filenames — the backend owns
 * naming, writing (#2185) and rendering. Resolves the report (for the company slug)
 * and config/profile.yml (for the candidate slug) — same naming convention
 * modes/pdf.md documents, so web and CLI output stay byte-identical.
 *
 * Framework-agnostic: returns a result instead of constructing a Response, so
 * the caller (a Next.js route today) decides how to surface `ok: false`.
 *
 * Side effect: creates `.career-ops-web/pdf-tmp/` under `root` if it doesn't
 * exist yet (the backend writes the parsed envelope there, #2185) — this is
 * NOT a pure path computation, despite the name.
 *
 * @param {string} input - The report number (e.g. "018").
 * @param {string} today - YYYY-MM-DD.
 * @param {string} root - careerOpsRoot().
 * @param {(input: string) => string | null} findReportFile - career-ops.ts's findReportFile.
 * @returns {{ok: true, paths: PdfPaths} | {ok: false, error: string}}
 */
export function resolvePdfPaths(
  input: string,
  today: string,
  root: string,
  findReportFile: (input: string) => string | null,
): { ok: true; paths: PdfPaths } | { ok: false; error: string } {
  // Reject anything but a bare report number before it ever reaches a path.
  // findReportFile()'s parseInt-based matching can still resolve a crafted
  // selector like "123/../../etc/passwd" to a legitimate report file, but the
  // raw string is also used verbatim below to build cv-web-${input}.html —
  // path.join would then honor those ".." segments and escape scratchDir.
  if (!/^\d+$/.test(input)) {
    return { ok: false, error: `Invalid report selector: "${input}"` };
  }
  const reportFile = findReportFile(input);
  if (!reportFile) {
    return { ok: false, error: `No report #${input} found — evaluate this posting first.` };
  }
  const companyMatch = path.basename(reportFile).match(/^\d+-(.+)-\d{4}-\d{2}-\d{2}\.md$/);
  const companySlug = companyMatch ? companyMatch[1] : "company";
  let candidateSlug = "candidate";
  try {
    // js-yaml v4's load() uses the safe default schema (no arbitrary type
    // construction, unlike Python's PyYAML) — same pattern already used in
    // web/src/routes/api/profile/+server.ts and portals/+server.ts.
    const profile = yaml.load(fs.readFileSync(getProfilePath(root, { explicitRoot: true }), "utf8")) as
      | { candidate?: { full_name?: unknown } }
      | null;
    const name = profile?.candidate?.full_name;
    if (typeof name === "string" && name) candidateSlug = slugify(name);
  } catch (err) {
    // A missing profile.yml is expected (not every checkout has one yet) and
    // falls back silently. Anything else — a real YAML syntax error in the
    // user's own file — should not fail silently forever; it would otherwise
    // produce a wrong-but-plausible-looking filename with zero signal.
    const info = err as { code?: string; message?: string };
    if (info.code !== "ENOENT") {
      console.warn(`resolvePdfPaths: could not read/parse config/profile.yml, defaulting candidate slug: ${info.message ?? String(err)}`);
    }
  }
  const scratchDir = path.join(root, ".career-ops-web", "pdf-tmp");
  fs.mkdirSync(scratchDir, { recursive: true });
  return {
    ok: true,
    paths: {
      html: path.join(scratchDir, `cv-web-${input}.html`),
      finalPdf: path.join(root, "output", `cv-${candidateSlug}-${companySlug}-${today}.pdf`),
    },
  };
}
