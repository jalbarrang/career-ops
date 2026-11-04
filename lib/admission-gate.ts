/**
 * admission-gate.ts — one decision for "does this posting go into
 * data/pipeline.md?", shared by the writers that are not scan.ts (#5478).
 *
 * scan.ts admits a posting only after the user's blacklist, title filter,
 * location filter and seen set (scan-history, pipeline and tracker, compared
 * as normalized URLs). scan-hn, scan-interamt, openrouter-runner and plugin
 * ingest each built their own subset of that: none read data/blacklist.md,
 * Interamt and scan-hn kept private substring matchers, and the seen checks
 * compared raw URLs or the pipeline alone. The same portals.yml then gave a
 * different verdict depending on which command added the row.
 *
 * The gate is assembled from the scan.ts pieces, so a change to any of those
 * rules reaches every writer. It never writes: the caller appends what it
 * admits and records whatever skip rows it already records.
 */

import {
  buildTitleFilter,
  buildLocationFilter,
  loadBlacklist,
  findBlacklistEntry,
  loadSeenUrls,
  isOfferSeen,
  markOfferSeen,
} from '../scan.ts';

/** Why the gate dropped a posting. */
type AdmissionReason = 'seen' | 'blacklisted' | 'title' | 'location';

/** One posting, as the gate sees it: a minimum the callers' own job objects extend. */
interface AdmissionOffer {
  url: string;
  company?: string;
  title?: string;
  location?: string;
}

/** The compiled `title_filter.positive` / `.negative` matcher from title-keywords.ts. */
type TitleFilter = (title: string) => boolean;

/** The compiled `location_filter` matcher from scan.ts. */
type LocationFilter = (location: string, url: string, title: string) => boolean;

/** One row of data/blacklist.md, as loadBlacklist() returns it. */
interface BlacklistEntry {
  company: string;
  since: string;
  scope?: string;
  reason: string;
}

/** Every skip reason plus the admitted tally, as the gate counts them. */
interface AdmissionCounts {
  admitted: number;
  seen: number;
  blacklisted: number;
  title: number;
  location: number;
}

/** What `partition` splits a batch into. */
interface PartitionResult {
  admitted: AdmissionOffer[];
  skipped: Record<AdmissionReason, AdmissionOffer[]>;
}

/** The parsed portals.yml fields the gate reads, plus injected overrides. */
interface AdmissionGateOptions {
  /** Parsed portals.yml; supplies title_filter and location_filter. */
  config?: {
    title_filter?: { positive?: unknown; negative?: unknown };
    location_filter?: unknown;
  };
  /** Overrides the compiled title matcher (scan-hn's own keyword list, tests). */
  titleFilter?: TitleFilter;
  /** Overrides the compiled location matcher. */
  locationFilter?: LocationFilter;
  /** As returned by loadBlacklist(). */
  blacklist?: Map<string, BlacklistEntry>;
  /** As returned by loadSeenUrls().seen. The gate adds to it. */
  seen?: Set<string>;
}

/** One run's gate. */
interface AdmissionGate {
  /** The compiled title matcher, exposed so a caller can reuse it. */
  titleFilter: TitleFilter;
  /** Every verdict this run has reached, admitted included. */
  counts: AdmissionCounts;
  /** Whether the posting is already in scan-history, the pipeline, the tracker, or this run. */
  isSeen(offer: AdmissionOffer): boolean;
  /** Record a posting as handled this run without judging it (a failed extraction, say). */
  markSeen(offer: AdmissionOffer): void;
  /** Judge one posting: null when admitted, otherwise the reason it was dropped. */
  check(offer: AdmissionOffer, options?: { titleText?: string }): AdmissionReason | null;
  /** Split a batch into the admitted postings and the skipped ones by reason. */
  partition(offers: AdmissionOffer[]): PartitionResult;
}

/** Skip reasons, in the order the gate tests them. */
export const ADMISSION_REASONS: readonly AdmissionReason[] = Object.freeze(['seen', 'blacklisted', 'title', 'location'] as const);

/**
 * The run's seen set, as loadSeenUrls() hands it over.
 *
 * The tokens collectSeenUrls() stores are URL and listing keys, all strings;
 * scan.ts is still JavaScript-shaped enough for the inferred type to widen to
 * `Set<unknown>`, so this is where the promise is made explicit.
 */
function seenUrlsFromScan(): Set<string> {
  return loadSeenUrls().seen as Set<string>;
}

/**
 * Build a gate for one run.
 *
 * Every dependency can be injected, which is how tests and callers with their
 * own filter (scan-hn's hn_hiring.keywords) use it. The defaults read the
 * user's files through scan.ts, so they honor the data root and the
 * CAREER_OPS_* path overrides.
 */
export function createAdmissionGate({
  config = {},
  titleFilter = buildTitleFilter(config?.title_filter),
  locationFilter = buildLocationFilter(config?.location_filter),
  blacklist = loadBlacklist(),
  seen = seenUrlsFromScan(),
}: AdmissionGateOptions = {}): AdmissionGate {
  const counts: AdmissionCounts = { admitted: 0, seen: 0, blacklisted: 0, title: 0, location: 0 };

  function reasonFor(offer: AdmissionOffer, titleText: string): AdmissionReason | null {
    if (isOfferSeen(offer, seen)) return 'seen';
    if (findBlacklistEntry(blacklist, offer.company || '', offer.url)) return 'blacklisted';
    if (!titleFilter(titleText)) return 'title';
    if (!locationFilter(offer.location || '', offer.url, offer.title || '')) return 'location';
    return null;
  }

  /**
   * Judge one posting. Returns null when it is admitted, otherwise one of
   * ADMISSION_REASONS. Either way the posting joins the run's seen set, so a
   * second copy later in the same run is reported as 'seen'.
   *
   * @param offer - The posting to judge.
   * @param options - `titleText` is the text the title filter reads, when it is
   *   not offer.title.
   */
  function check(offer: AdmissionOffer, { titleText = offer.title || '' }: { titleText?: string } = {}): AdmissionReason | null {
    const reason = reasonFor(offer, titleText);
    if (reason !== 'seen') markOfferSeen(offer, seen);
    counts[reason ?? 'admitted']++;
    return reason;
  }

  return {
    titleFilter,
    counts,

    /** Whether the posting is already in scan-history, the pipeline, the tracker, or this run. */
    isSeen(offer: AdmissionOffer): boolean {
      return isOfferSeen(offer, seen);
    },

    /** Record a posting as handled this run without judging it (a failed extraction, say). */
    markSeen(offer: AdmissionOffer): void {
      markOfferSeen(offer, seen);
    },

    check,

    /**
     * Split a batch into the admitted postings and the skipped ones by reason.
     *
     * @param offers - The batch to judge, in order.
     */
    partition(offers: AdmissionOffer[]): PartitionResult {
      const admitted: AdmissionOffer[] = [];
      const skipped: Record<AdmissionReason, AdmissionOffer[]> = { seen: [], blacklisted: [], title: [], location: [] };
      for (const offer of offers) {
        const reason = check(offer);
        if (reason) skipped[reason].push(offer);
        else admitted.push(offer);
      }
      return { admitted, skipped };
    },
  };
}

/**
 * One summary line of what the gate dropped, or '' when it dropped nothing.
 *
 * @param counts - The four skip tallies to report, as `createAdmissionGate().counts`.
 */
export function formatSkipCounts(counts: Omit<AdmissionCounts, 'admitted'>): string {
  const parts = [];
  if (counts.seen) parts.push(`${counts.seen} already seen`);
  if (counts.blacklisted) parts.push(`${counts.blacklisted} blacklisted`);
  if (counts.title) parts.push(`${counts.title} title filter`);
  if (counts.location) parts.push(`${counts.location} location filter`);
  return parts.join(', ');
}
