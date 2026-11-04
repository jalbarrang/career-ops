/**
 * Dupe-deflection search for the beta bug reporter: ask GitHub's public search
 * API whether this bug is already filed, with NO key and NO server of ours.
 *
 * WHY THIS IS ITS OWN MODULE, and the incident behind it: the caller used to
 * fold every failure into an empty array — `if (!res.ok) return []`. So on
 * 2026-09-01, when the repository moved to a new org and the stale `repo:`
 * qualifier started returning HTTP 422, the reporter kept telling users
 * "nothing similar found" in a perfectly calm voice. Not an error state: a
 * false negative dressed as a clean result. It hid a live break for two days
 * from the users AND from us.
 *
 * So the return type distinguishes the two answers that were being merged:
 *   - an array (possibly empty) = the search RAN. Empty means nothing similar.
 *   - null                      = the search could not run. We do not know.
 * A caller that treats null as "nothing similar" reintroduces the bug, which is
 * why it is null and not [].
 *
 * `fetchFn` is injected so this is testable without a network or a DOM. Plain
 * .ts (same pattern as tracker-table.ts and cv-selection.ts): the test suite
 * imports it with no build step and no `@/` alias loader.
 */

/** @typedef {{ number: number, title: string, url: string }} SimilarIssue */

/**
 * Cache SUCCESSES only. Caching a failure would pin "couldn't check" for the
 * lifetime of the page, so the retry the user is being invited to make would
 * silently not retry — the same lesson the pdf-index ACL learned in #2590.
 * @type {Map<string, SimilarIssue[]>}
 */
const searchCache = new Map();

/** Exposed for tests; never called by the component. */
export function _resetCache() {
  searchCache.clear();
}

/** One similar issue as the reporter's banner renders it. */
export interface SimilarIssue {
  number: number;
  title: string;
  url: string;
}

/** The fetch surface this search needs. Narrow on purpose: a caller (and the
 *  test suite) can hand over a stub that answers ok/json alone. */
export type IssueFetch = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; json: () => Promise<unknown> }>;

/**
 * @param {string} q  the GitHub search query, minus the repo qualifier
 * @param {string} repo  "owner/name"
 * @param {IssueFetch} fetchFn
 * @returns {Promise<SimilarIssue[] | null>} items, or null when the search could not run
 */
export async function searchIssues(q: string, repo: string, fetchFn: IssueFetch = fetch): Promise<SimilarIssue[] | null> {
  const cached = searchCache.get(q);
  if (cached) return cached;
  try {
    const res = await fetchFn(
      `https://api.github.com/search/issues?per_page=4&q=${encodeURIComponent(`repo:${repo} is:issue is:open ${q}`)}`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    // 422 (bad qualifier — a moved repo), 403 (rate limit), 5xx: all "we don't
    // know", none of them "nothing similar".
    if (!res.ok) return null;
    const d = (await res.json()) as { items?: Array<{ number: number; title: string; html_url: string }> };
    const items = (d.items || []).map((i) => ({ number: i.number, title: i.title, url: i.html_url }));
    searchCache.set(q, items);
    return items;
  } catch {
    // Offline, DNS, CORS, malformed JSON — still "we don't know".
    return null;
  }
}
