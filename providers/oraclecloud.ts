import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';

// Oracle Recruiting Cloud (ORC) / Fusion Candidate Experience provider — hits
// the public recruitingCEJobRequisitions REST API (zero-auth, GET). Large
// employers (JPMorgan Chase, Oracle, BNY Mellon, American Express, Honeywell, …)
// run their careers site on ORC.
//
// Host patterns (per-tenant, dynamic):
//   <tenant>.fa.oraclecloud.com
//   <tenant>.fa.<region>.oraclecloud.com   (e.g. us2)
//   <tenant>.fa.ocs.oraclecloud.com
//   ...and the same three shapes on the numbered apex `oraclecloud<NN>.com`
//   that Oracle issues to newer tenants (observed live: a Fusion board on
//   `<tenant>.fa.ocs.oraclecloud26.com` whose unnumbered `oraclecloud.com`
//   sibling host does not resolve at all).
//
// The numeric suffix is BOUNDED (1-99), not open-ended: this regex exists to
// PIN the host before every fetch, so it enumerates a finite apex family and
// never degrades into `oraclecloud<anything>.com`.
//
// Career page URL:
//   https://<host>/hcmUI/CandidateExperience/<lang>/sites/<siteNumber>/jobs
//   siteNumber is the segment after `sites/` (usually CX_1, CX_1002, …; default CX_1).
//
// JSON API (GET, zero-auth, no token/cookie):
//   https://<host>/hcmRestApi/resources/latest/recruitingCEJobRequisitions
//   ?onlyData=true
//   &expand=requisitionList.workLocation,requisitionList.secondaryLocations
//   &finder=findReqs;siteNumber=<site>,facetsList=...,limit=<n>,sortBy=POSTING_DATES_DESC,offset=<n>
//   &limit=<n>&offset=<n>   (set in BOTH finder and top-level — some tenants only honor one)
//   Optional: locationId=<numericId> (some tenants, e.g. BNY/Amex, need it to scope results).
//   The `expand` is REQUIRED: without it the API returns TotalJobsCount but an
//   empty/absent requisitionList (verified live against JPMC).
//   Response: items[0].requisitionList[] (jobs), items[0].TotalJobsCount (total),
//   top-level hasMore. Per item: Id, Title, PostedDate, PrimaryLocation,
//   WorkplaceTypeCode, ShortDescriptionStr, and (sometimes) ExternalURL.
//
// Known limitation: some tenants front the API with a WAF (e.g. Imperva) that
// 403s datacenter/cloud egress IPs. That's an environment/IP issue, not a
// provider bug — the same request succeeds from a residential IP. A browser-like
// User-Agent is sent to reduce (not eliminate) WAF friction.

import { decodeEntities } from './_html-entities.ts';
import { BROWSER_LIKE_USER_AGENT, fetchJsonWithRetry, sleep } from './_http.ts';

// `oraclecloud(?:[1-9][0-9]?)?` = oraclecloud.com plus oraclecloud1.com …
// oraclecloud99.com. No leading zero, at most two digits — a bounded family,
// so this stays a host pin and never becomes a wildcard apex match.
const ORACLE_HOST_RE = /^[a-z0-9-]+\.fa\.(?:[a-z0-9-]+\.)?(?:ocs\.)?oraclecloud(?:[1-9][0-9]?)?\.com$/i;

const PAGE_SIZE = 200;
const MAX_PAGES = 25;             // safety cap (~5000 jobs); hard ceiling like workday
const RETRY_POLICY = { retries: 3 };
const INTER_PAGE_DELAY_MS = 250;  // WAF-aware spacing between same-host pages

// facetsList is a fixed constant on the finder; %3B is the encoded ';' separator.
const FACETS_LIST = 'LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS';

/** ORC coordinates resolved from a portal entry. */
export interface OracleSite {
  host: string;
  lang: string;
  siteNumber: string;
  locationId: string | null;
}

/** One normalized requisition. */
export type OracleJob = {
  title: string;
  url: string;
  company: string;
  location: string;
  description?: string;
  postedAt?: number;
};

/** Portal-entry fields this provider reads beyond the shared shape. */
export type OracleEntry = PortalEntry & { siteNumber?: string; locationId?: string | number };

/** Narrow an untrusted JSON value to an object with unknown fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function assertOracleUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`oraclecloud: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`oraclecloud: URL must use HTTPS: ${url}`);
  if (!ORACLE_HOST_RE.test(parsed.hostname)) {
    throw new Error(`oraclecloud: untrusted hostname "${parsed.hostname}" — must match *.fa[.<region>][.ocs].oraclecloud[1-99].com`);
  }
  return url;
}

// NaN-safe Date.parse — `|| undefined` would also coerce a valid epoch 0.
// (copied from greenhouse.ts)
function toEpochMs(value: unknown): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Resolve ORC coordinates from a portal entry. `entry.api` takes precedence
 * over `entry.careers_url` (mirrors greenhouse/ashby/smartrecruiters) so a
 * branded careers page can stay as careers_url while the ORC host/site is
 * pinned via api:. Honors optional `entry.siteNumber` / `entry.locationId`.
 */
export function resolveSite(entry: OracleEntry): OracleSite | null {
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!ORACLE_HOST_RE.test(parsed.hostname)) continue;

    const segs = parsed.pathname.split('/').filter(Boolean);
    // Path shape: /hcmUI/CandidateExperience/<lang>/sites/<siteNumber>/...
    const ceIdx = segs.findIndex((s) => s === 'CandidateExperience');
    const lang = ceIdx !== -1 && segs[ceIdx + 1] ? segs[ceIdx + 1] : 'en';
    const sitesIdx = segs.indexOf('sites');
    const siteFromUrl = sitesIdx !== -1 && segs[sitesIdx + 1] ? segs[sitesIdx + 1] : null;

    const overrideSite = typeof entry.siteNumber === 'string' && entry.siteNumber ? entry.siteNumber : null;
    const siteNumber = overrideSite || siteFromUrl || 'CX_1';
    const locationId = entry.locationId != null && `${entry.locationId}` !== ''
      ? `${entry.locationId}`
      : null;

    return { host: parsed.hostname, lang, siteNumber, locationId };
  }
  return null;
}

/**
 * Build the requisitions API URL. Params are set in BOTH the finder segment
 * and top-level (some tenants only honor one). facetsList uses %3B-encoded ';'.
 */
export function buildApiUrl(site: { host: string; siteNumber: string; locationId?: string | null }, offset = 0, limit = PAGE_SIZE): string {
  // Finder grammar: `findReqs;key=val,key=val,...` — a ';' after the finder
  // name, then comma-separated key/value pairs. (A comma after findReqs 400s.)
  const finderParams = [
    `siteNumber=${site.siteNumber}`,
    `facetsList=${FACETS_LIST}`,
    `limit=${limit}`,
    'sortBy=POSTING_DATES_DESC',
    `offset=${offset}`,
  ];
  if (site.locationId) finderParams.push(`locationId=${site.locationId}`);
  const finder = `findReqs;${finderParams.join(',')}`;
  const expand = 'requisitionList.workLocation,requisitionList.secondaryLocations';
  return `https://${site.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`
    + `?onlyData=true`
    + `&expand=${encodeURIComponent(expand)}`
    + `&finder=${finder}`
    + `&limit=${limit}&offset=${offset}`;
}

/**
 * Build the public posting URL for a requisition Id.
 */
export function buildJobUrl(site: { host: string; lang: string; siteNumber: string }, id: string): string {
  return `https://${site.host}/hcmUI/CandidateExperience/${site.lang}/sites/${site.siteNumber}/job/${id}`;
}

/**
 * Assemble a location string for a requisition. Prefers PrimaryLocation; else
 * builds from the expanded workLocation object; appends a remote/hybrid hint
 * from WorkplaceTypeCode. Returns "" when nothing is available.
 */
function assembleLocation(req: unknown): string {
  const row = asRecord(req);
  let base = typeof row.PrimaryLocation === 'string' ? row.PrimaryLocation.trim() : '';
  if (!base && Array.isArray(row.workLocation) && row.workLocation.length) {
    const wl = asRecord(row.workLocation[0]);
    base = [wl.TownOrCity, wl.Region, wl.Country].filter((v) => typeof v === 'string' && v.trim()).join(', ');
  }
  const wt = row.WorkplaceTypeCode;
  const remoteHint = wt === 'ORA_REMOTE' ? 'Remote' : wt === 'ORA_HYBRID' ? 'Hybrid' : '';
  return [base, remoteHint].filter(Boolean).join(' · ');
}

/**
 * Pure normalizer for an ORC requisitions response. Exported for unit tests.
 * Reads items[0].requisitionList[], maps each to the Job shape, drops rows with
 * no resolvable URL. Returns [] for null / {} / non-array / {items:null}.
 */
export function parseOracleResponse(
  json: unknown,
  site: { host: string; lang: string; siteNumber: string },
  companyName: string,
): OracleJob[] {
  const items = asRecord(json).items;
  const item = Array.isArray(items) ? asRecord(items[0]) : null;
  const list = item && Array.isArray(item.requisitionList) ? (item.requisitionList as unknown[]) : null;
  if (!list) return [];
  const out: OracleJob[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const req = asRecord(raw);
    const id = req.Id != null ? String(req.Id) : (req.RequisitionNumber != null ? String(req.RequisitionNumber) : '');
    const externalUrl = typeof req.ExternalURL === 'string' && req.ExternalURL.trim() ? req.ExternalURL.trim() : '';
    const url = externalUrl || (id ? buildJobUrl(site, id) : '');
    if (!url) continue; // dedup key — drop rows we can't link to
    const job: OracleJob = {
      title: typeof req.Title === 'string' ? req.Title : '',
      url,
      company: companyName,
      location: assembleLocation(req),
    };
    if (typeof req.ShortDescriptionStr === 'string' && req.ShortDescriptionStr.trim()) {
      job.description = decodeEntities(req.ShortDescriptionStr);
    }
    const postedAt = toEpochMs(req.PostedDate);
    if (postedAt !== undefined) job.postedAt = postedAt;
    out.push(job);
  }
  return out;
}

const provider: Provider = {
  id: 'oraclecloud',

  detect(entry: PortalEntry): DetectHit | null {
    try {
      const site = resolveSite(entry);
      return site ? { url: buildApiUrl(site, 0, PAGE_SIZE) } : null;
    } catch {
      return null;
    }
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const site = resolveSite(entry);
    if (!site) throw new Error(`oraclecloud: cannot derive API URL for ${entry.name}`);

    const maxPages = Number.isInteger(entry.max_pages) && Number(entry.max_pages) > 0
      ? Math.min(Number(entry.max_pages), MAX_PAGES)
      : MAX_PAGES;

    const all: OracleJob[] = [];
    let total: number | null = null;
    for (let page = 0; page < maxPages; page++) {
      const offset = page * PAGE_SIZE;
      const apiUrl = buildApiUrl(site, offset, PAGE_SIZE);
      assertOracleUrl(apiUrl); // SSRF guard before every fetch
      if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);

      const json = await fetchJsonWithRetry(ctx, apiUrl, {
        redirect: 'error',
        headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT, Accept: 'application/json' },
      }, RETRY_POLICY);

      const parsed = parseOracleResponse(json, site, entry.name);
      all.push(...parsed);

      const items = asRecord(json).items;
      const item = Array.isArray(items) ? asRecord(items[0]) : null;
      if (total === null && item && typeof item.TotalJobsCount === 'number') total = item.TotalJobsCount;
      const listLen = item && Array.isArray(item.requisitionList) ? item.requisitionList.length : 0;

      // Stop conditions. NOTE: `hasMore` is unreliable on some tenants (e.g.
      // JPMC returns hasMore:false on EVERY page even with 7000+ jobs), so it's
      // NOT used to stop — trusting it caps the scan at one page.
      //
      // An empty page is always the end. A SHORT page is not: ORC serves fewer
      // rows than the limit mid-list (American Express reports TotalJobsCount
      // 454 and serves 200, 199, 54 — one row is filtered server-side), and
      // treating that 199 as the end dropped the last 54 postings, 12% of the
      // board. Matching the wider convention: "the API may return fewer results
      // than the number requested … even if not at the end of the collection"
      // (Google AIP-158). So a short page only ends the walk when the tenant
      // reports no total to check it against.
      if (listLen === 0) break;
      if (total !== null) {
        if (offset + PAGE_SIZE >= total) break;
      } else if (listLen < PAGE_SIZE) break;
    }
    return all;
  },
};

export default provider;
