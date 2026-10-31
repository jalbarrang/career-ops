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
 * Group parsed candidates into the units a person actually reviews.
 *
 * The importer's parser is heading-based and conservative: in an entity section
 * EVERY non-bullet line starts a new entity. A normal CV block
 *
 *     ### Series Entertainment
 *     **Senior Full Stack Engineer:**
 *     March 2025 - September 2026
 *     - Shipped …
 *
 * therefore arrives as three heading candidates — company, role, dates — and all
 * the facts hang off the last one. Reviewed candidate-by-candidate that reads as
 * three weird entries, two of them empty, and approving all three writes exactly
 * that into the profile.
 *
 * This groups consecutive headings plus the facts after them into one block with
 * ONE owner: the last heading, which is the entity the facts were attached to.
 * The earlier headings are metadata for the same role, so approving the block
 * approves the owner and skips them — the profile gets one entry instead of
 * three, and no empty ones.
 *
 * @typedef {object} ImportBlock
 * @property {string} key
 * @property {"entry" | "flat"} kind
 * @property {string} section
 * @property {number[]} headingIndices - every heading folded into this block
 * @property {number} ownerIndex - the heading that owns the facts, or -1
 * @property {number[]} factIndices
 * @property {string[]} labels - the heading texts, in order
 *
 * @param {Candidate[]} [candidates]
 * @returns {ImportBlock[]}
 */
export function groupImportBlocks(candidates = []) {
  /** @type {ImportBlock[]} */
  const blocks = [];
  /** @type {ImportBlock | null} */
  let current = null;

  candidates.forEach((candidate, index) => {
    if (!candidate.isHeading) {
      // A fact that belongs to the open entry block stays with it.
      if (current && current.kind === "entry" && candidate.parent !== null) {
        current.factIndices.push(index);
        return;
      }
      // A flat candidate closes whatever entry block was still open, so the
      // blocks keep the order of the source instead of the pending one landing
      // after everything that followed it.
      if (current) {
        blocks.push(current);
        current = null;
      }
      blocks.push({
        key: `flat-${index}`,
        kind: "flat",
        section: candidate.section,
        headingIndices: [],
        ownerIndex: -1,
        factIndices: [index],
        labels: [candidate.text],
      });
      return;
    }

    // A heading after facts starts a new block: the facts before it belong to
    // the previous owner, never to this one.
    if (current && current.kind === "entry" && (current.factIndices.length > 0 || current.section !== candidate.section)) {
      blocks.push(current);
      current = null;
    }

    if (!current) {
      current = {
        key: `entry-${index}`,
        kind: "entry",
        section: candidate.section,
        headingIndices: [],
        ownerIndex: -1,
        factIndices: [],
        labels: [],
      };
    }

    current.headingIndices.push(index);
    current.labels.push(candidate.text);
    // The most recent heading owns whatever facts follow — that is exactly how
    // the parser attached them.
    current.ownerIndex = index;
  });

  if (current) blocks.push(current);
  return blocks;
}

/**
 * Which of a block's heading lines is company, role, or dates.
 *
 * The parser keeps every heading line, so a role's lines arrive in cv.md's order
 * but with nothing saying which is which — and the stored entry label ends up
 * being whichever line happened to own the facts (usually the date range, which
 * reads as a bug in the builder). This classifies by SHAPE only, and only when
 * the answer is unambiguous: a date range has a 4-digit year, prose is a
 * sentence, everything else is a name. A block whose lines do not classify
 * cleanly gets empty fields the user fills in, never a guess.
 *
 * @param {string[]} [labels]
 * @returns {{ company: string, role: string, dates: string }}
 */
export function suggestEntryFields(labels = []) {
  const clean = (value) => String(value ?? "").trim();
  const isDates = (value) => /\b(?:19|20)\d{2}\b/.test(value) && !/[.;]$/.test(value) && value.length <= 40;
  // A comma-separated list ("Clients: SoftPatagonia, Valueinnova LLC") is a
  // sentence fragment, not a company name — treating it as one would write a
  // junk company into the profile.
  const isProse = (value) => value.length > 60 || /[.;]$/.test(value) || /,\s/.test(value);

  const named = [];
  let dates = "";
  for (const label of labels.map(clean).filter(Boolean)) {
    if (isDates(label)) {
      if (!dates) dates = label;
      continue;
    }
    if (isProse(label)) continue;
    named.push(label);
  }

  const company = named[0] ?? "";
  // A role line in cv.md is often bolded with a trailing colon ("Technical Lead:").
  const role = (named[1] ?? "").replace(/:+\s*$/, "").trim();
  return { company, role, dates };
}

/**
 * The per-candidate decisions one block-level choice implies.
 *
 * Approving a block approves its owner heading and its facts, and SKIPS the
 * metadata headings — those would otherwise become empty entries. Skipping a
 * block skips everything it covers. Indices outside the block are untouched, so
 * a per-fact override made earlier survives a later block click.
 *
 * @param {ImportBlock} block
 * @param {"approve" | "skip"} action
 * @param {({ action: "approve" | "skip" | "edit", text?: string } | undefined)[]} decisions
 * @returns {({ action: "approve" | "skip" | "edit", text?: string } | undefined)[]}
 */
export function applyBlockDecision(block, action, decisions = []) {
  const next = [...decisions];
  const set = (index, decision) => {
    next[index] = decision;
  };

  for (const index of block.headingIndices) set(index, { action: index === block.ownerIndex ? action : "skip" });
  for (const index of block.factIndices) set(index, { action });

  // A flat block is a single candidate and owns nothing else.
  if (block.kind === "flat") for (const index of block.factIndices) set(index, { action });

  return next;
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
