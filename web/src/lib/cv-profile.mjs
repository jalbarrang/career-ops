/**
 * Editing model for the Master Career Profile (`data/career-profile.yml`).
 *
 * FORK: schema v2. An experience is a COMPANY holding a list of ROLES:
 *
 *   experiences:
 *     - company: { name, evidence }
 *       roles:
 *         - { id, name, period, location, review_status, evidence, facts[] }
 *
 * That is the shape the engine writes (fork/core/career-profile.mjs) and the
 * only shape its validator accepts, so everything here works on it: one card per
 * employer, roles nested under it, facts under the roles.
 *
 * The profile is the record-everything layer: facts with the source line they
 * came from, and a review status. `cv.md` stays the master document and the
 * importer stays the only thing that extracts FROM it — this module covers what
 * the importer has no command for: a person editing the library afterwards.
 *
 * Everything here is pure and immutable so the builder is a plain function of
 * its state, and so `node --test` can assert the schema's rules without a
 * browser. The WRITE path (validate with the core's own `validate` command,
 * then back up and replace atomically) lives in the route and
 * lib/server/profile-write.ts, not here.
 *
 * Two invariants the rest of the system depends on:
 *
 *   - `evidence` is never rewritten by an edit. `quote` is the source line and
 *     `text`/`name` is the wording; keeping them apart is what lets the importer
 *     re-identify a role by its evidence on the next import, so a reworded fact
 *     survives instead of being duplicated. Anything authored here carries
 *     `source: "user-stated {date}"` with its own text as the quote.
 *   - ids are permanent. Renaming a role or a company does not mint a new id,
 *     and a saved CV selection is bound to a role id.
 *
 * Plain .mjs, no node built-ins and no `@/` aliases: the builder component
 * imports it directly, and `node --test` does too.
 */

export const SCHEMA_VERSION = 2;

/** Sections that hold facts directly. */
export const FLAT_SECTIONS = ["summary", "certifications", "skills"];

/** Sections that hold labelled entries with their own facts. */
export const LABEL_SECTIONS = ["projects", "education"];

/** The only section with companies and roles. */
export const EXPERIENCE_SECTION = "experiences";

/** Editable fields on a role. `name` is the role title. */
export const ROLE_FIELDS = ["name", "period", "location"];

export const STATUSES = ["needs_review", "verified"];

/** Render order used by the builder's nav. */
export const PROFILE_SECTIONS = ["summary", EXPERIENCE_SECTION, "projects", "education", "certifications", "skills"];

/**
 * A schema-v2 profile with no content. Mirrors `emptyProfile()` in the engine's
 * lib/career-profile.mjs so a file created here is one the validator accepts.
 */
export function emptyProfile() {
  return {
    schema_version: SCHEMA_VERSION,
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
 * A profile written by hand (or by an older importer) can be missing sections;
 * rendering it would otherwise crash on `profile.skills.map`. Missing values are
 * filled and everything present is left exactly as it is — a read convenience,
 * never a migration.
 */
export function ensureShape(profile) {
  const base = emptyProfile();
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) return base;
  const source = profile;
  const shaped = { ...base, ...source, schema_version: SCHEMA_VERSION };
  shaped.candidate = source.candidate && typeof source.candidate === "object" && !Array.isArray(source.candidate) ? source.candidate : {};
  for (const section of PROFILE_SECTIONS) {
    shaped[section] = Array.isArray(source[section]) ? source[section] : [];
  }
  shaped.experiences = shaped.experiences.map((company) => ({
    ...company,
    company: company?.company && typeof company.company === "object" ? company.company : { name: "" },
    roles: Array.isArray(company?.roles) ? company.roles : [],
  }));
  return shaped;
}

/**
 * Deterministic id in the same `<kind>-<hex>` shape the importer produces.
 *
 * NOT the same hash: the importer uses sha256 from node:crypto, and this module
 * is imported by a browser component, where that built-in does not exist. The
 * ids are opaque to every consumer (`validateProfile` only requires uniqueness),
 * so the two schemes coexist and neither needs to recompute the other's.
 */
export function makeId(kind, parts = []) {
  let hash = 0x811c9dc5;
  const input = parts.join("\u0000");
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let second = 0x1b873593;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    second ^= input.charCodeAt(i);
    second = Math.imul(second, 0x85ebca6b) >>> 0;
  }
  return `${kind}-${hash.toString(16).padStart(8, "0")}${second.toString(16).padStart(4, "0").slice(0, 4)}`;
}

/** Evidence for something typed here, rather than imported from cv.md. */
export function userEvidence(text, date) {
  return { source: `user-stated ${date}`, line: 1, quote: text };
}

export function cleanText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

const items = (profile, section) => (Array.isArray(profile?.[section]) ? profile[section] : []);

/** Month labels the CV prints, and the picker offers. */
export const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// English, plus the Spanish and Portuguese abbreviations a CV written in those
// languages arrives with. The picker always writes the English form back, which
// is what the PDF's ordering guard understands.
const MONTH_INDEX = new Map([
  ["jan", 1], ["ene", 1], ["feb", 2], ["mar", 3], ["apr", 4], ["abr", 4], ["may", 5],
  ["jun", 6], ["jul", 7], ["aug", 8], ["ago", 8], ["sep", 9], ["set", 9], ["oct", 10],
  ["nov", 11], ["dec", 12], ["dic", 12], ["dez", 12],
]);

const MONTH_NAME = /\b([a-z\u00C0-\u024F]{3,9})\.?\s*$/i;
const SEPARATOR = /\s+-\s+|\s+to\s+/i;

/**
 * Read a stored period into the pieces the picker edits.
 *
 * The stored value is free text — it comes from cv.md, from the picker, or from
 * a hand-edit — and the PDF's reverse-chronological guard reads only its START,
 * so parse and format are both anchored on the start date. A value this cannot
 * read (a sentence, a stray company name, a bare year) returns null, and the
 * builder falls back to a plain text box rather than discarding what is there.
 *
 * @param {string} text
 * @returns {{ start: { year: number, month: number | null }, end: { year: number, month: number | null } | null, present: boolean } | null}
 */
export function parsePeriod(text) {
  const raw = String(text ?? "").replace(/[\u2010-\u2015]/g, "-").trim();
  if (!raw) return null;
  // "Currently working here" spelled any of the ways a CV does.
  const present = /\b(present|current|currently|now|today|actualidad|actualmente|hoy|atual|atualmente)\b/i.test(raw);

  const side = (value) => {
    const year = value.match(/\b(19|20)\d{2}\b/);
    if (!year) return null;
    const named = value.slice(0, year.index).match(MONTH_NAME);
    const key = named ? named[1].normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().slice(0, 3) : "";
    return { year: Number(year[0]), month: MONTH_INDEX.get(key) ?? null };
  };

  const parts = raw.split(SEPARATOR);
  const start = side(parts[0] ?? "");
  if (!start) return null;
  if (present) return { start, end: null, present: true };
  if (parts.length === 1) return { start, end: null, present: false };
  return { start, end: side(parts.slice(1).join(" ")), present: false };
}

/**
 * Compose the canonical period from picker values.
 *
 * Keeps the four rules two consumers depend on: start date FIRST (the PDF guard
 * reads only the start), a 4-digit year, English month abbreviations (so roles
 * in the same year compare by month), and no trailing period or semicolon —
 * which is also how the importer recognises a cv.md line as a period, along with
 * staying under 40 characters.
 *
 * Returns null when there is no usable start year, so a half-typed year never
 * overwrites a stored period.
 *
 * @param {{ startMonth?: number | null, startYear?: number | null, endMonth?: number | null, endYear?: number | null, present?: boolean }} value
 * @returns {string | null}
 */
export function formatPeriod(value = {}) {
  const asYear = (input) => (Number.isInteger(input) && input >= 1900 && input <= 2100 ? String(input) : null);
  const asMonth = (input) => (Number.isInteger(input) && input >= 1 && input <= 12 ? MONTH_LABELS[input - 1] : null);
  const side = (monthInput, yearInput) => {
    const year = asYear(yearInput);
    if (!year) return null;
    const month = asMonth(monthInput);
    return month ? `${month} ${year}` : year;
  };

  const start = side(value.startMonth, value.startYear);
  if (!start) return null;
  if (value.present) return `${start} – Present`;
  const end = side(value.endMonth, value.endYear);
  return end ? `${start} – ${end}` : start;
}

/**
 * The facts of one scope.
 *
 * A scope names where the facts live: `{ section: 'skills' }` for a flat
 * section, `{ section: 'experiences', companyId, roleId }` for a role, or
 * `{ section: 'projects', entryId }` for a labelled entry.
 */
export function factsOf(profile, scope = {}) {
  const { section } = scope;
  if (FLAT_SECTIONS.includes(section)) return items(profile, section);
  if (section === EXPERIENCE_SECTION) {
    const company = items(profile, section).find((item) => item?.id === scope.companyId);
    const role = (company?.roles ?? []).find((item) => item?.id === scope.roleId);
    return Array.isArray(role?.facts) ? role.facts : [];
  }
  if (LABEL_SECTIONS.includes(section)) {
    const entry = items(profile, section).find((item) => item?.id === scope.entryId);
    return Array.isArray(entry?.facts) ? entry.facts : [];
  }
  return [];
}

/** Apply a change only to the targeted scope, leaving everything else untouched. */
function withFacts(profile, scope, transform) {
  const { section } = scope;
  if (FLAT_SECTIONS.includes(section)) {
    return { ...profile, [section]: transform(items(profile, section)) };
  }
  if (section === EXPERIENCE_SECTION) {
    return {
      ...profile,
      [section]: items(profile, section).map((company) =>
        company?.id === scope.companyId
          ? {
              ...company,
              roles: (company.roles ?? []).map((role) =>
                role?.id === scope.roleId ? { ...role, facts: transform(Array.isArray(role.facts) ? role.facts : []) } : role,
              ),
            }
          : company,
      ),
    };
  }
  if (LABEL_SECTIONS.includes(section)) {
    return {
      ...profile,
      [section]: items(profile, section).map((entry) =>
        entry?.id === scope.entryId ? { ...entry, facts: transform(Array.isArray(entry.facts) ? entry.facts : []) } : entry,
      ),
    };
  }
  return profile;
}

/** Facts identical to one already in the same scope are not stored twice. */
function isDuplicate(facts, text) {
  const clean = cleanText(text).toLowerCase();
  return facts.some((fact) => cleanText(fact?.text).toLowerCase() === clean);
}

/**
 * @param {object} profile
 * @param {{ section: string, companyId?: string, roleId?: string, entryId?: string, text: string, date: string }} params
 * @returns {{ profile: object, fact: object | null, added: boolean, reason?: string }}
 */
export function addFact(profile, scope) {
  const { section, text, date } = scope;
  if (!PROFILE_SECTIONS.includes(section)) return { profile, fact: null, added: false, reason: "unknown section" };
  const clean = cleanText(text);
  if (!clean) return { profile, fact: null, added: false, reason: "empty" };

  const existing = factsOf(profile, scope);
  if (isDuplicate(existing, clean)) return { profile, fact: null, added: false, reason: "duplicate" };

  const parent = section === EXPERIENCE_SECTION
    ? String(items(profile, section).find((company) => company?.id === scope.companyId)?.roles?.find((role) => role?.id === scope.roleId)?.name ?? "")
    : String(items(profile, section).find((entry) => entry?.id === scope.entryId)?.label ?? "");
  const fact = {
    id: makeId(section, [clean, parent, `user-stated ${date}`]),
    text: clean,
    review_status: "verified",
    evidence: userEvidence(clean, date),
  };
  return { profile: withFacts(profile, scope, (facts) => [...facts, fact]), fact, added: true };
}

/**
 * Reword a fact. Never touches its evidence or its id.
 *
 * The scope names where the fact lives: a flat section, a role, or a labelled
 * entry. Only the ids for that scope are required.
 *
 * @param {{ section: string, companyId?: string, roleId?: string, entryId?: string, factId: string, text?: string, status?: string, direction?: string }} params
 */
export function updateFactText(profile, scope) {
  const { factId, text } = scope;
  const clean = cleanText(text);
  if (!clean) return profile;
  return withFacts(profile, scope, (facts) => facts.map((fact) => (fact.id === factId ? { ...fact, text: clean } : fact)));
}

/**
 * Flip `needs_review` / `verified`. Anything else is ignored, not coerced.
 *
 * @param {{ section: string, companyId?: string, roleId?: string, entryId?: string, factId: string, text?: string, status?: string, direction?: string }} params
 */
export function setFactStatus(profile, scope) {
  const { factId, status } = scope;
  if (!STATUSES.includes(status)) return profile;
  return withFacts(profile, scope, (facts) => facts.map((fact) => (fact.id === factId ? { ...fact, review_status: status } : fact)));
}

/**
 * Drop one fact from its scope.
 *
 * @param {{ section: string, companyId?: string, roleId?: string, entryId?: string, factId: string, text?: string, status?: string, direction?: string }} params
 */
export function removeFact(profile, scope) {
  const { factId } = scope;
  return withFacts(profile, scope, (facts) => facts.filter((fact) => fact.id !== factId));
}

/**
 * Move a fact within its own scope (one flat section, one role, or one entry).
 *
 * @param {{ section: string, companyId?: string, roleId?: string, entryId?: string, factId: string, direction: "up" | "down" }} params
 */
export function moveFact(profile, scope) {
  const { factId, direction } = scope;
  const shift = direction === "up" ? -1 : 1;
  return withFacts(profile, scope, (facts) => {
    const from = facts.findIndex((fact) => fact.id === factId);
    const to = from + shift;
    if (from === -1 || to < 0 || to >= facts.length) return facts;
    const next = [...facts];
    [next[from], next[to]] = [next[to], next[from]];
    return next;
  });
}

/**
 * Add a company to the experience list.
 *
 * A company with no name is refused: the name is the card's identity and the
 * validator requires it. Roles are added separately, so a company can exist
 * before its first role is typed.
 */
export function addCompany(profile, { name, date }) {
  const clean = cleanText(name);
  if (!clean) return { profile, company: null, added: false, reason: "empty" };
  const existing = items(profile, EXPERIENCE_SECTION);
  if (existing.some((company) => cleanText(company?.company?.name).toLowerCase() === clean.toLowerCase())) {
    return { profile, company: null, added: false, reason: "duplicate" };
  }
  const company = {
    id: makeId(EXPERIENCE_SECTION, [clean, `user-stated ${date}`]),
    company: { name: clean, evidence: userEvidence(clean, date) },
    roles: [],
  };
  return { profile: { ...profile, [EXPERIENCE_SECTION]: [...existing, company] }, company, added: true };
}

export function updateCompanyName(profile, { companyId, name }) {
  const clean = cleanText(name);
  if (!clean) return profile;
  return {
    ...profile,
    [EXPERIENCE_SECTION]: items(profile, EXPERIENCE_SECTION).map((company) =>
      company?.id === companyId
        ? { ...company, company: { ...company.company, name: clean } }
        : company,
    ),
  };
}

/** Drop a company and every role and fact under it. The caller confirms first. */
export function removeCompany(profile, { companyId }) {
  return { ...profile, [EXPERIENCE_SECTION]: items(profile, EXPERIENCE_SECTION).filter((company) => company?.id !== companyId) };
}

export function moveCompany(profile, { companyId, direction }) {
  return moveWithin(profile, EXPERIENCE_SECTION, companyId, direction);
}

/**
 * Add a role under a company. `name` may be empty: the importer meets blocks
 * with a company and dates but no title line, and the builder flags the empty
 * field rather than refusing to save.
 */
export function addRole(profile, { companyId, name = "", date }) {
  const company = items(profile, EXPERIENCE_SECTION).find((item) => item?.id === companyId);
  if (!company) return { profile, role: null, added: false, reason: "unknown company" };
  const clean = cleanText(name);
  const roles = Array.isArray(company.roles) ? company.roles : [];
  if (clean && roles.some((role) => cleanText(role?.name).toLowerCase() === clean.toLowerCase())) {
    return { profile, role: null, added: false, reason: "duplicate" };
  }
  const role = {
    id: makeId(EXPERIENCE_SECTION, [clean, company.company?.name ?? "", `user-stated ${date}`]),
    name: clean,
    review_status: "verified",
    evidence: userEvidence(clean || String(company.company?.name ?? ""), date),
    facts: [],
  };
  return {
    profile: {
      ...profile,
      [EXPERIENCE_SECTION]: items(profile, EXPERIENCE_SECTION).map((item) =>
        item?.id === companyId ? { ...item, roles: [...roles, role] } : item,
      ),
    },
    role,
    added: true,
  };
}

export function updateRoleField(profile, { companyId, roleId, field, value }) {
  if (!ROLE_FIELDS.includes(field)) return profile;
  const clean = cleanText(value);
  const companies = items(profile, EXPERIENCE_SECTION);
  if (!companies.some((company) => company?.id === companyId)) return profile;
  return {
    ...profile,
    [EXPERIENCE_SECTION]: companies.map((company) =>
      company?.id !== companyId
        ? company
        : {
            ...company,
            roles: (company.roles ?? []).map((role) => {
              if (role?.id !== roleId) return role;
              const next = { ...role };
              if (clean) next[field] = clean;
              else delete next[field];
              return next;
            }),
          },
    ),
  };
}

export function removeRole(profile, { companyId, roleId }) {
  return {
    ...profile,
    [EXPERIENCE_SECTION]: items(profile, EXPERIENCE_SECTION).map((company) =>
      company?.id === companyId ? { ...company, roles: (company.roles ?? []).filter((role) => role?.id !== roleId) } : company,
    ),
  };
}

export function moveRole(profile, { companyId, roleId, direction }) {
  const shift = direction === "up" ? -1 : 1;
  return {
    ...profile,
    [EXPERIENCE_SECTION]: items(profile, EXPERIENCE_SECTION).map((company) => {
      if (company?.id !== companyId) return company;
      const roles = [...(company.roles ?? [])];
      const from = roles.findIndex((role) => role?.id === roleId);
      const to = from + shift;
      if (from === -1 || to < 0 || to >= roles.length) return company;
      [roles[from], roles[to]] = [roles[to], roles[from]];
      return { ...company, roles };
    }),
  };
}

/** Rename a labelled entry (projects / education). */
export function updateEntryLabel(profile, { section, entryId, label }) {
  const clean = cleanText(label);
  if (!clean) return profile;
  return {
    ...profile,
    [section]: items(profile, section).map((entry) => (entry?.id === entryId ? { ...entry, label: clean } : entry)),
  };
}

export function addEntry(profile, { section, label, date }) {
  if (!LABEL_SECTIONS.includes(section)) return { profile, entry: null, added: false, reason: "not a labelled section" };
  const clean = cleanText(label);
  if (!clean) return { profile, entry: null, added: false, reason: "empty" };
  const entries = items(profile, section);
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

export function removeEntry(profile, { section, entryId }) {
  return { ...profile, [section]: items(profile, section).filter((entry) => entry?.id !== entryId) };
}

export function moveEntry(profile, { section, entryId, direction }) {
  return moveWithin(profile, section, entryId, direction);
}

function moveWithin(profile, section, id, direction) {
  const shift = direction === "up" ? -1 : 1;
  const list = [...items(profile, section)];
  const from = list.findIndex((item) => item?.id === id);
  const to = from + shift;
  if (from === -1 || to < 0 || to >= list.length) return profile;
  [list[from], list[to]] = [list[to], list[from]];
  return { ...profile, [section]: list };
}

/**
 * Pull the error lines out of `career-profile.mjs validate` output.
 *
 * The command prints `Invalid profile:` then one `- <error>` line per problem,
 * on stderr or stdout depending on the outcome. Reading only the `- ` lines
 * keeps the parse independent of which stream carried them.
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
 * Per-section totals for the nav: companies and roles for experiences, entries
 * for the labelled sections, facts for the flat ones.
 */
export function profileCounts(profile) {
  const shaped = ensureShape(profile);
  const counts = {};
  for (const section of PROFILE_SECTIONS) {
    if (section === EXPERIENCE_SECTION) {
      const companies = shaped.experiences;
      counts[section] = {
        entries: companies.length,
        roles: companies.reduce((total, company) => total + (company.roles?.length ?? 0), 0),
        facts: companies.reduce(
          (total, company) => total + (company.roles ?? []).reduce((inner, role) => inner + (role.facts?.length ?? 0), 0),
          0,
        ),
      };
    } else if (LABEL_SECTIONS.includes(section)) {
      const entries = shaped[section];
      counts[section] = { entries: entries.length, facts: entries.reduce((total, entry) => total + (entry.facts?.length ?? 0), 0) };
    } else {
      counts[section] = { entries: 0, facts: shaped[section].length };
    }
  }
  return counts;
}

export function totalFacts(profile) {
  return Object.values(profileCounts(profile)).reduce((total, count) => total + count.facts, 0);
}

/** Facts imported from cv.md but never reviewed, so a library is not mistaken for a reviewed one. */
export function unverifiedCount(profile) {
  const shaped = ensureShape(profile);
  let count = 0;
  const check = (fact) => {
    if (fact?.review_status !== "verified") count += 1;
  };
  for (const section of PROFILE_SECTIONS) {
    if (section === EXPERIENCE_SECTION) {
      for (const company of shaped.experiences) for (const role of company.roles ?? []) for (const fact of role.facts ?? []) check(fact);
    } else if (LABEL_SECTIONS.includes(section)) {
      for (const entry of shaped[section]) for (const fact of entry.facts ?? []) check(fact);
    } else {
      for (const fact of shaped[section]) check(fact);
    }
  }
  return count;
}

/**
 * Every role in the profile, flattened with the company it belongs to.
 *
 * CV generation and any picker work on roles, so this is the one place that
 * knows how to walk the nesting.
 */
export function allRoles(profile) {
  const shaped = ensureShape(profile);
  const roles = [];
  for (const company of shaped.experiences) {
    for (const role of company.roles ?? []) roles.push({ company, role });
  }
  return roles;
}
