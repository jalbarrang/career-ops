import { decodeEntities } from './_html-entities.ts';
import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';

// Jobspresso provider - public WordPress jobs feed
// (https://jobspresso.co/?feed=job_feed). The feed is public, no-auth,
// and XML, so it is parsed in-process with the same tiny tag extractor
// approach as providers/personio.ts rather than adding an XML dependency.
//
// Wire in via a `job_boards:` entry with `provider: jobspresso`.

const FEED_URL = 'https://jobspresso.co/?feed=job_feed';
const TRUSTED_HOST = 'jobspresso.co';

function assertJobspressoUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jobspresso: invalid URL: ${url}`);
  }
  if (parsed.protocol !== "https:")
    throw new Error(`jobspresso: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(
      `jobspresso: untrusted hostname "${parsed.hostname}" - must be ${TRUSTED_HOST}`,
    );
  }
  return url;
}

// NaN-safe Date.parse - `|| undefined` would also coerce a valid epoch 0.
function toEpochMs(value: string): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

const jobspresso: Provider = {
  id: "jobspresso",

  detect(entry: PortalEntry): DetectHit | null {
    return entry?.provider === "jobspresso" ? { url: FEED_URL } : null;
  },

  async fetch(_entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const feedUrl = assertJobspressoUrl(FEED_URL);
    // redirect:'error' prevents SSRF via server-side redirects; combined with
    // assertJobspressoUrl above it keeps the request pinned to jobspresso.co.
    const text = await ctx.fetchText(feedUrl, { redirect: "error" });
    return parseJobspressoFeed(text);
  },
};

// Resolve a tag's inner text: unwrap a CDATA section, else decode entities.
function extractText(inner: string): string {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

// Extract the text of the first <tag>...</tag> in a block. Returns '' when absent.
function tagText(block: string, tag: string): string {
  const m = block.match(
    new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"),
  );
  return m ? extractText(m[1]) : "";
}

/** Validate a feed URL: https + jobspresso.co (or subdomain) only, else ''. */
function cleanUrl(value: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase();
    const trusted = host === TRUSTED_HOST || host.endsWith(`.${TRUSTED_HOST}`);
    return parsed.protocol === "https:" && trusted ? parsed.href : "";
  } catch {
    return "";
  }
}

/**
 * Parse Jobspresso's public WordPress jobs feed.
 *
 * Shape:
 * <rss><channel><item>...</item></channel></rss>
 *
 * Each item contains:
 * - title
 * - link
 * - pubDate
 * - job_listing:company
 * - job_listing:location
 *
 * The RSS link is used as the dedup key.
 * @param xml - raw RSS feed body
 */
export function parseJobspressoFeed(xml: string): Job[] {
  if (typeof xml !== "string") return [];
  const jobs: Job[] = [];
  const blocks = xml.match(/<item\b[^>]*>[\s\S]*?<\/item>/gi) || [];

  for (const item of blocks) {
    const url = cleanUrl(tagText(item, "link"));
    if (!url) continue;

    const title = tagText(item, "title");
    if (!title) continue;
    const company = tagText(item, "job_listing:company") || "";
    const location = tagText(item, "job_listing:location");

    jobs.push({
      title,
      company,
      location,
      url,
      postedAt: toEpochMs(tagText(item, "pubDate")),
    });
  }

  return jobs;
}

export default jobspresso;
