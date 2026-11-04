import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';
import { intInRange } from './_config-utils.ts';
import { htmlToText } from './_html-to-text.ts';
import { coerceId } from './_ids.ts';
import { safeEncodeURIComponent } from './_safe-url.ts';

// SmartRecruiters provider — hits the public postings API.
// Auto-detects from careers_url pattern
// `https://(careers|jobs).smartrecruiters.com/<slug>`. A tracked_companies
// entry can also set `provider: smartrecruiters` explicitly to bypass
// detection (useful when the public careers URL is a branded custom domain).
//
// The list payload carries NO description body. Boards that need it opt in
// via tracked_companies config (mirrors vdab):
//
//   smartrecruiters:
//     fetchDetails: true   # fetch each posting's detail JSON for descriptions
//     detailLimit: 25      # max detail calls per sweep when fetchDetails=true
//
// Detail enrichment answers "what does this job say", not "is this endpoint
// alive" — it is skipped entirely while verify-portals is probing, and runs
// in small batches so a 400-posting board cannot hammer the shared API host.

const ALLOWED_SMARTRECRUITERS_HOSTS = new Set(['api.smartrecruiters.com']);
const SR_CAREERS_HOSTS = new Set(['careers.smartrecruiters.com', 'jobs.smartrecruiters.com']);
const SR_PAGE_SIZE = 100;
const SR_MAX_PAGES = 50;  // safety cap (5000 postings @ 100/page)
const SR_DETAIL_BATCH = 5;

/** One posting as the list parser emits it (the `id` is stripped before return). */
export interface SmartRecruitersPosting {
  title: string;
  url: string;
  company: string;
  location: string;
  id?: string;
  requisitionId?: string;
  language?: string;
  description?: string;
}

/** Narrow an untrusted JSON value to an object with unknown fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function parseSmartRecruitersConfig(entry: PortalEntry): { fetchDetails: boolean; detailLimit: number } {
  const cfg = asRecord(entry.smartrecruiters);
  return {
    fetchDetails: cfg.fetchDetails === true,
    detailLimit: intInRange(cfg.detailLimit, 25, 1, 100),
  };
}

/**
 * Extracts the best plain-text description from a posting-detail response.
 *
 * The detail payload nests HTML bodies under `jobAd.sections`, keyed by a
 * fixed section set (companyDescription, jobDescription, qualifications,
 * additionalInformation). Joined in that order — company context first,
 * call-to-action last — then stripped by the shared pipeline.
 *
 * @param detail
 */
export function extractDescription(detail: unknown): string {
  const sections = asRecord(asRecord(detail).jobAd).sections;
  if (!sections || typeof sections !== 'object') return '';
  const sectionMap = asRecord(sections);
  const parts: string[] = [];
  for (const key of ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']) {
    const text = asRecord(sectionMap[key]).text;
    if (typeof text === 'string' && text.trim()) parts.push(text);
  }
  if (parts.length === 0) return '';
  return htmlToText(parts.join('\n'));
}

function assertSmartRecruitersUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`smartrecruiters: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`smartrecruiters: URL must use HTTPS: ${url}`);
  if (!ALLOWED_SMARTRECRUITERS_HOSTS.has(parsed.hostname)) {
    throw new Error(`smartrecruiters: untrusted hostname "${parsed.hostname}" — must be one of: ${[...ALLOWED_SMARTRECRUITERS_HOSTS].join(', ')}`);
  }
  return url;
}

function resolveSlug(entry: PortalEntry): string | null {
  // entry.api takes precedence over careers_url (mirrors greenhouse/ashby) so a
  // branded page (e.g. https://jobs.continental.com) can stay as careers_url
  // while the SmartRecruiters slug is pinned via
  // api: https://careers.smartrecruiters.com/<slug> in portals.yml.
  for (const raw of [entry.api, entry.careers_url]) {
    if (typeof raw !== 'string' || !raw) continue;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol !== 'https:') continue;
    if (!SR_CAREERS_HOSTS.has(parsed.hostname)) continue;
    const slug = parsed.pathname.split('/').filter(Boolean)[0];
    if (slug) return slug;
  }
  return null;
}

function buildPostingsUrl(slug: string, offset = 0): string {
  return `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=${SR_PAGE_SIZE}&offset=${offset}&status=PUBLIC`;
}

function buildPostingDetailUrl(slug: string, id: string): string {
  return `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${encodeURIComponent(id)}`;
}

function resolveApiUrl(entry: PortalEntry): string | null {
  const slug = resolveSlug(entry);
  return slug ? buildPostingsUrl(slug, 0) : null;
}

const provider: Provider = {
  id: 'smartrecruiters',

  detect(entry: PortalEntry): DetectHit | null {
    const apiUrl = resolveApiUrl(entry);
    return apiUrl ? { url: apiUrl } : null;
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const slug = resolveSlug(entry);
    if (!slug) throw new Error(`smartrecruiters: cannot derive API URL for ${entry.name}`);

    // Honor the ctx.maxPages pagination hint (the portal health probe passes 1);
    // a real sweep keeps the SR_MAX_PAGES safety cap.
    const pageLimit = Math.min(
      SR_MAX_PAGES,
      Number.isInteger(ctx?.maxPages) && Number(ctx.maxPages) > 0 ? Number(ctx.maxPages) : Infinity,
    );

    const all: SmartRecruitersPosting[] = [];
    for (let page = 0; page < pageLimit; page++) {
      const apiUrl = buildPostingsUrl(slug, page * SR_PAGE_SIZE);
      assertSmartRecruitersUrl(apiUrl);
      const json = await ctx.fetchJson(apiUrl, { redirect: 'error' });
      const parsed = parseSmartRecruitersResponse(json, entry.name, slug);
      all.push(...parsed);
      // A dropped malformed ID must not hide postings on subsequent pages.
      const content = asRecord(json).content;
      if (!Array.isArray(content) || content.length < SR_PAGE_SIZE) break;
    }

    // Detail enrichment answers "what does this job say", not "is this
    // endpoint alive" — skip it entirely while probing so it never spends
    // budget a liveness check has no use for (same rule as vdab).
    const { fetchDetails, detailLimit } = parseSmartRecruitersConfig(entry);
    const probing = Number.isInteger(ctx?.maxPages) && Number(ctx.maxPages) > 0;
    if (fetchDetails && !probing) {
      const jobs = all
        .filter((job): job is SmartRecruitersPosting & { id: string } => Boolean(job.id))
        .slice(0, detailLimit);
      for (let i = 0; i < jobs.length; i += SR_DETAIL_BATCH) {
        const batch = jobs.slice(i, i + SR_DETAIL_BATCH);
        await Promise.all(batch.map(async (job) => {
          try {
            const detailUrl = buildPostingDetailUrl(slug, job.id);
            assertSmartRecruitersUrl(detailUrl);
            const detail = await ctx.fetchJson(detailUrl, { redirect: 'error' });
            const description = extractDescription(detail);
            if (description) job.description = description;
          } catch {
            // Detail fetch is an enrichment only. Keep the listing result.
          }
        }));
      }
    }

    // The numeric posting id drove the detail calls above; it is internal
    // plumbing and must not leak into the pipeline's Job rows (vdab strips
    // its id the same way).
    return all.map(({ id, ...job }) => job);
  },
};

export default provider;

/**
 * Parse a SmartRecruiters /postings response. Exported for unit tests.
 *
 * SmartRecruiters returns:
 *   { content: [{ id, name, ref, refNumber, language: { code },
 *                 location: { fullLocation?, city?, region?, country?, remote? } }] }
 *
 * - requisitionId: `refNumber`, the employer's requisition id. It is stable
 *   across re-releases of one requisition (each re-release gets a new posting
 *   `id`), and shared by every language version of it.
 * - language: `language.code`, the language code of the posting's text (`de`,
 *   `en-GB`, `pt-BR`).
 *
 * Both keys are omitted when the payload carries no usable value.
 *
 * - location: prefer `fullLocation`; else assemble from city/region/country
 *   parts (skipping empties); append "Remote" when `location.remote` is true.
 * - url: `j.ref` is an `api.smartrecruiters.com/v1/companies/<slug>/postings/<id>`
 *   URL — rewrite to the public `jobs.smartrecruiters.com/<slug>/<id>-<title-slug>`.
 *   The public site has no `/postings/` segment; carrying it over yields a 404,
 *   which the liveness checker then reports as an expired posting (#1612).
 *   SmartRecruiters resolves the page by id alone, so the trailing title slug is
 *   cosmetic. If `ref` is missing or untrusted, synthesise the same shape from
 *   the configured company slug + posting id. The display name is only a
 *   fallback for callers that do not supply a company slug.
 *   A posting that needs the fallback and has an unencodable ID (a lone
 *   surrogate) is omitted, so the result can be shorter than `content`.
 */
export function parseSmartRecruitersResponse(
  json: unknown,
  companyName: string,
  companySlug?: string,
): SmartRecruitersPosting[] {
  const items = asRecord(json).content;
  if (!Array.isArray(items)) return [];
  return (items as unknown[]).flatMap((j: unknown): SmartRecruitersPosting[] => {
    const row = asRecord(j);
    const loc = asRecord(row.location);
    const fullLocation = typeof loc.fullLocation === 'string' && loc.fullLocation
      ? loc.fullLocation
      : [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
    const remote = loc.remote ? 'Remote' : '';
    const location = [fullLocation, remote].filter(Boolean).join(', ');
    const name = typeof row.name === 'string' ? row.name : '';
    const slugified = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let url = '';
    if (typeof row.ref === 'string') {
      let parsedRef: URL | null;
      try { parsedRef = new URL(row.ref); } catch { parsedRef = null; }
      if (parsedRef
          && parsedRef.protocol === 'https:'
          && parsedRef.hostname === 'api.smartrecruiters.com'
          && parsedRef.pathname.startsWith('/v1/companies/')) {
        // /v1/companies/<slug>/postings/<id> → <slug>, <id>
        const [refSlug, postings, refId] = parsedRef.pathname
          .slice('/v1/companies/'.length)
          .split('/')
          .filter(Boolean);
        if (refSlug && postings === 'postings' && refId) {
          url = `https://jobs.smartrecruiters.com/${refSlug}/${refId}${slugified ? `-${slugified}` : ''}`;
        }
      }
    }
    if (!url && row.id) {
      const fallbackSlug = companySlug || (companyName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      if (fallbackSlug) {
        const encodedId = safeEncodeURIComponent(row.id);
        if (encodedId === null) return [];
        url = `https://jobs.smartrecruiters.com/${fallbackSlug}/${encodedId}${slugified ? `-${slugified}` : ''}`;
      }
    }
    const requisitionId = coerceId(row.refNumber);
    const language = coerceId(asRecord(row.language).code);
    return [{
      title: name,
      url,
      location,
      company: companyName,
      id: typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : undefined,
      ...(requisitionId ? { requisitionId } : {}),
      ...(language ? { language } : {}),
    }];
  });
}
