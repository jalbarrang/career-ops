import type { Context, Job, PortalEntry, Provider } from './_types.ts';
import { safeEncodeURIComponent } from './_safe-url.ts';

// The Hub provider — board-wide aggregator feed (Nordic / EU startups):
// https://thehub.io/api/v2/jobsandfeatured
// Response shape: { jobs: { docs: [ { id, key, title, company: { name, ... },
//   location: { address, locality, country }, isRemote, ... } ], total, page,
//   pages, limit } }. No job URL or posting date in the response, so
// `normalizeHubJob` builds the URL from `id` and the Job shape omits `postedAt`.
//
// `countryCode` is required on every request: omitting it scopes results to
// the caller's geo-IP, making scan coverage depend on where this process runs.
//
// The site's "Remote jobs only" filter is a separate query mode, not a value
// combinable with `countryCode` — it queries `isRemote=true` with no
// `countryCode` at all. Covering both a region and remote postings takes two
// separate paginated passes, merged and deduped by job id. Configure via a
// `thehub:` block:
//
//   - name: The Hub — EU startups
//     provider: thehub
//     thehub:
//       countryCode: EU     # optional; any value the API accepts. Default: EU
//       includeRemote: true # optional; also runs an isRemote=true pass, merged in. Default: false
//     max_pages: 5           # applies to each pass independently
//
// Paginated 15/page via `?page=N` (1-indexed); the response carries `pages`, so
// iteration is bounded by min(pages, max_pages). Default cap is modest; override
// with `max_pages` on the entry.
//
// Wire in via a `job_boards:` entry with `provider: thehub`.

const FEED_BASE = 'https://thehub.io/api/v2/jobsandfeatured';
const TRUSTED_HOST = 'thehub.io';
const DEFAULT_COUNTRY_CODE = 'EU';
const PER_PAGE = 15;
const DEFAULT_MAX_PAGES = 3;
const MAX_PAGES_CAP = 67;

/** The `thehub:` config block from portals.yml, after defaults. */
export interface ThehubConfig {
  countryCode: string;
  includeRemote: boolean;
}

/** Everything one query pass shares: the dedup map and its failure state. */
export interface ScopeState {
  /** Set once any request — in this pass or an earlier one — has landed. */
  succeededOnce: boolean;
}

/** Narrow an untrusted JSON value to an object with unknown fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** `Object.keys` rendered for an error message, without throwing on a primitive. */
function keysOf(value: unknown): string {
  return value ? Object.keys(Object(value)).join(', ') : 'null';
}

/** The message of a caught value, for a log line. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve the page cap: a positive integer `max_pages` on the entry, capped. */
function resolveMaxPages(entry: PortalEntry): number {
  const v = entry?.max_pages;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES_CAP);
  return DEFAULT_MAX_PAGES;
}

/**
 * Reads the entry's `thehub:` config block. Exported for unit tests.
 */
export function parseThehubConfig(entry: PortalEntry): ThehubConfig {
  const cfg = asRecord(entry && entry.thehub);
  const countryCode = typeof cfg.countryCode === 'string' && cfg.countryCode.trim()
    ? cfg.countryCode.trim()
    : DEFAULT_COUNTRY_CODE;
  return { countryCode, includeRemote: cfg.includeRemote === true };
}

/**
 * Normalize a single The Hub job. Exported for unit tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `title`, trimmed (postings without one are dropped).
 *   - url:      built from `id` as `https://thehub.io/jobs/{id}` (postings
 *               without a usable id are dropped). This host is always
 *               thehub.io, so url is not attacker-controlled; it is the
 *               dedup key and is display-only (written to the
 *               pipeline/history, never fetched here).
 *   - company:  `company.name`, falling back to the portal entry name, then
 *               "The Hub".
 *   - location: `location.address`, else assembled from `location.locality` /
 *               `location.country`; "Remote" is appended when `isRemote` is true.
 */
export function normalizeHubJob(j: unknown, fallbackCompany?: string): Job | null {
  if (!j || typeof j !== 'object') return null;
  const row = asRecord(j);

  const title = typeof row.title === 'string' ? row.title.trim() : '';
  if (!title) return null;

  const id = typeof row.id === 'string' ? row.id.trim() : '';
  if (!id) return null;
  // A lone surrogate in id would throw URIError out of encodeURIComponent and
  // abort the caller's pagination loop; id is also the dedup key (byUrl). Drop
  // this one.
  const encodedId = safeEncodeURIComponent(id);
  if (encodedId === null) return null;
  const url = `https://${TRUSTED_HOST}/jobs/${encodedId}`;

  const rowCompany = asRecord(row.company);
  const company =
    row.company && typeof row.company === 'object' && typeof rowCompany.name === 'string' && rowCompany.name.trim()
      ? rowCompany.name.trim()
      : typeof fallbackCompany === 'string' && fallbackCompany.trim()
        ? fallbackCompany.trim()
        : 'The Hub';

  const loc = asRecord(row.location);
  const address = typeof loc.address === 'string' ? loc.address.trim() : '';
  const locality = typeof loc.locality === 'string' ? loc.locality.trim() : '';
  const country = typeof loc.country === 'string' ? loc.country.trim() : '';
  const base = address || [locality, country].filter(Boolean).join(', ');
  const location = [base, row.isRemote === true ? 'Remote' : ''].filter(Boolean).join(', ');

  return { title, url, company, location };
}

/**
 * Paginates one query mode (`?countryCode=X` or `?isRemote=true`) up to
 * `maxPages`, normalizing and appending each hit into `byUrl` (keyed by url,
 * so a job present in both passes is only counted once).
 *
 * `state.succeededOnce` is shared across both passes: a dead board should
 * still read as a failure, but once anything has resolved — in this pass or
 * an earlier one — a later failure (mid-pagination, or the remote pass
 * failing after the region pass already landed) must not discard what's
 * already collected (same `succeededOnce`/`firstErr` idiom as
 * tencent/meituan/alibaba/phenom/radancy/successfactors after #2379).
 * Returns `false` when the pass stopped early on a failure (region-pass
 * caller uses this to skip the remote pass), `true` otherwise.
 *
 * @param query the query string beyond `?`, e.g. `countryCode=EU` or `isRemote=true`
 * @param fallbackCompany portal entry name, used when a row names no employer
 * @param byUrl dedup map, keyed by normalized posting URL
 * @param state cross-pass failure state
 */
async function fetchScope(
  query: string,
  maxPages: number,
  fallbackCompany: string | undefined,
  byUrl: Map<string, Job>,
  ctx: Context,
  state: ScopeState,
): Promise<boolean> {
  for (let page = 1; page <= maxPages; page++) {
    const url = `${FEED_BASE}?page=${page}&${query}`;
    let docs: unknown[];
    let totalPages: unknown;
    try {
      // redirect:'error' prevents SSRF via server-side redirects
      const json = await ctx.fetchJson(url, { redirect: 'error' });
      const jobs = asRecord(asRecord(json).jobs);
      if (!Array.isArray(jobs.docs)) {
        throw new Error(
          `thehub: unexpected API response on page ${page} — expected { jobs: { docs: [...] } }, got keys: [${keysOf(json)}]`,
        );
      }
      docs = jobs.docs;
      totalPages = jobs.pages;
    } catch (err) {
      if (!state.succeededOnce) throw err;
      console.error(`  ⚠ thehub: query "${query}" page ${page} failed (${errorMessage(err)}) — keeping the ${byUrl.size} jobs collected so far`);
      return false;
    }
    state.succeededOnce = true;
    for (const j of docs) {
      const normalized = normalizeHubJob(j, fallbackCompany);
      if (normalized && !byUrl.has(normalized.url)) byUrl.set(normalized.url, normalized);
    }
    // Stop at the last page: a short page, or page >= the reported total pages.
    if (docs.length < PER_PAGE) break;
    if (typeof totalPages === 'number' && Number.isInteger(totalPages) && page >= totalPages) break;
  }
  return true;
}

const provider: Provider = {
  id: 'thehub',

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const maxPages = resolveMaxPages(entry);
    const { countryCode, includeRemote } = parseThehubConfig(entry);
    const fallbackCompany = entry?.name;
    const byUrl = new Map<string, Job>();
    const state: ScopeState = { succeededOnce: false };

    const regionOk = await fetchScope(`countryCode=${encodeURIComponent(countryCode)}`, maxPages, fallbackCompany, byUrl, ctx, state);
    if (regionOk && includeRemote) {
      await fetchScope('isRemote=true', maxPages, fallbackCompany, byUrl, ctx, state);
    }

    return [...byUrl.values()];
  },
};

export default provider;
