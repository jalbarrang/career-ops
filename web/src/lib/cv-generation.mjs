/**
 * Turn a selection of career-profile facts into an HTML CV payload.
 *
 * The payload contract belongs to the core (`lib/cv-payload-schema.mjs`, and the
 * builders that enforce it), so this module only ASSEMBLES one: it never renders
 * and never decides whether the result is valid. `build-cv-html.mjs` does that,
 * and its rejection is what the generation screen reports.
 *
 * Two field-name traps this exists to close, both silent:
 *
 *   - config/profile.yml stores the candidate as `full_name`, while the CV
 *     template reads `candidate.name`. Passing the profile straight through
 *     renders a CV with no name on it.
 *   - an `experience` entry needs `company` AND `role` or the builder drops the
 *     whole entry (see ENTRY_FIELD_SPECS.html.experience.required). The importer
 *     gives entries only a free-text `label`, so anything unbound here is
 *     reported as a gap instead of vanishing from the PDF.
 *
 * Plain .mjs, no I/O: the route reads the files, node --test asserts the mapping.
 */

/** Candidate keys the CV template renders, mapped from config/profile.yml. */
export function candidateFromProfileConfig(profileConfig = {}) {
  const source = profileConfig && typeof profileConfig === "object" ? profileConfig : {};
  const candidate = source.candidate && typeof source.candidate === "object" ? source.candidate : source;
  const pick = (...keys) => {
    for (const key of keys) {
      const value = candidate[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return undefined;
  };

  const out = {
    // `full_name` is how config/profile.yml spells it; `name` is what the
    // template reads. Both are accepted, `name` wins when present.
    name: pick("name", "full_name"),
    title: pick("title"),
    email: pick("email"),
    phone: pick("phone"),
    location: pick("location"),
    linkedin: pick("linkedin"),
    github: pick("github"),
    portfolio: pick("portfolio", "website"),
  };
  for (const [key, value] of Object.entries(out)) {
    if (value === undefined) delete out[key];
  }
  return out;
}

/** Facts by id, from a flat section or every entry of an entity section. */
function factIndex(profile) {
  const index = new Map();
  const add = (fact) => {
    if (fact && typeof fact.id === "string") index.set(fact.id, fact);
  };
  for (const section of ["summary", "certifications", "skills"]) {
    for (const fact of Array.isArray(profile?.[section]) ? profile[section] : []) add(fact);
  }
  for (const section of ["experiences", "projects", "education"]) {
    for (const entry of Array.isArray(profile?.[section]) ? profile[section] : []) {
      for (const fact of Array.isArray(entry?.facts) ? entry.facts : []) add(fact);
    }
  }
  return index;
}

/**
 * @typedef {object} Selection
 * @property {string[]} [summaryIds]      facts from `summary`
 * @property {{ entryId: string, factIds: string[] }[]} [experiences]  in the order to render
 * @property {string[]} [skills]          facts from `skills`
 * @property {string[]} [projectIds]      entry ids from `projects`
 * @property {string[]} [educationIds]    entry ids from `education`
 * @property {string[]} [certificationIds]
 */

/**
 * Build the payload, plus everything the caller needs to warn about BEFORE it
 * ships: entries that cannot render, facts that are unverified or missing.
 *
 * Nothing is silently dropped from the payload it returns — a gap means the
 * entry is omitted, and the caller is told which ones and why, so the screen can
 * say "this role has no company yet" instead of the PDF quietly having 2 roles
 * where the user selected 3.
 *
 * @param {{ profile: object, candidate?: object, selection?: Selection, today?: string }} input
 */
export function buildCvPayload({ profile, candidate = {}, selection = {}, today = new Date().toISOString().slice(0, 10) }) {
  const facts = factIndex(profile);
  const gaps = [];
  const warnings = [];

  const textOf = (id) => {
    const fact = facts.get(id);
    if (!fact) return null;
    if (fact.review_status !== "verified") {
      warnings.push(`“${String(fact.text).slice(0, 60)}” is still marked needs review`);
    }
    return String(fact.text ?? "").trim() || null;
  };

  const summaryText = (selection.summaryIds ?? [])
    .map(textOf)
    .filter(Boolean)
    .join(" ");

  const experience = [];
  for (const picked of selection.experiences ?? []) {
    const entry = (profile?.experiences ?? []).find((item) => item?.id === picked.entryId);
    if (!entry) {
      gaps.push({ entryId: picked.entryId, reason: "entry no longer exists" });
      continue;
    }
    const missing = ["company", "role"].filter((field) => !entry[field]);
    if (missing.length > 0) {
      gaps.push({
        entryId: entry.id,
        label: entry.label,
        reason: `needs ${missing.join(" and ")} — it would not render`,
        missing,
      });
      continue;
    }
    const bullets = (picked.factIds ?? []).map(textOf).filter(Boolean);
    const item = { company: entry.company, role: entry.role, bullets };
    if (entry.location) item.location = entry.location;
    if (entry.dates) item.dates = entry.dates;
    experience.push(item);
  }

  const skills = (selection.skills ?? []).map(textOf).filter(Boolean);

  const projectEntries = (selection.projectIds ?? [])
    .map((id) => (profile?.projects ?? []).find((entry) => entry?.id === id))
    .filter((entry) => entry && entry.name)
    .map((entry) => {
      const item = { name: entry.name, bullets: (entry.facts ?? []).map((fact) => String(fact.text ?? "").trim()).filter(Boolean) };
      if (entry.url) item.url = entry.url;
      if (entry.tech) item.tech = entry.tech;
      return item;
    });

  const educationEntries = (selection.educationIds ?? [])
    .map((id) => (profile?.education ?? []).find((entry) => entry?.id === id))
    .filter((entry) => entry && entry.title)
    .map((entry) => {
      const item = { title: entry.title };
      if (entry.org) item.org = entry.org;
      if (entry.location) item.location = entry.location;
      if (entry.year) item.year = entry.year;
      return item;
    });

  /** @type {Record<string, unknown>} */
  const payload = { candidate };
  if (summaryText) payload.summary = summaryText;
  if (experience.length > 0) payload.experience = experience;
  if (projectEntries.length > 0) payload.projects = projectEntries;
  if (educationEntries.length > 0) payload.education = educationEntries;
  if (skills.length > 0) payload.skills = [{ items: skills }];

  if (!payload.candidate.name) {
    warnings.push("config/profile.yml has no candidate name — the CV header will be empty");
  }
  if (!payload.experience && !payload.projects && !payload.summary) {
    warnings.push("nothing selected to render: pick a summary, a role, or a project");
  }

  return {
    payload,
    gaps,
    warnings,
    counts: { summary: summaryText ? 1 : 0, experience: experience.length, bullets: experience.reduce((total, item) => total + item.bullets.length, 0), skills: skills.length },
    generatedAt: today,
  };
}

/**
 * A filename stem for the generated CV: who it is for, and when.
 * Slugs are ascii-folded and dashed so the file survives any filesystem, and a
 * caller-supplied label can never escape the output directory.
 *
 * @param {string} label
 * @param {string} [date]
 */
export function cvFileStem(label, date = new Date().toISOString().slice(0, 10)) {
  const slug = String(label ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "cv"}-${date}`;
}
