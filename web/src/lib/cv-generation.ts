/**
 * Turn a selection of career-profile facts into an HTML CV payload.
 *
 * The payload contract belongs to the core (`lib/cv-payload-schema.ts`, and the
 * builders that enforce it), so this module only ASSEMBLES one: it never renders
 * and never decides whether the result is valid. `build-cv-html.ts` does that,
 * and its rejection is what the generation screen reports.
 *
 * FORK: schema v2. A profile experience is a company with nested roles, and a
 * CV slot is one ROLE — so a selection names role ids and this flattens them
 * back into the payload's flat `experience[]`, taking the company name from the
 * parent. Two roles at one employer therefore become two payload entries, which
 * is what the renderer expects today.
 *
 * Two field-name traps this exists to close, both silent:
 *
 *   - config/profile.yml stores the candidate as `full_name`, while the CV
 *     template reads `candidate.name`. Passing the profile straight through
 *     renders a CV with no name on it.
 *   - an `experience` entry needs `company` AND `role` or the builder drops the
 *     whole entry (see ENTRY_FIELD_SPECS.html.experience.required). Anything
 *     unbound here is reported as a gap instead of vanishing from the PDF.
 *
 * Plain .ts, no I/O and no `@/` aliases: the screen imports it, node --test too.
 */
import { allRoles, ensureShape } from "./cv-profile.ts";

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

/** Facts by id across every scope of the profile. */
function factIndex(profile) {
  const index = new Map();
  const add = (fact) => {
    if (fact && typeof fact.id === "string") index.set(fact.id, fact);
  };
  const shaped = ensureShape(profile);
  for (const section of ["summary", "certifications", "skills"]) {
    for (const fact of shaped[section]) add(fact);
  }
  for (const section of ["projects", "education"]) {
    for (const entry of shaped[section]) for (const fact of entry.facts ?? []) add(fact);
  }
  for (const { role } of allRoles(shaped)) for (const fact of role.facts ?? []) add(fact);
  return index;
}

/**
 * @typedef {object} Selection
 * @property {string[]} [summaryIds]      facts from `summary`
 * @property {{ entryId: string, factIds: string[] }[]} [experiences]  ROLE ids, in the order to render
 * @property {string[]} [skills]          facts from `skills`
 * @property {string[]} [projectIds]      entry ids from `projects`
 * @property {string[]} [educationIds]    entry ids from `education`
 */

/**
 * Build the payload, plus everything the caller needs to warn about BEFORE it
 * ships: roles that cannot render, and facts that are unverified or missing.
 *
 * A gap means the role is omitted, and the caller is told which one and why, so
 * the screen can say "this role has no company yet" instead of the PDF quietly
 * having two roles where the user selected three.
 *
 * @param {{ profile: object, candidate?: object, selection?: Selection, today?: string }} input
 */
export function buildCvPayload({ profile, candidate = {}, selection = {}, today = new Date().toISOString().slice(0, 10) }) {
  const facts = factIndex(profile);
  const roles = allRoles(profile);
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
    const found = roles.find(({ role }) => role.id === picked.entryId);
    if (!found) {
      gaps.push({ entryId: picked.entryId, reason: "role no longer exists" });
      continue;
    }
    const { company, role } = found;
    const companyName = String(company?.company?.name ?? "").trim();
    const roleName = String(role?.name ?? "").trim();
    const missing = [];
    if (!companyName) missing.push("company");
    if (!roleName) missing.push("role");
    if (missing.length > 0) {
      gaps.push({
        entryId: role.id,
        label: roleName || companyName || "(untitled role)",
        reason: `needs ${missing.join(" and ")} — it would not render`,
        missing,
      });
      continue;
    }
    const bullets = (picked.factIds ?? []).map(textOf).filter(Boolean);
    const item = { company: companyName, role: roleName, bullets };
    if (role.location) item.location = role.location;
    if (role.period) item.dates = role.period;
    experience.push(item);
  }

  const skills = (selection.skills ?? []).map(textOf).filter(Boolean);
  const shaped = ensureShape(profile);

  const projectEntries = (selection.projectIds ?? [])
    .map((id) => shaped.projects.find((entry) => entry?.id === id))
    .filter((entry) => entry && entry.label)
    .map((entry) => ({
      name: entry.label,
      bullets: (entry.facts ?? []).map((fact) => String(fact.text ?? "").trim()).filter(Boolean),
    }));

  const educationEntries = (selection.educationIds ?? [])
    .map((id) => shaped.education.find((entry) => entry?.id === id))
    .filter((entry) => entry && entry.label)
    .map((entry) => ({ title: entry.label }));

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
    counts: {
      summary: summaryText ? 1 : 0,
      experience: experience.length,
      bullets: experience.reduce((total, item) => total + item.bullets.length, 0),
      skills: skills.length,
    },
    generatedAt: today,
  };
}

/**
 * A filename stem for the generated CV: who it is for, and when.
 * Slugs are ascii-folded and dashed so the file survives any filesystem, and a
 * caller-supplied label can never escape the output directory.
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
