// Shaping for the Analytics progress + stats views.
//
// Pure JS so the page can import it and `node --test` can cover it, matching
// funnel-tiles.ts / awaiting.ts.
//
// ── Why there is a module here at all ───────────────────────────────────────
//
// Nothing below COMPUTES a metric. packages/core/src/insights/stats.ts and packages/cli/src/commands/insights/analyze-patterns.ts already
// do that, and computeFunnel()'s docstring in packages/core/src/insights/stats.ts is the canonical funnel
// definition that the Go dashboard's ComputeProgressMetrics mirrors — a second
// implementation in the web is how those three start disagreeing (#2369).
//
// What this module does is decide WHAT MAY BE SHOWN. Both core scripts ship
// honesty signals next to their numbers — `smallSample`, `sufficientSample`,
// `minSampleForClaim`, `coveragePct` — and a view that renders the number while
// dropping the caveat turns a hedged figure into a confident one. Those rules
// are the part worth testing, so they live here rather than inside JSX.

export interface FunnelStage {
  key: string;
  label: string;
  value: number;
}

export interface FunnelRate {
  key: string;
  label: string;
  /** `null` means the rate has no denominator — absent, not zero. */
  value: number | null;
}

export interface ProgressTotals {
  tracked: number;
  active: number;
  offers: number;
  avgScore: number | null;
  topScore: number | null;
}

export interface ProgressModel {
  available: boolean;
  /** Null when available; otherwise why not, which decides whether the view explains itself. */
  reason: "no-core" | "no-data" | null;
  totals: ProgressTotals;
  funnel: { stages: FunnelStage[]; rates: FunnelRate[] };
  provisional: boolean;
}

export type BreakdownRow = Record<string, string | number | undefined>;

export interface ThresholdSection {
  key: "threshold";
  label: string;
  value: number | null;
  note: string | null;
  sampleSize: number | null;
  provisional: boolean;
}

export interface BreakdownSection {
  key: string;
  label: string;
  rows: BreakdownRow[];
  dimension: string;
  partial: boolean;
}

export interface VendorSection {
  key: "vendor";
  label: string;
  rows: BreakdownRow[];
  claimable: boolean;
  coveragePct: number;
  minSampleForClaim: number;
  identified: number;
  citation: string | null;
}

export type StatsSection = ThresholdSection | BreakdownSection | VendorSection;

export interface StatsModel {
  state: "unavailable" | "below-threshold" | "ready";
  progress: { current: number; threshold: number | null; message: string } | null;
  sections: StatsSection[];
}

/** The packages/core/src/insights/stats.ts fields these views read. */
interface TrackerPayload {
  total?: unknown;
  activeApps?: unknown;
  avgScore?: unknown;
  topScore?: unknown;
}

interface FunnelPayload {
  everApplied?: unknown;
  everResponded?: unknown;
  everInterview?: unknown;
  everOffer?: unknown;
  responseRate?: unknown;
  interviewRate?: unknown;
  offerRate?: unknown;
  smallSample?: unknown;
}

/** The packages/cli/src/commands/insights/analyze-patterns.ts fields these views read. */
interface PatternsPayload {
  error?: unknown;
  current?: unknown;
  threshold?: unknown;
  scoreThreshold?: { recommended?: unknown; sufficientSample?: unknown; reasoning?: unknown; sampleSize?: unknown } | null;
  archetypeBreakdown?: unknown;
  remotePolicy?: unknown;
  companySizeBreakdown?: unknown;
  vendorAnalysis?: { identified?: unknown; minSampleForClaim?: unknown; breakdown?: unknown; coveragePct?: unknown; citation?: unknown } | null;
}

/** A rate that cannot be computed is absent, never 0. */
const NO_RATE = null;

/**
 * A percentage is only meaningful when something was counted.
 *
 * `responseRate: 0` with nothing applied means "no data", not "0% of employers
 * replied" — and a 0% response rate shown to someone who has not applied yet is
 * the app telling them their search is failing before it has started.
 *
 * @param {number|undefined} rate - Percentage from the core.
 * @param {number|undefined} denominator - Count the rate was taken over.
 * @returns {number|null}
 */
export function rateOrNull(rate: unknown, denominator: unknown): number | null {
  if (typeof denominator !== "number" || !Number.isFinite(denominator) || denominator <= 0) return NO_RATE;
  if (typeof rate !== "number" || !Number.isFinite(rate)) return NO_RATE;
  return rate;
}

/**
 * The progress view's model, from packages/core/src/insights/stats.ts's payload.
 *
 * @param {object|null} stats - Parsed packages/core/src/insights/stats.ts output, or null when unavailable.
 * @returns {ProgressModel}
 */
export function progressModel(stats: unknown): ProgressModel {
  const payload = (stats ?? null) as { tracker?: TrackerPayload | null; funnel?: FunnelPayload | null } | null;
  const tracker = payload?.tracker ?? null;
  const funnel = payload?.funnel ?? null;
  if (!tracker || !funnel) {
    // Two different facts, and collapsing them is how the Conversion block
    // disappears for every new user with no explanation. "no-core" is packages/core/src/insights/stats.ts
    // not being reachable at all — a non-event worth staying quiet about.
    // "no-data" is packages/core/src/insights/stats.ts running fine and reporting it has no tracker yet,
    // which is the normal starting state and needs to be said out loud.
    const reason: "no-core" | "no-data" = stats ? "no-data" : "no-core";
    return { available: false, reason, totals: { tracked: 0, active: 0, offers: 0, avgScore: null, topScore: null }, funnel: { stages: [], rates: [] }, provisional: false };
  }

  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  // Cumulative, in lifecycle order — the everApplied ⊇ everResponded ⊇
  // everInterview ⊇ everOffer nesting packages/core/src/insights/stats.ts guarantees.
  const stages: FunnelStage[] = [
    { key: "everApplied", label: "Applied", value: n(funnel.everApplied) },
    { key: "everResponded", label: "Responded", value: n(funnel.everResponded) },
    { key: "everInterview", label: "Interviewed", value: n(funnel.everInterview) },
    { key: "everOffer", label: "Offers", value: n(funnel.everOffer) },
  ];

  const rates: FunnelRate[] = [
    { key: "responseRate", label: "Response rate", value: rateOrNull(funnel.responseRate, funnel.everApplied) },
    { key: "interviewRate", label: "Interview rate", value: rateOrNull(funnel.interviewRate, funnel.everApplied) },
    { key: "offerRate", label: "Offer rate", value: rateOrNull(funnel.offerRate, funnel.everApplied) },
  ];

  const total = n(tracker.total);
  const avgScore = typeof tracker.avgScore === "number" && Number.isFinite(tracker.avgScore) && total > 0 ? tracker.avgScore : null;
  const topScore = typeof tracker.topScore === "number" && Number.isFinite(tracker.topScore) && total > 0 ? tracker.topScore : null;

  return {
    available: true,
    reason: null,
    totals: {
      tracked: total,
      active: n(tracker.activeApps),
      offers: n(funnel.everOffer),
      avgScore,
      topScore,
    },
    funnel: { stages, rates },
    // packages/core/src/insights/stats.ts's own flag. Carried through so the view can mark the rates
    // provisional instead of presenting three percentages off four applications
    // as a finding.
    provisional: funnel.smallSample === true,
  };
}

/**
 * The stats view's model, from packages/cli/src/commands/insights/analyze-patterns.ts's payload.
 *
 * Its "not enough data" reply is a RESULT, not an error: the core states the
 * threshold and how close the user is, which is more useful than an empty panel.
 *
 * @param {object|null} patterns - Parsed packages/cli/src/commands/insights/analyze-patterns.ts output, or null.
 * @returns {StatsModel}
 */
export function statsModel(patterns: unknown): StatsModel {
  const p = (patterns ?? null) as PatternsPayload | null;
  if (!p) return { state: "unavailable", progress: null, sections: [] };

  if (typeof p.error === "string") {
    return {
      state: "below-threshold",
      progress: {
        current: typeof p.current === "number" && Number.isFinite(p.current) ? p.current : 0,
        threshold: typeof p.threshold === "number" && Number.isFinite(p.threshold) ? p.threshold : null,
        message: p.error,
      },
      sections: [],
    };
  }

  const sections: StatsSection[] = [];

  // Quality threshold. Shown as a recommendation only when the core says the
  // sample supports one; otherwise the reasoning is shown WITHOUT the number.
  const t = p.scoreThreshold;
  if (t && typeof t.recommended === "number" && Number.isFinite(t.recommended)) {
    sections.push({
      key: "threshold",
      label: "Quality threshold",
      value: t.sufficientSample ? t.recommended : null,
      note: typeof t.reasoning === "string" ? t.reasoning : null,
      sampleSize: typeof t.sampleSize === "number" && Number.isFinite(t.sampleSize) ? t.sampleSize : null,
      provisional: t.sufficientSample !== true,
    });
  }

  // Breakdowns. An "Unknown"-only breakdown is not an insight.
  const breakdowns: Array<[string, string, unknown, string]> = [
    ["archetype", "Archetype mix", p.archetypeBreakdown, "archetype"],
    ["remote", "Work mode", p.remotePolicy, "policy"],
    ["companySize", "Company size", p.companySizeBreakdown, "size"],
  ];
  for (const [key, label, rows, dim] of breakdowns) {
    const list: BreakdownRow[] = Array.isArray(rows)
      ? (rows as BreakdownRow[]).filter((r) => typeof r?.total === "number" && Number.isFinite(r.total) && r.total > 0)
      : [];
    const named = list.filter((r) => !isUnlabelled(r?.[dim]));
    if (named.length === 0) continue;
    sections.push({ key, label, rows: list, dimension: dim, partial: named.length < list.length });
  }

  // Per-ATS advance rate. The core states the sample it needs and how much of
  // the pipeline it could actually identify; below either, there is no claim.
  const v = p.vendorAnalysis;
  if (v) {
    const identified = typeof v.identified === "number" && Number.isFinite(v.identified) ? v.identified : 0;
    const need = typeof v.minSampleForClaim === "number" && Number.isFinite(v.minSampleForClaim) ? v.minSampleForClaim : 0;
    const enough = identified >= need && Array.isArray(v.breakdown) && v.breakdown.length > 0;
    sections.push({
      key: "vendor",
      label: "By ATS vendor",
      rows: enough ? (v.breakdown as BreakdownRow[]) : [],
      claimable: enough,
      coveragePct: typeof v.coveragePct === "number" && Number.isFinite(v.coveragePct) ? v.coveragePct : 0,
      minSampleForClaim: need,
      identified,
      citation: typeof v.citation === "string" ? v.citation : null,
    });
  }

  return { state: "ready", progress: null, sections };
}

/**
 * Whether a breakdown label carries no information.
 *
 * `Unknown` / `unknown` / `` / `—` all mean "the reports did not say".
 *
 * @param {unknown} label
 * @returns {boolean}
 */
export function isUnlabelled(label: unknown): boolean {
  const s = String(label ?? "").trim().toLowerCase();
  return s === "" || s === "unknown" || s === "n/a" || s === "—" || s === "-";
}
