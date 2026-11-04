import assert from "node:assert/strict";
import { test } from "node:test";

import { reviewHeadline, summarizeCheck, summarizeDoctor, toDetailLines } from "../../src/lib/cv-review.ts";

// The fixtures below are verbatim output from the three core commands, run
// against a real cv.md and against a scratch data root. They are here because
// the panel's whole job is to not misreport them: every one of these shapes
// passed through the parser by hand before it was written down.

const SYNC_OK = "\n=== career-ops sync check ===\n\nAll checks passed.\n";

const SYNC_FAIL = [
  "",
  "=== career-ops sync check ===",
  "",
  "ERRORS (1):",
  "  ERROR: config/profile.yml not found. Copy from config/profile.example.yml and fill in your details.",
  "",
].join("\n");

const FACTS_FAIL = [
  "⚠️  fact-gate config not found: /tmp/co-scratch/config/cv-facts.json — forbidden/advisory phrase checks did not run.",
  "CV fact check failed: bad.md",
  "",
  "Metric-like claims absent from sources:",
  "  - 400%",
  "",
  "cv.md and article-digest.md do not contain these claims. Add career evidence to one of them.",
].join("\n");

test("a passing check reports pass and keeps the command's own verdict line", () => {
  const check = summarizeCheck({ id: "sync", label: "Setup consistency", exitCode: 0, stdout: SYNC_OK });
  assert.equal(check.status, "pass");
  assert.equal(check.summary, "All checks passed.");
  // The `=== banner ===` is decoration and must not become a detail row.
  assert.equal(check.details.some((line) => line.includes("===")), false);
});

test("a non-zero exit is a failure even when the output reads calmly", () => {
  const check = summarizeCheck({ id: "sync", label: "Setup consistency", exitCode: 1, stdout: SYNC_FAIL });
  assert.equal(check.status, "fail");
  assert.equal(check.summary, "ERRORS (1):");
  assert.equal(
    check.details.some((line) => line.includes("config/profile.yml not found")),
    true,
  );
});

test("a leading warning notice does not hide the fact gate's verdict line", () => {
  const check = summarizeCheck({ id: "facts", label: "Fact gate (banned claims)", exitCode: 1, stdout: FACTS_FAIL });
  assert.equal(check.status, "fail");
  // The ⚠️ config notice prints FIRST; the summary must be the verdict.
  assert.equal(check.summary, "CV fact check failed: bad.md");
  assert.equal(
    check.details.some((line) => line.includes("400%")),
    true,
  );
  assert.equal(
    check.details.some((line) => line.includes("fact-gate config not found")),
    true,
  );
});

test("warning output on a zero exit is a warn, not a pass", () => {
  const check = summarizeCheck({ id: "facts", label: "Fact gate", exitCode: 0, stdout: FACTS_FAIL });
  assert.equal(check.status, "warn");
});

test("a command that never ran is a failure, not an empty pass", () => {
  const check = summarizeCheck({ id: "facts", label: "Fact gate", exitCode: null, error: "spawn node ENOENT" });
  assert.equal(check.status, "fail");
  assert.equal(check.summary, "spawn node ENOENT");
});

test("an inapplicable check is skipped, never green", () => {
  const check = summarizeCheck({
    id: "facts",
    label: "Fact gate",
    exitCode: null,
    unavailable: "No cv.md yet — save one first.",
  });
  assert.equal(check.status, "skip");
});

test("doctor's structured arrays become one row, and missing files outrank warnings", () => {
  const withWarnings = summarizeDoctor({
    missing: [],
    warnings: ["Playwright MCP tools not detected\n→ Install one for browser checks."],
    unpersonalized: [{ path: "modes/_profile.md", reason: "still has 1 unfilled section: portfolio" }],
  });
  assert.equal(withWarnings.status, "warn");
  assert.equal(withWarnings.summary, "3 thing(s) to review"); // 2 warning lines + 1 profile entry
  assert.equal(
    withWarnings.details.some((line) => line === "→ Install one for browser checks."),
    true,
  );

  const withMissing = summarizeDoctor({ missing: ["cv.md"], warnings: [], unpersonalized: [] });
  assert.equal(withMissing.status, "fail");
  assert.equal(withMissing.details.includes("missing: cv.md"), true);

  const clean = summarizeDoctor({ missing: [], warnings: [], unpersonalized: [] });
  assert.equal(clean.status, "pass");
});

test("reviewHeadline ranks failures over warnings, and an all-skip run is not a pass", () => {
  const pass = { id: "a", label: "A", status: "pass", summary: "", details: [] };
  const warn = { ...pass, id: "b", status: "warn" };
  const fail = { ...pass, id: "c", status: "fail" };
  const skip = { ...pass, id: "d", status: "skip" };

  assert.equal(reviewHeadline([pass, warn, fail]), "1 check(s) failed");
  assert.equal(reviewHeadline([pass, warn]), "1 check(s) need a look");
  assert.equal(reviewHeadline([pass]), "All checks passed");
  assert.equal(reviewHeadline([skip]), "No checks ran");
  assert.equal(reviewHeadline([]), "No checks ran");
});

test("toDetailLines de-duplicates and caps without pretending the list is complete", () => {
  const many = Array.from({ length: 60 }, (_, i) => `finding ${i}`).join("\n");
  const lines = toDetailLines(`dup\ndup\n${many}`);
  assert.equal(lines.filter((line) => line === "dup").length, 1);
  assert.equal(lines.length, 40);
  assert.match(lines.at(-1), /more finding\(s\) not shown$/);
});
