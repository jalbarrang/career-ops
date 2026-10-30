import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReviewInput, parseImportPreview, summarizeImportRun } from "../../src/lib/cv-import.mjs";

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
