/**
 * Read the Master Career Profile importer's own output, and build the stdin it
 * consumes.
 *
 * `career-profile.ts import --review` is an interactive line protocol:
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
 * Plain .ts, no I/O, no `@/` aliases — `node --test` imports it directly.
 */

/** Sections the importer walks, in its own order. Keys come from parseCv(). */
export const SECTIONS = ["summary", "experiences", "projects", "education", "certifications", "skills"];

/** Candidate kinds that own facts, and so can swallow later answers when skipped. */
const ENTITY_SECTIONS = new Set(["experiences", "projects", "education"]);

const FOUND = /^Found (\d+) review candidates in (.+?)\.?\s*$/;

/** One review candidate the importer printed. */
export interface Candidate {
  /** One of SECTIONS. */
  section: string;
  /** The entity label a fact belongs to, if any. */
  parent: string | null;
  /** True for an entity-heading candidate. */
  isHeading: boolean;
  /** What the row shows. */
  text: string;
  /** The CLI's own label prefix, verbatim. */
  label: string;
}

/** One review prompt block: a flat fact, or an entry heading plus its facts. */
export interface ImportBlock {
  key: string;
  kind: "flat" | "entry";
  section: string;
  headingIndices: number[];
  ownerIndex: number;
  factIndices: number[];
  labels: string[];
}

export type ImportAction = "approve" | "skip" | "edit";

/** What the user chose for one candidate. */
export interface ImportDecision {
  action: ImportAction;
  text?: string;
}

/** Decisions are sparse: an index with no answer is `undefined`. */
export type ImportDecisions = Array<ImportDecision | undefined>;

/**
 * Parse `bun career-profile.ts import` (preview mode) stdout.
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
export function parseImportPreview(stdout: string = ""): { candidates: Candidate[]; total: number; totalMatches: boolean; source: string; parsed: boolean } {
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

  const candidates: Candidate[] = [];
  /** section -> current entity label */
  const parents = new Map<string, string>();

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
export function buildReviewInput(
  candidates: readonly Candidate[] = [],
  decisions: ImportDecisions = [],
): { stdin: string; prompted: number[]; swallowed: number[] } {
  const prompted: number[] = [];
  const swallowed: number[] = [];
  const lines: string[] = [];

  const push = (decision: ImportDecision | undefined): void => {
    const action = decision?.action ?? "skip";
    if (action === "edit") {
      const text = String(decision?.text ?? "").trim();
      // A blank rewrite cancels in the CLI and re-prompts, which would desync
      // every answer after it. Treat it as a skip instead of sending it.
      if (text) {
        lines.push("e", text);
        return;
      }
    }
    lines.push(action === "approve" ? "y" : "n");
  };

  // Answered per BLOCK, because the importer prompts per block: it walks a
  // block's lines and then its facts. A block whose first line is skipped is
  // dropped whole — the CLI does not prompt the rest of it — so sending answers
  // for those would shift every later decision onto the wrong row. That is not
  // hypothetical: it wrote one job's bullets onto another employer during this
  // fork's own seeding.
  for (const block of groupImportBlocks(candidates)) {
    const first = block.kind === "flat" ? block.factIndices[0] : block.headingIndices[0];
    const firstDecision = decisions[first];
    const dropped = block.kind === "entry" && (firstDecision?.action ?? "skip") === "skip";

    prompted.push(first);
    push(firstDecision);
    if (dropped) {
      swallowed.push(...block.headingIndices.slice(1), ...block.factIndices);
      continue;
    }
    for (const index of block.headingIndices.slice(1)) {
      prompted.push(index);
      push(decisions[index]);
    }
    for (const index of block.factIndices) {
      if (block.kind === "flat") continue;
      prompted.push(index);
      push(decisions[index]);
    }
  }

  return { stdin: lines.length > 0 ? `${lines.join("\n")}\n` : "", prompted, swallowed };
}

export function groupImportBlocks(candidates: readonly Candidate[] = []): ImportBlock[] {
  const blocks: ImportBlock[] = [];
  let current: ImportBlock | null = null;

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
export function suggestEntryFields(labels: readonly string[] = []): { company: string; role: string; dates: string } {
  const clean = (value: unknown): string => String(value ?? "").trim();
  const isDates = (value: string): boolean => /\b(?:19|20)\d{2}\b/.test(value) && !/[.;]$/.test(value) && value.length <= 40;
  // A comma-separated list ("Clients: SoftPatagonia, Valueinnova LLC") is a
  // sentence fragment, not a company name — treating it as one would write a
  // junk company into the profile.
  const isProse = (value: string): boolean => value.length > 60 || /[.;]$/.test(value) || /,\s/.test(value);

  const named: string[] = [];
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
 * Approving a block approves every line and fact it covers — under v2 the
 * company line is content, not metadata, so all of them are meaningful.
 * Skipping a block skips all of them, and the importer then drops the block
 * whole. Indices outside the block are untouched.
 *
 * @param {ImportBlock} block
 * @param {"approve" | "skip"} action
 * @param {({ action: "approve" | "skip" | "edit", text?: string } | undefined)[]} decisions
 * @returns {({ action: "approve" | "skip" | "edit", text?: string } | undefined)[]}
 */
export function applyBlockDecision(block: ImportBlock, action: "approve" | "skip", decisions: ImportDecisions = []): ImportDecisions {
  const next = [...decisions];
  const set = (index: number, decision: ImportDecision): void => {
    next[index] = decision;
  };

  // Every line of the block is content under v2 — company, role and period —
  // so a block decision applies to all of them, not just the owner. Skipping
  // them is what made the importer drop the employer entirely.
  for (const index of block.headingIndices) set(index, { action });
  for (const index of block.factIndices) set(index, { action });

  return next;
}

/**
 * The importer's closing lines: what it saved, or why it changed nothing.
 * Surfaced verbatim so the result is the core's own statement, not ours.
 *
 * @param {string} stdout
 * @returns {string}
 */
export function summarizeImportRun(stdout: string = ""): string {
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
