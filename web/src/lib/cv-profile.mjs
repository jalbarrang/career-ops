/**
 * Editing model for the Master Career Profile (`data/career-profile.yml`).
 *
 * The profile is the record-everything layer: facts with the source line they
 * came from, and a review status. `cv.md` stays the master document and the
 * importer (`career-profile.mjs import`) stays the only thing that extracts
 * FROM it — this module covers what the importer has no command for: a person
 * editing the library afterwards.
 *
 * Everything here is pure and immutable so the builder is a plain function of
 * its state, and so `node --test` can assert the schema's rules without a
 * browser. The WRITE path (validate with the core's own `validate` command,
 * then back up and replace atomically) lives in the route, not here.
 *
 * Two invariants the rest of the system depends on:
 *
 *   - `evidence` is never rewritten by an edit. `quote` is the source line and
 *     `text` is the wording; keeping them apart is what lets the importer
 *     re-identify an entry by its evidence on the next import, so a reworded
 *     fact survives instead of being duplicated. A fact authored here carries
 *     `source: "user-stated {date}"` with its own text as the quote.
 *   - ids are permanent. Renaming a fact does not mint a new id, and merging
 *     existing entries keeps theirs.
 *
 * Plain .mjs, no node built-ins and no `@/` aliases: the builder component
 * imports it directly, and `node --test` does too.
 */

/** Sections that hold facts directly. */
export const FLAT_SECTIONS = ["summary", "certifications", "skills"];

/** Sections that hold entries, each with its own facts. */
export const ENTITY_SECTIONS = ["experiences", "projects", "education"];

/** Import order the importer uses; the builder renders in the same order. */
export const PROFILE_SECTIONS = ["summary", "experiences", "projects", "education", "certifications", "skills"];

export const STATUSES = ["needs_review", "verified"];

/**
 * A schema-v1 profile with no content. The importer's own `readProfile()`
 * starts from exactly this shape for a file that does not exist yet.
 */
export function emptyProfile() {
  return {
    schema_version: 1,
    candidate: {},
    summary: [],
    experiences: [],
    projects: [],
    education: [],
    certifications: [],
    skills: [],
  };
}

/**
 * Coerce a parsed YAML document into the shape the builder renders.
 *
 * A profile written by hand (or by an older importer) can be missing sections
 * entirely; rendering it would otherwise crash on `profile.skills.map`. Missing
 * values are filled, and anything present is left exactly as it is — this is a
 * read convenience, never a migration.
 *
 * @param {unknown} profile
 */
export function ensureShape(profile) {
  const base = emptyProfile();
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return base;
  const source = /** @type {Record<string, unknown>} */ (profile);
  const shaped = { ...base, ...source, schema_version: 1 };
  shaped.candidate = source.candidate && typeof source.candidate === "object" && !Array.isArray(source.candidate) ? source.candidate : {};
  for (const section of PROFILE_SECTIONS) {
    shaped[section] = Array.isArray(source[section]) ? source[section] : [];
  }
  return shaped;
}

/**
 * Deterministic id in the same `<kind>-<hex>` shape the importer's stableId()
 * produces.
 *
 * NOT the same hash: the importer uses sha256 from node:crypto, and this module
 * is imported by a browser component, where that built-in does not exist. The
 * ids are opaque to every consumer (`validateProfile` only requires uniqueness,
 * and `profile-cv-selection` passes them through), and the importer re-identifies
 * entries by EVIDENCE rather than id, so the two schemes coexist and neither
 * needs to recompute the other's.
 *
 * @param {string} kind
 * @param {string[]} parts
 * @returns {string}
 */
export function makeId(kind, parts = []) {
  let hash = 0x811c9dc5;
  const input = parts.join("\u0000");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // A second, differently-seeded pass keeps short inputs from colliding as
  // readily as a single 32-bit FNV run would.
  let second = 0x1b873593;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    second ^= input.charCodeAt(i);
    second = Math.imul(second, 0x85ebca6b) >>> 0;
  }
  return `${kind}-${hash.toString(16).padStart(8, "0")}${second.toString(16).padStart(4, "0").slice(0, 4)}`;
}

/**
 * Evidence for a fact the user typed here, rather than one imported from cv.md.
 * The schema wants a non-empty source, a positive line and a quote; the honest
 * values are "they said so, on this date" and their own words.
 */
export function userEvidence(text, date) {
  return { source: `user-stated ${date}`, line: 1, quote: text };
}

/** @param {string} text */
export function cleanText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function sectionItems(profile, section) {
  const items = profile?.[section];
  return Array.isArray(items) ? items : [];
}

/**
 * The facts of one scope: a flat section's list, or one entry's nested list.
 * `entryId` is ignored for flat sections.
 */
function factsOf(profile, section, entryId) {
  if (FLAT_SECTIONS.includes(section)) return sectionItems(profile, section);
  const entry = sectionItems(profile, section).find((item) => item?.id === entryId);
  return Array.isArray(entry?.facts) ? entry.facts : [];
}

/**
 * Apply a change only to the targeted scope, leaving every other section (and
 * any field this module does not know about) untouched.
 */
function withFacts(profile, section, entryId, transform) {
  const next = { ...profile };
  if (FLAT_SECTIONS.includes(section)) {
    next[section] = transform(sectionItems(profile, section));
    return next;
  }
  next[section] = sectionItems(profile, section).map((entry) =>
    entry?.id === entryId ? { ...entry, facts: transform(Array.isArray(entry.facts) ? entry.facts : []) } : entry,
  );
  return next;
}

/**
 * Add a fact to a section (flat) or to one entry of an entity section.
 *
 * A fact identical to one already in the same scope is not added twice: the
 * importer de-duplicates the same way, and two identical lines in a library are
 * noise, not two facts. The caller is told which happened.
 *
 * @param {object} profile
 * @param {{ section: string, entryId?: string | null, text: string, date: string }} params
 * @returns {{ profile: object, fact: object | null, added: boolean, reason?: string }}
 */
export function addFact(profile, { section, entryId = null, text, date }) {
  if (!PROFILE_SECTIONS.includes(section)) return { profile, fact: null, added: false, reason: "unknown section" };
  if (!FLAT_SECTIONS.includes(section) && !sectionItems(profile, section).some((entry) => entry?.id === entryId)) {
    return { profile, fact: null, added: false, reason: "unknown entry" };
  }
  const clean = cleanText(text);
  if (!clean) return { profile, fact: null, added: false, reason: "empty" };

  const existing = factsOf(profile, section, entryId);
  if (existing.some((fact) => cleanText(fact?.text).toLowerCase() === clean.toLowerCase())) {
    return { profile, fact: null, added: false, reason: "duplicate" };
  }

  const parentLabel = FLAT_SECTIONS.includes(section)
    ? ""
    : String(sectionItems(profile, section).find((entry) => entry?.id === entryId)?.label ?? "");
  const fact = {
    id: makeId(section, [clean, parentLabel, `user-stated ${date}`]),
    text: clean,
    review_status: "verified",
    evidence: userEvidence(clean, date),
  };
  return { profile: withFacts(profile, section, entryId, (facts) => [...facts, fact]), fact, added: true };
}

/**
 * Reword a fact. Never touches its evidence or its id.
 *
 * @param {object} profile
 * @param {{ section: string, entryId?: string | null, factId: string, text: string }} params
 */
export function updateFactText(profile, { section, entryId = null, factId, text }) {
  const clean = cleanText(text);
  if (!clean) return profile;
  return withFacts(profile, section, entryId, (facts) => facts.map((fact) => (fact.id === factId ? { ...fact, text: clean } : fact)));
}

/**
 * Flip `needs_review` / `verified`. Anything else is ignored, not coerced.
 *
 * @param {object} profile
 * @param {{ section: string, entryId?: string | null, factId: string, status: string }} params
 */
export function setFactStatus(profile, { section, entryId = null, factId, status }) {
  if (!STATUSES.includes(status)) return profile;
  return withFacts(profile, section, entryId, (facts) => facts.map((fact) => (fact.id === factId ? { ...fact, review_status: status } : fact)));
}

/**
 * @param {object} profile
 * @param {{ section: string, entryId?: string | null, factId: string }} params
 */
export function removeFact(profile, { section, entryId = null, factId }) {
  return withFacts(profile, section, entryId, (facts) => facts.filter((fact) => fact.id !== factId));
}

/**
 * Move a fact within its own scope (one flat section, or one entry's facts).
 *
 * @param {object} profile
 * @param {{ section: string, entryId?: string | null, factId: string, direction: "up" | "down" }} params
 */
export function moveFact(profile, { section, entryId = null, factId, direction }) {
  const shift = direction === "up" ? -1 : 1;
  return withFacts(profile, section, entryId, (facts) => {
    const from = facts.findIndex((fact) => fact.id === factId);
    const to = from + shift;
    if (from === -1 || to < 0 || to >= facts.length) return facts;
    const next = [...facts];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
  });
}

/**
 * Add an entry to an entity section. The label is the entry's identity for a
 * human ("Series Entertainment — Senior Full Stack Engineer"); the importer's
 * own labels are whatever its conservative parser found, so a builder-made
 * entry is how a role line and a date range become one entry instead of three.
 */
export function addEntry(profile, { section, label, date }) {
  if (!ENTITY_SECTIONS.includes(section)) return { profile, entry: null, added: false, reason: "not an entry section" };
  const clean = cleanText(label);
  if (!clean) return { profile, entry: null, added: false, reason: "empty" };
  const entries = sectionItems(profile, section);
  if (entries.some((entry) => cleanText(entry?.label).toLowerCase() === clean.toLowerCase())) {
    return { profile, entry: null, added: false, reason: "duplicate" };
  }
  const entry = {
    id: makeId(section, [clean, `user-stated ${date}`]),
    label: clean,
    review_status: "verified",
    evidence: userEvidence(clean, date),
    facts: [],
  };
  return { profile: { ...profile, [section]: [...entries, entry] }, entry, added: true };
}

export function updateEntryLabel(profile, { section, entryId, label }) {
  const clean = cleanText(label);
  if (!clean) return profile;
  return {
    ...profile,
    [section]: sectionItems(profile, section).map((entry) => (entry?.id === entryId ? { ...entry, label: clean } : entry)),
  };
}

/** Drop an entry and its facts. The caller confirms first — nothing here is undoable. */
export function removeEntry(profile, { section, entryId }) {
  return { ...profile, [section]: sectionItems(profile, section).filter((entry) => entry?.id !== entryId) };
}

export function moveEntry(profile, { section, entryId, direction }) {
  const shift = direction === "up" ? -1 : 1;
  const entries = sectionItems(profile, section);
  const from = entries.findIndex((entry) => entry?.id === entryId);
  const to = from + shift;
  if (from === -1 || to < 0 || to >= entries.length) return profile;
  const next = [...entries];
  [next[from], next[to]] = [next[to], next[from]];
  return { ...profile, [section]: next };
}

/**
 * Pull the error lines out of `career-profile.mjs validate` output.
 *
 * The command prints `Invalid profile:` (or `Valid Master Career Profile: <path>`)
 * and then one `- <error>` line per problem, on stderr or stdout depending on
 * the outcome. Reading only the `- ` lines keeps the parse independent of which
 * stream carried them and of the heading's wording.
 *
 * @param {string} [output]
 * @returns {string[]}
 */
export function parseValidationErrors(output = "") {
  return String(output)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line !== "");
}

/**
 * Per-section totals for the nav: entries for entity sections, facts for flat
 * ones, plus the fact count behind each entry, which is what tells an empty
 * entry from a populated one.
 */
export function profileCounts(profile) {
  const shaped = ensureShape(profile);
  /** @type {Record<string, { entries: number, facts: number }>} */
  const counts = {};
  for (const section of PROFILE_SECTIONS) {
    const items = sectionItems(shaped, section);
    if (FLAT_SECTIONS.includes(section)) {
      counts[section] = { entries: 0, facts: items.length };
    } else {
      counts[section] = {
        entries: items.length,
        facts: items.reduce((total, entry) => total + (Array.isArray(entry?.facts) ? entry.facts.length : 0), 0),
      };
    }
  }
  return counts;
}

export function totalFacts(profile) {
  return Object.values(profileCounts(profile)).reduce((total, count) => total + count.facts, 0);
}

/**
 * Facts that were imported from cv.md but never reviewed. Surfaced so a library
 * that is mostly `needs_review` is not mistaken for a reviewed one.
 */
export function unverifiedCount(profile) {
  const shaped = ensureShape(profile);
  let count = 0;
  for (const section of PROFILE_SECTIONS) {
    const items = sectionItems(shaped, section);
    const facts = FLAT_SECTIONS.includes(section) ? items : items.flatMap((entry) => (Array.isArray(entry?.facts) ? entry.facts : []));
    for (const fact of facts) if (fact?.review_status !== "verified") count += 1;
  }
  return count;
}
