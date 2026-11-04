import { sleep } from './_http.ts';
import type { JsonFetchContext } from './_http.ts';
import type { Context, FetchOptions, Job, PortalEntry, Provider } from './_types.ts';

// The Muse provider — public, zero-auth JSON jobs feed.
// Endpoint: https://www.themuse.com/api/public/jobs?page={n}
// Response shape: { results: [...], page: n, page_count: N }
// All pages are fetched sequentially and aggregated before normalizing.
//
// Wire in via a `job_boards:` entry with `provider: themuse`.

const FEED_BASE = 'https://www.themuse.com/api/public/jobs';
const TRUSTED_HOST = 'www.themuse.com';

// Safety cap on pagination. The feed can carry tens of thousands of pages;
// this board only ever samples the first slice of it regardless of retry
// behavior below.
const MAX_PAGES = 100;

// Retry policy for transient page failures (429 rate-limit, 5xx,
// timeouts/aborts). Without retry, one stalled request out of up to 100
// sequential page fetches throws and discards every job already gathered
// from this board for the run -- the whole board reads as "not working" when
// only one page had a bad moment. Mirrors workday.ts / oraclecloud.ts.
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8_000;

// Delay between successive pages so a 100-page walk doesn't fire as a burst
// against the same host (mirrors workday.ts / oraclecloud.ts).
const INTER_PAGE_DELAY_MS = 250;

/** An Error carrying the HTTP metadata the transport attaches, plus `attempts`. */
interface AttemptError extends Error {
  status?: number;
  retryAfter?: string | null;
  attempts?: number;
}

/** Narrow a parsed-JSON value to an indexable object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Parses a `Retry-After` header value (seconds, or an HTTP-date) to ms, or null. */
function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function isRetryableError(err: unknown): boolean {
  const status = isRecord(err) ? err.status : undefined;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  return status === undefined; // network error / timeout / abort — no status set
}

/**
 * Fetches a single page, retrying transient failures with backoff. The
 * thrown error (whether retries were exhausted or the error was
 * non-retryable) carries `attempts` — the actual number of fetchJson calls
 * made — so a caller reporting failure doesn't have to assume the fixed
 * MAX_RETRIES+1 ceiling, which would misreport a non-retryable error (one
 * attempt, no retries) as having exhausted the full retry budget.
 */
async function fetchPageWithRetry(ctx: JsonFetchContext, url: string, opts: FetchOptions): Promise<unknown> {
  let lastErr: AttemptError | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await ctx.fetchJson(url, opts);
    } catch (err) {
      const failure: AttemptError = err instanceof Error ? err : new Error(String(err));
      failure.attempts = attempt + 1;
      lastErr = failure;
      if (attempt === MAX_RETRIES || !isRetryableError(failure)) throw lastErr;
      const backoff = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      // A server-supplied Retry-After is honored, but still clamped — an
      // unbounded value would otherwise stall this board's fetch for as long
      // as the server says, defeating the point of a bounded backoff.
      const retryAfterMs = parseRetryAfterMs(failure.retryAfter);
      const delayMs = retryAfterMs !== null ? Math.min(retryAfterMs, RETRY_MAX_DELAY_MS * 4) : (backoff + Math.random() * 250);
      await sleep(delayMs, ctx);
    }
  }
  throw lastErr ?? new Error('themuse: retry loop exited without a result');
}

function assertMuseUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`themuse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`themuse: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`themuse: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/**
 * Normalize a single result from the Muse API response. Exported for unit tests.
 *
 * Field mapping:
 *   name              → title
 *   refs.landing_page → url
 *   company.name      → company
 *   locations[0].name → location
 *
 * Returns null when required fields (title or url) are missing or invalid.
 */
export function normalizeMuseJob(j: unknown): Job | null {
  if (!isRecord(j)) return null;
  const title = typeof j.name === 'string' ? j.name.trim() : '';
  if (!title) return null;
  const refs = isRecord(j.refs) ? j.refs : {};
  const url = typeof refs.landing_page === 'string' ? refs.landing_page.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const companyBlock = isRecord(j.company) ? j.company : {};
  const company =
    typeof companyBlock.name === 'string' && companyBlock.name.trim()
      ? companyBlock.name.trim()
      : 'The Muse';
  const firstLocation = Array.isArray(j.locations) ? j.locations[0] : undefined;
  const location =
    isRecord(firstLocation) && typeof firstLocation.name === 'string'
      ? firstLocation.name.trim()
      : '';
  return { title, url, company, location };
}

const themuse: Provider = {
  id: 'themuse',

  async fetch(_entry: PortalEntry, ctx: Context): Promise<Job[]> {
    assertMuseUrl(FEED_BASE);

    // Page 0 is fetched outside the tolerant loop below and its failure is
    // NOT caught: a completely dead board must throw, not return []. A
    // caught page-0 failure would return an empty array indistinguishable
    // from a healthy "0 jobs today" result -- packages/core/src/scanning/scan.ts's consecutive-failure
    // detector resets its streak on any non-throwing fetch, so a themuse
    // outage would silently reset the very detector meant to catch it.
    // Mirrors workday.ts, which fetches its first page outside the
    // retry-tolerant loop (`page = 1` start) for the same reason.
    const firstUrl = `${FEED_BASE}?page=0`;
    // redirect:'error' prevents SSRF via server-side redirects
    const first = await fetchPageWithRetry(ctx, firstUrl, { redirect: 'error' });
    if (!isRecord(first) || !Array.isArray(first.results)) {
      throw new Error(
        `themuse: unexpected API response on page 0 — expected { results: [...] }, got keys: [${isRecord(first) ? Object.keys(first).join(', ') : 'null'}]`,
      );
    }
    const allResults: unknown[] = [...first.results];
    const declaredPages = first.page_count;
    const pageCount = typeof declaredPages === 'number' && Number.isInteger(declaredPages) && declaredPages > 1
      ? Math.min(declaredPages, MAX_PAGES)
      : 1;

    // Pages 1+ stay tolerant: a page that exhausts retries, OR comes back
    // with an unexpected shape (a successful fetch, no retry involved --
    // caught here so it lands in the same truncation path instead of
    // escaping uncaught and discarding allResults), truncates with a warning
    // and returns whatever was already gathered instead of discarding it.
    for (let page = 1; page < pageCount; page++) {
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = `${FEED_BASE}?page=${page}`;
      try {
        const json = await fetchPageWithRetry(ctx, url, { redirect: 'error' });
        if (!isRecord(json) || !Array.isArray(json.results)) {
          throw new Error(
            `themuse: unexpected API response on page ${page} — expected { results: [...] }, got keys: [${isRecord(json) ? Object.keys(json).join(', ') : 'null'}]`,
          );
        }
        allResults.push(...json.results);
      } catch (err) {
        const attemptsRaw = isRecord(err) ? err.attempts : undefined;
        const attempts = typeof attemptsRaw === 'number' && Number.isInteger(attemptsRaw) ? attemptsRaw : 1;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`⚠️  themuse: truncated at page ${page} of ${pageCount} after ${attempts} attempt${attempts === 1 ? '' : 's'} (${allResults.length} jobs gathered so far): ${message}`);
        break;
      }
    }
    return allResults.map(normalizeMuseJob).filter((job): job is Job => job !== null);
  },
};

export default themuse;
