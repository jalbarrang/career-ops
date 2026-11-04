// Zoho Recruit provider — target list: `tracked_companies:` (one Zoho Recruit
// tenant's career site per entry).
//
// Auto-detects any `https://<tenant>.zohorecruit.com` careers_url. Only the
// hostname is used: the board is always read from `/jobs/Careers`, which every
// tenant with the current career site serves, whatever its own portal name
// (`Emplois`, …) or the path the configured URL carries (a posting, the bare
// host, the legacy `/recruit/Portal.na`). Posting URLs are built under the
// same path.
//
// The career site is server-rendered: the whole board sits in the list page
// as `<input type="hidden" id="jobs" value="[…]">`, a JSON array whose
// quotes are HTML-entity-escaped. One list request per tenant, no auth.
//   - `id="jobs"` present with `[]`     → a live board with nothing open.
//   - `id="jobs"` absent on the page   → throw. Zoho answers 200 with a
//     "Page does not exist" page for an unknown tenant, and for a tenant that
//     only has the legacy career site, so a missing input is the only signal
//     that tells a broken or unsupported board from an empty one.
// Rows marked `Is_Locked: true` or `Publish: false` are postings the career
// site shows as filled, and are skipped.
//
// Each posting's own page (`/jobs/Careers/<id>`) embeds its record as a
// JavaScript string literal, `var jobs = JSON.parse('[…]')`, with HTML
// `Job_Description`, `Date_Opened` and a free-text `Salary`.
// parseZohoDetailPage() reads it without evaluating any script; the scan
// uses it only under the opt-in below, and liveness-api.ts /
// browser-extract.ts use it for a posting's liveness and JD text.
//
//   - name: Example Zoho Recruit Co
//     careers_url: https://exampleco.zohorecruit.com/jobs/Careers
//     zohoRecruit:
//       fetchDetails: true   # optional: fetch each posting's page for description, date and salary
//       detailLimit: 25      # optional: max detail fetches per sweep (1..100, default 25)

import { intInRange } from './_config-utils.ts';
import { decodeEntities } from './_html-entities.ts';
import { htmlToText } from './_html-to-text.ts';
import { fetchTextWithRetry, sleep } from './_http.ts';
import { compensationCurrency, parseAnnualCompensation } from './_salary-text.ts';
import { safeEncodeURIComponent } from './_safe-url.ts';
import type { Context, DetectHit, Job, JobSalary, PortalEntry, Provider } from './_types.ts';

const ZOHO_HOST_RE = /^[a-z0-9][a-z0-9-]*\.zohorecruit\.com$/;
const BOARD_PATH = '/jobs/Careers';
const DETAIL_PACE_MS = 250;

/** The tenant board an entry points at. */
interface ZohoBoard {
  origin: string;
  boardUrl: string;
}

/** A normalized list row paired with the raw record it came from. */
interface ZohoRow {
  job: Job;
  record: Record<string, unknown>;
}

/** Opt-in detail-enrichment config. */
interface ZohoConfig {
  fetchDetails: boolean;
  detailLimit: number;
}

/**
 * Narrowing guard for a JSON object — never null, never an array.
 *
 * @param value - Value to test.
 * @returns True when `value` is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param value - Raw field.
 * @returns The trimmed string, or '' for anything else.
 */
function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @param value - Raw timestamp.
 * @returns Epoch ms, or undefined when absent or unparseable.
 */
function toEpochMs(value: unknown): number | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Parse an entry's careers_url / api into its Zoho Recruit host, or null for
 * anything that is not an HTTPS `<tenant>.zohorecruit.com` URL.
 *
 * @param entry - Portal entry.
 * @returns The validated URL, or null.
 */
function parseZohoUrl(entry: PortalEntry): URL | null {
  const raw = str(entry?.careers_url) || str(entry?.api);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (!ZOHO_HOST_RE.test(parsed.hostname)) return null;
  return parsed;
}

/**
 * The board an entry points at: the origin rebuilt from the hostname alone,
 * and the fixed list path. The configured path and port are discarded.
 *
 * @param entry - Portal entry.
 * @returns The tenant board, or null when the entry is not a Zoho Recruit one.
 */
export function resolveZohoBoard(entry: PortalEntry): ZohoBoard | null {
  const parsed = parseZohoUrl(entry);
  if (!parsed) return null;
  const origin = `https://${parsed.hostname}`;
  return { origin, boardUrl: `${origin}${BOARD_PATH}` };
}

// A tag ends at an unquoted `>`: a JSON value inside an attribute can carry a
// literal `>`.
const INPUT_TAG_RE = /<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

/**
 * The raw job records from a list page's `<input id="jobs">`. Throws when the
 * input is missing or its value is not a JSON array — a missing page or a
 * markup change, never an empty board.
 *
 * @param html - The list page markup.
 * @returns The raw records, each still opaque.
 */
export function extractZohoListRecords(html: unknown): unknown[] {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('zoho-recruit: empty careers page');
  }
  let value: string | null = null;
  for (const [tag] of html.matchAll(INPUT_TAG_RE)) {
    if (!/\sid\s*=\s*["']?jobs["'\s/>]/i.test(tag)) continue;
    const attr = tag.match(/\svalue\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    value = attr ? (attr[1] ?? attr[2] ?? '') : '';
    break;
  }
  if (value === null) {
    const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
    throw new Error(`zoho-recruit: no id="jobs" input on ${BOARD_PATH} — an unknown tenant, or one with only the legacy career site, which is not supported${title ? ` (page title: "${decodeEntities(title)}")` : ''}`);
  }
  let records: unknown;
  try {
    records = JSON.parse(decodeEntities(value));
  } catch (err) {
    throw new Error(`zoho-recruit: id="jobs" value is not JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(records)) {
    const got = records && typeof records === 'object' ? `{${Object.keys(records).join(', ')}}` : typeof records;
    throw new Error(`zoho-recruit: id="jobs" value is not an array, got: ${got}`);
  }
  return records;
}

/**
 * True for a record the career site shows as filled.
 *
 * @param record - Raw record.
 * @returns True when the posting is closed on the career site.
 */
export function isZohoRecordClosed(record: Record<string, unknown> | null | undefined): boolean {
  return record?.Is_Locked === true || record?.Publish === false;
}

/**
 * Location from the tenant-configured fields: city, state and country as
 * given, then "Remote" when the posting is flagged remote.
 *
 * @param record - Raw record.
 * @returns The assembled location string.
 */
function locationOf(record: Record<string, unknown>): string {
  const parts = [str(record.City), str(record.State), str(record.Country)].filter(Boolean);
  if (record.Remote_Job === true) parts.push('Remote');
  return [...new Set(parts)].join(', ');
}

/**
 * Normalize one list record, or null when it is filled or lacks a title/id.
 *
 * @param record - Raw record.
 * @param board - The tenant board.
 * @param company - Company name stamped on the Job.
 * @returns The normalized Job, or null.
 */
function normalizeRecord(record: unknown, board: ZohoBoard, company: string): Job | null {
  if (!isRecord(record) || isZohoRecordClosed(record)) return null;
  const title = str(record.Posting_Title) || str(record.Job_Opening_Name);
  if (!title) return null;
  const id = typeof record.id === 'number' ? String(record.id) : str(record.id);
  if (!id) return null;
  const seg = safeEncodeURIComponent(id);
  if (seg === null) return null;
  const job: Job = {
    title,
    url: `${board.origin}${BOARD_PATH}/${seg}`,
    company,
    location: locationOf(record),
    externalId: id,
  };
  const postedAt = toEpochMs(record.Date_Opened);
  if (postedAt !== undefined) job.postedAt = postedAt;
  const description: string = htmlToText(record.Job_Description);
  if (description) job.description = description;
  return job;
}

/**
 * List page → normalized jobs. Exported for tests.
 *
 * @param html - The list page markup.
 * @param board - The tenant board.
 * @param company - Company name stamped on every Job.
 * @returns The normalized jobs.
 */
export function parseZohoJobsPage(html: unknown, board: ZohoBoard, company: string): Job[] {
  return pairRecords(extractZohoListRecords(html), board, company).map(({ job }) => job);
}

/**
 * Pair each normalized Job with the raw record it came from.
 *
 * @param records - Raw records.
 * @param board - The tenant board.
 * @param company - Company name stamped on every Job.
 * @returns The surviving rows, deduped by URL.
 */
function pairRecords(records: unknown[], board: ZohoBoard, company: string): ZohoRow[] {
  const seen: Set<string> = new Set<string>();
  const out: ZohoRow[] = [];
  for (const record of records) {
    const job = normalizeRecord(record, board, company);
    if (!job || seen.has(job.url)) continue;
    seen.add(job.url);
    const raw: Record<string, unknown> = isRecord(record) ? record : {};
    out.push({ job, record: raw });
  }
  return out;
}

const JS_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * Unescape the body of a single-quoted JavaScript string literal (`\x22`,
 * `\u00e9`, `\n`, `\/`, `\-`, `\'`, line continuations). Never evaluates code.
 *
 * @param body - The literal's body, without the surrounding quotes.
 * @returns The unescaped string.
 */
function unescapeJsString(body: string): string {
  return body.replace(/\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]{1,6})\}|(\r\n|[\s\S]))/g,
    (_match: string, hex: string | undefined, u4: string | undefined, uBraced: string | undefined, ch: string): string => {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (u4) return String.fromCharCode(parseInt(u4, 16));
      if (uBraced) {
        const cp = parseInt(uBraced, 16);
        return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
      }
      if (ch === '\n' || ch === '\r' || ch === '\r\n' || ch === '\u2028' || ch === '\u2029') return '';
      return JS_ESCAPES[ch] ?? ch;
    });
}

const DETAIL_RECORD_RE = /\bjobs\s*=\s*JSON\.parse\(\s*'((?:[^'\\]|\\[\s\S])*)'\s*\)/;

/**
 * The posting record embedded in a detail page, or null when the page carries
 * none (a removed posting, an error page, a markup change). Exported for
 * liveness-api.ts and browser-extract.ts.
 *
 * @param html - The detail page markup.
 * @returns The embedded record, or null.
 */
export function parseZohoDetailPage(html: unknown): Record<string, unknown> | null {
  if (typeof html !== 'string') return null;
  const match = html.match(DETAIL_RECORD_RE);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unescapeJsString(match[1]));
  } catch {
    return null;
  }
  const record: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  return isRecord(record) ? record : null;
}

/**
 * Annual salary from a detail record's free-text `Salary` field, never
 * inferred. Currency: the one the text names, else the list record's
 * `Currency` field when the text names none, else unset. A non-annual period
 * ("$20-25/hr") or an unreadable amount yields null.
 *
 * @param salaryText - The free-text salary field.
 * @param listCurrency - The list record's `Currency` field, if any.
 * @returns The annual range, or null.
 */
export function parseZohoSalary(salaryText: unknown, listCurrency?: unknown): JobSalary | null {
  const text = str(salaryText);
  if (!text) return null;
  const amount: { min: number; max: number; mid: number } | null = parseAnnualCompensation(text);
  if (!amount || !(amount.max > 0)) return null;
  const named: string | undefined = compensationCurrency(text);
  const fallback = /^[A-Za-z]{3}$/.test(str(listCurrency)) ? str(listCurrency).toUpperCase() : '';
  const currency: string = named === undefined ? fallback : named;
  return { min: amount.min, max: amount.max, ...(currency ? { currency } : {}) };
}

/**
 * @param entry - Portal entry.
 * @returns The opt-in detail-enrichment config.
 */
function parseZohoConfig(entry: PortalEntry): ZohoConfig {
  const cfg: Record<string, unknown> = isRecord(entry?.zohoRecruit) ? entry.zohoRecruit : {};
  const detailLimit: number = intInRange(cfg.detailLimit, 25, 1, 100);
  return {
    fetchDetails: cfg.fetchDetails === true,
    detailLimit,
  };
}

/**
 * Fill description, postedAt and salary from each posting's own page.
 * Best-effort: a failed or unreadable detail fetch, or a page whose record is
 * not this posting's, keeps the list row.
 *
 * @param rows - Rows to enrich in place.
 * @param ctx - Scanner context.
 * @returns Resolves once every row has been tried.
 */
async function enrichFromDetails(rows: ZohoRow[], ctx: Context): Promise<void> {
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await sleep(DETAIL_PACE_MS, ctx);
    const { job, record } = rows[i];
    try {
      const html: unknown = await fetchTextWithRetry(ctx, job.url, { redirect: 'error' });
      const detail = parseZohoDetailPage(html);
      if (!detail || String(detail.id) !== job.externalId) continue;
      const description: string = htmlToText(detail.Job_Description);
      if (description) job.description = description;
      if (job.postedAt === undefined) {
        const postedAt = toEpochMs(detail.Date_Opened);
        if (postedAt !== undefined) job.postedAt = postedAt;
      }
      const salary = parseZohoSalary(detail.Salary, record.Currency);
      if (salary) job.salary = salary;
    } catch {
      // Detail enrichment is opt-in; keep the list row as-is.
    }
  }
}

const provider: Provider = {
  id: 'zoho-recruit',

  detect(entry: PortalEntry): DetectHit | null {
    const board = resolveZohoBoard(entry);
    return board ? { url: board.boardUrl } : null;
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const board = resolveZohoBoard(entry);
    if (!board) {
      throw new Error(`zoho-recruit: ${entry?.name || '(unnamed)'} needs an https://<tenant>.zohorecruit.com careers_url`);
    }
    const html: unknown = await fetchTextWithRetry(ctx, board.boardUrl, { redirect: 'error' });
    const rows = pairRecords(extractZohoListRecords(html), board, str(entry?.name));

    const maxPages: number | undefined = ctx?.maxPages;
    const probing = typeof maxPages === 'number' && Number.isInteger(maxPages) && maxPages > 0;
    const { fetchDetails, detailLimit } = parseZohoConfig(entry);
    if (fetchDetails && !probing) await enrichFromDetails(rows.slice(0, detailLimit), ctx);
    return rows.map(({ job }) => job);
  },
};

export default provider;
