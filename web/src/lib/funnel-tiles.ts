import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCodeRoot } from './core/code-root.ts';
import { statusToken } from './pipeline-sankey.ts';

// Cumulative "how far has this search actually got?" counters for the analytics
// headline tiles. Pure JS (no TS types) so it can be imported by the analytics
// page and unit-tested under `node --test`, matching clean-chips.ts /
// stream-parse.ts / act-envelope.ts.
//
// The "Pipeline by stage" BARS below the tiles are deliberately a current-state
// snapshot — Hired, Rejected and Discarded are each their own bar, and an
// application sits in exactly one. The two headline tiles are a different
// question: they are achievement counters ("interviews", "offers") whose
// zero-state shows a coaching nudge. Reading a snapshot count there means a
// candidate who ADVANCED past a stage reads zero for it and gets told to try
// harder to reach the stage they already cleared.
//
// The cumulative math is the core's, not a new invention: computeFunnel() in
// stats.ts is the canonical definition —
//   everInterview = Interview + Offer + Hired
//   everOffer     = Offer + Hired
// — on the reasoning that a landed job proves the offer and everything before
// it. A rejection proves a response, but not an interview or offer. The
// ledger-aware variant below recovers those stages from actual transitions.

/**
 * Count applications whose canonical status is any of `keys`.
 *
 * @param {string[]} canonStatuses - Already-canonicalized (uppercase) statuses.
 * @param {string[]} keys - Canonical stage keys to count.
 * @returns {number}
 */
function countOf(canonStatuses: readonly string[], keys: readonly string[]): number {
  return canonStatuses.filter((s) => keys.some((k) => s.includes(k))).length;
}

/**
 * Cumulative interview/offer counters for the analytics headline tiles.
 *
 * @param {string[]} canonStatuses - Canonicalized statuses, one per application.
 * @returns {{interviews: number, offers: number}}
 */
export function cumulativeTiles(canonStatuses: unknown): { interviews: number; offers: number } {
  const list: string[] = Array.isArray(canonStatuses) ? (canonStatuses as string[]) : [];
  return {
    interviews: countOf(list, ["INTERVIEW", "OFFER", "HIRED"]),
    offers: countOf(list, ["OFFER", "HIRED"]),
  };
}

/** Recover interview/offer achievements by tracker identity, not row position.
 * Malformed transitions and history for deleted tracker rows are ignored.
 * @param {{n: string, status: string}[]} applications
 * @param {string|null} content
 * @param {string} [coreRoot] Code checkout, never the separate user data root.
 */
export async function cumulativeTilesWithHistory(
  applications: readonly { n?: string; status: string }[],
  content: string | null,
  coreRoot: string = resolveCodeRoot(process.cwd(), process.env),
): Promise<{ interviews: number; offers: number }> {
  // The web build is intentionally confined to web/ for Windows stability. Load
  // the core at runtime, as the other core accessors do; do not widen its root
  // or silently substitute a second engine if the installation is incomplete.
  const file = path.join(coreRoot, 'funnel-stages.ts');
  const { parseStatusLogStages, recoverFunnelStages } = await import(/* @vite-ignore */ pathToFileURL(file).href);
  const statuses = new Map<number, string>();
  // Non-numeric backfill IDs retain snapshot counts but cannot join history.
  // Distinct NEGATIVE keys give each one its own slot: ledger numbers are
  // positive, so none of them can ever match a history row.
  let synthetic = 0;
  for (const app of applications) {
    const n = app.n;
    const id = typeof n === "string" && /^\d+$/.test(n) ? Number(n) : -1 - synthetic++;
    statuses.set(id, statusToken(app.status));
  }
  const values = [...recoverFunnelStages(statuses, parseStatusLogStages(content)).values()];
  // Thresholds mirror the core funnel (funnel-stages.ts ranks): interview is
  // rank 4 (INTERVIEW), offer is rank 5 (OFFER). Counting an interview as an
  // offer at rank 4 double-counted every candidate who reached one.
  return { interviews: values.filter(n => n >= 4).length, offers: values.filter(n => n >= 5).length };
}
