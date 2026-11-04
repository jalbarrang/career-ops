// Local, untrusted status proposals. The producer never gets a tracker writer.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalizeTrackerPath } from '../path-resolver.ts';

const MAX_FILE_BYTES = 64 * 1024;
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const HASH = /^[a-f0-9]{64}$/;

/** Exact field set of a drop file's `source` object. */
const SOURCE_FIELDS = ['kind', 'account_id', 'message_id'] as const;

/** Exact field set of a drop file's `application` object. */
const APPLICATION_FIELDS = ['num', 'date', 'company', 'role', 'report'] as const;

/** Exact field set of a drop file itself; any extra key is a schema error. */
const PROPOSAL_FIELDS = ['schema_version', 'source', 'tracker_path', 'application', 'from_status', 'to_status', 'evidence'] as const;

/** Identity of the mailbox message a proposal came from. */
export interface ReplyProposalSource {
  kind: 'gmail';
  account_id: string;
  message_id: string;
}

/** The tracker row a proposal claims to describe, as the producer saw it. */
export interface ReplyProposalApplication {
  num: number;
  date: string;
  company: string;
  role: string;
  report: string;
}

/** One fully validated drop file. */
export interface ReplyProposal {
  schema_version: 1;
  source: ReplyProposalSource;
  tracker_path: string;
  application: ReplyProposalApplication;
  from_status: string;
  to_status: string;
  evidence: string;
}

/**
 * A parsed tracker row. `parseTrackerRow()` returns null for header and
 * separator lines, so callers' arrays are typed nullable even after their
 * `.filter(Boolean)`; the readers below skip those holes.
 */
export interface TrackerApplicationRow {
  num: number;
  date: string;
  company: string;
  role: string;
  score: string;
  status: string;
  pdf: string;
  report: string;
  notes: string;
  url: string;
  raw: string;
  location?: string;
  via?: string;
}

/** One canonical state, as loadCanonicalStates() returns it. */
export interface CanonicalState {
  id: string;
  label: string;
  aliases: readonly string[];
  description: string;
  terminal: boolean;
}

/** One tracker row's worth of accepted-looking proposals, shown for review. */
export interface ReplyProposalRecommendation {
  num: number;
  company: string;
  role: string;
  oldStatus: string;
  newStatus: string;
  snapshot: TrackerApplicationRow;
  proposals: { receipt: string; evidence: string; source: ReplyProposalSource }[];
}

/** Everything one scan of the drop directory produced. */
export interface ReplyProposalScan {
  recommendations: ReplyProposalRecommendation[];
  warnings: string[];
}

/** A drop file that passed validation, with the states it resolves to. */
interface ValidatedProposal {
  proposal: ReplyProposal;
  from: CanonicalState;
  to: CanonicalState;
}

/** Validation either yields the typed proposal or the reason it was rejected. */
type ValidationOutcome =
  | ({ ok: true } & ValidatedProposal)
  | { ok: false; error: string };

export function proposalReceipt(source: ReplyProposalSource): string {
  const key = JSON.stringify([source.kind, source.account_id, source.message_id]);
  return `[reply-proposal:${createHash('sha256').update(key).digest('hex')}]`;
}

export function hasProposalReceipt(apps: readonly (TrackerApplicationRow | null)[], receipt: string): boolean {
  return apps.some(app => app !== null && app.notes.split(';').some(note => note.trim() === receipt));
}

function fields(value: unknown, names: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name));
}

function text(value: unknown, max = 1000, empty = false): value is string {
  return typeof value === 'string' && value.length <= max
    && (empty || value.trim().length > 0) && !CONTROLS.test(value);
}

/** `error.message` as text, for a caught value of unknown shape. */
function errorMessage(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'message' in error) return String(error.message);
  return String(error);
}

/** `error.code` when the caught value carries a string one, else undefined. */
function errorCode(error: unknown): string | undefined {
  if (error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return undefined;
}

// Diagnostics are also untrusted: JSON.parse errors can include bytes from a
// malformed file, and JSON.stringify alone does not escape bidi controls.
function diagnostic(value: unknown): string {
  return JSON.stringify(String(value)).replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function validSource(source: unknown): source is ReplyProposalSource {
  return fields(source, SOURCE_FIELDS)
    && source.kind === 'gmail' && typeof source.account_id === 'string'
    && source.account_id.length === 64 && HASH.test(source.account_id) && typeof source.message_id === 'string'
    && !CONTROLS.test(source.message_id) && /^[A-Za-z0-9_-]{1,256}$/.test(source.message_id);
}

function validate(row: unknown, trackerPath: string, states: readonly CanonicalState[]): ValidationOutcome {
  if (!fields(row, PROPOSAL_FIELDS) || row.schema_version !== 1) return { ok: false, error: 'invalid schema or fields' };
  const source = row.source;
  if (!validSource(source)) return { ok: false, error: 'invalid source identity' };
  const rowTrackerPath = row.tracker_path;
  if (!text(rowTrackerPath, 4096) || !path.isAbsolute(rowTrackerPath)
      || rowTrackerPath !== canonicalizeTrackerPath(trackerPath)) return { ok: false, error: 'foreign or noncanonical tracker path' };
  const app = row.application;
  if (!fields(app, APPLICATION_FIELDS)) return { ok: false, error: 'invalid application identity' };
  const num = app.num;
  const date = app.date;
  const company = app.company;
  const role = app.role;
  const report = app.report;
  // The typeof guard only narrows for TypeScript; isSafeInteger already rejects
  // every non-number, so the accepted set is unchanged.
  if (typeof num !== 'number' || !Number.isSafeInteger(num) || num <= 0
      || !text(date, 100, true) || !text(company) || !text(role)
      || !text(report, 2000, true)) return { ok: false, error: 'invalid application identity' };
  const fromStatus = row.from_status;
  const toStatus = row.to_status;
  // A non-string id can never equal a canonical state id; this guard narrows
  // for TypeScript without changing which inputs are rejected, or the reason.
  if (typeof fromStatus !== 'string' || typeof toStatus !== 'string') {
    return { ok: false, error: 'expected distinct canonical status ids' };
  }
  const from = states.find(s => s.id === fromStatus);
  const to = states.find(s => s.id === toStatus);
  if (!from || !to || fromStatus === toStatus) return { ok: false, error: 'expected distinct canonical status ids' };
  const evidence = row.evidence;
  if (!text(evidence, 2000)) return { ok: false, error: 'invalid evidence excerpt' };
  return {
    ok: true,
    proposal: {
      schema_version: 1,
      source,
      tracker_path: rowTrackerPath,
      application: { num, date, company, role, report },
      from_status: fromStatus,
      to_status: toStatus,
      evidence,
    },
    from,
    to,
  };
}

// Fixed field order makes semantically identical JSON deduplicate regardless of
// whitespace or producer object-key order. Source identity is deliberately NOT
// tied to the proposed transition: changing a target cannot replay accepted mail.
function payload(row: ReplyProposal): string {
  const a = row.application;
  return JSON.stringify([row.tracker_path, a.num, a.date, a.company, a.role, a.report,
    row.from_status, row.to_status, row.evidence]);
}

/** Read one JSON object per file, without modifying drops or tracker data. */
export function readReplyProposals(
  dataRoot: string,
  trackerPath: string,
  apps: readonly (TrackerApplicationRow | null)[],
  states: readonly CanonicalState[],
): ReplyProposalScan {
  const directory = path.join(dataRoot, 'data', 'reply-proposals');
  const warnings: string[] = [];
  const proposals = new Map<string, ValidatedProposal>();
  const blocked = new Set<string>();
  let entries: string[];
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('expected a regular directory');
    entries = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
  } catch (err) {
    if (errorCode(err) !== 'ENOENT') warnings.push(`Cannot read reply proposals: ${diagnostic(errorMessage(err))}`);
    return { recommendations: [], warnings };
  }

  for (const name of entries) {
    let fd: number | undefined;
    let row: unknown;
    try {
      const filename = path.join(directory, name);
      const stat = fs.lstatSync(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('expected a regular file');
      fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new Error('file exceeds 64 KiB or is not regular');
      // Read at most the contract limit even if a producer writes concurrently.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (bytes > MAX_FILE_BYTES) throw new Error('file exceeds 64 KiB');
      row = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
      const validation = validate(row, trackerPath, states);
      if (!validation.ok) throw new Error(validation.error);
      const proposal = validation.proposal;
      const receipt = proposalReceipt(proposal.source);
      const previous = proposals.get(receipt);
      if (previous && payload(previous.proposal) !== payload(proposal)) {
        blocked.add(receipt);
        throw new Error('conflicting payloads for the same source identity');
      }
      proposals.set(receipt, validation);
    } catch (err) {
      // An invalid duplicate must not leave its valid sibling actionable.
      const parsedSource = row !== null && typeof row === 'object' && 'source' in row ? row.source : undefined;
      if (validSource(parsedSource)) blocked.add(proposalReceipt(parsedSource));
      warnings.push(`Skipped proposal ${diagnostic(name)}: ${diagnostic(errorMessage(err))}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  const recommendations: ReplyProposalRecommendation[] = [];
  for (const [receipt, validated] of proposals) {
    if (blocked.has(receipt) || hasProposalReceipt(apps, receipt)) continue;
    const proposal = validated.proposal;
    const matches = apps.filter((app): app is TrackerApplicationRow =>
      app !== null && app.num === proposal.application.num);
    const app = matches[0];
    const from = validated.from.label;
    const to = validated.to.label;
    let reason: string | undefined;
    if (matches.length !== 1) reason = 'missing or ambiguous tracker row';
    else if (!APPLICATION_FIELDS.every(key => app[key] === proposal.application[key])) reason = 'application identity changed';
    else if (app.status === to) continue;
    else if (app.status !== from) reason = 'stale from-status';
    if (reason) {
      warnings.push(`Skipped proposal for #${proposal.application.num}: ${reason}`);
      continue;
    }
    recommendations.push({
      num: app.num, company: app.company, role: app.role,
      oldStatus: from, newStatus: to, snapshot: app,
      proposals: [{ receipt, evidence: proposal.evidence, source: proposal.source }],
    });
  }
  return { recommendations, warnings };
}
