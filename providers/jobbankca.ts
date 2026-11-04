// Job Bank (Canada) provider — the federal government's public job-search
// service (jobbank.gc.ca), run by Employment and Social Development Canada.
// A national employment service, same class as arbeitsagentur.ts (Germany):
// a high-volume public source no commercial aggregator covers well (#230).
// Wire in via a `job_boards` entry with `provider: jobbankca` and a
// `jobbankca:` block:
//
//   - name: Job Bank Canada — Software
//     provider: jobbankca
//     jobbankca:
//       # keywords optional: falls back to config/profile.yml's target_roles
//       # (primary[] + archetypes[].name) when omitted, same as vdab.ts.
//       keywords: ["software engineer", "backend developer"]
//     enabled: true
//
// PUBLIC FEED, NO AUTH. `FEED_URL` below is Job Bank's public search feed —
// despite "RSS" in its path it is ATOM (`<feed><entry>`, not `<rss><item>`),
// confirmed by fetching it directly. No login, no API key, no session cookie.
//
// robots.txt (fetched 2026-08-21) sets `Crawl-delay: 5` and does not disallow
// `/jobsearch/feed/` or `/jobsearch/jobsearch`:
//   User-agent: *
//   Crawl-delay: 5
// INTER_REQUEST_DELAY_MS below honors that delay between every request this
// provider makes, including the first.
//
// `searchstring` does free-text matching against title+description.
// `locationstring` does NOT reliably filter — measured: `locationstring=
// Toronto` still returned Vancouver/Winnipeg/Québec hits — so, same
// recall-first choice arbeitsagentur.ts already made for its nationwide
// pass, this provider does not attempt location filtering at the source;
// scan.ts's own location_filter runs on the results afterwards.
//
// PAGE SIZE. Measured directly: every page returns exactly 100 entries while
// results remain, and a page past the end returns 0 with a plain HTTP 200 (no
// error, no signal it was the last page other than the count itself). One
// query (`manager`) transiently answered page 1 with 0 entries once and 100
// on an immediate retry seconds later — a live-service hiccup, not a stable
// end-of-results signal. This provider does not special-case it: a dry page
// ends that keyword's pagination (same convention senjob.ts uses), which
// costs at most one keyword's remaining pages on a rare blip and is the same
// recall-first tradeoff arbeitsagentur.ts already accepts for a single
// failed keyword request.

import { fetchTextWithRetry, BROWSER_LIKE_USER_AGENT, sleep } from './_http.ts';
import { decodeEntities } from './_html-entities.ts';
import { resolveProfileKeywords } from './_profile-keywords.ts';
import type { Context, DetectHit, Job, PortalEntry, Provider } from './_types.ts';

/** Narrow a parsed-JSON value to an indexable object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A config value's non-empty trimmed strings, or [] when it is not an array. */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[])
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .map((item) => item.trim());
}

const FEED_URL = 'https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed';
const TRUSTED_HOST = 'www.jobbank.gc.ca';

/** Measured page size; a short page (< this) is the end of that keyword's results. */
const PAGE_SIZE = 100;

/** Pages per keyword; 5 covers a common keyword (~500 postings) with room to spare. */
const DEFAULT_MAX_PAGES = 5;

/** Hard ceiling on a configured `max_pages`, so one entry cannot sweep forever. */
const MAX_PAGES_CAP = 20;

/** robots.txt: `Crawl-delay: 5`. Applied between every request, including the first. */
const INTER_REQUEST_DELAY_MS = 5000;

/**
 * Reads and sanitizes the entry's `jobbankca:` config block.
 */
export function parseJobBankConfig(entry: PortalEntry): { keywords: string[] } {
  const cfg: Record<string, unknown> = isRecord(entry.jobbankca) ? entry.jobbankca : {};
  const keywords = stringList(cfg.keywords);
  return { keywords };
}

export function buildFeedUrl(keyword: string, page: number): string {
  const params = new URLSearchParams({ searchstring: keyword, locationstring: '', page: String(page) });
  return `${FEED_URL}?${params.toString()}`;
}

export function assertJobBankUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`jobbankca: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`jobbankca: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`jobbankca: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

// Resolve an Atom element's inner text: unwrap CDATA, else decode entities.
function extractText(inner: string): string {
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  if (cdata) return cdata[1].trim();
  return decodeEntities(inner).trim();
}

function tagText(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? extractText(m[1]) : '';
}

// <link rel="alternate" type="text/html" href="..."/> — an attribute here,
// not inner text (Atom), unlike an RSS <link>text</link>. An Atom entry may
// carry several <link> elements (e.g. a "self" link alongside "alternate");
// the human-facing posting page is specifically the "alternate" one, so it is
// preferred over whichever <link> happens to come first.
//
// Attributes are tokenized sequentially with a global regex (`attrsOf`)
// rather than searched for with a standalone `rel=`/`href=` pattern. A
// standalone pattern scans the ENTIRE tag text, including the inside of
// other attributes' quoted values — so a same-host attack tag like
// `<link data=" rel='alternate' href='.../WRONG'" rel="self" href="REAL"/>`
// has a `rel='alternate' href='...'` substring inside `data="..."` that is
// preceded by whitespace exactly like a real attribute, defeating even a
// precisely word-boundary-anchored pattern (confirmed by execution: it
// returned WRONG). Sequential tokenization can't make this mistake because
// each match consumes a full `name="value"` pair before the next match
// starts, so a quoted value's contents are never re-scanned as siblings.
function attrsOf(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-\w:.]*)\s*=\s*(["'])((?:(?!\2)[\s\S])*)\2/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[3];
  return attrs;
}

function linkHref(block: string): string {
  const tags: string[] = block.match(/<link(?=[\s/>])[^>]*>/gi) || [];
  const links: Record<string, string>[] = tags.map((tag) => attrsOf(tag));
  const alternate = links.find((a: Record<string, string>) => (a.rel || '').toLowerCase() === 'alternate') || links[0];
  return alternate && alternate.href ? decodeEntities(alternate.href).trim() : '';
}

function cleanUrl(value: string): string {
  if (!value) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST ? parsed.href : '';
  } catch {
    return '';
  }
}

// The summary embeds Location/Employer/Salary as labeled HTML inside one
// CDATA block rather than as separate Atom elements, e.g.:
//   <strong>Job number:</strong> 123<br /><strong>Location:</strong> Vancouver (BC)  <br /><strong>Employer:</strong> Acme Inc<br /><strong>Salary:</strong> $100,000.00 annually
// Each label is extracted independently — Salary is often present but is not
// part of the Job shape (_types.ts), so it is read here only to bound the
// other two fields' matches and is otherwise discarded.
// Strips HTML tags to bare fixed-point, not one regex pass: a single
// `.replace(/<[^>]+>/g, '')` call can leave a residual tag-shaped fragment
// behind when the source deliberately nests malformed brackets (CodeQL
// js/incomplete-multi-character-sanitization) — this is a government feed,
// not attacker-controlled by design, but the summary text still ultimately
// originates from a third-party employer's posting content, so it is not
// trusted input either. Looping until a pass changes nothing closes that gap
// without needing a real HTML parser for two plain-text labels.
function stripTags(s: string): string {
  let prev;
  let out = s;
  do {
    prev = out;
    out = out.replace(/<[^>]+>/g, '');
  } while (out !== prev);
  // A malformed/nested bracket construct (`<<a>b>`) can leave a lone `>` (or,
  // symmetrically, a lone `<`) behind even at fixed point: the loop above only
  // ever removes a COMPLETE `<...>` span, and a stray unmatched bracket is
  // never one. Neither field this feeds is meant to carry markup at all, so
  // any remaining bracket — paired or not — is simply dropped rather than
  // trusted to be inert.
  return out.replace(/[<>]/g, '');
}

function summaryField(summaryHtml: string, label: string): string {
  const re = new RegExp(`<strong>${label}:</strong>\\s*([\\s\\S]*?)\\s*(?:<br\\s*/?>|$)`, 'i');
  const m = summaryHtml.match(re);
  return m ? stripTags(decodeEntities(m[1])).trim() : '';
}

/**
 * Parse Job Bank's public Atom feed. Exported for unit tests.
 */
export function parseJobBankFeed(xml: string): Job[] {
  const jobs: Job[] = [];
  const entries = String(xml ?? '').match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || [];

  for (const entry of entries) {
    const url = cleanUrl(linkHref(entry));
    if (!url) continue;

    const title = tagText(entry, 'title');
    if (!title) continue;

    const summaryRaw = tagText(entry, 'summary');
    const company = summaryField(summaryRaw, 'Employer');
    const location = summaryField(summaryRaw, 'Location');

    const updatedRaw = tagText(entry, 'updated');
    const postedAt = updatedRaw ? Date.parse(updatedRaw) : NaN;

    jobs.push({
      title,
      company,
      location,
      url,
      ...(Number.isFinite(postedAt) ? { postedAt } : {}),
    });
  }

  return jobs;
}

const jobbankca: Provider = {
  id: 'jobbankca',

  detect(entry: PortalEntry): DetectHit | null {
    return entry?.provider === 'jobbankca' ? { url: FEED_URL } : null;
  },

  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    let { keywords } = parseJobBankConfig(entry);
    // Fall back to config/profile.yml's target_roles when this entry has no
    // jobbankca.keywords[] of its own — same convention vdab.ts uses, so a
    // user who already onboarded with target roles doesn't have to duplicate
    // them into every keyword-required provider's config by hand.
    if (!keywords.length) keywords = resolveProfileKeywords();
    if (!keywords.length) {
      throw new Error(`jobbankca: entry "${entry?.name || '(unnamed)'}" has no jobbankca.keywords[] and no config/profile.yml target_roles to fall back to`);
    }

    const configuredPages = entry.max_pages;
    const entryMaxPages = typeof configuredPages === 'number'
      && Number.isInteger(configuredPages) && configuredPages > 0
      ? Math.min(configuredPages, MAX_PAGES_CAP)
      : DEFAULT_MAX_PAGES;
    const probePages = ctx.maxPages;
    const maxPages = Math.min(
      entryMaxPages,
      typeof probePages === 'number' && Number.isInteger(probePages) && probePages > 0 ? probePages : Infinity,
    );

    const byUrl = new Map<string, Job>();
    const errors: string[] = [];
    let succeeded = 0;

    for (const keyword of keywords) {
      let keywordFailed = false;
      for (let page = 1; page <= maxPages; page++) {
        await sleep(INTER_REQUEST_DELAY_MS, ctx);

        const url = assertJobBankUrl(buildFeedUrl(keyword, page));
        let xml: string;
        try {
          xml = await fetchTextWithRetry(ctx, url, {
            headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT },
            redirect: 'error',
          });
        } catch (err) {
          if (page === 1) {
            keywordFailed = true;
            errors.push(`"${keyword}": ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        const rawEntryCount = (String(xml ?? '').match(/<entry\b[^>]*>[\s\S]*?<\/entry>/gi) || []).length;
        const parsed = parseJobBankFeed(xml);
        for (const job of parsed) {
          if (!byUrl.has(job.url)) byUrl.set(job.url, job);
        }
        if (rawEntryCount < PAGE_SIZE) break; // short feed page — end of this keyword's results
      }
      if (!keywordFailed) succeeded++;
    }

    // Total outage = every keyword's first request failed. A keyword that
    // answered with zero results is not an outage — recall-first, same as
    // arbeitsagentur.ts.
    if (succeeded === 0 && errors.length) {
      throw new Error(`jobbankca: all ${keywords.length} keyword request(s) failed — ${errors[0]}`);
    }

    return [...byUrl.values()];
  },
};

export default jobbankca;
