// analytics-metrics.ts — the dashboard's progress metrics over tracker rows.
//
// A pure function (no fs, no imports) because the analytics tests drive it with
// plain `{status}` objects. The stage ranks mirror the core funnel in
// packages/core/src/insights/funnel-stages.ts: a row contributes to every stage at or below the one it
// reached, so the numbers are cumulative and can never invert.
//
//   Evaluated / Discarded / SKIP   0  (counted, but never applied)
//   Applied                        1
//   Responded / Assessment /
//   Rejected                       2  (a rejection is a reply)
//   Interview                      3
//   Offer                          4
//   Hired                          5  (proves every stage before it)

/** One tracker row, reduced to what the metrics need. */
export interface ProgressRow {
  status: string;
}

/** One cumulative funnel stage. */
export interface FunnelStage {
  key: string;
  label: string;
  count: number;
}

/** What the progress view renders. */
export interface ProgressMetrics {
  funnel: FunnelStage[];
  activeApps: number;
  totalOffers: number;
}

const RANK: Record<string, number> = {
  EVALUATED: 0,
  DISCARDED: 0,
  SKIP: 0,
  APPLIED: 1,
  RESPONDED: 2,
  ASSESSMENT: 2,
  REJECTED: 2,
  INTERVIEW: 3,
  OFFER: 4,
  HIRED: 5,
};

/** Statuses that are still in flight — the dashboard's "active" count. */
const ACTIVE = new Set(['APPLIED', 'RESPONDED', 'ASSESSMENT', 'INTERVIEW', 'OFFER']);

/** Statuses that mean an offer was made. */
const OFFERED = new Set(['OFFER', 'HIRED']);

/** Canonical uppercase token for a tracker cell: bold, dates and case removed. */
function stageOf(status: string): string {
  return String(status ?? '')
    .replace(/\*\*/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z ]+/g, '')
    .trim();
}

/**
 * Progress metrics for a set of rows.
 *
 * @param rows - Parsed tracker rows (only `status` is read).
 */
export function computeProgressMetrics(rows: readonly ProgressRow[]): ProgressMetrics {
  const ranks = rows.map((row) => {
    const key = stageOf(row.status);
    return RANK[key] ?? 0;
  });
  const atLeast = (rank: number): number => ranks.filter((r) => r >= rank).length;
  return {
    funnel: [
      { key: 'total', label: 'Tracked', count: atLeast(0) },
      { key: 'everApplied', label: 'Applied', count: atLeast(1) },
      { key: 'everResponded', label: 'Responded', count: atLeast(2) },
      { key: 'everInterview', label: 'Interviewed', count: atLeast(3) },
      { key: 'everOffer', label: 'Offers', count: atLeast(4) },
    ],
    activeApps: rows.filter((row) => ACTIVE.has(stageOf(row.status))).length,
    totalOffers: rows.filter((row) => OFFERED.has(stageOf(row.status))).length,
  };
}
