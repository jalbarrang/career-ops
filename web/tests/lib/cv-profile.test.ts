import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addCompany,
  addEntry,
  addFact,
  addRole,
  allRoles,
  emptyProfile,
  formatPeriod,
  parsePeriod,
  ensureShape,
  factsOf,
  makeId,
  makeUniqueId,
  moveCompany,
  moveFact,
  moveRole,
  parseValidationErrors,
  profileCounts,
  removeCompany,
  removeFact,
  removeRole,
  setFactStatus,
  totalFacts,
  unverifiedCount,
  updateCompanyName,
  updateEntryLabel,
  updateFactText,
  updateRoleField,
  userEvidence,
} from "../../src/lib/cv-profile.ts";

const DATE = "2026-11-02";

/** One employer, one role, ready for fact tests. */
function withCompany() {
  const added = addCompany(emptyProfile(), { name: "Acme Inc.", date: DATE });
  const role = addRole(added.profile, { companyId: added.company!.id, name: "Senior Engineer", date: DATE });
  return { profile: role.profile, companyId: added.company!.id, roleId: role.role!.id };
}

test("a new profile is schema v2 with every section present", () => {
  const profile = emptyProfile();
  assert.equal(profile.schema_version, 2);
  for (const section of ["summary", "experiences", "projects", "education", "certifications", "skills"]) {
    assert.deepEqual(profile[section], []);
  }
});

test("a company needs a name, and the name is unique", () => {
  const first = addCompany(emptyProfile(), { name: "  Acme Inc.  ", date: DATE });
  assert.equal(first.added, true);
  assert.equal(first.company!.company.name, "Acme Inc."); // trimmed
  assert.match(first.company!.id, /^experiences-[0-9a-f]{12}$/);
  assert.deepEqual(first.company!.company.evidence, { source: `user-stated ${DATE}`, line: 1, quote: "Acme Inc." });

  const duplicate = addCompany(first.profile, { name: "acme inc.", date: DATE });
  assert.equal(duplicate.added, false);
  assert.equal(duplicate.reason, "duplicate");
  assert.equal(addCompany(emptyProfile(), { name: "   ", date: DATE }).reason, "empty");
});

test("roles nest under their company and carry their own fields", () => {
  const { profile, companyId, roleId } = withCompany();
  assert.equal(profile.experiences.length, 1);
  assert.equal(profile.experiences[0].roles.length, 1);

  const named = updateRoleField(profile, { companyId, roleId, field: "period", value: "2024 – 2026" });
  assert.equal(named.experiences[0].roles[0].period, "2024 – 2026");

  const located = updateRoleField(named, { companyId, roleId, field: "location", value: "Remote" });
  assert.equal(located.experiences[0].roles[0].location, "Remote");

  // Clearing removes the key, so a payload builder can tell "not provided" from "empty".
  const cleared = updateRoleField(located, { companyId, roleId, field: "location", value: "  " });
  assert.equal("location" in cleared.experiences[0].roles[0], false);

  // A field the CV never renders is refused rather than stored.
  const bogus = updateRoleField(profile, { companyId, roleId, field: "colour", value: "green" });
  assert.equal("colour" in bogus.experiences[0].roles[0], false);
});

test("a second role on the same company is what a promotion looks like", () => {
  const { profile, companyId } = withCompany();
  const second = addRole(profile, { companyId, name: "Engineer", date: DATE });
  assert.equal(second.added, true);

  let next = updateRoleField(second.profile, { companyId, roleId: second.role!.id, field: "period", value: "2021 – 2023" });
  const roles = next.experiences[0].roles;
  assert.deepEqual(roles.map((role) => role.name), ["Senior Engineer", "Engineer"]);
  assert.deepEqual(roles.map((role) => role.period ?? null), [null, "2021 – 2023"]);

  // Moving the newer role below the older one is a plain array swap inside the company.
  next = moveRole(next, { companyId, roleId: second.role!.id, direction: "up" });
  assert.deepEqual(next.experiences[0].roles.map((role) => role.name), ["Engineer", "Senior Engineer"]);

  // Past the top is a no-op, not a wrap-around.
  const same = moveRole(next, { companyId, roleId: second.role!.id, direction: "up" });
  assert.deepEqual(same.experiences[0].roles.map((role) => role.name), ["Engineer", "Senior Engineer"]);
});

test("a role with no title is allowed, because the importer meets blocks without one", () => {
  const added = addCompany(emptyProfile(), { name: "Acme", date: DATE });
  const role = addRole(added.profile, { companyId: added.company!.id, date: DATE });
  assert.equal(role.added, true);
  assert.equal(role.role!.name, "");
  assert.deepEqual(role.role!.facts, []);
});

test("adding a role to a company that does not exist adds nothing", () => {
  const { profile } = withCompany();
  const result = addRole(profile, { companyId: "experiences-nope", date: DATE });
  assert.equal(result.added, false);
  assert.equal(result.reason, "unknown company");
});

test("facts live in their own scope: a role, a labelled entry, or a flat section", () => {
  const { profile, companyId, roleId } = withCompany();
  const scope = { section: "experiences", companyId, roleId };

  const added = addFact(profile, { ...scope, text: "  Shipped the editor.  ", date: DATE });
  assert.equal(added.added, true);
  assert.equal(added.fact!.text, "Shipped the editor.");
  assert.equal(added.fact!.review_status, "verified");
  assert.deepEqual(added.fact!.evidence, { source: `user-stated ${DATE}`, line: 1, quote: "Shipped the editor." });
  assert.deepEqual(factsOf(added.profile, scope).map((fact) => fact.text), ["Shipped the editor."]);

  const flat = addFact(emptyProfile(), { section: "skills", text: "TypeScript", date: DATE });
  assert.equal(flat.added, true);
  assert.equal(flat.profile.skills[0].text, "TypeScript");
});

test("the same wording under two roles is two facts, but twice in one scope is a duplicate", () => {
  const { profile, companyId, roleId } = withCompany();
  const second = addRole(profile, { companyId, name: "Engineer", date: DATE });
  const first = addFact(second.profile, { section: "experiences", companyId, roleId, text: "Led the cell.", date: DATE });
  const twice = addFact(first.profile, { section: "experiences", companyId, roleId, text: "  led the cell. ", date: DATE });
  assert.equal(twice.added, false);
  assert.equal(twice.reason, "duplicate");

  const other = addFact(first.profile, { section: "experiences", companyId, roleId: second.role!.id, text: "Led the cell.", date: DATE });
  assert.equal(other.added, true);
  assert.equal(other.profile.experiences[0].roles[0].facts.length, 1);
  assert.equal(other.profile.experiences[0].roles[1].facts.length, 1);
});

test("rewording a fact keeps its id and its evidence — that is what re-import matches on", () => {
  const { profile, companyId, roleId } = withCompany();
  const scope = { section: "experiences", companyId, roleId };
  const added = addFact(profile, { ...scope, text: "Original wording", date: DATE });
  const edited = updateFactText(added.profile, { ...scope, factId: added.fact!.id, text: "Sharper wording" });

  const fact = edited.experiences[0].roles[0].facts[0];
  assert.equal(fact.text, "Sharper wording");
  assert.equal(fact.id, added.fact!.id);
  assert.deepEqual(fact.evidence, userEvidence("Original wording", DATE));

  const blank = updateFactText(edited, { ...scope, factId: fact.id, text: "   " });
  assert.equal(blank.experiences[0].roles[0].facts[0].text, "Sharper wording");
});

test("review status accepts only the two values the schema knows", () => {
  const { profile, companyId, roleId } = withCompany();
  const scope = { section: "experiences", companyId, roleId };
  const added = addFact(profile, { ...scope, text: "Shipped it.", date: DATE });

  const flipped = setFactStatus(added.profile, { ...scope, factId: added.fact!.id, status: "needs_review" });
  assert.equal(flipped.experiences[0].roles[0].facts[0].review_status, "needs_review");

  // A typo must not reach the file, where the core validator would reject it.
  const bogus = setFactStatus(flipped, { ...scope, factId: added.fact!.id, status: "approved" });
  assert.equal(bogus.experiences[0].roles[0].facts[0].review_status, "needs_review");
});

test("removing and reordering facts stays inside one role", () => {
  const { profile, companyId, roleId } = withCompany();
  const second = addRole(profile, { companyId, name: "Engineer", date: DATE });
  const scope = { section: "experiences", companyId, roleId };
  const one = addFact(second.profile, { ...scope, text: "First", date: DATE });
  const two = addFact(one.profile, { ...scope, text: "Second", date: DATE });
  const otherRole = addFact(two.profile, { section: "experiences", companyId, roleId: second.role!.id, text: "Elsewhere", date: DATE });

  const moved = moveFact(otherRole.profile, { ...scope, factId: two.fact!.id, direction: "up" });
  assert.deepEqual(moved.experiences[0].roles[0].facts.map((fact) => fact.text), ["Second", "First"]);
  assert.equal(moved.experiences[0].roles[1].facts[0].text, "Elsewhere");

  const removed = removeFact(moved, { ...scope, factId: one.fact!.id });
  assert.deepEqual(removed.experiences[0].roles[0].facts.map((fact) => fact.text), ["Second"]);
  assert.equal(removed.experiences[0].roles[1].facts.length, 1);
});

test("removing a company takes its roles and facts with it", () => {
  const { profile, companyId, roleId } = withCompany();
  const withFact = addFact(profile, { section: "experiences", companyId, roleId, text: "Shipped it.", date: DATE });
  const removed = removeCompany(withFact.profile, { companyId });
  assert.equal(removed.experiences.length, 0);

  // And a role removal leaves the company standing.
  const roleRemoved = removeRole(withFact.profile, { companyId, roleId });
  assert.equal(roleRemoved.experiences.length, 1);
  assert.equal(roleRemoved.experiences[0].roles.length, 0);
});

test("renaming a company and reordering companies are plain list operations", () => {
  const first = addCompany(emptyProfile(), { name: "Acme", date: DATE });
  const second = addCompany(first.profile, { name: "Beta", date: DATE });
  const renamed = updateCompanyName(second.profile, { companyId: first.company!.id, name: "Acme Holdings" });
  assert.deepEqual(renamed.experiences.map((company) => company.company.name), ["Acme Holdings", "Beta"]);

  const moved = moveCompany(renamed, { companyId: second.company!.id, direction: "up" });
  assert.deepEqual(moved.experiences.map((company) => company.company.name), ["Beta", "Acme Holdings"]);
});

test("labelled entries (projects/education) keep their v1 shape and their own facts", () => {
  const added = addEntry(emptyProfile(), { section: "projects", label: "FraudShield", date: DATE });
  assert.equal(added.added, true);
  assert.equal(added.entry!.label, "FraudShield");

  const withFact = addFact(added.profile, { section: "projects", entryId: added.entry!.id, text: "Detected fraud in real time.", date: DATE });
  assert.equal(withFact.added, true);
  assert.equal(withFact.profile.projects[0].facts.length, 1);

  const renamed = updateEntryLabel(withFact.profile, { section: "projects", entryId: added.entry!.id, label: "FraudShield OSS" });
  assert.equal(renamed.projects[0].label, "FraudShield OSS");
  // A duplicate label in the same section is refused, matching the importer's dedupe.
  assert.equal(addEntry(renamed, { section: "projects", label: "fraudshield oss", date: DATE }).reason, "duplicate");
});

test("counts separate companies, roles and facts", () => {
  const { profile, companyId, roleId } = withCompany();
  const second = addRole(profile, { companyId, name: "Engineer", date: DATE });
  const withFacts = addFact(second.profile, { section: "experiences", companyId, roleId, text: "One", date: DATE });
  const final = addFact(withFacts.profile, { section: "skills", text: "TypeScript", date: DATE });

  const counts = profileCounts(final.profile);
  assert.deepEqual(counts.experiences, { entries: 1, roles: 2, facts: 1 });
  assert.equal(counts.skills.facts, 1);
  assert.equal(totalFacts(final.profile), 2);
});

test("unverified counts facts that are not verified, wherever they live", () => {
  const imported = {
    ...emptyProfile(),
    skills: [{ id: "skills-a", text: "a", review_status: "needs_review", evidence: userEvidence("a", DATE) }],
    experiences: [
      {
        id: "experiences-a",
        company: { name: "Acme", evidence: userEvidence("Acme", DATE) },
        roles: [{ id: "experiences-r", name: "Engineer", review_status: "verified", evidence: userEvidence("Engineer", DATE), facts: [
          { id: "experiences-f", text: "built", review_status: "needs_review", evidence: userEvidence("built", DATE) },
        ] }],
      },
    ],
  };
  assert.equal(unverifiedCount(imported), 2);
});

test("allRoles flattens companies so a picker can name one role", () => {
  const { profile, companyId } = withCompany();
  const second = addRole(profile, { companyId, name: "Engineer", date: DATE });
  const flat = allRoles(second.profile);
  assert.equal(flat.length, 2);
  assert.equal(flat[0].company.company.name, "Acme Inc.");
  assert.deepEqual(flat.map(({ role }) => role.name), ["Senior Engineer", "Engineer"]);
});

test("a profile with missing sections is rendered, not crashed on or 'migrated'", () => {
  const partial = ensureShape({ schema_version: 2, candidate: { full_name: "Juan" }, summary: [{ id: "summary-1", text: "x" }] });
  assert.equal(partial.experiences.length, 0);
  assert.equal(partial.summary.length, 1);
  assert.deepEqual(partial.candidate, { full_name: "Juan" });
  assert.equal(ensureShape(null).schema_version, 2);

  // A company written without a `company` mapping or `roles` list still renders.
  const messy = ensureShape({ experiences: [{ id: "c1" }] });
  assert.deepEqual(messy.experiences[0].company, { name: "" });
  assert.deepEqual(messy.experiences[0].roles, []);
});

test("the core's validation output is parsed without depending on its heading wording", () => {
  assert.deepEqual(parseValidationErrors("Invalid profile:\n- schema_version must be 2\n- summary must be a list\n"), [
    "schema_version must be 2",
    "summary must be a list",
  ]);
  assert.deepEqual(parseValidationErrors("Valid Master Career Profile: /tmp/x/data/career-profile.yml\n"), []);
  assert.deepEqual(parseValidationErrors(""), []);
});

test("ids are deterministic, differ by scope, and keep the importer's shape", () => {
  assert.equal(makeId("experiences", ["TypeScript", "", "user-stated x"]), makeId("experiences", ["TypeScript", "", "user-stated x"]));
  assert.notEqual(makeId("experiences", ["TypeScript", "", "a"]), makeId("experiences", ["TypeScript", "", "b"]));
  assert.match(makeId("experiences", ["x"]), /^experiences-[0-9a-f]{12}$/);
});

test("two untitled roles added to one company on the same day get distinct ids", () => {
  // The builder's "Add role" button sends no name, so the parts handed to
  // `makeId` are identical for the second role — which used to reproduce the
  // role id, and with it the keyed-`{#each}` duplicate key crash.
  const added = addCompany(emptyProfile(), { name: "Acme", date: DATE });
  const first = addRole(added.profile, { companyId: added.company!.id, date: DATE });
  const second = addRole(first.profile, { companyId: added.company!.id, date: DATE });
  const third = addRole(second.profile, { companyId: added.company!.id, date: DATE });

  const ids = third.profile.experiences[0].roles.map((role) => role.id);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  // The first of them still carries the importer's id shape.
  assert.match(ids[0], /^experiences-[0-9a-f]{12}$/);
});

test("ids are unique across the whole profile, as the core validator requires", () => {
  const added = addCompany(emptyProfile(), { name: "Acme", date: DATE });
  const role = addRole(added.profile, { companyId: added.company!.id, date: DATE });
  const second = addRole(role.profile, { companyId: added.company!.id, date: DATE });

  // The same wording under two UNNAMED roles of one company hashes to the same
  // parts too, so facts need the same guarantee the roles just got.
  const one = addFact(second.profile, { section: "experiences", companyId: added.company!.id, roleId: role.role!.id, text: "Led the cell.", date: DATE });
  const two = addFact(one.profile, { section: "experiences", companyId: added.company!.id, roleId: second.role!.id, text: "Led the cell.", date: DATE });

  const ids = [];
  for (const company of two.profile.experiences) {
    ids.push(company.id);
    for (const nested of company.roles ?? []) {
      ids.push(nested.id);
      for (const fact of nested.facts ?? []) ids.push(fact.id);
    }
  }
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, ids.length);
});

test("makeUniqueId leaves a free id alone and only salts a taken one", () => {
  const profile = emptyProfile();
  const base = makeId("skills", ["TypeScript"]);
  assert.equal(makeUniqueId(profile, "skills", ["TypeScript"]), base);

  const taken = { ...profile, skills: [{ id: base }] };
  const next = makeUniqueId(taken, "skills", ["TypeScript"]);
  assert.notEqual(next, base);
  assert.match(next, /^skills-[0-9a-f]{12}$/);
});

test('a period parses into start and end, whichever month naming the CV uses', () => {
  assert.deepEqual(parsePeriod('March 2025 - September 2026'), { start: { year: 2025, month: 3 }, end: { year: 2026, month: 9 }, present: false });
  assert.deepEqual(parsePeriod('Mar 2025 – Sep 2026'), { start: { year: 2025, month: 3 }, end: { year: 2026, month: 9 }, present: false });
  assert.deepEqual(parsePeriod('June 2016 - December 2021'), { start: { year: 2016, month: 6 }, end: { year: 2021, month: 12 }, present: false });
  // Spanish/Portuguese abbreviations are read too, so an imported CV in those
  // languages still opens in the picker instead of falling back to raw text.
  assert.deepEqual(parsePeriod('Ago 2021 – Dez 2022'), { start: { year: 2021, month: 8 }, end: { year: 2022, month: 12 }, present: false });
});

test('a year-only period, a single date, and "present" all parse', () => {
  assert.deepEqual(parsePeriod('2025 – 2026'), { start: { year: 2025, month: null }, end: { year: 2026, month: null }, present: false });
  assert.deepEqual(parsePeriod('2025'), { start: { year: 2025, month: null }, end: null, present: false });
  assert.deepEqual(parsePeriod('Mar 2025'), { start: { year: 2025, month: 3 }, end: null, present: false });
  assert.deepEqual(parsePeriod('Mar 2025 – Present'), { start: { year: 2025, month: 3 }, end: null, present: true });
  assert.deepEqual(parsePeriod('2025 to 2026'), { start: { year: 2025, month: null }, end: { year: 2026, month: null }, present: false });
});

test('a value the picker cannot read returns null, so the builder keeps a text box', () => {
  assert.equal(parsePeriod('last summer'), null);
  assert.equal(parsePeriod('Clients: SoftPatagonia, Valueinnova LLC'), null);
  assert.equal(parsePeriod(''), null);
  assert.equal(parsePeriod('   '), null);
  assert.equal(parsePeriod(undefined), null);
});

test('formatPeriod writes the canonical string the two consumers expect', () => {
  // Start first, English month, en dash, no trailing punctuation.
  assert.equal(formatPeriod({ startMonth: 3, startYear: 2025, endMonth: 9, endYear: 2026 }), 'Mar 2025 – Sep 2026');
  assert.equal(formatPeriod({ startMonth: 3, startYear: 2025, present: true }), 'Mar 2025 – Present');
  assert.equal(formatPeriod({ startYear: 2025, endYear: 2026 }), '2025 – 2026');
  assert.equal(formatPeriod({ startYear: 2025 }), '2025');
});

test('formatPeriod refuses a half-typed year instead of blanking the stored period', () => {
  assert.equal(formatPeriod({ startMonth: 3, startYear: 20 }), null);
  assert.equal(formatPeriod({ startMonth: 3, startYear: null }), null);
  assert.equal(formatPeriod({}), null);
  // A month without a year is not a date.
  assert.equal(formatPeriod({ startMonth: 3, endMonth: 9, endYear: 2026 }), null);
});

test('what the picker writes parses back to the same dates', () => {
  for (const value of [
    { startMonth: 3, startYear: 2025, endMonth: 9, endYear: 2026 },
    { startMonth: 1, startYear: 2024, endMonth: 3, endYear: 2025 },
    { startMonth: 3, startYear: 2025, present: true },
    { startYear: 2016, endYear: 2021 },
  ]) {
    const written = formatPeriod(value);
    const reread = parsePeriod(written!);
    assert.notEqual(reread!, null, `${written} should parse back`);
    assert.equal(reread!.start.year, value.startYear);
    assert.equal(reread!.start.month, value.startMonth ?? null);
    assert.equal(reread!.present, Boolean(value.present));
    assert.equal(reread!.end?.year ?? null, value.present ? null : (value.endYear ?? null));
    // And it stays inside the length the importer classifies on.
    assert.ok(written!.length <= 40, `${written} is too long for the importer`);
  }
});
