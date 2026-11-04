import { fetchJsonWithRetry, sleep } from './_http.ts';
import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';

// Himalayas provider - board-wide remote jobs API
// (https://himalayas.app/jobs/api?limit=20). Returns { jobs: [...], nextCursor? }.
// Walk the feed's cursor pages so packages/core/src/scanning/scan.ts's title_filter / location_filter can do
// the local gating consistently with other zero-token board providers.
//
// Wire in via a `job_boards:` entry with `provider: himalayas`.

const FEED_URL = 'https://himalayas.app/jobs/api?limit=20';
const TRUSTED_HOST = 'himalayas.app';
const DEFAULT_MAX_PAGES = 10;
const MAX_PAGES_CAP = 50;
const INTER_PAGE_DELAY_MS = 200;

/** Narrow a parsed-JSON value to an indexable object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertHimalayasUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`himalayas: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`himalayas: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`himalayas: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanHimalayasUrl(value: unknown): string {
  const raw = cleanText(value);
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

function locationText(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .map(v => v.trim())
    .join(', ');
}

// Himalayas pubDate is currently epoch seconds. Accept milliseconds and
// parseable date strings too so the parser survives small API shape changes.
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

const himalayas: Provider = {
  id: 'himalayas',

  detect(entry: PortalEntry): DetectHit | null {
    return entry?.provider === 'himalayas' ? { url: FEED_URL } : null;
  },

  /**
   * Fetches and normalizes postings from the Himalayas public feed.
   * @param entry - The job_boards entry being processed.
   * @param ctx - HTTP context.
   */
  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const configured = entry.max_pages;
    const maxPages = typeof configured === 'number' && Number.isInteger(configured) && configured > 0
      ? Math.min(configured, MAX_PAGES_CAP) : DEFAULT_MAX_PAGES;
    const ctxCap = ctx.maxPages;
    const probeCap = typeof ctxCap === 'number' && Number.isInteger(ctxCap) && ctxCap > 0 ? ctxCap : Infinity;
    const pageLimit = Math.min(maxPages, probeCap);
    const jobs: Job[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < pageLimit; page++) {
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = new URL(FEED_URL);
      // A cursor is an opaque token, never a URL to follow. Encoding it as a
      // query value keeps every request on the same pinned endpoint.
      if (cursor !== null) url.searchParams.set('cursor', cursor);
      const feedUrl = assertHimalayasUrl(url.href);
      const json: unknown = await fetchJsonWithRetry(ctx, feedUrl, { redirect: 'error' });
      if (!isRecord(json) || !Array.isArray(json.jobs)) {
        throw new Error(`himalayas: unexpected API response - expected { jobs: [...] }, got keys: [${isRecord(json) ? Object.keys(json).join(', ') : 'null'}]`);
      }
      jobs.push(...parseHimalayasResponse(json));
      const next = json.nextCursor;
      if (next === undefined || next === null || next === '') return jobs;
      if (typeof next !== 'string') throw new Error('himalayas: nextCursor must be a string');
      if (cursors.has(next)) throw new Error('himalayas: repeated cursor in API response');
      cursors.add(next);
      cursor = next;
    }
    if (probeCap === Infinity) {
      console.error(`⚠️  himalayas: ${entry.name || 'Himalayas'} truncated at max_pages=${maxPages} (${jobs.length} jobs)`);
    }
    return jobs;
  },
};

/**
 * Parse Himalayas' public jobs API response. Exported for unit tests.
 *
 * Shape: `{ jobs: [...] }`, where each job currently carries `title`,
 * `companyName`, `locationRestrictions`, `applicationLink`, `guid`,
 * `pubDate`, and `companySlug`. `applicationLink` is preferred over `guid`
 * and used as the dedup key after HTTPS + host validation.
 *
 * @param json - raw parsed API response
 */
export function parseHimalayasResponse(json: unknown): Job[] {
  if (!isRecord(json) || !Array.isArray(json.jobs)) return [];

  const jobs: Job[] = [];
  for (const item of json.jobs) {
    if (!isRecord(item)) continue;

    const title = cleanText(item.title);
    if (!title) continue;

    const url = cleanHimalayasUrl(item.applicationLink) || cleanHimalayasUrl(item.guid);
    if (!url) continue;

    jobs.push({
      title,
      url,
      company: cleanText(item.companyName),
      location: locationText(item.locationRestrictions),
      postedAt: toEpochMs(item.pubDate),
    });
  }

  return jobs;
}

export default himalayas;
