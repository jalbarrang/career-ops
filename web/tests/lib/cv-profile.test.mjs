import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addEntry,
  addFact,
  emptyProfile,
  ENTRY_FIELDS,
  ensureShape,
  makeId,
  moveEntry,
  moveEntryTo,
  moveFact,
  parseValidationErrors,
  profileCounts,
  removeEntry,
  removeFact,
  setFactStatus,
  totalFacts,
  unverifiedCount,
  updateEntryField,
  updateFactText,
  userEvidence,
} from "../../src/lib/cv-profile.mjs";

const DATE = "2026-10-30";

function withEntry() {
  let profile = emptyProfile();
  const added = addEntry(profile, { section: "experiences", label: "Series Entertainment — Senior Full Stack Engineer", date: DATE });
  return { profile: added.profile, entryId: added.entry.id };
}

test("a new fact carries user-stated evidence, the schema's required fields, and a verified status", () => {
  const { profile } = addFact(emptyProfile(), { section: "skills", text: "  TypeScript  ", date: DATE });
  const [fact] = profile.skills;

  assert.equal(fact.text, "TypeScript"); // whitespace collapsed, not stored raw
  assert.equal(fact.review_status, "verified");
  assert.deepEqual(fact.evidence, { source: `user-stated ${DATE}`, line: 1, quote: "TypeScript" });
  assert.match(fact.id, /^skills-[0-9a-f]{12}$/);
});

test("the same fact is not stored twice in one scope", () => {
  const first = addFact(emptyProfile(), { section: "skills", text: "TypeScript", date: DATE });
  const second = addFact(first.profile, { section: "skills", text: "  typescript ", date: DATE });

  assert.equal(second.added, false);
  assert.equal(second.reason, "duplicate");
  assert.equal(second.profile.skills.length, 1);
});

test("the same wording under two entries is two facts, not a duplicate", () => {
  const a = withEntry();
  const b = addEntry(a.profile, { section: "experiences", label: "Isapre Esencial — Technical Lead", date: DATE });

  const first = addFact(b.profile, { section: "experiences", entryId: a.entryId, text: "Led the cell.", date: DATE });
  const second = addFact(first.profile, { section: "experiences", entryId: b.entry.id, text: "Led the cell.", date: DATE });

  assert.equal(second.added, true);
  const entryA = second.profile.experiences.find((entry) => entry.id === a.entryId);
  const entryB = second.profile.experiences.find((entry) => entry.id === b.entry.id);
  assert.equal(entryA.facts.length, 1);
  assert.equal(entryB.facts.length, 1);
});

test("reordering a fact stays inside its own entry", () => {
  const { profile, entryId } = withEntry();
  const one = addFact(profile, { section: "experiences", entryId, text: "First", date: DATE });
  const two = addFact(one.profile, { section: "experiences", entryId, text: "Second", date: DATE });
  const factId = two.fact.id;

  const moved = moveFact(two.profile, { section: "experiences", entryId, factId, direction: "up" });
  const facts = moved.experiences.find((entry) => entry.id === entryId).facts;
  assert.deepEqual(
    facts.map((fact) => fact.text),
    ["Second", "First"],
  );

  // Already first: a no-op rather than an error or a wrap-around.
  const again = moveFact(moved, { section: "experiences", entryId, factId, direction: "up" });
  assert.deepEqual(
    again.experiences.find((entry) => entry.id === entryId).facts.map((fact) => fact.text),
    ["Second", "First"],
  );
});

test("reordering entries swaps neighbours and stops at the ends", () => {
  let profile = emptyProfile();
  const a = addEntry(profile, { section: "experiences", label: "A", date: DATE });
  const b = addEntry(a.profile, { section: "experiences", label: "B", date: DATE });

  const moved = moveEntry(b.profile, { section: "experiences", entryId: b.entry.id, direction: "up" });
  assert.deepEqual(
    moved.experiences.map((entry) => entry.label),
    ["B", "A"],
  );

  const pastTop = moveEntry(moved, { section: "experiences", entryId: b.entry.id, direction: "up" });
  assert.deepEqual(
    pastTop.experiences.map((entry) => entry.label),
    ["B", "A"],
  );
});

test("rewording a fact never rewrites its evidence — that is what re-import matches on", () => {
  const { profile, entryId } = withEntry();
  const added = addFact(profile, { section: "experiences", entryId, text: "Original wording", date: DATE });
  const edited = updateFactText(added.profile, { section: "experiences", entryId, factId: added.fact.id, text: "Sharper wording" });

  const fact = edited.experiences.find((entry) => entry.id === entryId).facts[0];
  assert.equal(fact.text, "Sharper wording");
  assert.equal(fact.id, added.fact.id); // id survives the rename
  assert.deepEqual(fact.evidence, userEvidence("Original wording", DATE));
});

test("an empty rewrite is refused instead of blanking the fact", () => {
  const added = addFact(emptyProfile(), { section: "skills", text: "TypeScript", date: DATE });
  const edited = updateFactText(added.profile, { section: "skills", factId: added.fact.id, text: "   " });
  assert.equal(edited.skills[0].text, "TypeScript");
});

test("status can only be one of the two the schema knows", () => {
  const added = addFact(emptyProfile(), { section: "skills", text: "TypeScript", date: DATE });
  const flipped = setFactStatus(added.profile, { section: "skills", factId: added.fact.id, status: "needs_review" });
  assert.equal(flipped.skills[0].review_status, "needs_review");

  // A typo must not reach the file, where `validateProfile` would reject it.
  const bogus = setFactStatus(flipped, { section: "skills", factId: added.fact.id, status: "approved" });
  assert.equal(bogus.skills[0].review_status, "needs_review");
});

test("an unknown entry id adds nothing rather than creating an orphan fact", () => {
  const result = addFact(emptyProfile(), { section: "experiences", entryId: "experiences-nope", text: "x", date: DATE });
  assert.equal(result.added, false);
  assert.equal(result.reason, "unknown entry");
});

test("removing an entry takes its facts with it", () => {
  const { profile, entryId } = withEntry();
  const added = addFact(profile, { section: "experiences", entryId, text: "Led the cell.", date: DATE });
  const removed = removeEntry(added.profile, { section: "experiences", entryId });
  assert.equal(removed.experiences.length, 0);
});

test("removing a fact leaves its siblings and its entry intact", () => {
  const { profile, entryId } = withEntry();
  const one = addFact(profile, { section: "experiences", entryId, text: "One", date: DATE });
  const two = addFact(one.profile, { section: "experiences", entryId, text: "Two", date: DATE });
  const removed = removeFact(two.profile, { section: "experiences", entryId, factId: one.fact.id });

  const entry = removed.experiences.find((item) => item.id === entryId);
  assert.equal(entry.facts.length, 1);
  assert.equal(entry.facts[0].text, "Two");
});

test("counts separate entries from facts, and an empty entry reads as empty", () => {
  const { profile, entryId } = withEntry();
  const added = addFact(profile, { section: "experiences", entryId, text: "One", date: DATE });
  const withEmpty = addEntry(added.profile, { section: "experiences", label: "Empty role", date: DATE });

  const counts = profileCounts(withEmpty.profile);
  assert.deepEqual(counts.experiences, { entries: 2, facts: 1 });
  assert.equal(totalFacts(withEmpty.profile), 1);
  assert.equal(counts.skills.facts, 0);
});

test("unverified counts only facts that are not verified", () => {
  const imported = {
    ...emptyProfile(),
    skills: [
      { id: "skills-a", text: "a", review_status: "needs_review", evidence: userEvidence("a", DATE) },
      { id: "skills-b", text: "b", review_status: "verified", evidence: userEvidence("b", DATE) },
    ],
  };
  assert.equal(unverifiedCount(imported), 1);
});

test("a profile with missing sections is rendered, not crashed on or 'migrated'", () => {
  const partial = ensureShape({ schema_version: 1, candidate: { full_name: "Juan" }, summary: [{ id: "summary-1", text: "x" }] });
  assert.equal(partial.experiences.length, 0);
  assert.equal(partial.summary.length, 1); // present data untouched
  assert.deepEqual(partial.candidate, { full_name: "Juan" });
  assert.equal(ensureShape(null).schema_version, 1);
});

test("structured entry fields are settable, clearable, and limited to the ones a CV renders", () => {
  const { profile, entryId } = withEntry();

  const named = updateEntryField(profile, { section: "experiences", entryId, field: "company", value: " Series Entertainment " });
  assert.equal(named.experiences[0].company, "Series Entertainment"); // trimmed

  const both = ENTRY_FIELDS.reduce(
    (current, field) => updateEntryField(current, { section: "experiences", entryId, field, value: `${field}-value` }),
    named,
  );
  for (const field of ENTRY_FIELDS) assert.equal(both.experiences[0][field], `${field}-value`);

  // Clearing removes the key rather than storing "", so a payload builder can
  // tell "not provided" from "empty" and the builder can flag the missing one.
  const cleared = updateEntryField(both, { section: "experiences", entryId, field: "company", value: "   " });
  assert.equal("company" in cleared.experiences[0], false);

  // A field the payload never reads is refused, not stored.
  const bogus = updateEntryField(profile, { section: "experiences", entryId, field: "favourite_colour", value: "green" });
  assert.equal("favourite_colour" in bogus.experiences[0], false);
});

test("an entries-only section rejects entry fields, and an unknown entry is a no-op", () => {
  const { profile, entryId } = withEntry();
  assert.equal(updateEntryField(profile, { section: "skills", entryId, field: "company", value: "x" }), profile);
  assert.equal(updateEntryField(profile, { section: "experiences", entryId: "nope", field: "company", value: "x" }), profile);
});

test("moveEntryTo places an entry at an explicit index, which is what newest-first needs", () => {
  let profile = emptyProfile();
  for (const label of ["A", "B", "C"]) profile = addEntry(profile, { section: "experiences", label, date: DATE }).profile;

  const movedToTop = moveEntryTo(profile, { section: "experiences", entryId: profile.experiences[2].id, toIndex: 0 });
  assert.deepEqual(
    movedToTop.experiences.map((entry) => entry.label),
    ["C", "A", "B"],
  );

  const outOfRange = moveEntryTo(profile, { section: "experiences", entryId: profile.experiences[0].id, toIndex: 9 });
  assert.equal(outOfRange, profile);
});

test("the core's validation output is parsed without depending on its heading wording", () => {
  // Real output, verbatim, from `career-profile.mjs validate <file>`.
  assert.deepEqual(parseValidationErrors("Invalid profile:\n- schema_version must be 1\n- summary must be a list\n"), [
    "schema_version must be 1",
    "summary must be a list",
  ]);
  // A passing run has a path, not a `- ` line, and must not invent an error.
  assert.deepEqual(parseValidationErrors("Valid Master Career Profile: /tmp/x/data/career-profile.yml\n"), []);
  assert.deepEqual(parseValidationErrors(""), []);
});

test("ids are deterministic, differ by scope, and keep the importer's shape", () => {
  assert.equal(makeId("skills", ["TypeScript", "", "user-stated x"]), makeId("skills", ["TypeScript", "", "user-stated x"]));
  assert.notEqual(makeId("skills", ["TypeScript", "", "a"]), makeId("skills", ["TypeScript", "", "b"]));
  assert.match(makeId("experiences", ["x"]), /^experiences-[0-9a-f]{12}$/);
});
