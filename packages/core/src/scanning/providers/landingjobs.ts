import type { Context, Job, PortalEntry, Provider } from './_types.ts';

// Landing.jobs provider — board-wide aggregator feed (tech, Europe-focused):
// https://landing.jobs/api/v1/jobs
// Response shape: a JSON ARRAY of
//   { id, title, url, locations: [{ city, country_code }], remote, published_at,
//     created_at, type, tags, gross_salary_low, gross_salary_high, ... }
//
// NOTE: the v1 feed carries no company-name field — the employer slug only
// appears in the posting URL path (`https://landing.jobs/at/<slug>/<job>`), so
// `company` is derived best-effort from that slug (humanized) and falls back to
// the portal entry name. The whole active set is returned in one call.
//
// Wire in via a `job_boards:` entry with `provider: landingjobs`.

const FEED_URL = 'https://landing.jobs/api/v1/jobs';
const TRUSTED_HOST = 'landing.jobs';

/** Narrow a parsed-JSON value to an indexable object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertLandingUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`landingjobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`landingjobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`landingjobs: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

// NaN-safe Date.parse.
function toEpochMs(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Derive a best-effort company name from a Landing.jobs posting URL.
 * Posting URLs are `https://landing.jobs/at/<slug>/<job>`; the `<slug>` is
 * humanized (hyphens/underscores → spaces, title-cased). Returns '' when the
 * URL is not the expected `/at/<slug>/…` shape. Exported for unit tests.
 */
export function companyFromUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (segs[0] !== 'at' || !segs[1]) return '';
  return segs[1]
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Normalize a single Landing.jobs job. Exported for unit tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `title`, trimmed (postings without one are dropped).
 *   - url:      `url` — host-locked to `landing.jobs` (an off-host or non-https
 *               URL drops the posting). It is the dedup key and is display-only.
 *   - company:  derived from the URL slug (see companyFromUrl), falling back to
 *               the portal entry name, then "Landing.jobs".
 *   - location: first `locations[]` entry as "city, country_code"; "Remote" is
 *               appended when `remote` is true.
 *   - postedAt: `published_at` (else `created_at`) ISO date → epoch ms.
 */
export function normalizeLandingJob(j: unknown, fallbackCompany?: string): Job | null {
  if (!isRecord(j)) return null;

  const title = typeof j.title === 'string' ? j.title.trim() : '';
  if (!title) return null;

  let url = '';
  const rawUrl = typeof j.url === 'string' ? j.url.trim() : '';
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST) url = parsed.href;
    } catch {
      // malformed URL → leave url = '' → dropped below
    }
  }
  if (!url) return null;

  const company =
    companyFromUrl(url) ||
    (typeof fallbackCompany === 'string' && fallbackCompany.trim() ? fallbackCompany.trim() : 'Landing.jobs');

  const firstLoc = Array.isArray(j.locations) ? j.locations[0] : undefined;
  const first: Record<string, unknown> = isRecord(firstLoc) ? firstLoc : {};
  const city = typeof first.city === 'string' ? first.city.trim() : '';
  const country = typeof first.country_code === 'string' ? first.country_code.trim() : '';
  const base = [city, country].filter(Boolean).join(', ');
  const location = [base, j.remote === true ? 'Remote' : ''].filter(Boolean).join(', ');

  const job: Job = { title, url, company, location };
  const postedAt = toEpochMs(j.published_at) ?? toEpochMs(j.created_at);
  if (postedAt !== undefined) job.postedAt = postedAt;
  return job;
}

const landingjobs: Provider = {
  id: 'landingjobs',

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    assertLandingUrl(FEED_URL);
    // redirect:'error' prevents SSRF via server-side redirects
    const json: unknown = await ctx.fetchJson(FEED_URL, { redirect: 'error' });
    if (!Array.isArray(json)) {
      throw new Error(
        `landingjobs: unexpected API response — expected a JSON array, got ${json === null ? 'null' : typeof json}`,
      );
    }
    const rows: unknown[] = json;
    const fallbackCompany = entry?.name;
    return rows.map(j => normalizeLandingJob(j, fallbackCompany)).filter((job): job is Job => job !== null);
  },
};

export default landingjobs;
