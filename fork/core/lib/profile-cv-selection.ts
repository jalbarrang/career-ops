/** Explicit, verbatim Profile facts -> HTML CV payload. No source or PDF writes.
 *
 * FORK: schema v2. A profile experience is a company with nested roles, and a CV
 * slot is bound to ONE ROLE, so the lookup flattens through experienceRoles().
 * The selection manifest keeps its `profile-selection.v1` name and its
 * `profile_entry_id` field — the id it carries is a ROLE id now, and the
 * selection file a user already wrote stays readable.
 */
import { createHash } from 'node:crypto';
import { experienceRoles, validateProfile } from '../../../packages/cli/src/commands/profile/career-profile.ts';
import { validatePayload } from './cv-payload-schema.ts';

// ---------------------------------------------------------------------------
// Profile shapes this module reads (schema v2 — validation lives in packages/cli/src/commands/profile/career-profile.ts)
// ---------------------------------------------------------------------------

type ReviewStatus = 'needs_review' | 'verified';

/** Where a Profile claim came from: primary source plus its verbatim quote. */
interface ProfileEvidence {
  source: string;
  line: number;
  quote: string;
}

/** One Profile fact: a single quotable claim attached to a role. */
interface ProfileFact {
  id: string;
  text: string;
  review_status: ReviewStatus;
  evidence: ProfileEvidence;
}

/** One role inside a company. */
interface ProfileRole {
  id: string;
  name?: string;
  review_status?: ReviewStatus;
  evidence: ProfileEvidence;
  facts?: ProfileFact[];
}

/** One company; the roles nested under it carry what a CV renders. */
interface ProfileCompany {
  id: string;
  company: { name?: string; evidence: ProfileEvidence };
  roles?: ProfileRole[];
}

/** A schema-v2 Profile, as far as selection reads it. */
interface CareerProfile {
  experiences?: ProfileCompany[];
}

/** A role paired with the company it belongs to — the shape experienceRoles() returns. */
interface ProfileRoleBinding {
  company: ProfileCompany;
  role: ProfileRole;
}

// ---------------------------------------------------------------------------
// CV payload shapes (the HTML contract itself is validated by cv-payload-schema.ts)
// ---------------------------------------------------------------------------

/** One experience slot of the HTML CV payload. */
interface CvExperienceEntry {
  company: string;
  role: string;
  location?: string;
  context?: string;
  dates?: string;
  period?: string;
  bullets?: string[];
}

/**
 * The HTML CV payload. Selection interprets only `experience[].bullets`; every
 * other key is opaque JSON that must survive the round trip unchanged.
 */
interface CvPayload {
  experience: CvExperienceEntry[];
  [key: string]: unknown;
}

/** Which base-payload experience slot a Profile role fills, plus its anchor hash. */
interface CvSelectionTarget {
  experience_index: number;
  entry_sha256: string;
}

/** One role -> one experience slot, plus the fact ids quoted into it. */
interface CvSelectionBinding {
  profile_entry_id: string;
  target: CvSelectionTarget;
  fact_ids: string[];
}

/** The `profile-selection.v1` manifest a user writes. */
interface CvSelectionManifest {
  schema: 'profile-selection.v1';
  base_payload_sha256: string;
  bindings: CvSelectionBinding[];
}

/** Everything prepareCvSelection() reconstructs from independent originals. */
interface CvSelectionInputs {
  profile: CareerProfile;
  basePayload: CvPayload;
  selection: CvSelectionManifest;
}

/** Evidence identity as the mapping records it: line numbers are deliberately dropped. */
interface EvidenceIdentity {
  source: string;
  quote: string;
}

/** A selected fact, as recorded in the selected-profile digest. */
interface SelectedFact {
  id: string;
  text: string;
  review_status: ReviewStatus;
  evidence: EvidenceIdentity;
}

/** A selected role, as recorded in the selected-profile digest. */
interface SelectedRole {
  id: string;
  label: string;
  review_status: ReviewStatus;
  evidence: EvidenceIdentity;
  facts: SelectedFact[];
}

/** One bullet written into the payload, traceable back to the fact it came from. */
interface MappingBullet {
  experience_index: number;
  bullet_index: number;
  profile_entry_id: string;
  fact_id: string;
  text_sha256: string;
  evidence: EvidenceIdentity;
}

/** The `profile-mapping.v1` receipt: which facts landed where, and input hashes. */
interface CvSelectionMapping {
  schema: 'profile-mapping.v1';
  base_payload_sha256: string;
  selection_sha256: string;
  selected_profile_sha256: string;
  payload_sha256: string;
  bullets: MappingBullet[];
}

/** What prepareCvSelection() returns: the filled payload plus its mapping. */
interface PreparedCvSelection {
  payload: CvPayload;
  mapping: CvSelectionMapping;
}

/** Diagnostic context attached to a SelectionError; arbitrary keys, never read back by type. */
type SelectionContext = Record<string, unknown>;

export class SelectionError extends Error {
  /** Stable machine-readable reason, e.g. 'fact-not-verified'. */
  code: string;
  /** Context fields (profile_entry_id, fact_id, experience_index) when known. */
  [context: string]: unknown;

  constructor(code: string, message: string, context: SelectionContext = {}) {
    super(message);
    this.name = 'SelectionError';
    this.code = code;
    Object.assign(this, context);
  }
}

function requireThat(condition: unknown, code: string, message: string, context?: SelectionContext): asserts condition {
  if (!condition) throw new SelectionError(code, message, context);
}

/** JSON arrays only, typed so the element type stays `unknown` rather than `any`. */
function isJsonArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** A plain `{}` object — exactly what JSON.parse() produces for an object literal. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

// Object key order/JSON formatting is immaterial; array order is significant.
// Reject values JSON would silently drop or change, including cyclic objects.
export function selectionDigest(value: unknown): string {
  const ancestors = new Set<unknown>();
  function canonical(item: unknown): string {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    requireThat(isJsonArray(item) || isJsonObject(item),
      'non-json-input', 'Selection inputs must contain only JSON values.');
    requireThat(!ancestors.has(item), 'non-json-input', 'Selection inputs must contain only JSON values.');
    ancestors.add(item);
    const result: string = isJsonArray(item)
      ? `[${Array.from(item, canonical).join(',')}]`
      : `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`;
    ancestors.delete(item);
    return result;
  }
  return createHash('sha256').update(canonical(value)).digest('hex');
}

const evidenceIdentity = (evidence: ProfileEvidence): EvidenceIdentity => ({ source: evidence.source, quote: evidence.quote });

/** `Company — Role`, the human identity of the slot being filled. */
function roleLabel(company: ProfileCompany, role: ProfileRole): string {
  const name = String(role?.name ?? '').trim();
  const employer = String(company?.company?.name ?? '').trim();
  if (employer && name) return `${employer} — ${name}`;
  return name || employer;
}

/**
 * Revalidates the whole Profile and the existing HTML payload contract.
 * Selection v1 binds stable Profile ROLE ids to exact base-payload experience slots.
 * Hashes detect stale/changed inputs; they certify neither truth nor consent.
 */
export function prepareCvSelection({ profile, basePayload, selection }: CvSelectionInputs): PreparedCvSelection {
  const profileErrors: string[] = validateProfile(profile);
  requireThat(!profileErrors.length, 'invalid-profile', `Invalid profile:\n- ${profileErrors.join('\n- ')}`);
  const { errors } = validatePayload(basePayload, 'html');
  requireThat(!errors.length, 'invalid-payload', `Invalid HTML payload:\n- ${errors.join('\n- ')}`);
  const baseDigest = selectionDigest(basePayload);
  requireThat(selection?.schema === 'profile-selection.v1', 'selection-schema', 'Expected profile-selection.v1.');
  // Validate the entire manifest as JSON before examining any of its fields.
  const manifestDigest = selectionDigest(selection);
  requireThat(selection.base_payload_sha256 === baseDigest, 'base-payload-changed', 'Base payload changed; select facts again.');
  requireThat(Array.isArray(selection.bindings) && selection.bindings.length > 0, 'empty-bindings', 'Select at least one experience binding.');
  requireThat(Array.isArray(basePayload.experience), 'invalid-target', 'Base payload must have an experience list.');
  const payload: CvPayload = structuredClone(basePayload);
  const roles: ProfileRoleBinding[] = experienceRoles(profile);
  const targets = new Set<number>();
  const selectedIds = new Set<string>();
  const selectedProfile: SelectedRole[] = [];
  const bullets: MappingBullet[] = [];
  for (const binding of selection.bindings) {
    const context: SelectionContext = { profile_entry_id: binding?.profile_entry_id, experience_index: binding?.target?.experience_index };
    const found = roles.find(({ role }) => role.id === binding?.profile_entry_id);
    requireThat(found, 'missing-entry', 'Selected Profile role does not exist.', context);
    const { role: entry, company } = found;
    requireThat(entry.review_status !== 'needs_review', 'entry-not-verified', 'Selected Profile role needs review.', context);
    requireThat(String(entry.name ?? '').trim(), 'role-unnamed', 'Selected Profile role has no title yet.', context);
    const index = binding.target?.experience_index;
    requireThat(Number.isInteger(index) && index >= 0 && index < payload.experience.length, 'invalid-target', 'Experience index is outside the base payload.', context);
    requireThat(!targets.has(index), 'duplicate-target', 'An experience may be bound only once.', context);
    targets.add(index);
    requireThat(binding.target.entry_sha256 === selectionDigest(basePayload.experience[index]), 'target-anchor-changed', 'Bound experience changed; select facts again.', context);
    requireThat(Array.isArray(binding.fact_ids) && binding.fact_ids.length > 0, 'empty-fact-selection', 'Select at least one fact for each binding.', context);
    const facts: SelectedFact[] = [];
    for (const id of binding.fact_ids) {
      const factContext: SelectionContext = { ...context, fact_id: id };
      requireThat(!selectedIds.has(id), 'duplicate-selected-fact', 'A fact may be selected only once.', factContext);
      selectedIds.add(id);
      const fact = (entry.facts ?? []).find(item => item.id === id);
      requireThat(fact, 'missing-or-wrongly-bound-fact', 'Selected fact does not belong to the bound Profile role.', factContext);
      requireThat(fact.review_status === 'verified', 'fact-not-verified', 'Selected fact needs review.', factContext);
      facts.push({ id: fact.id, text: fact.text, review_status: fact.review_status, evidence: evidenceIdentity(fact.evidence) });
      bullets.push({ experience_index: index, bullet_index: facts.length - 1,
        profile_entry_id: entry.id, fact_id: fact.id,
        text_sha256: selectionDigest(fact.text), evidence: evidenceIdentity(fact.evidence) });
    }
    payload.experience[index].bullets = facts.map(fact => fact.text);
    selectedProfile.push({ id: entry.id, label: roleLabel(company, entry), review_status: entry.review_status ?? 'verified',
      evidence: evidenceIdentity(entry.evidence), facts });
  }
  return {
    payload,
    mapping: {
      schema: 'profile-mapping.v1', base_payload_sha256: baseDigest,
      selection_sha256: manifestDigest, selected_profile_sha256: selectionDigest(selectedProfile),
      payload_sha256: selectionDigest(payload), bullets,
    },
  };
}

/** Reconstruct from independent originals, rather than trusting a sidecar hash. */
export function verifyCvSelection(inputs: CvSelectionInputs, prepared: PreparedCvSelection): true {
  const expected = prepareCvSelection(inputs);
  requireThat(prepared && typeof prepared === 'object', 'invalid-prepared', 'Expected a prepared payload and mapping.');
  requireThat(selectionDigest(prepared.payload) === selectionDigest(expected.payload), 'prepared-payload-mismatch', 'Prepared payload differs from the current selection.');
  requireThat(selectionDigest(prepared.mapping) === selectionDigest(expected.mapping), 'prepared-mapping-mismatch', 'Prepared mapping differs from the current selection.');
  return true;
}
