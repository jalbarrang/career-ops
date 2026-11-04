import { decodeEntities } from './_html-entities.ts';
import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';

// LaraJobs provider — the board-wide public RSS feed at
// https://larajobs.com/feed (Laravel / PHP jobs). The feed is public, no-auth,
// and XML, so it is parsed in-process with the same tiny tag extractor as
// packages/core/src/scanning/providers/nodesk.ts rather than adding an XML dependency.
//
// Each <item> carries the standard RSS fields plus a `job:` namespace with
// `<job:company>` and `<job:location>`, so company and location come straight
// from the feed (no title-splitting heuristics needed).
//
// Wire in via a `job_boards:` entry with `provider: larajobs`.

const FEED_URL = 'https://larajobs.com/feed';
const TRUSTED_HOST = 'larajobs.com';

function assertLarajobsUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`larajobs: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`larajobs: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`larajobs: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

// NaN-safe Date.parse - `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fallbackCompany(entry: PortalEntry): string {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'LaraJobs';
}

const larajobs: Provider = {
  id: 'larajobs',

  detect(entry: PortalEntry): DetectHit | null {
    return entry?.provider === 'larajobs' ? { url: FEED_URL } : null;
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const feedUrl = assertLarajobsUrl(FEED_URL);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertLarajobsUrl above it keeps the request pinned to larajobs.com.
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    return parseLarajobsFeed(text, fallbackCompany(entry));
  },
};

// Resolve a tag's inner text: unwrap a CDATA section, else decode entities.
function extractText(inner: string): string {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

// Extract the text of the first <tag>...</tag> in a block. Returns '' when
// absent. Tag names may carry a namespace colon (e.g. job:company).
function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

// Keep only absolute HTTPS links hosted on the trusted board domain.
function cleanUrl(value: string): string {
  if (!value) return '';
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Parse LaraJobs' public RSS jobs feed. Exported for unit tests.
 *
 * Shape: `<rss><channel><item>...</item>...</channel></rss>`. Each item exposes
 * `<title>`, `<link>` (larajobs.com/job/<id>), `<pubDate>`, and a `job:`
 * namespace with `<job:company>` and `<job:location>`. Company falls back to
 * `<dc:creator>` then the entry name; location may be empty.
 *
 * @param xml - raw RSS feed body
 * @param defaultCompany - fallback company when the feed omits one
 */
export function parseLarajobsFeed(xml: string, defaultCompany = 'LaraJobs'): Job[] {
  if (typeof xml !== 'string') return [];
  const fallback = typeof defaultCompany === 'string' && defaultCompany.trim() ? defaultCompany.trim() : 'LaraJobs';
  const jobs: Job[] = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const title = tagText(item, 'title');
    if (!title) continue;

    const company = tagText(item, 'job:company') || tagText(item, 'dc:creator') || fallback;
    const postedAt = toEpochMs(tagText(item, 'pubDate'));
    const job: Job = {
      title,
      company,
      location: tagText(item, 'job:location'),
      url,
    };
    if (postedAt !== undefined) job.postedAt = postedAt;
    jobs.push(job);
  }

  return jobs;
}

export default larajobs;
