/**
 * Read the Master Career Profile importer's own output, and build the stdin it
 * consumes.
 *
 * `career-profile.mjs import --review` is an interactive line protocol:
 *
 *   y            approve this candidate
 *   n            skip it
 *   e, <text>    approve with revised wording
 *   q            stop and save what was approved so far
 *
 * The web review queue therefore does NOT reimplement the importer (the thing
 * that decides ids, evidence, merge rules and the write itself) — it renders
 * the candidate list the CLI just printed, then replays the user's answers into
 * that same process. Everything that can go wrong with a profile stays in one
 * implementation, in the core, under its lock.
 *
 * That only works if the answers line up with the prompts, which has one trap:
 * a candidate that is an ENTITY HEADING (an `experiences heading`, a
 * `projects heading`) is followed by that entity's facts, and skipping the
 * heading makes the CLI skip those facts WITHOUT prompting. Replaying an answer
 * for each of them would shift every later answer by one. buildReviewInput()
 * drops exactly those, and its test pins the case.
 *
 * Plain .mjs, no I/O, no `@/` aliases — `node --test` imports it directly.
 */

/** Sections the importer walks, in its own order. Keys come from parseCv(). */
export const SECTIONS = ["summary", "experiences", "projects", "education", "certifications", "skills"];

/** Candidate kinds that own facts, and so can swallow later answers when skipped. */
const ENTITY_SECTIONS = new Set(["experiences", "projects", "education"]);

const FOUND = /^Found (\d+) review candidates in (.+?)\.?\s*$/;

/**
 * @typedef {object} Candidate
 * @property {string} section   one of SECTIONS
 * @property {string | null} parent  the entity label a fact belongs to, if any
 * @property {boolean} isHeading     true for an entity-heading candidate
 * @property {string} text      what the row shows
 * @property {string} label     the CLI's own label prefix, verbatim
 */

/**
 * Parse `node career-profile.mjs import` (preview mode) stdout.
 *
 * The importer prints `- {label}: {text}`, where `label` is either a bare
 * section (`summary`), `{section} heading`, or `{section}: {entity label}`.
 * Splitting on the FIRST ": " is not enough for the last form — the entity
 * label is itself free text that may contain colons — so the heading candidates
 * seen so far are tracked and used to strip the parent prefix. That makes the
 * parent available to the UI, which needs it to group rows under their job.
 *
 * An empty `candidates` list with a `total` is a parse failure, reported rather
 * than silently rendered as "nothing to review".
 *
 * @param {string} stdout
 * @returns {{ candidates: Candidate[], total: number, totalMatches: boolean, source: string, parsed: boolean }}
 */
export function parseImportPreview(stdout = "") {
  const lines = String(stdout).replace(/\r\n?/g, "\n").split("\n");

  let source = "";
  let total = 0;
  let sawHeader = false;
  for (const line of lines) {
    const found = line.trim().match(FOUND);
    if (found) {
      total = Number(found[1]);
      source = found[2].trim();
      sawHeader = true;
      break;
    }
  }

  /** @type {Candidate[]} */
  const candidates = [];
  /** @type {Map<string, string>} section -> current entity label */
  const parents = new Map();

  for (const line of lines) {
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2);
    const split = body.indexOf(": ");
    if (split === -1) continue;

    const label = body.slice(0, split);
    const rest = body.slice(split + 2);

    const heading = label.match(/^(\w+) heading$/);
    if (heading && SECTIONS.includes(heading[1])) {
      const section = heading[1];
      parents.set(section, rest);
      candidates.push({ section, parent: null, isHeading: true, text: rest, label });
      continue;
    }

    if (SECTIONS.includes(label)) {
      const parent = ENTITY_SECTIONS.has(label) ? (parents.get(label) ?? null) : null;
      // Strip the parent prefix the CLI repeats in front of each fact's text.
      const text = parent && rest.startsWith(`${parent}: `) ? rest.slice(parent.length + 2) : rest;
      candidates.push({ section: label, parent, isHeading: false, text, label });
    }
  }

  return {
    candidates,
    total,
    totalMatches: !sawHeader || candidates.length === total,
    source,
    parsed: sawHeader && candidates.length > 0,
  };
}

/**
 * Turn per-candidate decisions into the stdin the importer expects.
 *
 * Decisions are accepted as `"approve" | "skip" | "edit"`; `"edit"` requires
 * `text`. A skipped entity heading drops every following candidate of that
 * section under that parent, because the CLI will not prompt for them — see the
 * header. Those dropped indices are returned so the caller can tell the user
 * which pending answers were folded into the heading's skip instead of silently
 * discarding them.
 *
 * @param {Candidate[]} candidates
 * @param {({ action: "approve" | "skip" | "edit", text?: string } | undefined)[]} decisions
 * @returns {{ stdin: string, prompted: number[], swallowed: number[] }}
 */
export function buildReviewInput(candidates = [], decisions = []) {
  const swallowedHeadings = new Set();
  const prompted = [];
  const swallowed = [];
  /** @type {string[]} */
  const lines = [];

  candidates.forEach((candidate, index) => {
    const section = candidate.section;
    const parent = candidate.parent;

    // Facts under a heading the user skipped: the CLI never prompts for these.
    if (!candidate.isHeading && parent !== null) {
      const entityKey = `${section}\0${parent}`;
      if (swallowedHeadings.has(entityKey)) {
        swallowed.push(index);
        return;
      }
    }

    const decision = decisions[index];
    const action = decision?.action ?? "skip";

    // Known limitation: headings are matched by label, the one identity the
    // preview prints. A cv.md with two identically-labelled entries in one
    // section (the same company twice) would fold both into one skip. The CLI
    // itself keys on entry id and would not; closing this properly needs the
    // preview to carry ids, which is a core change to a manifest-owned file.
    if (action === "skip" && candidate.isHeading) {
      swallowedHeadings.add(`${section}\0${candidate.text}`);
    }

    prompted.push(index);

    if (action === "edit") {
      const text = (decision?.text ?? "").trim();
      // A blank rewrite cancels in the CLI and re-prompts, which would desync
      // every answer after it. Treat it as a skip instead of sending it.
      if (!text) {
        lines.push("n");
      } else {
        lines.push("e", text);
      }
      return;
    }

    lines.push(action === "approve" ? "y" : "n");
  });

  return { stdin: lines.length > 0 ? `${lines.join("\n")}\n` : "", prompted, swallowed };
}

/**
 * The importer's closing lines: what it saved, or why it changed nothing.
 * Surfaced verbatim so the result is the core's own statement, not ours.
 *
 * @param {string} stdout
 * @returns {string}
 */
export function summarizeImportRun(stdout = "") {
  const lines = String(stdout)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const saved = lines.find((line) => line.startsWith("Saved "));
  if (saved) return "Profile saved";
  const unchanged = lines.find((line) => line.startsWith("No approved items"));
  if (unchanged) return "Nothing approved — profile was not changed";
  // A rejected import leads with "Import rejected:" and then one line per
  // validation error. The errors are the actionable part, so keep them with it.
  const rejectedAt = lines.findIndex((line) => line.startsWith("Import rejected"));
  if (rejectedAt !== -1) {
    const errors = lines.slice(rejectedAt + 1).map((line) => line.replace(/^-\s*/, ""));
    return errors.length > 0 ? `Import rejected: ${errors.join("; ")}` : "Import rejected";
  }
  return lines.at(-1) ?? "The importer returned no result";
}
