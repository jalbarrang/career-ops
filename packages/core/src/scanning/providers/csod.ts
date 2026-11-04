// Cornerstone OnDemand (CSOD) career-site provider — the hosted boards at
// https://{tenant}.csod.com/ux/ats/careersite/{siteId}/home?c={corpName}
// (e.g. OHB: career-ohb.csod.com/ux/ats/careersite/4/home?c=career-ohb).
//
// The search API is public but wants a bearer token. The career-site home page
// is a small (~5 KB) bootstrap document that embeds an ANONYMOUS JWT as
// `"token":"eyJ…"` — no login needed. It ALSO sets session cookies, and some
// tenants (verified live on careers-kln) reject the search call with
// "HTTP 401 CSOD Unauthorized" unless those cookies come back alongside the
// token, so both halves of the bootstrap response matter. Flow per fetch:
//
//   1. GET  {origin}/ux/ats/careersite/{siteId}/home?c={corpName}
//                                          → extract token AND session cookies
//   2. POST {origin}/services/x/career-site/v1/search               → page through
//      body: {careerSiteId, careerSitePageId, pageNumber (1-based), pageSize,
//             cultureId, cultureName, searchText:"", …empty facet arrays}
//      → {data: {totalCount, requisitions: [{requisitionId, displayJobTitle,
//                postingEffectiveDate: "M/D/YYYY", locations: [{city,state,country}]}]}}
//
// Job detail URL (verified live): {origin}/ux/ats/careersite/{siteId}/home/
// requisition/{requisitionId}?c={corpName}.
//
// Detection: *.csod.com hosts auto-claim when the path carries the careersite
// shape; the branded corporate page goes in careers_url and the csod.com URL in
// `api:` (same convention as workday/successfactors).

// Titles arrive HTML-escaped, so the tag strip below is not enough on its own:
// an undecoded "R&amp;D Engineer" fails the user's own title_filter positive
// "r&d" and is silently dropped, and a negative like "sales & marketing" never
// vetoes "Sales &amp; Marketing Lead". Shared decoder, same as softgarden and
// radancy (#2487, #2921).
import { decodeEntities } from './_html-entities.ts';
import { sleep } from './_http.ts';
import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';

const PAGE_SIZE = 25; // server default; verified OHB serves exactly 25/page
const MAX_PAGES = 40; // safety cap on request count (40*25 = 1000 postings)
const MAX_JOBS = 1000; // cap total postings pulled per site
const PAGE_DELAY_MS = 120; // polite pacing between search requests

/** Resolved tenant coordinates for one careersite. */
export interface CsodConfig {
  origin: string;
  siteId: number;
  corpName: string;
  homeUrl: string;
  searchApi: string;
}

/** One requisition row, before it becomes a `Job`. */
interface CsodRequisition {
  id: string;
  title: string;
  url: string;
  location: string;
  postedAt: number | undefined;
}

/** Narrow a parsed-JSON value to an indexable object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Parse tenant/site/corp out of a careersite URL.
 */
export function resolveConfig(entry: PortalEntry): CsodConfig | null {
  const raw = entry.api || entry.careers_url || '';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  // HTTPS only: the bootstrap Set-Cookie values are replayed on the search
  // request, so an http: entry would put session cookies on the wire in clear.
  if (u.protocol !== 'https:') return null;
  const host = u.host.toLowerCase();
  if (host !== 'csod.com' && !host.endsWith('.csod.com')) return null;
  const m = u.pathname.match(/\/ux\/ats\/careersite\/(\d+)\//i) || u.pathname.match(/\/ux\/ats\/careersite\/(\d+)$/i);
  if (!m) return null;
  const siteId = Number(m[1]);
  const corpName = u.searchParams.get('c') || host.split('.')[0];
  return {
    origin: u.origin,
    siteId,
    corpName,
    homeUrl: `${u.origin}/ux/ats/careersite/${siteId}/home?c=${encodeURIComponent(corpName)}`,
    searchApi: `${u.origin}/services/x/career-site/v1/search`,
  };
}

/**
 * Build a `Cookie` request header from the bootstrap response's Set-Cookie
 * headers. Only the leading name=value pair is meaningful on a request;
 * attributes (path/HttpOnly/Secure/SameSite/Expires) describe storage rules for
 * a browser jar and are dropped. A repeated name takes its last definition,
 * mirroring jar semantics. Returns '' when nothing usable was set, which the
 * caller treats as "send no cookie header at all".
 */
export function cookieHeaderFrom(setCookies: string[]): string {
  const jar = new Map<string, string>();
  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    if (typeof raw !== 'string') continue;
    const pair = raw.split(';', 1)[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue; // no '=', or an empty name — not a cookie
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Pull the anonymous bearer token out of the bootstrap home page.
 */
export function extractToken(html: string): string {
  const m = typeof html === 'string' ? html.match(/"token"\s*:\s*"([A-Za-z0-9._-]+)"/) : null;
  return m ? m[1] : '';
}

// postingEffectiveDate is US-format M/D/YYYY ("7/3/2026") → epoch ms (UTC for
// determinism; consumers only use this for coarse recency ranking).
export function parseCsodDate(raw: unknown): number | undefined {
  const m = typeof raw === 'string' ? raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/) : null;
  if (!m) return undefined;
  const month = Number(m[1]);
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const ms = Date.UTC(year, month - 1, day);
  if (new Date(ms).getUTCDate() !== day) return undefined; // catches 4/31, 2/30, etc.
  return Number.isFinite(ms) ? ms : undefined;
}

// locations is an array of {city, state, country}. City is the useful part;
// append the country code when present ("Bremen, DE"). Multiple work locations
// join with " / ".
export function cleanLocations(raw: unknown): string {
  const list: unknown[] = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const loc of list) {
    if (!isRecord(loc)) continue;
    const city = String(loc.city || '').trim();
    const country = String(loc.country || '').trim();
    const s = city ? (country ? `${city}, ${country}` : city) : country;
    if (s && !out.includes(s)) out.push(s);
  }
  return out.join(' / ');
}

/**
 * Map one search response page to raw {id, title, url, location, postedAt}.
 * Records without an id or a title are skipped (no stable dedup key / no
 * meaningful listing).
 */
export function parseRequisitions(
  json: unknown,
  cfg: { origin: string; siteId: number; corpName: string },
): CsodRequisition[] {
  const data = isRecord(json) && isRecord(json.data) ? json.data : {};
  const list: unknown[] = Array.isArray(data.requisitions) ? data.requisitions : [];
  const out: CsodRequisition[] = [];
  for (const r of list) {
    if (!isRecord(r)) continue;
    const id = r.requisitionId != null ? String(r.requisitionId) : '';
    const title = decodeEntities(String(r.displayJobTitle || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!id || !title) continue;
    out.push({
      id,
      title,
      url: `${cfg.origin}/ux/ats/careersite/${cfg.siteId}/home/requisition/${id}?c=${encodeURIComponent(cfg.corpName)}`,
      location: cleanLocations(r.locations),
      postedAt: parseCsodDate(r.postingEffectiveDate),
    });
  }
  return out;
}

/** Resolve the page cap: positive integer `max_pages`, else default. */
function resolveMaxPages(entry: PortalEntry): number {
  const v = entry?.max_pages;
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return Math.min(v, MAX_PAGES);
  return MAX_PAGES;
}

const csod: Provider = {
  id: 'csod',

  detect(entry: PortalEntry): DetectHit | null {
    const url = entry.api || entry.careers_url || '';
    if (typeof url !== 'string') return null;
    // Host check (not a path substring) so evil.com/x.csod.com can't spoof it,
    // and the URL must carry the careersite path shape we know how to drive.
    return resolveConfig(entry) ? { url } : null;
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const cfg = resolveConfig(entry);
    if (!cfg) throw new Error(`csod: cannot resolve careersite URL for ${entry.name}`);

    // The bootstrap page yields two things, not one: the anonymous bearer
    // token, and — on some tenants — the session cookies the search API
    // insists on. careers-kln rejects an otherwise valid token+body with
    // "HTTP 401 CSOD Unauthorized" until those cookies come back with it, so
    // the token alone is not a sufficient credential. Prefer ctx.fetchResponse
    // to see Set-Cookie; fall back to fetchText when the caller's ctx predates
    // it (older embedders and test mocks), which keeps the pre-cookie
    // behaviour intact for tenants that never needed it.
    //
    // cfg.homeUrl and cfg.searchApi are both built from the same parsed
    // origin, so replaying these cookies cannot reach a third-party host.
    // redirect:'error' on the bootstrap keeps that true: origin validation
    // covers the URL we ask for, not wherever a 3xx would send us.
    let html: string;
    let cookie = '';
    if (typeof ctx.fetchResponse === 'function') {
      const res = await ctx.fetchResponse(cfg.homeUrl, { redirect: 'error', headers: { accept: 'text/html' } });
      const setCookies = typeof res?.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      cookie = cookieHeaderFrom(setCookies);
      html = await res.text();
    } else {
      html = await ctx.fetchText(cfg.homeUrl, { redirect: 'error', headers: { accept: 'text/html' } });
    }
    const token = extractToken(html);
    if (!token) throw new Error(`csod: no anonymous token on ${cfg.homeUrl}`);

    const maxPages = resolveMaxPages(entry);
    const jobs: Job[] = [];
    const seen = new Set<string>();
    let total: number | null = null;

    for (let page = 1; page <= maxPages; page++) {
      if (page > 1) await sleep(PAGE_DELAY_MS, ctx);
      const json: unknown = await ctx.fetchJson(cfg.searchApi, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({
          careerSiteId: cfg.siteId,
          careerSitePageId: cfg.siteId,
          pageNumber: page,
          pageSize: PAGE_SIZE,
          cultureId: 1,
          cultureName: 'en-US',
          searchText: '',
          states: [],
          countryCodes: [],
          cities: [],
          placeID: '',
          radius: null,
          postingsWithinDays: null,
          customFieldCheckboxKeys: [],
          customFieldDropdowns: [],
          customFieldRadios: [],
        }),
      });
      const data = isRecord(json) && isRecord(json.data) ? json.data : {};
      if (total === null) {
        total = typeof data.totalCount === 'number' ? data.totalCount : null;
      }
      const rows = parseRequisitions(json, cfg);
      // Rows the source returned, before parseRequisitions() dropped any. The
      // short-page stop below must use this: a full page with one untitled
      // requisition would otherwise read as the last page.
      const rawCount = Array.isArray(data.requisitions) ? data.requisitions.length : 0;
      if (rows.length === 0) break;

      let fresh = 0;
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        fresh++;
        const job: Job = { title: row.title, url: row.url, company: entry.name, location: row.location };
        if (typeof row.postedAt === 'number') job.postedAt = row.postedAt;
        jobs.push(job);
        if (jobs.length >= MAX_JOBS) break;
      }
      // No new ids → server ignored the page number (or we've looped). Stop.
      if (fresh === 0) break;
      if (jobs.length >= MAX_JOBS) break;
      if (total !== null && page * PAGE_SIZE >= total) break;
      if (rawCount < PAGE_SIZE) break;
    }
    return jobs;
  },
};

export default csod;
