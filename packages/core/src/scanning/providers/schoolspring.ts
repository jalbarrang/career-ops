import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';
import { decodeEntities } from './_html-entities.ts';
import { fetchJsonWithRetry, sleep } from './_http.ts';

// SchoolSpring provider — K-12 districts hosted at `<district>.schoolspring.com`.
// tracked_companies: (one entry = one district). Auto-detects from careers_url.
//
// The board is an SPA over a public, unauthenticated JSON API
// (api.schoolspring.com) that takes the district's hostname as `domainName`.
// The list endpoint returns id / title / employer / location / date only — pay
// and description live behind a per-job request the zero-token scanner skips.
//
// Paginated 100 at a time. A network/HTTP failure on ANY page fails the whole
// target loudly rather than returning a silently partial board.

const SCHOOLSPRING_HOST_RE = /^[a-z0-9][a-z0-9-]*\.schoolspring\.com$/;
// `www` and `api` are the platform's own hosts, not districts.
const NON_DISTRICT = new Set(['www.schoolspring.com', 'api.schoolspring.com']);

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 20; // 2,000 postings; a district never comes close
const MAX_PAGES_CAP = 100;
const INTER_PAGE_DELAY_MS = 200;

/** One parsed `GetPagedJobsWithSearch` page. */
export interface SchoolSpringPage {
  jobs: Job[];
  rawCount: number;
}

/** Narrow an untrusted JSON value to an object with unknown fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function resolveMaxPages(entry: PortalEntry): number {
  const v = entry?.max_pages;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/**
 * District hostname from a careers_url, or null.
 */
function resolveHost(entry: PortalEntry): string | null {
  const raw = typeof entry?.careers_url === 'string' ? entry.careers_url.trim() : '';
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !SCHOOLSPRING_HOST_RE.test(host) || NON_DISTRICT.has(host)) return null;
  return host;
}

function pageUrl(host: string, page: number): string {
  const q = new URLSearchParams({
    domainName: host,
    keyword: '',
    location: '',
    category: '',
    gradelevel: '',
    jobtype: '',
    organization: '',
    swLat: '',
    swLon: '',
    neLat: '',
    neLon: '',
    page: String(page),
    size: String(PAGE_SIZE),
    sortDateAscending: 'false',
  });
  return `https://api.schoolspring.com/api/Jobs/GetPagedJobsWithSearch?${q}`;
}

const provider: Provider = {
  id: 'schoolspring',

  detect(entry: PortalEntry): DetectHit | null {
    const host = resolveHost(entry);
    return host ? { url: `https://${host}/` } : null;
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const host = resolveHost(entry);
    if (!host) throw new Error(`schoolspring: cannot derive district host for ${entry.name} (need an https://<district>.schoolspring.com careers_url)`);

    const ctxMax = Number(ctx?.maxPages);
    const ceiling = resolveMaxPages(entry);
    const pagesToFetch = ctxMax > 0 ? Math.min(ceiling, ctxMax) : ceiling;

    const jobs: Job[] = [];
    const seen = new Set<string>();
    let lastPageFull = false;
    let stoppedOnRepeat = false;
    let pagesFetched = 0;
    for (let page = 1; page <= pagesToFetch; page++) {
      if (page > 1) await sleep(INTER_PAGE_DELAY_MS, ctx);
      // No catch: a ctx.fetchJson rejection (including the probe's
      // ProbePageBudgetReached) propagates unwrapped, and a real failure on any
      // page fails the target instead of returning a partial list.
      const json = await fetchJsonWithRetry(ctx, pageUrl(host, page), { redirect: 'error' });
      const list = parseSchoolSpringPage(json, entry.name, `https://${host}`);
      pagesFetched++;
      // A repeated or overlapping page must not add the same postings again. A
      // page that adds nothing new is the end of the board, or the API ignoring
      // `page` and repeating itself; either way, stop instead of looping to the
      // ceiling.
      let fresh = 0;
      for (const job of list.jobs) {
        if (seen.has(job.url)) continue;
        seen.add(job.url);
        jobs.push(job);
        fresh++;
      }
      lastPageFull = list.rawCount >= PAGE_SIZE;
      if (!lastPageFull) break;
      if (fresh === 0) {
        stoppedOnRepeat = true;
        break;
      }
    }
    // Warn only when OUR ceiling cut a board that had more, never for a
    // ctx.maxPages probe cap and never when the API just repeated itself.
    if (lastPageFull && !stoppedOnRepeat && pagesFetched >= ceiling && !(ctxMax > 0 && ctxMax < ceiling)) {
      console.warn(`schoolspring: ${entry.name}: stopped at ${ceiling} pages (${ceiling * PAGE_SIZE} postings); raise max_pages on this entry`);
    }
    return jobs;
  },
};

/** NaN-safe; the API's timestamps carry no zone, so they read as local time. */
function toEpochMs(value: unknown): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * The API HTML-escapes titles and employer names ("Hudson&#x27;s Bay", "Grade 5
 * &#8211; Teacher"), so they go through the shared decoder.
 */
const clean = (s: unknown): string => decodeEntities(String(s ?? '')).trim();

/**
 * Parse one `GetPagedJobsWithSearch` page. Exported for unit tests.
 *
 * Shape: `{ success, message, value: { page, size, jobsList: [{ jobId,
 * employer, title, location, displayDate }] } }`.
 *
 * - `null`, `{}` and `[]` (contentless bodies) or `jobsList: []` (a real empty
 *   board) → empty.
 * - A bare primitive (string, number, boolean), any envelope without
 *   `success: true` (including an omitted `success`), or any body with no
 *   `jobsList` array (including `value: null` and `jobsList: null`) → throws,
 *   naming what it got.
 * - Rows with no numeric `jobId` or no title are skipped.
 *
 * @param json - Raw response body.
 * @param companyName - Company to attribute each posting to.
 * @param origin - e.g. "https://acme.schoolspring.com"
 */
export function parseSchoolSpringPage(json: unknown, companyName: string, origin: string): SchoolSpringPage {
  // Only the documented contentless bodies (null, {} and []) read as empty. Any
  // other primitive (a bare string or number) is not this API's envelope.
  if (json == null) return { jobs: [], rawCount: 0 };
  if (typeof json !== 'object') throw new Error(`schoolspring: unexpected response type ${typeof json}, expected a JSON object`);
  if (Object.keys(json).length === 0) return { jobs: [], rawCount: 0 };
  const body = asRecord(json);
  // The API always answers success:true on a good response, so require it rather
  // than treating only an explicit success:false as a failure.
  if (body.success !== true) throw new Error(`schoolspring: API error: ${body.message || 'response did not report success:true'}`);
  // A real empty board answers `jobsList: []`. A response with no jobsList array
  // at all is not that, so it throws instead of silently reading as empty.
  const value = body.value;
  const list = typeof value === 'object' && value !== null ? asRecord(value).jobsList : undefined;
  if (!Array.isArray(list)) {
    throw new Error(`schoolspring: unexpected response shape, no jobsList array (${value && typeof value === 'object' ? `value keys: ${Object.keys(value).join(', ') || 'none'}` : `top-level keys: ${Object.keys(json).join(', ')}`})`);
  }
  const jobs: Job[] = [];
  for (const raw of list) {
    const j = asRecord(raw);
    const id = String(j.jobId ?? '').trim();
    const title = clean(j.title);
    // jobId is numeric; anything else is not a posting we can link to.
    if (!/^\d+$/.test(id) || !title) continue;
    const where = clean(j.location);
    const employer = clean(j.employer);
    const job: Job = {
      title,
      url: `${origin}/?jobid=${id}`,
      company: companyName,
      location: [where, employer].filter(Boolean).join(' - '),
    };
    const postedAt = toEpochMs(j.displayDate);
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }
  return { jobs, rawCount: list.length };
}

export default provider;
