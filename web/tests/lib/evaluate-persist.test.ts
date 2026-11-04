// The evaluate route must persist the report the worker returns (#2185).
//
// The worker is read-only (a posting is untrusted data), so the backend runs
// reserve-report-num → persist-evaluation-report → merge-tracker against the
// user's data root. This test drives that writer against a throwaway root with
// the real scripts, so a renamed flag, a changed payload key or a broken merge
// fails here instead of in the UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { persistEvaluation } from "../../src/lib/evaluate-persist.ts";

const CORE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const TRACKER_HEADER =
  "# Applications Tracker\n\n" +
  "| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |\n" +
  "|---|------|---------|------|-------|--------|-----|--------|-------|-----|\n";

const REPORT = `# Evaluation: Acme Corp — Senior Engineer

**Date:** 2026-11-03
**Score:** 4.2/5
**Decision:** Apply
**URL:** https://acme.example/jobs/1

---

## Machine Summary

\`\`\`yaml
company: "Acme Corp"
role: "Senior Engineer"
score: 4.2
final_decision: "Apply"
\`\`\`
`;

test("persistEvaluation writes the report and merges the tracker", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "co-evaluate-persist-"));
  const prior = {
    root: process.env.CAREER_OPS_ROOT,
    data: process.env.CAREER_OPS_DATA_DIR,
    code: process.env.CAREER_OPS_CODE_ROOT,
  };
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "applications.md"), TRACKER_HEADER);

  process.env.CAREER_OPS_ROOT = root;
  process.env.CAREER_OPS_DATA_DIR = "";
  process.env.CAREER_OPS_CODE_ROOT = CORE;
  t.after(() => {
    for (const [key, value] of [
      ["CAREER_OPS_ROOT", prior.root],
      ["CAREER_OPS_DATA_DIR", prior.data],
      ["CAREER_OPS_CODE_ROOT", prior.code],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const saved = await persistEvaluation(REPORT, "https://acme.example/jobs/1");
  if (!saved.ok) assert.fail(saved.error);
  assert.match(saved.reportFile ?? "", /^\d{3}-acme-corp-\d{4}-\d{2}-\d{2}\.md$/);
  assert.equal(fs.readFileSync(path.join(root, "reports", saved.reportFile as string), "utf8"), REPORT);

  const tracker = fs.readFileSync(path.join(root, "data", "applications.md"), "utf8");
  assert.match(tracker, /\| Acme Corp \| Senior Engineer \| 4\.2\/5 \| Evaluated \|/);
  assert.match(tracker, /https:\/\/acme\.example\/jobs\/1/);
});

test("persistEvaluation refuses a report with no company/role heading", async () => {
  const saved = await persistEvaluation("# Something else\n\n**Score:** 4/5\n", "https://acme.example/jobs/1");
  assert.equal(saved.ok, false);
  assert.match(saved.error ?? "", /heading/);
});
