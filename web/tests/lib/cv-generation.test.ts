import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCvPayload, candidateFromProfileConfig, cvFileStem } from "../../src/lib/cv-generation.ts";

const evidence = (source, line, quote) => ({ source, line, quote });

/** Schema v2: one employer, two roles — the promotion case. */
function fixture() {
  return {
    schema_version: 2,
    candidate: {},
    summary: [
      { id: "summary-1", text: "Full stack engineer.", review_status: "verified", evidence: evidence("cv.md", 11, "Full stack engineer.") },
      { id: "summary-2", text: "Ten years shipping product.", review_status: "verified", evidence: evidence("cv.md", 11, "Ten years shipping product.") },
    ],
    experiences: [
      {
        id: "experiences-acme",
        company: { name: "Acme", evidence: evidence("cv.md", 18, "### Acme") },
        roles: [
          {
            id: "experiences-senior",
            name: "Senior Engineer",
            period: "2024 – 2026",
            location: "Remote",
            review_status: "verified",
            evidence: evidence("cv.md", 19, "**Senior Engineer**"),
            facts: [
              { id: "fact-a", text: "Shipped the editor.", review_status: "verified", evidence: evidence("cv.md", 20, "Shipped the editor.") },
              { id: "fact-b", text: "Cut build times 40%.", review_status: "verified", evidence: evidence("cv.md", 21, "Cut build times 40%.") },
            ],
          },
          {
            id: "experiences-engineer",
            name: "Engineer",
            period: "2021 – 2023",
            review_status: "verified",
            evidence: evidence("cv.md", 24, "**Engineer**"),
            facts: [{ id: "fact-c", text: "Built the dashboard.", review_status: "verified", evidence: evidence("cv.md", 25, "Built the dashboard.") }],
          },
        ],
      },
      {
        id: "experiences-untitled",
        company: { name: "Beta", evidence: evidence("cv.md", 30, "### Beta") },
        roles: [
          {
            id: "experiences-noname",
            name: "",
            period: "2019 – 2021",
            review_status: "verified",
            evidence: evidence("cv.md", 31, "2019 – 2021"),
            facts: [{ id: "fact-d", text: "Did the thing.", review_status: "verified", evidence: evidence("cv.md", 32, "Did the thing.") }],
          },
        ],
      },
    ],
    projects: [{ id: "projects-1", label: "FraudShield", review_status: "verified", evidence: evidence("cv.md", 40, "## Projects"), facts: [
      { id: "fact-p", text: "Detected fraud in real time.", review_status: "verified", evidence: evidence("cv.md", 41, "Detected fraud.") },
    ] }],
    education: [],
    certifications: [],
    skills: [
      { id: "skills-1", text: "TypeScript", review_status: "verified", evidence: evidence("cv.md", 5, "TypeScript") },
      { id: "skills-2", text: "Go", review_status: "verified", evidence: evidence("cv.md", 5, "Go") },
    ],
  };
}

test("the candidate is mapped to the keys the template actually reads", () => {
  // config/profile.yml says full_name; the template reads name. Straight
  // passthrough renders a CV with no name on it.
  const candidate = candidateFromProfileConfig({
    candidate: {
      full_name: "Juan Andrés Albarrán",
      title: "Senior Full Stack Engineer",
      email: "j@example.com",
      phone: "+56 9 0000 0000",
      location: "Concepción, Chile",
      linkedin: "linkedin.com/in/x",
      github: "github.com/x",
    },
  });
  assert.equal(candidate.name, "Juan Andrés Albarrán");
  assert.equal(candidate.title, "Senior Full Stack Engineer");
  assert.equal(candidate.full_name, undefined);
});

test("empty candidate fields are dropped, not passed as empty strings", () => {
  assert.deepEqual(candidateFromProfileConfig({ candidate: { full_name: "X", github: "   ", phone: "" } }), { name: "X" });
  assert.equal(candidateFromProfileConfig({ candidate: { name: "N", full_name: "F" } }).name, "N");
  assert.equal(candidateFromProfileConfig({ full_name: "F" }).name, "F");
});

test("a selected role becomes one payload entry, taking the company from its parent", () => {
  const { payload, gaps, counts } = buildCvPayload({
    profile: fixture(),
    candidate: { name: "Juan", email: "j@example.com" },
    selection: {
      summaryIds: ["summary-1", "summary-2"],
      experiences: [{ entryId: "experiences-senior", factIds: ["fact-a", "fact-b"] }],
      skills: ["skills-1"],
    },
  });

  assert.equal(payload.summary, "Full stack engineer. Ten years shipping product.");
  assert.deepEqual(payload.experience, [
    { company: "Acme", role: "Senior Engineer", location: "Remote", dates: "2024 – 2026", bullets: ["Shipped the editor.", "Cut build times 40%."] },
  ]);
  assert.deepEqual(payload.skills, [{ items: ["TypeScript"] }]);
  assert.deepEqual(gaps, []);
  assert.deepEqual(counts, { summary: 1, experience: 1, bullets: 2, skills: 1 });
});

test("two roles at one employer are two payload entries, in the order selected", () => {
  const { payload } = buildCvPayload({
    profile: fixture(),
    candidate: { name: "Juan" },
    selection: {
      experiences: [
        { entryId: "experiences-senior", factIds: ["fact-a"] },
        { entryId: "experiences-engineer", factIds: ["fact-c"] },
      ],
    },
  });
  assert.deepEqual(payload.experience.map((entry) => `${entry.company} ${entry.role}`), ["Acme Senior Engineer", "Acme Engineer"]);
  assert.deepEqual(payload.experience.map((entry) => entry.dates), ["2024 – 2026", "2021 – 2023"]);
});

test("a role with no title is reported as a gap, never dropped in silence", () => {
  const { payload, gaps } = buildCvPayload({
    profile: fixture(),
    candidate: { name: "Juan" },
    selection: {
      experiences: [
        { entryId: "experiences-senior", factIds: ["fact-a"] },
        { entryId: "experiences-noname", factIds: ["fact-d"] },
      ],
    },
  });
  assert.equal(payload.experience.length, 1);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].label, "Beta");
  assert.deepEqual(gaps[0].missing, ["role"]);
  assert.match(gaps[0].reason, /would not render/);
});

test("a selected role that no longer exists is a gap, not an empty entry", () => {
  const { payload, gaps } = buildCvPayload({
    profile: fixture(),
    candidate: { name: "Juan" },
    selection: { experiences: [{ entryId: "experiences-gone", factIds: [] }] },
  });
  assert.equal(payload.experience, undefined);
  assert.equal(gaps[0].reason, "role no longer exists");
});

test("a fact that is still needs_review is rendered but flagged", () => {
  const profile = fixture();
  profile.experiences[0].roles[0].facts[0].review_status = "needs_review";
  const { payload, warnings } = buildCvPayload({
    profile,
    candidate: { name: "Juan" },
    selection: { experiences: [{ entryId: "experiences-senior", factIds: ["fact-a"] }] },
  });
  assert.equal(payload.experience[0].bullets.length, 1);
  assert.equal(warnings.some((line) => line.includes("needs review")), true);
});

test("a stale fact id is skipped rather than shipped as an empty bullet", () => {
  const { payload } = buildCvPayload({
    profile: fixture(),
    candidate: { name: "Juan" },
    selection: { experiences: [{ entryId: "experiences-senior", factIds: ["fact-a", "fact-gone"] }] },
  });
  assert.deepEqual(payload.experience[0].bullets, ["Shipped the editor."]);
});

test("project facts survive as bullets, and an empty selection is a warning", () => {
  const withProject = buildCvPayload({
    profile: fixture(),
    candidate: { name: "Juan" },
    selection: { projectIds: ["projects-1"] },
  });
  assert.deepEqual(withProject.payload.projects, [{ name: "FraudShield", bullets: ["Detected fraud in real time."] }]);

  const empty = buildCvPayload({ profile: fixture(), candidate: { name: "Juan" }, selection: {} });
  assert.equal(empty.payload.experience, undefined);
  assert.equal(empty.warnings.some((line) => line.includes("nothing selected")), true);
});

test("a missing candidate name is called out, because the header would be blank", () => {
  const { warnings } = buildCvPayload({
    profile: fixture(),
    candidate: {},
    selection: { experiences: [{ entryId: "experiences-senior", factIds: ["fact-a"] }] },
  });
  assert.equal(warnings.some((line) => line.includes("no candidate name")), true);
});

test("file stems are ascii-folded, dashed, and cannot escape the output directory", () => {
  assert.equal(cvFileStem("Acme — Senior Engineer", "2026-10-30"), "acme-senior-engineer-2026-10-30");
  assert.equal(cvFileStem("../../etc/passwd", "2026-10-30"), "etc-passwd-2026-10-30");
  assert.equal(cvFileStem("", "2026-10-30"), "cv-2026-10-30");
  assert.equal(cvFileStem("Ñandú & Cía", "2026-10-30"), "nandu-cia-2026-10-30");
});
