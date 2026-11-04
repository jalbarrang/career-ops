import { decodeEntities } from './_html-entities.ts';
import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';

// We Work Remotely provider - board-wide RSS feed
// (https://weworkremotely.com/remote-jobs.rss). The feed is public, no-auth,
// and XML, so it is parsed in-process with the same tiny tag extractor approach
// as providers/personio.ts rather than adding an XML dependency.
//
// Wire in via a `job_boards:` entry with `provider: weworkremotely`.

const FEED_URL = 'https://weworkremotely.com/remote-jobs.rss';
const TRUSTED_HOST = 'weworkremotely.com';

function assertWwrUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`weworkremotely: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`weworkremotely: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`weworkremotely: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`);
  }
  return url;
}

// NaN-safe Date.parse - `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value: unknown): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fallbackCompany(entry: PortalEntry): string {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'We Work Remotely';
}

const provider: Provider = {
  id: 'weworkremotely',

  detect(entry: PortalEntry): DetectHit | null {
    return entry?.provider === 'weworkremotely' ? { url: FEED_URL } : null;
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const feedUrl = assertWwrUrl(FEED_URL);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertWwrUrl above it keeps the request pinned to weworkremotely.com.
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    return parseWwrFeed(text, fallbackCompany(entry));
  },
};

export default provider;

// Resolve a tag's inner text: unwrap a CDATA section, else decode entities.
function extractText(inner: string): string {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

// Extract the text of the first <tag>...</tag> in a block. Returns '' when absent.
function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

function cleanUrl(value: string): string {
  if (!value) return '';
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

function splitTitle(rawTitle: string, defaultCompany: string): { company: string; title: string } {
  const text = rawTitle.trim();
  const colon = text.indexOf(':');
  if (colon > 0) {
    const company = text.slice(0, colon).trim();
    const title = text.slice(colon + 1).trim();
    if (company && title) return { company, title };
  }
  return { company: defaultCompany, title: text };
}

/**
 * Parse We Work Remotely's public RSS jobs feed. Exported for unit tests.
 *
 * Shape: `<rss><channel><item>...</item>...</channel></rss>`, each item
 * carrying `<title>`, `<link>`, `<pubDate>`, and often `<region>` plus
 * `<category>`. The title is usually "Company: Role"; when that split is
 * present, company and title are normalized separately. The RSS `<link>` is
 * the dedup key; items without a usable absolute URL are dropped.
 *
 * @param xml - raw RSS feed body
 * @param defaultCompany - fallback company for unsplittable titles
 */
export function parseWwrFeed(xml: string, defaultCompany = 'We Work Remotely'): Job[] {
  if (typeof xml !== 'string') return [];
  const fallback = typeof defaultCompany === 'string' && defaultCompany.trim() ? defaultCompany.trim() : 'We Work Remotely';
  const jobs: Job[] = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const rawTitle = tagText(item, 'title');
    if (!rawTitle) continue;

    const { company, title } = splitTitle(rawTitle, fallback);
    const location = tagText(item, 'region') || tagText(item, 'category');

    jobs.push({
      title,
      company,
      location,
      url,
      postedAt: toEpochMs(tagText(item, 'pubDate')),
    });
  }

  return jobs;
}
