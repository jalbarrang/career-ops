#!/usr/bin/env node
/**
 * packages/core/src/insights/funnel-velocity.ts — Funnel calibration vs market benchmarks + stage velocity
 *
 * Three payloads, decreasing availability:
 *   1. calibration — own funnel rates (canonical ever* definition imported from
 *      packages/core/src/insights/stats.ts) vs candidate-side market benchmark ranges. Works day one;
 *      folds status-log history when the ledger is present so a row rejected
 *      after an interview still counts as having reached Interview (#3493).
 *   2. waiting — in-flight Applied rows and elapsed days vs the typical
 *      first-response window. Per-row factual reporting, not an aggregate claim.
 *   3. velocity — median/p75 days per stage hop, folded from the append-only
 *      transition ledger data/status-log.tsv. Accrues value as the log grows.
 *
 * Transition ledger (written by packages/cli/src/commands/tracker/set-status.ts, never edited in place):
 *   {tracker#}\t{YYYY-MM-DD}\t{from}\t{to}\t{source}\t{note}
 *   - from may be "-" (unknown prior state)
 *   - to "-" retracts the row's latest observation
 *   - source "correction" replaces an earlier same-(num,to) observation
 *   - log path = sibling of the active tracker file (sandbox-safe for tests)
 *
 * Statistical honesty rules (council-reviewed, non-negotiable):
 *   - medians report right-censoring ("n still waiting, excluded") — with 61%
 *     ghosting, completed-only medians are survivorship-biased otherwise
 *   - 0-day hops (same-day catch-up entries) are excluded from medians, counted
 *   - no comparative multiplier claims below n=20 applied
 *   - above-range calibration always carries the selection-bias note
 *   - every benchmark mention carries its year and "directional"
 *
 * Benchmarks lookup order: --benchmarks <path> > config/benchmarks.yml (user
 * layer, survives updates) > templates/benchmarks.yml (shipped default).
 *
 * Run: career-ops funnel-velocity             (JSON)
 *      career-ops funnel-velocity --summary   (human-readable)
 *      career-ops funnel-velocity --self-test
 *      career-ops funnel-velocity --benchmarks path/to/benchmarks.yml
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from '../kernel/yaml-document.ts';
import { computeFunnel, computeFunnelWithHistory, parseStatusLogStages, trackerStatusByNum, computeTrackerStats } from './stats.ts';
import { resolveColumns, parseTrackerRow } from '../tracker/tracker-parse.ts';
import type { TrackerRow } from '../tracker/tracker-parse.ts';
import { resolveTrackerPath, loadCanonicalStates, resolveCanonicalState } from '../tracker/tracker-utils.ts';
import { getCareerOpsRoot } from '../kernel/path-resolver.ts';
import { parseAppliedDate, normalizeStatus } from '../outreach/followup-cadence.ts';
import { flagValue, validateFlags } from '../kernel/cli-flags.ts';
import { localToday } from '../kernel/local-today.ts';
import { isMainModule } from '../kernel/is-main-module.ts';
import { repoRoot } from '../kernel/repo-root.ts';

// Two roots, because this file reads both layers and they are not the same
// directory. CODE_ROOT is where the shipped templates live; DATA_ROOT is where
// the USER's tracker and overrides live, and getCareerOpsRoot() is what honours
// CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR / the .career-ops-data marker.
//
// One name for both is how this went wrong: the constant was called CAREER_OPS
// and held __dirname, so it read correctly for templates and silently pointed
// the tracker lookup at the checkout. A user with a data root configured got
// "No tracker found ... nothing to calibrate yet" — indistinguishable from
// having no data.
const CODE_ROOT = repoRoot();
const DATA_ROOT = getCareerOpsRoot();
const STATES_FILE = join(CODE_ROOT, 'templates/states.yml');

const KNOWN_FLAGS = ['--summary', '--self-test', '--benchmarks', '--help', '-h'];
const VALUE_FLAGS = ['--benchmarks'];

const USAGE = `Usage:
  career-ops funnel-velocity                       # JSON report
  career-ops funnel-velocity --summary             # human-readable report
  career-ops funnel-velocity --benchmarks <path>   # override the benchmark YAML file
  career-ops funnel-velocity --self-test           # run the built-in fixtures
  career-ops funnel-velocity --help|-h              # show this message`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// `web` sits alongside `set-status` because it is the same class of event: a
// status change made in the web app is recorded as the user makes it, not
// reconstructed afterwards. Only the door differs.
// `reply-watch` is the same class: the user confirms the update interactively;
// the transition is observed at that moment, not reconstructed later.
// `dedup-tracker` is the opposite class: the kept row of a duplicate pair takes
// over the removed row's more advanced status, and that transition was found
// at dedup time, not observed then (#5536).
const VALID_SOURCES = new Set(['set-status', 'web', 'correction', 'backfill', 'manual', 'reply-watch', 'dedup-tracker']);
// Sources whose dates are trusted for day-math. backfill/manual/dedup-tracker
// are parsed and counted but excluded: they are reconstructed after the fact,
// not observed.
const DAY_MATH_SOURCES = new Set(['set-status', 'web', 'correction', 'reply-watch']);

// The hops a candidate can measure from their own tracker. Applied→Rejected is
// tracked separately from the forward hops — a "days to terminal" number that
// mixes offers and rejections reads grim and means nothing.
const HOPS: readonly Hop[] = [
  { key: 'appliedToResponded', from: 'Applied', to: 'Responded' },
  { key: 'respondedToAssessment', from: 'Responded', to: 'Assessment' },
  { key: 'assessmentToInterview', from: 'Assessment', to: 'Interview' },
  // Keep the direct hop for legacy rows that moved from Responded straight to
  // Interview before Assessment became a first-class lifecycle stage.
  { key: 'respondedToInterview', from: 'Responded', to: 'Interview', excludeIntermediate: 'Assessment' },
  { key: 'interviewToOffer', from: 'Interview', to: 'Offer' },
  { key: 'appliedToRejected', from: 'Applied', to: 'Rejected' },
];

// Verbatim strings the tone contract pins (also asserted by mode-doc checks).
const SELECTION_BIAS_NOTE = 'targeted applications are expected to beat mass-platform averages — this confirms your filtering works';
const BELOW_RANGE_ACTION = '→ check follow-up compliance (followup mode) or review your score threshold (patterns mode)';
const CLAIM_MIN_N = 20;
const HOP_MIN_N = 3;

// --- Types ---
/** One entry of templates/states.yml, as loadCanonicalStates() returns it. */
export interface CanonicalState {
  id: string;
  label: string;
  aliases: string[];
  description: string;
  terminal: boolean;
}

/** One parsed line of the transition ledger. */
export interface Observation {
  num: number;
  date: string;
  /** Canonical label, or null when the ledger recorded "-" (unknown prior state). */
  from: string | null;
  /** Canonical label, or "-" for a retraction entry. */
  to: string;
  source: string;
  note: string;
  dayMath: boolean;
}

/** A ledger line that could not be parsed, kept for the dataQuality report. */
export interface UnparseableLine {
  line: number;
  raw: string;
  reason: string;
}

/** An observation whose `source` the ledger contract does not recognize. */
export interface UnknownSource {
  line: number;
  num: number;
  source: string;
}

export interface ParsedStatusLog {
  observations: Observation[];
  unparseable: UnparseableLine[];
  unknownSources: UnknownSource[];
}

/** One surviving transition in a tracker row's folded timeline. */
export interface TimelineEntry {
  to: string;
  date: string;
  source: string;
  dayMath: boolean;
}

/** Folded timelines, keyed by tracker number. */
export type TimelineMap = Map<number, TimelineEntry[]>;

/** A measurable stage hop. */
interface Hop {
  key: string;
  from: string;
  to: string;
  excludeIntermediate?: string;
}

/** Market context attached to the one hop that carries a day benchmark. */
export interface HopBenchmark {
  rangeDays: number[];
  typicalDays: number | null;
  source: string | null;
  year: string | number | null;
}

/** Per-hop day statistics. */
export interface HopVelocity {
  from: string;
  to: string;
  n: number;
  median: number | null;
  p75: number | null;
  insufficientData: boolean;
  sameDayExcluded: number;
  censored: number;
  benchmark?: HopBenchmark;
}

/** Hop statistics keyed by hop key (appliedToResponded, …). */
export type Velocity = Record<string, HopVelocity>;

/** One own-rate percentage classified against a benchmark's inclusive band. */
export interface Classification {
  band: 'below-range' | 'within-range' | 'above-range';
  ownPct: number;
  rangePct: [number, number];
  typicalPct: number | null;
  vsTypical: number | null;
  source: string | null;
  year: string | number | null;
  caveat: string | null;
}

/** Cumulative funnel counts (packages/core/src/insights/stats.ts's canonical ever* definition). */
export interface FunnelCounts {
  everApplied: number;
  everResponded: number;
  everInterview: number;
  everOffer: number;
  responseRate: number;
  interviewRate: number;
  offerRate: number;
  smallSample: boolean;
  /** Present only on the ledger-aware funnel. */
  basis?: string;
}

export interface Calibration {
  everApplied: number;
  smallSample: boolean;
  claimMinN: number;
  basis: 'ledger' | 'snapshot';
  responseRate: Classification | null;
  interviewRate: Classification | null;
}

/** Where a waiting row's applied date came from. */
export type AppliedDateSource = 'status-log' | 'tracker-notes' | 'unknown';

export interface WaitingItem {
  num: number;
  company: string;
  appliedDate: string | null;
  elapsedDays: number | null;
  beyondTypicalWindow: boolean;
  dateSource: AppliedDateSource;
}

export interface WindowSource {
  source: string | null;
  year: string | number | null;
}

export interface WaitingSummary {
  windowDays: number[];
  windowSource: WindowSource | null;
  inFlight: number;
  unknownDates: number;
  items: WaitingItem[];
}

export interface DataQuality {
  trackerRows: number;
  coveredRows: number;
  observations: number;
  orphans: number[];
  unparseable: UnparseableLine[];
  unknownSources: UnknownSource[];
  newestObservation: string | null;
}

export interface AnalysisResult {
  calibration: Calibration;
  waiting: WaitingSummary;
  velocity: Velocity;
  dataQuality: DataQuality;
}

export interface AnalyzeOptions {
  trackerContent: string;
  logContent: string;
  benchmarks: Record<string, unknown>;
  states: readonly CanonicalState[];
  todayStr: string;
}

// --- Narrowing helpers (the benchmarks document is an unknown YAML boundary) ---
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Numeric view of a YAML scalar. The band comparisons below coerced with `<`/`>`
 * anyway, so a non-number still lands in the same band; a real benchmark file
 * only ever holds numbers.
 */
function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function toYear(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

/** Message of a thrown value: Error.message when present, else String(). */
function errorText(err: unknown): string {
  return isRecord(err) && typeof err.message === 'string' ? err.message : String(err);
}

// --- Date helpers ---
export function parseISODate(s: string | null | undefined): Date | null {
  if (!DATE_RE.test(String(s ?? '').trim())) return null;
  const d = new Date(`${String(s).trim()}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function daysBetween(fromStr: string | null | undefined, toStr: string | null | undefined): number | null {
  const a = parseISODate(fromStr), b = parseISODate(toStr);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// --- Ledger parsing ---
// line: {tracker#}\t{YYYY-MM-DD}\t{from}\t{to}\t{source}\t{note}
export function parseStatusLog(content: string | null | undefined, states: readonly CanonicalState[]): ParsedStatusLog {
  const observations: Observation[] = [];
  const unparseable: UnparseableLine[] = [];
  const unknownSources: UnknownSource[] = [];
  const lines = String(content || '').replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const cells = t.split('\t').map(c => c.trim());
    if (cells.length < 5) { unparseable.push({ line: i + 1, raw: t, reason: 'expected 5+ tab-separated columns' }); continue; }
    const [numRaw, date, fromRaw, toRaw, source, note = ''] = cells;
    const num = parseInt(numRaw, 10);
    if (!Number.isInteger(num) || String(num) !== numRaw) { unparseable.push({ line: i + 1, raw: t, reason: `bad tracker# "${numRaw}"` }); continue; }
    if (!parseISODate(date)) { unparseable.push({ line: i + 1, raw: t, reason: `bad date "${date}"` }); continue; }
    let from: string | null;
    if (fromRaw === '-') from = null;
    else {
      const canonicalFrom: string | null = resolveCanonicalState(fromRaw, states);
      if (!canonicalFrom) { unparseable.push({ line: i + 1, raw: t, reason: `unknown from-state "${fromRaw}"` }); continue; }
      from = canonicalFrom;
    }
    let to: string;
    if (toRaw === '-') to = '-';
    else {
      const canonicalTo: string | null = resolveCanonicalState(toRaw, states);
      if (!canonicalTo) { unparseable.push({ line: i + 1, raw: t, reason: `unknown to-state "${toRaw}"` }); continue; }
      to = canonicalTo;
    }
    if (!VALID_SOURCES.has(source)) {
      unknownSources.push({ line: i + 1, num, source });
      // Parsed but never fed to day-math; still visible in dataQuality.
      observations.push({ num, date, from, to, source, note, dayMath: false });
      continue;
    }
    observations.push({ num, date, from, to, source, note, dayMath: DAY_MATH_SOURCES.has(source) });
  }
  return { observations, unparseable, unknownSources };
}

/**
 * Fold observations into one ordered timeline per tracker#.
 *
 * Rules (append-only log semantics):
 *   - later `correction` with same (num, to) replaces the earlier observation's
 *     date (the fix for "agent logged the wrong day")
 *   - `to: "-"` retracts the row's latest surviving observation (the fix for
 *     "that transition never happened")
 *   - otherwise observations accumulate in file order (the log IS the order;
 *     dates may legitimately be non-monotonic via --on backdating)
 *
 * @returns Map num -> [{to, date, source, dayMath}]
 */
export function foldObservations(observations: readonly Observation[]): TimelineMap {
  const byNum: TimelineMap = new Map();
  for (const obs of observations) {
    let timeline = byNum.get(obs.num);
    if (!timeline) {
      timeline = [];
      byNum.set(obs.num, timeline);
    }
    if (obs.to === '-') { timeline.pop(); continue; }
    if (obs.source === 'correction') {
      const idx = timeline.map(o => o.to).lastIndexOf(obs.to);
      if (idx !== -1) { timeline[idx] = { to: obs.to, date: obs.date, source: obs.source, dayMath: obs.dayMath }; continue; }
    }
    timeline.push({ to: obs.to, date: obs.date, source: obs.source, dayMath: obs.dayMath });
  }
  // Sort each timeline by date so hop math sees event order, not entry order
  // (--on backdating makes file order unreliable). Stable sort keeps same-day
  // catch-up entries in entry order.
  for (const timeline of byNum.values()) {
    timeline.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }
  return byNum;
}

// --- Percentiles ---
export function median(nums: readonly number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// p75 by linear interpolation between closest ranks (R-7, the numpy default).
// Pinned by self-test fixture: [3,6,20] -> 13.
export function p75(nums: readonly number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const rank = 0.75 * (s.length - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}

// --- Velocity ---
/**
 * Per-hop day stats from folded timelines.
 *
 * A hop measurement = days between a row's dated `from` observation and its
 * next dated `to` observation (both day-math-trusted). Honesty rules:
 *   - 0-day hops excluded from the math, counted (same-day catch-up entries)
 *   - right-censoring: a row sitting in `from` with no later observation
 *     counts as censored for that hop (still waiting — median excludes it and
 *     must say so)
 *   - < HOP_MIN_N completed measurements -> insufficientData, no median
 */
export function computeVelocity(timelines: TimelineMap, todayStr: string): Velocity {
  const result: Velocity = {};
  for (const hop of HOPS) {
    const days: number[] = [];
    let sameDayExcluded = 0;
    let censored = 0;
    for (const timeline of timelines.values()) {
      const fromIdx = timeline.findIndex(o => o.to === hop.from && o.dayMath);
      if (fromIdx === -1) continue;
      const later = timeline.slice(fromIdx + 1);
      const nextIdx = later.findIndex(o => o.to === hop.to && o.dayMath);
      const next = nextIdx === -1 ? null : later[nextIdx];
      if (next && hop.excludeIntermediate && later.slice(0, nextIdx).some(o => o.to === hop.excludeIntermediate)) continue;
      if (next) {
        const d = daysBetween(timeline[fromIdx].date, next.date);
        if (d === null || d < 0) continue;
        if (d === 0) { sameDayExcluded++; continue; }
        days.push(d);
      } else if (fromIdx === timeline.length - 1) {
        // Row's latest state is the hop's from-state: still waiting = censored.
        // Only forward hops censor; Applied→Rejected shares Applied rows with
        // Applied→Responded, so count censoring once (on the forward hop).
        if (hop.to !== 'Rejected') censored++;
      }
    }
    result[hop.key] = {
      from: hop.from,
      to: hop.to,
      n: days.length,
      median: days.length >= HOP_MIN_N ? median(days) : null,
      p75: days.length >= HOP_MIN_N ? p75(days) : null,
      insufficientData: days.length < HOP_MIN_N,
      sameDayExcluded,
      censored,
    };
  }
  return result;
}

// --- Benchmarks ---
export function loadBenchmarks(explicitPath?: string | null): { benchmarks: Record<string, unknown>; path: string } {
  const path = explicitPath
    || (existsSync(join(DATA_ROOT, 'config/benchmarks.yml')) ? join(DATA_ROOT, 'config/benchmarks.yml') : join(CODE_ROOT, 'templates/benchmarks.yml'));
  let doc: unknown;
  try {
    doc = loadYaml(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`Cannot read benchmarks at ${path}: ${errorText(err)}`);
  }
  if (!isRecord(doc) || !isRecord(doc.benchmarks)) {
    throw new Error(`Malformed benchmarks file at ${path}: expected a top-level "benchmarks" map`);
  }
  return { benchmarks: doc.benchmarks, path };
}

/** Classify an own-rate percentage against a benchmark's range (inclusive). */
export function classify(ownPct: number | null | undefined, metric: unknown): Classification | null {
  if (ownPct === null || ownPct === undefined || !isRecord(metric)) return null;
  const rangePct = metric.range_pct;
  if (!Array.isArray(rangePct)) return null;
  const lo = toNumber(rangePct[0]);
  const hi = toNumber(rangePct[1]);
  const band = ownPct < lo ? 'below-range' : ownPct > hi ? 'above-range' : 'within-range';
  const typical = toNumberOrNull(metric.typical_pct);
  return {
    band,
    ownPct,
    rangePct: [lo, hi],
    typicalPct: typical,
    vsTypical: typical ? Math.round((ownPct / typical) * 10) / 10 : null,
    source: toStringOrNull(metric.source),
    year: toYear(metric.year),
    caveat: toStringOrNull(metric.caveat),
  };
}

// --- Calibration (flagship: works day one, no ledger needed) ---
export function computeCalibration(funnel: FunnelCounts, benchmarks: Record<string, unknown>): Calibration {
  const smallSample = funnel.everApplied < CLAIM_MIN_N;
  return {
    everApplied: funnel.everApplied,
    smallSample,
    claimMinN: CLAIM_MIN_N,
    // 'ledger' when the ever* counts fold status-log history (rejected-after-
    // interview rows counted at the stage they reached), 'snapshot' otherwise.
    basis: funnel.basis === 'ledger' ? 'ledger' : 'snapshot',
    responseRate: classify(funnel.everApplied > 0 ? funnel.responseRate : null, benchmarks.response_rate),
    interviewRate: classify(funnel.everApplied > 0 ? funnel.interviewRate : null, benchmarks.application_to_interview),
  };
}

// --- Waiting (flagship #2: in-flight Applied rows vs first-response window) ---
/**
 * Applied-date priority per row:
 *   1. ledger Applied observation (event-dated via --on, or logged same day)
 *   2. "Applied YYYY-MM-DD" in the tracker notes (followup-cadence convention;
 *      followup-seed/apply modes write it — same helper, same regex)
 *   3. unknown (listed, never guessed — the tracker date column is the
 *      EVALUATION date and must not stand in for the submission date)
 */
export function computeWaiting(
  rows: readonly TrackerRow[],
  timelines: TimelineMap,
  benchmarks: Record<string, unknown>,
  todayStr: string,
): WaitingSummary {
  const firstResponse = benchmarks.days_first_response;
  const windowRange = isRecord(firstResponse) ? firstResponse.range_days : undefined;
  const windowDays: number[] = Array.isArray(windowRange) ? [toNumber(windowRange[0]), toNumber(windowRange[1])] : [5, 14];
  const items: WaitingItem[] = [];
  let unknownDates = 0;
  for (const row of rows) {
    // Canonicalize before comparing — the funnel counts everApplied through
    // normalizeStatus, so non-canonical Applied rows (lowercase "applied", a
    // status carrying a date, localized "Aplicado", markdown-bold "**Applied**")
    // must surface here too, or the follow-up backlog is under-reported.
    if (normalizeStatus(row.status) !== 'applied') continue;
    const timeline = timelines.get(row.num) || [];
    const ledgerApplied = timeline.filter(o => o.to === 'Applied' && o.dayMath).pop();
    const notesDate: string | null = parseAppliedDate(row.notes);
    const appliedDate = ledgerApplied?.date ?? notesDate ?? null;
    if (!appliedDate) { unknownDates++; items.push({ num: row.num, company: row.company, appliedDate: null, elapsedDays: null, beyondTypicalWindow: false, dateSource: 'unknown' }); continue; }
    const elapsed = daysBetween(appliedDate, todayStr);
    items.push({
      num: row.num,
      company: row.company,
      appliedDate,
      elapsedDays: elapsed,
      beyondTypicalWindow: elapsed !== null && elapsed > windowDays[1],
      dateSource: ledgerApplied ? 'status-log' : 'tracker-notes',
    });
  }
  return {
    windowDays,
    windowSource: isRecord(firstResponse) ? { source: toStringOrNull(firstResponse.source), year: toYear(firstResponse.year) } : null,
    inFlight: items.length,
    unknownDates,
    items: items.sort((a, b) => (b.elapsedDays ?? -1) - (a.elapsedDays ?? -1)),
  };
}

// --- Tracker rows ---
export function parseTrackerRows(content: string): TrackerRow[] {
  const lines = String(content ?? '').replace(/\r/g, '').split('\n');
  const colmap = resolveColumns(lines);
  const rows: TrackerRow[] = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (row) rows.push(row);
  }
  return rows;
}

// --- Assembly ---
export function analyze({ trackerContent, logContent, benchmarks, states, todayStr }: AnalyzeOptions): AnalysisResult {
  const rows = parseTrackerRows(trackerContent);
  const stats = computeTrackerStats(trackerContent);
  // Ledger-aware funnel when the transition log carries usable history: a row now
  // sitting in a terminal snapshot (Rejected/Discarded) still counts for the
  // middle stages it passed through, so interviewRate/responseRate stop
  // undercounting rejected-after-interview rows (#3493). Same canonical
  // definition `career-ops stats` uses. Branch on the parsed stages, not the raw
  // file: a header-only, comment-only, or all-malformed log has no history to
  // fold, and taking the ledger path anyway would stamp basis:'ledger' on a
  // funnel identical to the snapshot and print the "rates fold history" note.
  const ledgerStages = parseStatusLogStages(logContent);
  const funnel: FunnelCounts = ledgerStages.length > 0
    ? computeFunnelWithHistory(trackerStatusByNum(trackerContent), ledgerStages)
    : computeFunnel(stats.byStatus);
  const { observations, unparseable, unknownSources } = parseStatusLog(logContent, states);
  const timelines = foldObservations(observations);

  const trackerNums = new Set(rows.map(r => r.num));
  const orphans = [...timelines.keys()].filter(n => !trackerNums.has(n));
  const coveredRows = [...timelines.keys()].filter(n => trackerNums.has(n)).length;
  const newestObs = observations.reduce((max, o) => (o.date > max ? o.date : max), '');

  const velocity = computeVelocity(timelines, todayStr);
  // The one hop with a candidate-side day benchmark gets it attached, so the
  // renderer can show market context next to the own-median (same denominator:
  // per-successful-process). Gated on an existing median: with insufficientData
  // the JSON output would otherwise leak a benchmark next to a null median.
  const io = benchmarks.days_interview_to_offer;
  if (isRecord(io) && Array.isArray(io.range_days) && velocity.interviewToOffer.median !== null) {
    velocity.interviewToOffer.benchmark = {
      rangeDays: io.range_days.map((d: unknown) => toNumber(d)),
      typicalDays: toNumberOrNull(io.typical_days),
      source: toStringOrNull(io.source),
      year: toYear(io.year),
    };
  }

  return {
    calibration: computeCalibration(funnel, benchmarks),
    waiting: computeWaiting(rows, timelines, benchmarks, todayStr),
    velocity,
    dataQuality: {
      trackerRows: rows.length,
      coveredRows,
      observations: observations.length,
      orphans,
      unparseable,
      unknownSources,
      newestObservation: newestObs || null,
    },
  };
}

// --- Summary rendering (tone contract lives here — see header) ---
function fmtCalibrationLine(label: string, c: Classification | null, smallSample: boolean, n: number): string {
  if (!c) return `  ${label}: no data yet`;
  const range = `${c.rangePct[0]}–${c.rangePct[1]}% typical band (${c.year ?? 'n/a'}, directional)`;
  let line = `  ${label}: ${c.ownPct}% vs ${range}`;
  if (smallSample) {
    line += ` — small sample (n=${n}) — directional only`;
    return line;
  }
  if (c.band === 'above-range') {
    line += ` — above the typical band${c.vsTypical ? `, ${c.vsTypical}× typical` : ''} (${SELECTION_BIAS_NOTE})`;
  } else if (c.band === 'below-range') {
    line += ` — below the typical band ${BELOW_RANGE_ACTION}`;
  } else {
    line += ' — within the typical band';
  }
  return line;
}

export function renderSummary(result: AnalysisResult, todayStr: string): string {
  const out: string[] = [];
  const { calibration: cal, waiting, velocity, dataQuality: dq } = result;
  out.push('━'.repeat(46));
  out.push(`Funnel Calibration — ${todayStr}`);
  out.push('━'.repeat(46));

  out.push('\nCalibration (your funnel vs market):');
  if (cal.everApplied === 0) {
    out.push('  no applications sent yet — calibration starts at your first Applied row');
  } else {
    out.push(fmtCalibrationLine('Response rate', cal.responseRate, cal.smallSample, cal.everApplied));
    out.push(fmtCalibrationLine('Interview rate', cal.interviewRate, cal.smallSample, cal.everApplied));
    if (cal.basis === 'ledger') out.push('  (rates fold status-log history — a row rejected after an interview still counts as reaching Interview)');
    if (cal.smallSample) out.push(`  (comparative claims need n≥${cal.claimMinN} applied; you have ${cal.everApplied})`);
  }

  out.push('\nWaiting (in-flight applications):');
  if (!waiting.inFlight) {
    out.push('  none in Applied right now');
  } else {
    out.push(`  ${waiting.inFlight} in flight. Typical first-response window: ${waiting.windowDays[0]}–${waiting.windowDays[1]} days (${waiting.windowSource?.year ?? 'n/a'}, directional; many applications never get a response — silence is common, not a verdict).`);
    for (const item of waiting.items) {
      if (item.appliedDate === null) { out.push(`  #${item.num} ${item.company} — applied date unknown (no dated Applied observation; add "Applied YYYY-MM-DD" to its notes or use set-status)`); continue; }
      const flag = item.beyondTypicalWindow ? `, beyond typical ${waiting.windowDays[0]}–${waiting.windowDays[1]}d window → consider followup mode` : '';
      out.push(`  #${item.num} ${item.company} — applied ${item.appliedDate} (${item.elapsedDays}d${flag})`);
    }
  }

  out.push('\nVelocity (days per stage, from the transition ledger):');
  const hopsWithData = Object.values(velocity).filter(h => !h.insufficientData);
  for (const h of Object.values(velocity)) {
    const extras: string[] = [];
    if (h.censored) extras.push(`${h.censored} still waiting, excluded`);
    if (h.sameDayExcluded) extras.push(`${h.sameDayExcluded} same-day catch-up entr${h.sameDayExcluded === 1 ? 'y' : 'ies'} excluded`);
    const extraStr = extras.length ? `; ${extras.join('; ')}` : '';
    if (h.insufficientData) {
      out.push(`  ${h.from}→${h.to}: insufficient data (n=${h.n}${extraStr})`);
    } else {
      const bm = h.benchmark ? ` vs ${h.benchmark.rangeDays[0]}–${h.benchmark.rangeDays[1]}d typical (${h.benchmark.year ?? 'n/a'}, directional)` : '';
      out.push(`  ${h.from}→${h.to}: median ${h.median}d, p75 ${h.p75}d${bm} (n=${h.n} completed${extraStr} — median reflects answered applications only)`);
    }
  }
  if (!hopsWithData.length && dq.observations === 0) {
    out.push('  ledger is empty — velocity accrues as statuses change through packages/cli/src/commands/tracker/set-status.ts');
  }

  out.push('\nData quality:');
  out.push(`  velocity data for ${dq.coveredRows} of ${dq.trackerRows} tracker rows (rows predating the log or edited outside set-status have no dated transitions)`);
  if (dq.unparseable.length) {
    out.push(`  ⚠ ${dq.unparseable.length} unparseable ledger line${dq.unparseable.length === 1 ? '' : 's'}:`);
    for (const u of dq.unparseable) out.push(`      line ${u.line}: ${u.reason}`);
  } else out.push('  unparseable ledger lines: none');
  if (dq.unknownSources.length) {
    out.push(`  ⚠ ${dq.unknownSources.length} observation${dq.unknownSources.length === 1 ? '' : 's'} with unrecognized source (excluded from day-math):`);
    for (const s of dq.unknownSources) out.push(`      line ${s.line}: #${s.num} source "${s.source}"`);
  } else out.push('  unrecognized sources: none');
  if (dq.orphans.length) {
    out.push(`  ⚠ ${dq.orphans.length} orphaned tracker#${dq.orphans.length === 1 ? '' : 's'} in the ledger (renumbering/dedup can strand them): ${dq.orphans.map((n: number) => `#${n}`).join(', ')}`);
  } else out.push('  orphaned ledger entries: none');
  if (dq.newestObservation) out.push(`  newest observation: ${dq.newestObservation}`);
  out.push('');
  return out.join('\n');
}

// --- Self-test ---
function selfTest(): void {
  let failures = 0;
  const check = (cond: unknown, msg: string): void => {
    if (!cond) { console.error(`SELF-TEST FAIL: ${msg}`); failures++; }
  };
  const states = loadCanonicalStates(STATES_FILE);
  const TODAY = '2026-07-08';

  // -- parser --
  const LOG_FIXTURE = [
    '1\t2026-06-01\tEvaluated\tApplied\tset-status\t',
    '1\t2026-06-08\tApplied\tResponded\tset-status\t',
    '1\t2026-06-15\tResponded\tInterview\tset-status\t',
    '1\t2026-06-30\tInterview\tOffer\tset-status\t',
    '2\t2026-06-01\t-\tApplied\tset-status\tunknown prior state',
    '2\t2026-06-11\tApplied\tResponded\tset-status\t',
    '2\t2026-06-09\tApplied\tResponded\tcorrection\tthey actually replied on the 9th',
    '3\t2026-06-05\tEvaluated\tApplied\tset-status\t',
    '3\t2026-06-05\tApplied\tResponded\tset-status\tsame-day catch-up',
    '4\t2026-06-20\tEvaluated\tApplied\tset-status\t',
    '5\t2026-06-01\tEvaluated\tApplied\tset-status\t',
    '5\t2026-06-02\tApplied\tInterview\tset-status\tmis-click',
    '5\t2026-06-02\t-\t-\tset-status\tretract the mis-click',
    '6\t2026-06-03\tEvaluated\tApplied\tfuture-import\tunknown source on purpose',
    '99\t2026-06-01\tEvaluated\tApplied\tset-status\torphan - not in tracker',
    'x\t2026-06-01\tEvaluated\tApplied\tset-status\tbad num',
    '7\t06/01/2026\tEvaluated\tApplied\tset-status\tbad date',
    '8\t2026-06-01\tEvaluated\tShortlisted\tset-status\tnon-canonical state',
    '',
    '# comment line',
  ].join('\n');

  const { observations, unparseable, unknownSources } = parseStatusLog(LOG_FIXTURE, states);
  check(unparseable.length === 3, `parser: expected 3 unparseable, got ${unparseable.length}`);
  check(unparseable.some(u => u.reason.includes('bad tracker#')), 'parser: bad num reported');
  check(unparseable.some(u => u.reason.includes('bad date')), 'parser: bad date reported');
  check(unparseable.some(u => u.reason.includes('unknown to-state')), 'parser: non-canonical state reported');
  check(unknownSources.length === 1 && unknownSources[0].source === 'future-import', 'parser: unknown source counted');
  check(observations.find(o => o.source === 'future-import')?.dayMath === false, 'parser: unknown source excluded from day-math');
  check(observations.find(o => o.num === 2 && o.from === null), 'parser: "-" from-state parses as null');

  // A status change made from the web app is observed live, at the moment the
  // user makes it — the same event as a set-status transition entering through
  // a different door. Excluding it does not drop the rows, which is what makes
  // the failure quiet: they are parsed, counted, flagged under unknownSources,
  // and contribute nothing to the hop figures, so a web-driven install reads as
  // an empty funnel rather than a broken one. Its own fixture so the counts
  // pinned above stay pinned.
  const WEB_FIXTURE = [
    '1\t2026-06-01\tEvaluated\tApplied\tweb\t',
    '1\t2026-06-08\tApplied\tResponded\tweb\t',
  ].join('\n');
  const web = parseStatusLog(WEB_FIXTURE, states);
  check(web.unknownSources.length === 0, `parser: web is a recognized source (got ${web.unknownSources.length} unknown)`);
  check(web.observations.length === 2 && web.observations.every(o => o.dayMath === true),
    'parser: web observations are trusted for day-math');

  // The rows above are a clean 7-day Applied→Responded hop. Asserting the
  // parse alone would not have caught this: the defect was never that the rows
  // failed to parse, it was that a parsed row reached no figure.
  const webVelocity = computeVelocity(foldObservations(web.observations), TODAY);
  check(webVelocity.appliedToResponded.n === 1,
    `velocity: a web transition reaches the hop figures (expected n=1, got ${webVelocity.appliedToResponded.n})`);

  // reply-watch is the same event class as set-status/web: the user confirms the
  // update interactively and it is recorded at that moment (not reconstructed
  // after the fact the way backfill/manual are). A reply-watch transition that is
  // excluded from day-math silently empties the velocity figures for users who
  // manage their inbox through reply-watch. Its own fixture so the counts above
  // stay pinned and this source is covered independently.
  const REPLY_WATCH_FIXTURE = [
    '1\t2026-06-01\tEvaluated\tApplied\treply-watch\t',
    '1\t2026-06-09\tApplied\tResponded\treply-watch\t',
  ].join('\n');
  const rw = parseStatusLog(REPLY_WATCH_FIXTURE, states);
  check(rw.unknownSources.length === 0, `parser: reply-watch is a recognized source (got ${rw.unknownSources.length} unknown)`);
  check(rw.observations.length === 2 && rw.observations.every(o => o.dayMath === true),
    'parser: reply-watch observations are trusted for day-math');
  const rwVelocity = computeVelocity(foldObservations(rw.observations), TODAY);
  check(rwVelocity.appliedToResponded.n === 1,
    `velocity: a reply-watch transition reaches the hop figures (expected n=1, got ${rwVelocity.appliedToResponded.n})`);

  // -- fold --
  const timelines = foldObservations(observations);
  const t2 = timelines.get(2);
  check(t2?.length === 2, `fold: row 2 expected 2 observations, got ${t2?.length}`);
  check(t2?.[1].date === '2026-06-09' && t2[1].source === 'correction', 'fold: correction replaces same-(num,to) date');
  const t5 = timelines.get(5);
  check(t5?.length === 1 && t5[0].to === 'Applied', `fold: retraction removes latest observation (got ${t5?.map(o => o.to).join(',')})`);

  // -- percentiles --
  check(median([3, 6, 20]) === 6, 'median odd');
  check(median([3, 6]) === 4.5, 'median even');
  check(p75([3, 6, 20]) === 13, `p75 interpolation: expected 13, got ${p75([3, 6, 20])}`);
  check(p75([5]) === 5, 'p75 single value');

  // -- velocity --
  const velocity = computeVelocity(timelines, TODAY);
  check(velocity.appliedToResponded.n === 2, `velocity: A→R expected n=2 (rows 1,2), got ${velocity.appliedToResponded.n}`);
  check(velocity.appliedToResponded.insufficientData === true, 'velocity: n=2 < 3 → insufficient');
  check(velocity.appliedToResponded.median === null, 'velocity: insufficient → no median');
  check(velocity.appliedToResponded.sameDayExcluded === 1, `velocity: row 3 same-day hop excluded+counted, got ${velocity.appliedToResponded.sameDayExcluded}`);
  // rows 4, 5, 99 sit in Applied with no later observation → censored (still waiting)
  check(velocity.appliedToResponded.censored === 3, `velocity: expected 3 censored, got ${velocity.appliedToResponded.censored}`);
  check(velocity.appliedToRejected.censored === 0, 'velocity: rejection hop does not double-count censoring');
  check(velocity.interviewToOffer.n === 1 && velocity.interviewToOffer.insufficientData, 'velocity: I→O n=1 insufficient');

  const ASSESSMENT_FIXTURE = [
    '10\t2026-06-01\tApplied\tResponded\tset-status\t',
    '10\t2026-06-04\tResponded\tAssessment\tset-status\t',
    '10\t2026-06-09\tAssessment\tInterview\tset-status\t',
  ].join('\n');
  const assessmentVelocity = computeVelocity(
    foldObservations(parseStatusLog(ASSESSMENT_FIXTURE, states).observations),
    TODAY,
  );
  check(assessmentVelocity.respondedToAssessment.n === 1,
    `velocity: Responded→Assessment expected n=1, got ${assessmentVelocity.respondedToAssessment.n}`);
  check(assessmentVelocity.assessmentToInterview.n === 1,
    `velocity: Assessment→Interview expected n=1, got ${assessmentVelocity.assessmentToInterview.n}`);
  check(assessmentVelocity.respondedToInterview.n === 0,
    `velocity: Assessment path must not count as legacy Responded→Interview, got n=${assessmentVelocity.respondedToInterview.n}`);

  // three completed A→R measurements → median renders
  const logWithThird = LOG_FIXTURE + '\n4\t2026-06-27\tApplied\tResponded\tset-status\t';
  const v3 = computeVelocity(foldObservations(parseStatusLog(logWithThird, states).observations), TODAY);
  check(v3.appliedToResponded.n === 3 && v3.appliedToResponded.median === 7, `velocity: [7,8,7] → median 7, got n=${v3.appliedToResponded.n} median=${v3.appliedToResponded.median}`);
  check(v3.appliedToResponded.censored === 2, 'velocity: censored drops to 2 after row 4 completes');

  // -- benchmarks + classification --
  const bm = loadBenchmarks(join(CODE_ROOT, 'templates/benchmarks.yml')).benchmarks;
  const bmResponseRate = bm.response_rate;
  const bmFirstResponse = bm.days_first_response;
  check(isRecord(bmResponseRate) && Array.isArray(bmResponseRate.range_pct), 'benchmarks: shipped file loads');
  check(isRecord(bmFirstResponse) && Array.isArray(bmFirstResponse.range_days) && bmFirstResponse.range_days[1] === 14, 'benchmarks: first-response window upper bound');
  check(!('time_to_fill' in bm), 'benchmarks: employer-side time_to_fill must not exist');
  check(classify(1.5, bm.response_rate)?.band === 'below-range', 'classify: below');
  check(classify(6, bm.response_rate)?.band === 'within-range', 'classify: within');
  check(classify(14, bm.response_rate)?.band === 'above-range', 'classify: above');
  check(classify(2, bm.response_rate)?.band === 'within-range', 'classify: lower bound inclusive');
  check(classify(13, bm.response_rate)?.band === 'within-range', 'classify: upper bound inclusive');
  check(classify(6, bm.response_rate)?.vsTypical === 2, 'classify: vsTypical multiplier');

  // -- calibration gating --
  const mkTracker = (applied: number, responded: number): string => {
    const header = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|';
    const rows: string[] = [];
    let n = 1;
    for (let i = 0; i < applied; i++) rows.push(`| ${n++} | 2026-06-01 | Co${n} | Role | 4.0/5 | Applied | ❌ | - | |`);
    for (let i = 0; i < responded; i++) rows.push(`| ${n++} | 2026-06-01 | Co${n} | Role | 4.0/5 | Responded | ❌ | - | Applied 2026-06-01 |`);
    return `${header}\n${rows.join('\n')}`;
  };
  const small = analyze({ trackerContent: mkTracker(16, 1), logContent: '', benchmarks: bm, states, todayStr: TODAY });
  check(small.calibration.smallSample === true, 'calibration: n=17 < 20 → smallSample');
  const smallSummary = renderSummary(small, TODAY);
  check(!/[\d.]+× typical/.test(smallSummary), 'tone: no multiplier claim under n=20');
  check(smallSummary.includes('directional only'), 'tone: small-sample label present');

  const big = analyze({ trackerContent: mkTracker(38, 2), logContent: '', benchmarks: bm, states, todayStr: TODAY });
  check(big.calibration.smallSample === false, 'calibration: n=40 → claims allowed');
  check(big.calibration.responseRate?.ownPct === 5, `calibration: 2/40 = 5%, got ${big.calibration.responseRate?.ownPct}`);
  const bigSummary = renderSummary(big, TODAY);
  check(bigSummary.includes('within the typical band'), 'tone: within-band phrasing');

  // above-range → selection-bias note; below-range → single action pointer
  const above = renderSummary(analyze({ trackerContent: mkTracker(25, 15), logContent: '', benchmarks: bm, states, todayStr: TODAY }), TODAY);
  check(above.includes(SELECTION_BIAS_NOTE), 'tone: above-range carries selection-bias note');
  const below = renderSummary(analyze({ trackerContent: mkTracker(40, 0), logContent: '', benchmarks: bm, states, todayStr: TODAY }), TODAY);
  check(below.includes(BELOW_RANGE_ACTION), 'tone: below-range carries the single action pointer');
  check(below.includes('(2025, directional)'), 'tone: benchmark year + directional attached');

  // -- ledger-aware calibration (#3493): a terminal Rejected snapshot must not
  // erase the middle stages the row actually reached. Same shape packages/core/src/insights/stats.ts uses. --
  const ledgerHeader = '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|';
  const ledgerRows: string[] = [];
  for (let i = 1; i <= 21; i++) ledgerRows.push(`| ${i} | 2026-06-01 | Co${i} | Role | 4.0/5 | Applied | ❌ | - | |`);
  for (let i = 22; i <= 25; i++) ledgerRows.push(`| ${i} | 2026-06-01 | Co${i} | Role | 4.0/5 | Rejected | ❌ | - | |`);
  const ledgerTracker = `${ledgerHeader}\n${ledgerRows.join('\n')}`;
  const ledgerLog = [
    '22\t2026-06-02\tApplied\tResponded\tset-status\t',
    '22\t2026-06-09\tResponded\tInterview\tset-status\t',
    '22\t2026-06-20\tInterview\tRejected\tset-status\t',
    '23\t2026-06-02\tApplied\tResponded\tset-status\t',
    '23\t2026-06-09\tResponded\tInterview\tset-status\t',
    '23\t2026-06-20\tInterview\tRejected\tset-status\t',
    '24\t2026-06-03\tApplied\tResponded\tset-status\t',
    '24\t2026-06-18\tResponded\tRejected\tset-status\t',
  ].join('\n');
  const snap = analyze({ trackerContent: ledgerTracker, logContent: '', benchmarks: bm, states, todayStr: TODAY });
  check(snap.calibration.basis === 'snapshot', 'ledger-funnel: no log → snapshot basis');
  check(snap.calibration.interviewRate?.ownPct === 0, `ledger-funnel: snapshot erases interviews reached, got ${snap.calibration.interviewRate?.ownPct}`);
  const led = analyze({ trackerContent: ledgerTracker, logContent: ledgerLog, benchmarks: bm, states, todayStr: TODAY });
  check(led.calibration.basis === 'ledger', 'ledger-funnel: log present → ledger basis');
  check(led.calibration.everApplied === 25, `ledger-funnel: everApplied still 25, got ${led.calibration.everApplied}`);
  check(led.calibration.interviewRate?.ownPct === 8, `ledger-funnel: 2/25 reached Interview → 8%, got ${led.calibration.interviewRate?.ownPct}`);
  check(led.calibration.responseRate?.ownPct === 16, `ledger-funnel: 4/25 received a reply including rejection → 16%, got ${led.calibration.responseRate?.ownPct}`);
  check(renderSummary(led, TODAY).includes('rates fold status-log history'), 'ledger-funnel: summary flags the folded basis');
  check(!renderSummary(snap, TODAY).includes('rates fold status-log history'), 'ledger-funnel: snapshot summary carries no fold note');

  // A log with no *parsed* history — header row, comments, torn rows — must stay
  // on the snapshot basis: taking the ledger path would stamp basis:'ledger' on
  // a funnel identical to the snapshot and wrongly print the fold note.
  for (const [label, emptyLog] of [
    ['header only', '#\tdate\tfrom\tto\tsource\tnote'],
    ['comment only', '# migrated 2026-06-01 — no transitions yet'],
    ['torn rows only', 'x\t2026-06-02\tApplied\tResponded\nx\t2026-06-09\tResponded\tInterview'],
    ['whitespace', '   \n\t\n'],
  ]) {
    const r = analyze({ trackerContent: ledgerTracker, logContent: emptyLog, benchmarks: bm, states, todayStr: TODAY });
    check(r.calibration.basis === 'snapshot', `ledger-funnel: ${label} log → snapshot basis`);
    check(r.calibration.interviewRate?.ownPct === snap.calibration.interviewRate?.ownPct, `ledger-funnel: ${label} log leaves rates on the snapshot value`);
    check(!renderSummary(r, TODAY).includes('rates fold status-log history'), `ledger-funnel: ${label} log carries no fold note`);
  }

  // everX counts distinct tracker rows, so a transition the ledger records more
  // than once (a re-applied set-status, a torn-then-rewritten append) must not
  // inflate the funnel — the ledger result is identical with each line doubled.
  const dupLog = ledgerLog.split('\n').flatMap(l => [l, l]).join('\n');
  const dup = analyze({ trackerContent: ledgerTracker, logContent: dupLog, benchmarks: bm, states, todayStr: TODAY });
  check(dup.calibration.everApplied === led.calibration.everApplied, `ledger-funnel: duplicated transitions leave everApplied at ${led.calibration.everApplied}, got ${dup.calibration.everApplied}`);
  check(dup.calibration.interviewRate?.ownPct === led.calibration.interviewRate?.ownPct, `ledger-funnel: duplicated transitions leave interviewRate at ${led.calibration.interviewRate?.ownPct}%, got ${dup.calibration.interviewRate?.ownPct}%`);
  check(dup.calibration.responseRate?.ownPct === led.calibration.responseRate?.ownPct, `ledger-funnel: duplicated transitions leave responseRate at ${led.calibration.responseRate?.ownPct}%, got ${dup.calibration.responseRate?.ownPct}%`);
  // A row that genuinely bounces back and forth is still one row at its deepest
  // stage — Responded→Interview→Responded→Interview counts once into everInterview.
  const bounceLog = [
    '2\t2026-06-02\tApplied\tResponded\tset-status\t',
    '2\t2026-06-09\tResponded\tInterview\tset-status\t',
    '2\t2026-06-12\tInterview\tResponded\tset-status\t',
    '2\t2026-06-15\tResponded\tInterview\tset-status\t',
  ].join('\n');
  const bounce = analyze({ trackerContent: ledgerTracker, logContent: bounceLog, benchmarks: bm, states, todayStr: TODAY });
  check(bounce.calibration.interviewRate?.ownPct === 4, `ledger-funnel: a bouncing row counts once → 1/25 = 4%, got ${bounce.calibration.interviewRate?.ownPct}`);

  // A current Discarded row with no ledger history stays out of everApplied in
  // both funnels — Discarded (unlike Rejected) does not by itself prove a
  // submission, and the ledger path must not silently diverge from the snapshot.
  const discardTracker = `${ledgerHeader}\n${[
    ...Array.from({ length: 10 }, (_, i) => `| ${i + 1} | 2026-06-01 | Co${i + 1} | Role | 4.0/5 | Applied | ❌ | - | |`),
    '| 11 | 2026-06-01 | Co11 | Role | 4.0/5 | Discarded | ❌ | - | |',
  ].join('\n')}`;
  const discardSnap = analyze({ trackerContent: discardTracker, logContent: '', benchmarks: bm, states, todayStr: TODAY });
  const discardLed = analyze({ trackerContent: discardTracker, logContent: '1\t2026-06-05\tApplied\tResponded\tset-status\t', benchmarks: bm, states, todayStr: TODAY });
  check(discardSnap.calibration.everApplied === 10, `ledger-funnel: snapshot leaves a no-history Discarded row out of everApplied, got ${discardSnap.calibration.everApplied}`);
  check(discardLed.calibration.everApplied === discardSnap.calibration.everApplied, `ledger-funnel: ledger path agrees with snapshot on a no-history Discarded row, got ${discardLed.calibration.everApplied} vs ${discardSnap.calibration.everApplied}`);

  // -- waiting --
  const waitTracker = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-06-01 | LogCo | Role | 4.0/5 | Applied | ❌ | - | |',
    '| 2 | 2026-06-01 | NotesCo | Role | 4.0/5 | Applied | ❌ | - | Applied 2026-07-01 |',
    '| 3 | 2026-06-01 | UnknownCo | Role | 4.0/5 | Applied | ❌ | - | evaluated only |',
    '| 4 | 2026-06-01 | DoneCo | Role | 4.0/5 | Responded | ❌ | - | Applied 2026-06-01 |',
  ].join('\n');
  const waitLog = '1\t2026-06-10\tEvaluated\tApplied\tset-status\t';
  const wait = analyze({ trackerContent: waitTracker, logContent: waitLog, benchmarks: bm, states, todayStr: TODAY }).waiting;
  check(wait.inFlight === 3, `waiting: 3 Applied rows in flight, got ${wait.inFlight}`);
  const w1 = wait.items.find(i => i.num === 1);
  check(w1?.dateSource === 'status-log' && w1.appliedDate === '2026-06-10', 'waiting: ledger date wins');
  check(w1?.elapsedDays === 28 && w1.beyondTypicalWindow === true, `waiting: 28d beyond 14d window, got ${w1?.elapsedDays}`);
  const w2 = wait.items.find(i => i.num === 2);
  check(w2?.dateSource === 'tracker-notes' && w2.elapsedDays === 7 && w2.beyondTypicalWindow === false, 'waiting: notes date fallback, within window');
  const w3 = wait.items.find(i => i.num === 3);
  check(w3?.dateSource === 'unknown' && w3.appliedDate === null, 'waiting: unknown date listed, never guessed');
  check(!wait.items.some(i => i.num === 4), 'waiting: non-Applied rows excluded');

  // Non-canonical Applied rows must still count as in-flight. The funnel counts
  // everApplied through normalizeStatus, so lowercase "applied", a status
  // carrying a date, a localized "Aplicado", and markdown-bold "**Applied**"
  // belong in the waiting backlog too (regression: a raw row.status !== 'Applied'
  // filter dropped all four and under-reported follow-ups).
  const noncanonTracker = [
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '| 1 | 2026-06-01 | CanonCo | Role | 4.0/5 | Applied | ❌ | - | Applied 2026-07-01 |',
    '| 2 | 2026-06-01 | LowerCo | Role | 4.0/5 | applied | ❌ | - | Applied 2026-07-01 |',
    '| 3 | 2026-06-01 | DatedCo | Role | 4.0/5 | Applied 2026-06-01 | ❌ | - | Applied 2026-07-01 |',
    '| 4 | 2026-06-01 | LocaleCo | Role | 4.0/5 | Aplicado | ❌ | - | Applied 2026-07-01 |',
    '| 5 | 2026-06-01 | BoldCo | Role | 4.0/5 | **Applied** | ❌ | - | Applied 2026-07-01 |',
  ].join('\n');
  const noncanon = analyze({ trackerContent: noncanonTracker, logContent: '', benchmarks: bm, states, todayStr: TODAY });
  check(noncanon.waiting.inFlight === 5, `waiting: non-canonical Applied variants all count in-flight, got ${noncanon.waiting.inFlight}`);
  // The waiting count must agree with the funnel's everApplied for the same rows —
  // both canonicalize status the same way, so neither may silently drop a variant.
  check(noncanon.calibration.everApplied === 5, `waiting: in-flight agrees with everApplied on non-canonical rows, got ${noncanon.calibration.everApplied}`);

  // -- data quality --
  const dq = analyze({ trackerContent: waitTracker, logContent: LOG_FIXTURE, benchmarks: bm, states, todayStr: TODAY }).dataQuality;
  check(dq.orphans.length >= 1 && dq.orphans.includes(99), 'dataQuality: orphan #99 surfaced');
  check(dq.unparseable.length === 3, 'dataQuality: unparseable lines surfaced');
  check(dq.newestObservation === '2026-06-30', `dataQuality: newest observation, got ${dq.newestObservation}`);
  const dqSummary = renderSummary(analyze({ trackerContent: waitTracker, logContent: LOG_FIXTURE, benchmarks: bm, states, todayStr: TODAY }), TODAY);
  check(dqSummary.includes('velocity data for'), 'summary: coverage line present');
  check(dqSummary.includes('still waiting, excluded'), 'summary: censoring surfaced next to velocity');

  // -- interview→offer day benchmark wiring --
  const ioLog = [
    '1\t2026-05-01\tResponded\tInterview\tset-status\t',
    '1\t2026-05-22\tInterview\tOffer\tset-status\t',
    '2\t2026-05-01\tResponded\tInterview\tset-status\t',
    '2\t2026-05-26\tInterview\tOffer\tset-status\t',
    '3\t2026-05-01\tResponded\tInterview\tset-status\t',
    '3\t2026-05-31\tInterview\tOffer\tset-status\t',
  ].join('\n');
  const ioResult = analyze({ trackerContent: waitTracker, logContent: ioLog, benchmarks: bm, states, todayStr: TODAY });
  check(ioResult.velocity.interviewToOffer.benchmark?.rangeDays?.[0] === 20, 'io-benchmark: days_interview_to_offer attached to the hop');
  check(ioResult.velocity.interviewToOffer.n === 3 && ioResult.velocity.interviewToOffer.median === 25, `io-benchmark: [21,25,30] → median 25, got ${ioResult.velocity.interviewToOffer.median}`);
  const ioSummary = renderSummary(ioResult, TODAY);
  check(ioSummary.includes('vs 20–28d typical (2019, directional)'), 'io-benchmark: summary carries the benchmark with year + directional');
  check(!renderSummary(analyze({ trackerContent: waitTracker, logContent: '', benchmarks: bm, states, todayStr: TODAY }), TODAY).includes('20–28d typical'), 'io-benchmark: no benchmark context without a median (claims stay gated)');
  // n=1 I→O hop → insufficientData, median null → benchmark must not leak into JSON output
  const ioInsufficient = analyze({ trackerContent: waitTracker, logContent: LOG_FIXTURE, benchmarks: bm, states, todayStr: TODAY });
  check(ioInsufficient.velocity.interviewToOffer.insufficientData === true && !('benchmark' in ioInsufficient.velocity.interviewToOffer), 'io-benchmark: not attached when median is null (JSON output stays gated)');

  // -- missing year in a user-override benchmark file must render n/a, not null --
  const bmNoYear: Record<string, unknown> = JSON.parse(JSON.stringify(bm));
  const dropYear = (doc: Record<string, unknown>, key: string): void => {
    const metric = doc[key];
    if (isRecord(metric)) delete metric.year;
  };
  dropYear(bmNoYear, 'response_rate');
  dropYear(bmNoYear, 'application_to_interview');
  dropYear(bmNoYear, 'days_interview_to_offer');
  const noYearSummary = renderSummary(analyze({ trackerContent: mkTracker(40, 0), logContent: ioLog, benchmarks: bmNoYear, states, todayStr: TODAY }), TODAY);
  check(noYearSummary.includes('(n/a, directional)'), 'no-year: renders n/a fallback');
  check(!noYearSummary.includes('null, directional'), 'no-year: never prints (null, directional)');

  // -- empty state --
  const empty = analyze({ trackerContent: '', logContent: '', benchmarks: bm, states, todayStr: TODAY });
  check(empty.calibration.everApplied === 0, 'empty: zero applied');
  const emptySummary = renderSummary(empty, TODAY);
  check(emptySummary.includes('calibration starts at your first Applied row'), 'empty: friendly zero state');
  check(emptySummary.includes('ledger is empty'), 'empty: ledger explainer');

  if (failures) { console.error(`\n${failures} self-test failure(s)`); process.exit(1); }
  console.log('funnel-velocity self-test OK (parser + fold + percentiles + velocity/censoring + benchmarks + calibration gating + waiting + tone contract)');
}

// --- Main ---
function main(): void {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });

  const summaryMode = args.includes('--summary');
  const selfTestMode = args.includes('--self-test');
  if (selfTestMode) { selfTest(); return; }

  let benchmarks: Record<string, unknown>;
  try {
    benchmarks = loadBenchmarks(flagValue(args, '--benchmarks')).benchmarks;
  } catch (err) {
    console.error(`Error: ${errorText(err)}`);
    process.exit(1);
  }
  const states = loadCanonicalStates(STATES_FILE);
  const trackerPath = resolveTrackerPath(DATA_ROOT);
  const logPath = join(dirname(trackerPath), 'status-log.tsv');
  const trackerContent = existsSync(trackerPath) ? readFileSync(trackerPath, 'utf-8') : '';
  const logContent = existsSync(logPath) ? readFileSync(logPath, 'utf-8') : '';
  // LOCAL day: the UTC day is tomorrow for a west-of-Greenwich evening run, so
  // every "waiting" figure read one day high (#3070).
  const todayStr = localToday();

  if (!trackerContent) {
    if (summaryMode) console.log(`No tracker found at ${trackerPath} — nothing to calibrate yet.`);
    else console.log(JSON.stringify({ calibration: null, waiting: null, velocity: null, dataQuality: { trackerRows: 0, note: `no tracker at ${trackerPath}` } }, null, 2));
    return;
  }

  const result = analyze({ trackerContent, logContent, benchmarks, states, todayStr });
  if (summaryMode) console.log(renderSummary(result, todayStr));
  else console.log(JSON.stringify({ ...result, generatedAt: todayStr }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
