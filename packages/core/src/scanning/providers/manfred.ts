import type { Context, DetectHit, Job, JobSalary, PortalEntry, Provider } from './_types.ts';

// getManfred provider — board-wide public JSON feed of Spanish/EU tech jobs
// (https://www.getmanfred.com/api/v2/public/offers). Public, zero-auth, and
// returned in ONE call: the endpoint has no pagination parameters and answers
// with the full catalogue.
//
// Two things measured against the live feed on 2026-08-03 shape this provider:
//
//   1. The feed is a CATALOGUE, NOT A LIVE BOARD. 1,604 of its 1,628 entries
//      carry `status: "CLOSED"`; only 24 were ACTIVE. Ingesting it unfiltered
//      would push ~1.6k dead postings into the pipeline on the first scan, so
//      the status filter is not an optimization here — it is the difference
//      between a usable provider and an unusable one.
//   2. `lang` is REQUIRED: without it the API answers 400 with
//      `"lang must be one of the following values: EN, ES"`.
//
// Wire in via a `job_boards:` entry with `provider: manfred`.

import { safeEncodeURIComponent } from './_safe-url.ts';
import { fetchJsonWithRetry } from './_http.ts';

const FEED_BASE = 'https://www.getmanfred.com/api/v2/public/offers';
// The full catalogue in one response runs ~2.3MB and takes 8-9.6s to arrive
// even on a clean connection — right against the shared 10s default timeout,
// so any network jitter aborts it. Give it real headroom rather than relying
// on retry alone to paper over a structurally near-timeout request.
const FETCH_TIMEOUT_MS = 25_000;
const TRUSTED_HOST = 'www.getmanfred.com';
const OFFER_BASE = 'https://www.getmanfred.com/ofertas-empleo';
const VALID_LANGS = ['EN', 'ES'];
const DEFAULT_LANG = 'EN';

/** One normalized Manfred offer. */
export type ManfredJob = {
  title: string;
  url: string;
  company: string;
  location: string;
  salary?: JobSalary;
};

/** Narrow an untrusted JSON value to an object with unknown fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function assertManfredUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`manfred: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`manfred: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`manfred: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/** Resolve the feed language: `lang` on the entry, uppercased, else EN. */
export function resolveLang(entry: PortalEntry): string {
  const raw = typeof entry?.lang === 'string' ? entry.lang.trim().toUpperCase() : '';
  return VALID_LANGS.includes(raw) ? raw : DEFAULT_LANG;
}

// The feed reports currency as the SYMBOL, not an ISO code, and the observed
// values include a narrow-no-break-space variant of the euro sign. packages/core/src/scanning/scan.ts's
// salary_filter compares currencies case-insensitively as plain strings, so a
// symbol would never match a user's `currency: EUR` — map to ISO, and drop the
// field entirely rather than guess when the symbol is unknown.
const CURRENCY_BY_SYMBOL = new Map([
  ['€', 'EUR'],
  ['£', 'GBP'],
  ['US$', 'USD'],
  ['$', 'USD'],
  ['MXN$', 'MXN'],
]);

export function normalizeCurrency(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  //    (narrow no-break space) and friends appear glued to the symbol in
  // the live feed; strip every space class before the lookup.
  const cleaned = raw.replace(/[\s\u00A0\u202F]/g, '').toUpperCase();
  for (const [symbol, iso] of CURRENCY_BY_SYMBOL) {
    if (cleaned === symbol.toUpperCase()) return iso;
  }
  return /^[A-Z]{3}$/.test(cleaned) ? cleaned : '';
}

/**
 * The feed URL, built in ONE place: detect() reports it and fetch() requests
 * it, so building it twice would let the reported URL drift from the one
 * actually called the day a second query parameter is added.
 */
function buildFeedUrl(entry: PortalEntry): string {
  return `${FEED_BASE}?lang=${resolveLang(entry)}`;
}

/**
 * Build the `{min, max, currency}` shape packages/core/src/scanning/scan.ts's salary_filter consumes.
 * Returns null when the offer carries no usable figure, which the filter
 * treats as "no data" and passes.
 */
export function parseCompensation(offer: unknown): { min: number; max: number; currency: string } | null {
  const row = asRecord(offer);
  const from = Number(row.salaryFrom);
  const to = Number(row.salaryTo);
  const min = Number.isFinite(from) && from > 0 ? from : null;
  const max = Number.isFinite(to) && to > 0 ? to : null;
  const currency = normalizeCurrency(row.currency);
  if (min !== null && max !== null) return { min, max, currency };
  if (min !== null) return { min, max: min, currency };
  if (max !== null) return { min: max, max, currency };
  return null;
}

/**
 * Location for an offer.
 *
 * `locations` is a plain string array ("Madrid, Spain") and is empty on 932 of
 * the 1,628 entries measured. For those, `remotePercentage` is the only place
 * signal there is — and remote and hybrid are kept DISTINGUISHABLE rather than
 * collapsed into "Remote", because the emitted string is what `location_filter`
 * matches on: collapsing them makes a `block: ["Hybrid"]` rule unmatchable
 * (same failure as #2258 in the echojobs provider).
 *
 * A placeless on-site offer (0%) keeps "", which passes the filter under the
 * scanner's "don't penalize missing data" convention.
 */
export function resolveLocation(offer: unknown): string {
  const row = asRecord(offer);
  const locations: unknown[] = Array.isArray(row.locations) ? row.locations : [];
  const listed: string[] = locations
    .filter((l: unknown): l is string => typeof l === 'string' && Boolean(l.trim()))
    .map((l: string) => l.trim());
  if (listed.length > 0) return listed.join(', ');

  const remote = Number(row.remotePercentage);
  if (!Number.isFinite(remote)) return '';
  if (remote >= 100) return 'Remote';
  if (remote > 0) return 'Hybrid';
  return '';
}

/**
 * Normalize a single offer. Exported for tests.
 *
 * Field mapping → the normalized Job shape:
 *   - title:    `position`, trimmed (offers without one are dropped).
 *   - url:      built from `id` and `slug` as `/ofertas-empleo/{id}/{slug}` —
 *               the canonical form published in the site's own
 *               sitemap-offers.xml. An offer missing either part is dropped
 *               rather than linked to a guessed URL, since url is the dedup key.
 *   - company:  `company.name`, falling back to the portal entry name.
 *   - location: see resolveLocation.
 *   - salary:   `salaryFrom`/`salaryTo`/`currency` → `{min, max, currency}`.
 *
 * NO postedAt: the only timestamp in the payload is `updatedAt`, which is a
 * modification time, not a publication date. Mapping it to postedAt would make
 * an edited old posting look freshly published to the recency filters, so the
 * field is omitted — the Job contract explicitly allows that.
 */
export function normalizeManfredOffer(offer: unknown, fallbackCompany?: string): ManfredJob | null {
  if (!offer || typeof offer !== 'object') return null;
  const row = asRecord(offer);
  if (row.status !== 'ACTIVE') return null;

  const title = typeof row.position === 'string' ? row.position.trim() : '';
  if (!title) return null;

  const id = Number(row.id);
  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  if (!Number.isInteger(id) || id <= 0 || !slug) return null;
  // A lone surrogate in slug would throw URIError out of encodeURIComponent and
  // abort the caller's loop over the whole catalogue. Drop this one.
  const encodedSlug = safeEncodeURIComponent(slug);
  if (encodedSlug === null) return null;
  const url = `${OFFER_BASE}/${id}/${encodedSlug}`;

  const companyName = asRecord(row.company).name;
  const company =
    typeof companyName === 'string' && companyName.trim()
      ? companyName.trim()
      : fallbackCompany || 'getManfred';

  const job: ManfredJob = { title, url, company, location: resolveLocation(offer) };
  const salary = parseCompensation(offer);
  if (salary) job.salary = salary;
  return job;
}

const provider: Provider = {
  id: 'manfred',

  detect(entry: PortalEntry): DetectHit | null {
    return entry?.provider === 'manfred' ? { url: buildFeedUrl(entry) } : null;
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    // Validate the URL actually fetched (not just a constant) so the host pin
    // is meaningful, then redirect:'error' blocks SSRF via server-side
    // redirects — together they keep the request on getmanfred.com.
    const url = assertManfredUrl(buildFeedUrl(entry));
    const json = await fetchJsonWithRetry(ctx, url, { redirect: 'error', timeoutMs: FETCH_TIMEOUT_MS });
    if (!Array.isArray(json)) {
      throw new Error(
        `manfred: unexpected API response — expected a JSON array of offers, got ${json === null ? 'null' : typeof json}`,
      );
    }
    const fallbackCompany = entry?.name;
    const out: ManfredJob[] = [];
    for (const offer of json as unknown[]) {
      const normalized = normalizeManfredOffer(offer, fallbackCompany);
      if (normalized) out.push(normalized);
    }
    return out;
  },
};

export default provider;
