import assert from "node:assert/strict";
import { test } from "node:test";

import { buildCvPayload, candidateFromProfileConfig, cvFileStem } from "../../src/lib/cv-generation.mjs";

const evidence = (source, line, quote) => ({ source, line, quote });

function fixture() {
  return {
    schema_version: 1,
    candidate: {},
    summary: [
      { id: "summary-1", text: "Full stack engineer.", review_status: "verified", evidence: evidence("cv.md", 11, "Full stack engineer.") },
      { id: "summary-2", text: "Ten years shipping product.", review_status: "verified", evidence: evidence("cv.md", 11, "Ten years shipping product.") },
    ],
    experiences: [
      {
        id: "experiences-acme",
        label: "Acme — Software Engineer",
        company: "Acme",
        role: "Software Engineer",
        location: "Remote",
        dates: "2024 – 2026",
        facts: [
          { id: "fact-a", text: "Shipped the editor.", review_status: "verified", evidence: evidence("cv.md", 20, "Shipped the editor.") },
          { id: "fact-b", text: "Cut build times 40%.", review_status: "verified", evidence: evidence("cv.md", 21, "Cut build times 40%.") },
        ],
      },
      {
        id: "experiences-unbound",
        label: "March 2025 - September 2026",
        facts: [{ id: "fact-c", text: "Did the thing.", review_status: "verified", evidence: evidence("cv.md", 31, "Did the thing.") }],
      },
    ],
    projects: [],
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
  assert.equal(candidate.email, "j@example.com");
  assert.equal(candidate.full_name, undefined);
});

test("empty candidate fields are dropped, not passed as empty strings", () => {
  const candidate = candidateFromProfileConfig({ candidate: { full_name: "X", github: "   ", phone: "" } });
  assert.deepEqual(candidate, { name: "X" });
});

test("a name already present wins over full_name, and a bare mapping works too", () => {
  assert.equal(candidateFromProfileConfig({ candidate: { name: "N", full_name: "F" } }).name, "N");
  assert.equal(candidateFromProfileConfig({ full_name: "F" }).name, "F");
});

test("selected facts become the payload's experience, summary and skills", () => {
  const candidate = { name: "Juan", email: "j@example.com" };
  const { payload, gaps, counts } = buildCvPayload({
    profile: fixture(),
    candidate,
    selection: {
      summaryIds: ["summary-1", "summary-2"],
      experiences: [{ entryId: "experiences-acme", factIds: ["fact-a", "fact-b"] }],
      skills: ["skills-1"],
    },
  });

  assert.equal(payload.candidate, candidate);
  assert.equal(payload.summary, "Full stack engineer. Ten years shipping product.");
  assert.deepEqual(payload.experience, [
    { company: "Acme", role: "Software Engineer", location: "Remote", dates: "2024 – 2026", bullets: ["Shipped the editor.", "Cut build times 40%."] },
  ]);
  assert.deepEqual(payload.skills, [{ items: ["TypeScript"] }]);
  assert.deepEqual(gaps, []);
  assert.deepEqual(counts, { summary: 1, experience: 1, bullets: 2, skills: 1 });
});

test("an entry without company and role is reported, never dropped in silence", () => {
  const { payload, gaps } = buildCvPayload({
    profile: fixture(),
    candidate: { name: "Juan" },
    selection: { experiences: [{ entryId: "experiences-acme", factIds: ["fact-a"] }, { entryId: "experiences-unbound", factIds: ["fact-c"] }] },
  });

  assert.equal(payload.experience.length, 1);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].label, "March 2025 - September 2026");
  assert.deepEqual(gaps[0].missing, ["company", "role"]);
  assert.match(gaps[0].reason, /would not render/);
});

test("a fact that is still needs_review is rendered but flagged", () => {
  const profile = fixture();
  profile.experiences[0].facts[0].review_status = "needs_review";
  const { payload, warnings } = buildCvPayload({
    profile,
    candidate: { name: "Juan" },
    selection: { experiences: [{ entryId: "experiences-acme", factIds: ["fact-a"] }] },
  });
  assert.equal(payload.experience[0].bullets.length, 1);
  assert.equal(
    warnings.some((line) => line.includes("needs review")),
    true,
  );
});

test("a stale fact id is skipped rather than shipped as an empty bullet", () => {
  const { payload } = buildCvPayload({
    profile: fixture(),
    candidate: { name: "Juan" },
    selection: { experiences: [{ entryId: "experiences-acme", factIds: ["fact-a", "fact-gone"] }] },
  });
  assert.deepEqual(payload.experience[0].bullets, ["Shipped the editor."]);
});

test("an empty selection is a warning, not an empty CV with no explanation", () => {
  const { payload, warnings } = buildCvPayload({ profile: fixture(), candidate: { name: "Juan" }, selection: {} });
  assert.equal(payload.experience, undefined);
  assert.equal(
    warnings.some((line) => line.includes("nothing selected")),
    true,
  );
});

test("a missing candidate name is called out, because the header would be blank", () => {
  const { warnings } = buildCvPayload({
    profile: fixture(),
    candidate: {},
    selection: { experiences: [{ entryId: "experiences-acme", factIds: ["fact-a"] }] },
  });
  assert.equal(
    warnings.some((line) => line.includes("no candidate name")),
    true,
  );
});

test("file stems are ascii-folded, dashed, and cannot escape the output directory", () => {
  assert.equal(cvFileStem("Acme — Senior Engineer", "2026-10-30"), "acme-senior-engineer-2026-10-30");
  assert.equal(cvFileStem("../../etc/passwd", "2026-10-30"), "etc-passwd-2026-10-30");
  assert.equal(cvFileStem("", "2026-10-30"), "cv-2026-10-30");
  assert.equal(cvFileStem("Ñandú & Cía", "2026-10-30"), "nandu-cia-2026-10-30");
});
