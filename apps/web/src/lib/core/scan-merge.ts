// Pure helpers for runDiscovery's per-source fan-out (packages/core/src/scanning/scan.ts). Plain .ts (same
// pattern as explore-error.ts) so tests/lib/scan-merge.test.ts can import them
// without a TS runner.
//
// WHY PER-SOURCE: packages/cli/src/commands/scanning/scan-ats-full.ts --json prints its one result object only on
// exit. A single child spanning every source therefore lost ALL results when the
// slowest source hit the route's deadline — in practice Workday, whose enterprise
// boards page slowly and rate-limit — and the UI reported the kill as "The scanner
// returned no readable output." One child per source keeps every source that
// finished, and names the one that didn't.

/**
 * Fold per-source --json results into the single `summary` event the Explore UI
 * already consumes. Counts add; capHit is true if any source was capped; dataset
 * statuses merge by source name.
 *
 * @param {Array<{companiesScanned?: number, unreachableBoards?: number, postingsKept?: number,
 *   companiesAvailable?: number, capHit?: boolean, datasetStatus?: Record<string, string>,
 *   postingsDroppedNoDate?: number}>} results Parsed --json objects of the sources that finished.
 * @param {number} offerCount Offers actually surfaced — the fallback when no source reports postingsKept.
 */
/** One source's `--json` receipt, as far as this merge reads it. */
export interface ScanSourceResult {
  companiesScanned?: number;
  unreachableBoards?: number;
  postingsKept?: number;
  companiesAvailable?: number;
  capHit?: boolean;
  datasetStatus?: Record<string, string>;
  postingsDroppedNoDate?: number;
  [key: string]: unknown;
}

/** The merged counters the route reports. */
export interface MergedScanResult {
  companiesScanned: number;
  unreachable: number;
  matches: number;
  companiesAvailable?: number;
  capHit: boolean;
  datasetStatus: Record<string, string>;
  postingsDroppedNoDate?: number;
}

export function mergeScanResults(results: readonly ScanSourceResult[], offerCount: number): MergedScanResult {
  const sum = (key: string): number => results.reduce((n, r) => {
    const value = r[key];
    return n + (typeof value === "number" ? value : 0);
  }, 0);
  const anyNumber = (key: string): boolean => results.some((r) => typeof r[key] === "number");
  const datasetStatus: Record<string, string> = {};
  for (const r of results) Object.assign(datasetStatus, r.datasetStatus || {});
  return {
    companiesScanned: sum("companiesScanned"),
    unreachable: sum("unreachableBoards"),
    matches: anyNumber("postingsKept") ? sum("postingsKept") : offerCount,
    ...(anyNumber("companiesAvailable") ? { companiesAvailable: sum("companiesAvailable") } : {}),
    capHit: results.some((r) => r.capHit === true),
    datasetStatus,
    ...(anyNumber("postingsDroppedNoDate") ? { postingsDroppedNoDate: sum("postingsDroppedNoDate") } : {}),
  };
}

function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * User-facing copy for sources whose results are incomplete because they ran out
 * of time (a stopped source keeps only what it found before the deadline). Names
 * the sources and the levers that fix it, instead of the generic "no readable
 * output" that read as a broken install.
 *
 * @param {string[]} labels Display names of the timed-out sources (e.g. ["Workday"]).
 * @param {number} deadlineSec The deadline they missed, in seconds.
 */
export function timedOutMessage(labels: readonly string[], deadlineSec: number): string {
  const names = joinLabels(labels);
  const plural = labels.length > 1;
  return (
    `${names} didn't finish within ${deadlineSec}s, so ${plural ? "their" : "its"} results are incomplete. ` +
    `Try again without ${names}, with a shorter date range or a lower per-source limit, ` +
    `or raise scan.timeout_seconds in config/profile.yml.`
  );
}
