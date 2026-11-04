/**
 * Shared schema v2 validation and read-only loading for Master Career Profile.
 *
 * FORK-OWNED. Upstream ships schema v1, where an experience is a flat
 * `{id, label, evidence, facts[]}` and a person who held two roles at one
 * company appears as two unrelated entries with the company name repeated.
 * This fork's v2 nests them the way a career actually looks:
 *
 *   experiences:
 *     - company: { name, evidence }
 *       roles:
 *         - { id, name, period, location, review_status, evidence, facts[] }
 *
 * The company holds the identity (one card, one name) and the roles carry what
 * a CV renders. Everything below enforces that shape; `fork/apply.ts` is what
 * puts this file back after an update reverts it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadYaml } from '../kernel/yaml-document.ts';
import { getCareerOpsRoot } from '../kernel/path-resolver.ts';

/** The two review states a fact, entry or role may carry. */
type ReviewStatus = 'needs_review' | 'verified';

/** Where in a source file a statement was found, so it can be re-checked. */
interface ProfileEvidence {
  source: string;
  line: number;
  quote: string;
}

/** One statement in a bare-fact section (summary, certifications, skills). */
interface ProfileFact {
  id: string;
  text: string;
  review_status: ReviewStatus;
  evidence: ProfileEvidence;
}

/** A labelled entry in `projects` / `education`, with the facts under it. */
interface ProfileLabeledEntry {
  id: string;
  label: string;
  review_status?: ReviewStatus;
  evidence: ProfileEvidence;
  facts: ProfileFact[];
}

/** One role held at a company. An empty `name` is allowed on purpose. */
interface ProfileRole {
  id: string;
  name: string;
  period?: string;
  location?: string;
  review_status?: ReviewStatus;
  evidence: ProfileEvidence;
  facts: ProfileFact[];
}

/** A company and every role held there; the company carries the identity. */
interface ProfileCompany {
  id: string;
  company: { name: string; evidence: ProfileEvidence };
  roles: ProfileRole[];
}

/** A schema-v2 profile. */
interface CareerProfile {
  schema_version: number;
  candidate: Record<string, unknown>;
  summary: ProfileFact[];
  experiences: ProfileCompany[];
  projects: ProfileLabeledEntry[];
  education: ProfileLabeledEntry[];
  certifications: ProfileFact[];
  skills: ProfileFact[];
}

/** A role paired with the company it belongs to, as `experienceRoles` returns it. */
interface ProfileRoleEntry {
  company: ProfileCompany;
  role: ProfileRole;
}

const STATUS: ReadonlySet<unknown> = new Set(['needs_review', 'verified']);

export const SCHEMA_VERSION = 2;

/** Sections that hold a bare list of facts. */
export const FACT_SECTIONS: string[] = ['summary', 'certifications', 'skills'];

/** Sections that hold labelled entries with their own facts (unchanged from v1). */
export const LABEL_SECTIONS: string[] = ['projects', 'education'];

const isMapping = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** `Array.isArray` that narrows to `unknown[]` instead of `any[]`. */
const isUnknownArray = (value: unknown): value is unknown[] => Array.isArray(value);

/**
 * Validate a profile and return its errors ([] means valid).
 *
 * Every message names the exact path (`experiences[0].roles[1].name`) because
 * the only consumer that shows these to a person is the web builder, and
 * "roles are invalid" does not tell them which role.
 *
 * Takes `unknown` because the input is parsed YAML, not a value whose shape is
 * already known; the return value is the only thing that vouches for it.
 */
export function validateProfile(profile: unknown): string[] {
  const errors: string[] = [];
  if (!isMapping(profile)) {
    return ['profile must be a mapping'];
  }
  if (profile.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isMapping(profile.candidate)) errors.push('candidate must be a mapping');

  const ids = new Set<string>();
  const checkEvidence = (evidence: unknown, path: string): void => {
    if (!isMapping(evidence) || typeof evidence.source !== 'string' || !evidence.source.trim() ||
        typeof evidence.line !== 'number' || !Number.isInteger(evidence.line) || evidence.line < 1 ||
        typeof evidence.quote !== 'string' || !evidence.quote.trim()) {
      errors.push(`${path}.evidence requires source, positive line, and quote`);
    }
  };
  const checkId = (id: unknown, path: string): void => {
    if (typeof id !== 'string' || !id.trim()) errors.push(`${path}.id is required`);
    else if (ids.has(id)) errors.push(`duplicate id: ${id}`);
    else ids.add(id);
  };
  const checkFacts = (facts: unknown, path: string): void => {
    if (!isUnknownArray(facts)) {
      errors.push(`${path}.facts must be a list`);
      return;
    }
    facts.forEach((fact: unknown, i: number) => {
      const at = `${path}.facts[${i}]`;
      if (!isMapping(fact)) {
        errors.push(`${at} must be a mapping`);
        return;
      }
      checkId(fact.id, at);
      if (typeof fact.text !== 'string' || !fact.text.trim()) errors.push(`${at}.text is required`);
      if (!STATUS.has(fact.review_status)) errors.push(`${at}.review_status must be needs_review or verified`);
      checkEvidence(fact.evidence, at);
    });
  };

  for (const section of [...FACT_SECTIONS, ...LABEL_SECTIONS, 'experiences']) {
    if (!isUnknownArray(profile[section])) errors.push(`${section} must be a list`);
  }

  for (const section of FACT_SECTIONS) {
    const facts = profile[section];
    for (const [i, fact] of (isUnknownArray(facts) ? facts : []).entries()) {
      const at = `${section}[${i}]`;
      if (!isMapping(fact)) {
        errors.push(`${at} must be a mapping`);
        continue;
      }
      checkId(fact.id, at);
      if (typeof fact.text !== 'string' || !fact.text.trim()) errors.push(`${at}.text is required`);
      if (!STATUS.has(fact.review_status)) errors.push(`${at}.review_status must be needs_review or verified`);
      checkEvidence(fact.evidence, at);
    }
  }

  for (const section of LABEL_SECTIONS) {
    const entries = profile[section];
    for (const [i, entry] of (isUnknownArray(entries) ? entries : []).entries()) {
      const at = `${section}[${i}]`;
      if (!isMapping(entry)) {
        errors.push(`${at} must be a mapping`);
        continue;
      }
      checkId(entry.id, at);
      if (typeof entry.label !== 'string' || !entry.label.trim()) errors.push(`${at}.label is required`);
      if (!STATUS.has(entry.review_status ?? 'verified')) errors.push(`${at}.review_status must be needs_review or verified`);
      checkEvidence(entry.evidence, at);
      checkFacts(entry.facts, at);
    }
  }

  const experiences = profile.experiences;
  for (const [i, company] of (isUnknownArray(experiences) ? experiences : []).entries()) {
    const at = `experiences[${i}]`;
    if (!isMapping(company)) {
      errors.push(`${at} must be a mapping`);
      continue;
    }
    checkId(company.id, at);
    if (!isMapping(company.company)) {
      errors.push(`${at}.company must be a mapping`);
      continue;
    }
    // The company name is the group's identity: an empty one cannot be
    // distinguished from any other empty one, and the builder titles the card
    // with it.
    if (typeof company.company.name !== 'string' || !company.company.name.trim()) {
      errors.push(`${at}.company.name is required`);
    }
    checkEvidence(company.company.evidence, `${at}.company`);

    const roles = company.roles;
    if (!isUnknownArray(roles)) {
      errors.push(`${at}.roles must be a list`);
      continue;
    }
    roles.forEach((role: unknown, j: number) => {
      const roleAt = `${at}.roles[${j}]`;
      if (!isMapping(role)) {
        errors.push(`${roleAt} must be a mapping`);
        return;
      }
      checkId(role.id, roleAt);
      // An empty role name is allowed on purpose: the importer can meet a block
      // with a company and dates but no title line, and the builder flags the
      // empty field instead of the file refusing to save.
      if (typeof role.name !== 'string') errors.push(`${roleAt}.name must be a string`);
      for (const optional of ['period', 'location']) {
        if (role[optional] !== undefined && typeof role[optional] !== 'string') {
          errors.push(`${roleAt}.${optional} must be a string`);
        }
      }
      if (!STATUS.has(role.review_status ?? 'verified')) errors.push(`${roleAt}.review_status must be needs_review or verified`);
      checkEvidence(role.evidence, roleAt);
      checkFacts(role.facts, roleAt);
    });
  }

  return errors;
}

/** Options for `loadValidatedProfile`. */
interface LoadProfileOptions {
  /** Data root the default file path is anchored to. */
  dataRoot?: string;
  /** Explicit profile file, overriding the data-root default. */
  file?: string;
}

/** Missing/invalid profiles fail; only the importer may initialize a new one. */
export function loadValidatedProfile({ dataRoot = getCareerOpsRoot(), file = join(dataRoot, 'data', 'career-profile.yml') }: LoadProfileOptions = {}): CareerProfile {
  // Parsed YAML is untrusted input; validateProfile is what turns it into a
  // CareerProfile, and the assertion below is that proof.
  const parsed: unknown = loadYaml(readFileSync(file, 'utf8'));
  const errors = validateProfile(parsed);
  if (errors.length) throw new Error(`Invalid profile:\n- ${errors.join('\n- ')}`);
  return parsed as CareerProfile;
}

/** A schema-v2 profile with no content. */
export function emptyProfile(): CareerProfile {
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
 * Flatten companies into their roles, each carrying the company it belongs to.
 *
 * Selection (`packages/core/src/profile/profile-cv-selection.ts`) binds a CV slot to ONE role, so it
 * needs the roles addressable on their own. Keeping the flattening here means
 * the nested shape has exactly one reader that understands nesting.
 *
 * Takes `unknown` and narrows: it is called with a profile that has just been
 * validated, but also from callers holding parsed YAML.
 */
export function experienceRoles(profile: unknown): ProfileRoleEntry[] {
  const roles: ProfileRoleEntry[] = [];
  const companies = isMapping(profile) && isUnknownArray(profile.experiences) ? profile.experiences : [];
  for (const company of companies) {
    const nested = isMapping(company) && isUnknownArray(company.roles) ? company.roles : [];
    for (const role of nested) {
      roles.push({ company: company as ProfileCompany, role: role as ProfileRole });
    }
  }
  return roles;
}
