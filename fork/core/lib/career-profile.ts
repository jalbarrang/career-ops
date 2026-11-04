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
import { loadYaml } from './yaml-document.ts';
import { getCareerOpsRoot } from '../path-resolver.ts';

const STATUS = new Set(['needs_review', 'verified']);

export const SCHEMA_VERSION = 2;

/** Sections that hold a bare list of facts. */
export const FACT_SECTIONS = ['summary', 'certifications', 'skills'];

/** Sections that hold labelled entries with their own facts (unchanged from v1). */
export const LABEL_SECTIONS = ['projects', 'education'];

const isMapping = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Validate a profile and return its errors ([] means valid).
 *
 * Every message names the exact path (`experiences[0].roles[1].name`) because
 * the only consumer that shows these to a person is the web builder, and
 * "roles are invalid" does not tell them which role.
 */
export function validateProfile(profile) {
  const errors = [];
  if (!isMapping(profile)) {
    return ['profile must be a mapping'];
  }
  if (profile.schema_version !== SCHEMA_VERSION) errors.push(`schema_version must be ${SCHEMA_VERSION}`);
  if (!isMapping(profile.candidate)) errors.push('candidate must be a mapping');

  const ids = new Set();
  const checkEvidence = (evidence, path) => {
    if (!isMapping(evidence) || typeof evidence.source !== 'string' || !evidence.source.trim() ||
        !Number.isInteger(evidence.line) || evidence.line < 1 ||
        typeof evidence.quote !== 'string' || !evidence.quote.trim()) {
      errors.push(`${path}.evidence requires source, positive line, and quote`);
    }
  };
  const checkId = (id, path) => {
    if (typeof id !== 'string' || !id.trim()) errors.push(`${path}.id is required`);
    else if (ids.has(id)) errors.push(`duplicate id: ${id}`);
    else ids.add(id);
  };
  const checkFacts = (facts, path) => {
    if (!Array.isArray(facts)) {
      errors.push(`${path}.facts must be a list`);
      return;
    }
    facts.forEach((fact, i) => {
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
    if (!Array.isArray(profile[section])) errors.push(`${section} must be a list`);
  }

  for (const section of FACT_SECTIONS) {
    for (const [i, fact] of (Array.isArray(profile[section]) ? profile[section] : []).entries()) {
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
    for (const [i, entry] of (Array.isArray(profile[section]) ? profile[section] : []).entries()) {
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

  for (const [i, company] of (Array.isArray(profile.experiences) ? profile.experiences : []).entries()) {
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

    if (!Array.isArray(company.roles)) {
      errors.push(`${at}.roles must be a list`);
      continue;
    }
    company.roles.forEach((role, j) => {
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

/** Missing/invalid profiles fail; only the importer may initialize a new one. */
export function loadValidatedProfile({ dataRoot = getCareerOpsRoot(), file = join(dataRoot, 'data', 'career-profile.yml') } = {}) {
  const profile = loadYaml(readFileSync(file, 'utf8'));
  const errors = validateProfile(profile);
  if (errors.length) throw new Error(`Invalid profile:\n- ${errors.join('\n- ')}`);
  return profile;
}

/** A schema-v2 profile with no content. */
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
 * Flatten companies into their roles, each carrying the company it belongs to.
 *
 * Selection (`lib/profile-cv-selection.ts`) binds a CV slot to ONE role, so it
 * needs the roles addressable on their own. Keeping the flattening here means
 * the nested shape has exactly one reader that understands nesting.
 */
export function experienceRoles(profile) {
  const roles = [];
  for (const company of Array.isArray(profile?.experiences) ? profile.experiences : []) {
    for (const role of Array.isArray(company?.roles) ? company.roles : []) {
      roles.push({ company, role });
    }
  }
  return roles;
}
