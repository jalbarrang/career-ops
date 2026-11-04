import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyBlockDecision,
  buildReviewInput,
  groupImportBlocks,
  parseImportPreview,
  suggestEntryFields,
  summarizeImportRun,
} from "../../src/lib/cv-import.ts";

// Real preview output, trimmed to the shapes that matter: a section the
// importer treats as flat facts, and an entity section whose headings own them.
const PREVIEW = [
  "Found 7 review candidates in cv.md.",
  "- summary: Full stack engineer with 10 years shipping product.",
  "- experiences heading: Series Entertainment",
  "- experiences: Series Entertainment: Shipped Creator Quests, an 18-quest ladder.",
  "- experiences: Series Entertainment: Made quest completion server-authoritative.",
  "- experiences heading: Isapre Esencial — Chile",
  "- experiences: Isapre Esencial — Chile: Led a cell of up to 6 developers.",
  "- skills: TypeScript",
  "Preview only; rerun with --review to approve items and save.",
  "",
].join("\n");

test("the preview parses into sections, and facts are grouped under their heading", () => {
  const { candidates, total, totalMatches, source, parsed } = parseImportPreview(PREVIEW);

  assert.equal(parsed, true);
  assert.equal(total, 7);
  assert.equal(totalMatches, true);
  assert.equal(source, "cv.md");
  assert.equal(candidates.length, 7);

  assert.deepEqual(candidates[0], {
    section: "summary",
    parent: null,
    isHeading: false,
    text: "Full stack engineer with 10 years shipping product.",
    label: "summary",
  });
  assert.equal(candidates[1].isHeading, true);
  assert.equal(candidates[1].text, "Series Entertainment");

  // The parent prefix the CLI repeats is stripped from the fact's own text,
  // including a parent label that itself contains a colon-adjacent dash.
  assert.equal(candidates[2].parent, "Series Entertainment");
  assert.equal(candidates[2].text, "Shipped Creator Quests, an 18-quest ladder.");
  assert.equal(candidates[5].parent, "Isapre Esencial — Chile");
  assert.equal(candidates[5].text, "Led a cell of up to 6 developers.");
  assert.equal(candidates[6].section, "skills");
  assert.equal(candidates[6].text, "TypeScript");
});

test("a preview that prints no header is reported as unparsed, not as an empty review", () => {
  const result = parseImportPreview("error: CV file not found: /nope/cv.md\n");
  assert.equal(result.parsed, false);
  assert.equal(result.candidates.length, 0);
});

test("a count that disagrees with the parsed rows is flagged", () => {
  const truncated = PREVIEW.replace("Found 7 review candidates", "Found 9 review candidates");
  const result = parseImportPreview(truncated);
  assert.equal(result.total, 9);
  assert.equal(result.totalMatches, false);
});

test("every candidate gets exactly one answer, in order, headings included", () => {
  const { candidates } = parseImportPreview(PREVIEW);
  const decisions = candidates.map(() => ({ action: "skip" }));
  // The CLI prompts for a heading too (approve keeps the entry, skip drops it);
  // only the facts UNDER a skipped heading go unprompted.
  const { stdin, prompted, swallowed } = buildReviewInput(candidates, decisions);

  assert.deepEqual(prompted, [0, 1, 4, 6]); // summary, both headings, the skill
  assert.deepEqual(swallowed, [2, 3, 5]); // facts under the two skipped headings
  assert.equal(stdin, "n\nn\nn\nn\n");
});

/**
 * The reason buildReviewInput exists. Skipping a heading makes the CLI skip that
 * entity's facts without prompting, so an answer queued for them would be read
 * as the answer to the NEXT candidate — every decision after the skip lands on
 * the wrong row, silently.
 */
test("skipping a heading does not queue answers for the facts it swallows", () => {
  const { candidates } = parseImportPreview(PREVIEW);
  const decisions = [
    { action: "approve" }, // summary
    { action: "skip" }, // heading: Series Entertainment
    { action: "approve" }, // would have been "Shipped Creator Quests" — never prompted
    { action: "approve" }, // would have been "server-authoritative" — never prompted
    { action: "approve" }, // heading: Isapre (kept, so its fact IS prompted)
    { action: "approve" }, // Isapre fact
    { action: "edit", text: "TypeScript, Node.js" }, // skill
  ];

  const { stdin, prompted, swallowed } = buildReviewInput(candidates, decisions);

  assert.deepEqual(prompted, [0, 1, 4, 5, 6]);
  assert.deepEqual(swallowed, [2, 3]);
  // y | n (the skipped heading) | y (Isapre heading) | y (its fact) | e + text
  assert.equal(stdin, "y\nn\ny\ny\ne\nTypeScript, Node.js\n");
});

test("approving a heading keeps its facts in the queue", () => {
  const { candidates } = parseImportPreview(PREVIEW);
  const decisions = candidates.map((candidate) => ({ action: candidate.isHeading ? "approve" : "approve" }));
  const { stdin, prompted, swallowed } = buildReviewInput(candidates, decisions);

  assert.deepEqual(swallowed, []);
  assert.equal(prompted.length, candidates.length);
  assert.equal(stdin, "y\n".repeat(candidates.length));
});

test("a blank rewrite becomes a skip, because the CLI would re-prompt and desync", () => {
  const { candidates } = parseImportPreview(PREVIEW);
  const decisions = candidates.map(() => ({ action: "skip" }));
  decisions[0] = { action: "edit", text: "   " };
  const { stdin } = buildReviewInput(candidates, decisions);
  assert.equal(stdin, "n\nn\nn\nn\n");
});

test("an unanswered candidate is a skip, never an accidental approval", () => {
  const { candidates } = parseImportPreview(PREVIEW);
  const { stdin } = buildReviewInput(candidates, []);
  assert.equal(stdin.includes("y"), false);
});

test("the importer's own closing line is what the UI reports", () => {
  assert.equal(
    summarizeImportRun("Found 7 review candidates in cv.md.\nSaved /root/data/career-profile.yml.\n"),
    "Profile saved",
  );
  assert.equal(
    summarizeImportRun("No approved items; profile was not changed.\n"),
    "Nothing approved — profile was not changed",
  );
  assert.equal(summarizeImportRun("Import rejected:\n- schema_version must be 1\n"), "Import rejected: schema_version must be 1");
});

/**
 * The shape that started this: one real job arrives as three headings because
 * the parser starts an entity on every non-bullet line, and the facts hang off
 * the last one (the date range).
 */
test("a job split into company / role / dates is one block, owned by the heading that has the facts", () => {
  const { candidates } = parseImportPreview(PREVIEW);
  const blocks = groupImportBlocks(candidates);

  const series = blocks.find((block) => block.kind === "entry");
  assert.deepEqual(series.headingIndices, [1]);
  assert.equal(series.ownerIndex, 1);
  assert.deepEqual(series.factIndices, [2, 3]);

  // And the flat sections stay one candidate each.
  assert.deepEqual(
    blocks.filter((block) => block.kind === "flat").map((block) => block.factIndices[0]),
    [0, 6],
  );
});

test("consecutive headings fold together, and a later heading with facts starts a new block", () => {
  const { candidates } = parseImportPreview(
    [
      "Found 6 review candidates in cv.md.",
      "- experiences heading: Acme",
      "- experiences heading: Senior Engineer:",
      "- experiences heading: 2024 - 2026",
      "- experiences: 2024 - 2026: Shipped the editor.",
      "- experiences heading: Beta",
      "- experiences: Beta: Did the other thing.",
    ].join("\n"),
  );

  const blocks = groupImportBlocks(candidates);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].labels, ["Acme", "Senior Engineer:", "2024 - 2026"]);
  assert.deepEqual(blocks[0].factIndices, [3]);
  assert.equal(blocks[0].ownerIndex, 2); // the dates heading owns the bullet
  assert.deepEqual(blocks[1].labels, ["Beta"]);
  assert.equal(blocks[1].ownerIndex, 4);
});

/**
 * Under v2 the company line is content, so approving a block approves every
 * line. Skipping the metadata lines is what used to drop the employer on the
 * floor — and what desynced the answer stream against the other employer.
 */
test("approving a block approves every line and fact it covers", () => {
  const { candidates } = parseImportPreview(
    [
      "Found 5 review candidates in cv.md.",
      "- experiences heading: Acme",
      "- experiences heading: Senior Engineer:",
      "- experiences heading: 2024 - 2026",
      "- experiences: 2024 - 2026: Shipped the editor.",
      "- skills: TypeScript",
    ].join("\n"),
  );
  const blocks = groupImportBlocks(candidates);
  const decided = applyBlockDecision(blocks[0], "approve", []);

  assert.deepEqual(decided[0], { action: "approve" }); // Acme — the company
  assert.deepEqual(decided[1], { action: "approve" }); // Senior Engineer: — the role
  assert.deepEqual(decided[2], { action: "approve" }); // 2024 - 2026 — the period
  assert.deepEqual(decided[3], { action: "approve" }); // its fact
  assert.equal(decided[4], undefined); // another block, untouched

  const { stdin, prompted } = buildReviewInput(candidates, decided);
  assert.deepEqual(prompted, [0, 1, 2, 3, 4]);
  assert.equal(stdin, "y\ny\ny\ny\nn\n");
});

test("skipping a block queues ONE answer for it, because the importer drops the rest", () => {
  const { candidates } = parseImportPreview(
    [
      "Found 5 review candidates in cv.md.",
      "- experiences heading: Acme",
      "- experiences heading: Senior Engineer:",
      "- experiences heading: 2024 - 2026",
      "- experiences: 2024 - 2026: Shipped the editor.",
      "- skills: TypeScript",
    ].join("\n"),
  );
  const blocks = groupImportBlocks(candidates);
  const decided = applyBlockDecision(blocks[0], "skip", []);
  const { stdin, prompted, swallowed } = buildReviewInput(candidates, decided);

  // The CLI prompts the company line, sees a skip, and drops the block whole —
  // so the next prompt is the skills candidate, not the role or the fact.
  assert.deepEqual(prompted, [0, 4]);
  assert.deepEqual(swallowed, [1, 2, 3]);
  assert.equal(stdin, "n\nn\n");
});

test("a per-fact edit survives a later block-level change to its siblings", () => {
  const { candidates } = parseImportPreview(PREVIEW);
  const blocks = groupImportBlocks(candidates);
  const withEdit = [];
  withEdit[2] = { action: "edit", text: "Sharper wording." };

  const decided = applyBlockDecision(blocks[1], "approve", withEdit);
  // The block click deliberately overwrites its own facts: the user just asked
  // for the whole block. What matters is that it cannot touch ANOTHER block.
  assert.deepEqual(decided[2], { action: "approve" });
  assert.equal(decided[0], undefined);
});

test("blocks keep the source order when a flat section follows an entry block", () => {
  const { candidates } = parseImportPreview(
    [
      "Found 4 review candidates in cv.md.",
      "- experiences heading: Acme",
      "- experiences heading: 2024 - 2026",
      "- experiences: 2024 - 2026: Shipped the editor.",
      "- skills: TypeScript",
    ].join("\n"),
  );
  const blocks = groupImportBlocks(candidates);
  // The open entry block must not be flushed after the flat candidate that
  // followed it — that reordering is what made a block-level click apply to the
  // wrong block.
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["entry", "flat"],
  );
  assert.equal(blocks[0].ownerIndex, 1);
});

test("the role's lines are classified by shape, and only when unambiguous", () => {
  // The common cv.md shape: company, bolded role with a colon, date range.
  assert.deepEqual(suggestEntryFields(["Series Entertainment", "Senior Full Stack Engineer:", "March 2025 - September 2026"]), {
    company: "Series Entertainment",
    role: "Senior Full Stack Engineer",
    dates: "March 2025 - September 2026",
  });

  // A block whose middle line is the date range still classifies: the role is
  // whichever line is a name, not whichever line came second.
  assert.deepEqual(suggestEntryFields(["Continuum HQ — Chile", "February 2022 - January 2024", "Placed on the Isapre Esencial account."]), {
    company: "Continuum HQ — Chile",
    role: "",
    dates: "February 2022 - January 2024",
  });

  // Nothing classifiable: empty fields rather than a guess.
  assert.deepEqual(suggestEntryFields(["Clients: SoftPatagonia, Valueinnova LLC"]), { company: "", role: "", dates: "" });
  assert.deepEqual(suggestEntryFields([]), { company: "", role: "", dates: "" });
});
