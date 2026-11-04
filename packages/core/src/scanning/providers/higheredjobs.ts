import { decodeEntities } from './_html-entities.ts';
import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';

// HigherEdJobs.com RSS category feed provider.
// (https://www.higheredjobs.com/rss/categoryFeed.cfm?catID=68). The feed is
// public, no-auth, and XML, so it is parsed in-process with the same tiny tag
// extractor approach as packages/core/src/scanning/providers/weworkremotely.ts rather than adding an
// XML dependency.
//
// Wire in via a `job_boards:` entry with `provider: higheredjobs`.

const DEFAULT_CAT_ID = 68; // Higher Education category
const TRUSTED_HOST = 'www.higheredjobs.com';

function feedUrlFor(catId: unknown): string {
  const catID = typeof catId === 'number' && Number.isFinite(catId) ? catId : DEFAULT_CAT_ID;
  return `https://www.higheredjobs.com/rss/categoryFeed.cfm?catID=${catID}`;
}

// NaN-safe Date.parse - `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value: unknown): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

function fallbackCompany(entry: PortalEntry): string {
  return typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : 'HigherEdJobs';
}

const provider: Provider = {
  id: 'higheredjobs',

  detect(entry: PortalEntry): DetectHit | null {
    if (entry?.provider !== 'higheredjobs') return null;
    return { url: feedUrlFor(entry.cat_id) };
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const feedUrl = feedUrlFor(entry?.cat_id);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // cleanUrl below it keeps the request pinned to www.higheredjobs.com.
    const text = await ctx.fetchText(feedUrl, { redirect: 'error' });
    assertRssFeed(text);
    return parseHigherEdJobsFeed(text, fallbackCompany(entry));
  },
};

export default provider;

// The RSS endpoint sits behind an Incapsula bot wall on some networks, and the
// wall answers 200 with a small HTML challenge page. Parsed as a feed that is
// zero <item>s, so the board read as "0 jobs" with no hint that nothing was
// fetched (#3637). A feed with no items is still a valid, empty board; only a
// body that is not a feed at all is an error. Solving the challenge is out of
// scope: providers are fetch-only.
function assertRssFeed(text: string): void {
  if (typeof text === 'string' && /<(?:rss|channel)\b/i.test(text)) return;
  if (typeof text === 'string' && /<html\b/i.test(text)) {
    throw new Error('higheredjobs: RSS endpoint answered a challenge page, not a feed');
  }
  throw new Error('higheredjobs: RSS endpoint answered no feed');
}

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
    // Exact-match host (no subdomain wildcard): higheredjobs serves only
    // www.higheredjobs.com for posting URLs.
    const trusted = host === TRUSTED_HOST;
    return parsed.protocol === 'https:' && trusted ? parsed.href : '';
  } catch {
    return '';
  }
}

// HigherEdJobs <description> is "Institution Name (City, ST)". Split on the
// last " (" to separate company from location. When no parens are present the
// whole description is treated as the company and location is empty.
function splitDescription(rawDescription: string, defaultCompany: string): { company: string; location: string } {
  const text = rawDescription.trim();
  const open = text.lastIndexOf(' (');
  if (open > 0) {
    const close = text.lastIndexOf(')');
    const company = text.slice(0, open).trim();
    const location = close > open ? text.slice(open + 2, close).trim() : text.slice(open + 2).trim();
    if (company) return { company, location };
  }
  return { company: text || defaultCompany, location: '' };
}

/**
 * Parse HigherEdJobs' public RSS category feed. Exported for unit tests.
 *
 * Shape: `<rss><channel><item>...</item>...</channel></rss>`, each item
 * carrying `<title>` (plain job title), `<description>` ("Institution (City,
 * ST)"), `<link>`, `<pubDate>`, and `<guid>`. Company and location are
 * derived from <description>. The RSS <link> is the dedup key; items without
 * a usable absolute URL on www.higheredjobs.com are dropped.
 *
 * @param xml - raw RSS feed body
 * @param defaultCompany - fallback company for empty descriptions
 */
export function parseHigherEdJobsFeed(xml: string, defaultCompany = 'HigherEdJobs'): Job[] {
  if (typeof xml !== 'string') return [];
  const fallback = typeof defaultCompany === 'string' && defaultCompany.trim() ? defaultCompany.trim() : 'HigherEdJobs';
  const jobs: Job[] = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, 'link'));
    if (!url) continue;

    const title = tagText(item, 'title');
    if (!title) continue;

    const { company, location } = splitDescription(tagText(item, 'description'), fallback);

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
