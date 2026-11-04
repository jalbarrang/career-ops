const MAX_SAMPLES = 10;

/** One completed run, as much of it as the estimate reads. */
export interface RunCostJob {
  kind?: string;
  status?: string;
  cost?: { tokens?: number; usd?: number };
  startedAt?: number;
  [key: string]: unknown;
}

/** The estimate the UI shows; empty when no sample exists yet. */
export interface RunCostEstimate {
  tokens?: number;
  usd?: number;
  samples?: number;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Estimate a future run from the user's own recent completed runs of that kind.
 * A median keeps one unusually large agent run from inflating every later warning.
 */
export function estimateRunCost(jobs: unknown, kind: string, count: number = 1): RunCostEstimate {
  const runCount = Number.isSafeInteger(count) && count > 0 ? count : 1;
  const samples = (Array.isArray(jobs) ? (jobs as RunCostJob[]) : [])
    .filter((job): job is RunCostJob & { cost: { tokens: number; usd?: number } } =>
      job?.kind === kind && job?.status === "done" && positiveFinite(job?.cost?.tokens))
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, MAX_SAMPLES);

  const tokensPerRun = median(samples.map((job) => job.cost.tokens));
  const usdPerRun = median(samples.map((job) => job.cost.usd).filter(positiveFinite));

  if (tokensPerRun === undefined) return {};
  return {
    tokens: Math.round(tokensPerRun * runCount),
    ...(usdPerRun === undefined ? {} : { usd: Number((usdPerRun * runCount).toFixed(2)) }),
    samples: samples.length,
  };
}

export function formatTokenCount(tokens: unknown): string {
  if (!positiveFinite(tokens)) return "";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(Math.round(tokens));
}

export function formatRunCostEstimate(estimate: RunCostEstimate | null | undefined, fallback: string = "uses your tokens"): string {
  if (!positiveFinite(estimate?.tokens)) return fallback;
  const usd = positiveFinite(estimate?.usd) ? ` · ≈ $${estimate.usd.toFixed(2)}` : "";
  return `≈ ${formatTokenCount(estimate.tokens)} tokens${usd}`;
}

export function requiresBatchSpendConfirmation(count: number): boolean {
  return Number.isFinite(count) && count > 1;
}

export function formatBatchSpendConfirmation(subject: string, count: number, estimate: RunCostEstimate | null | undefined): string {
  const workers = `${count} worker${count === 1 ? "" : "s"}`;
  const cost = formatRunCostEstimate(estimate, "token estimate available after the first completed run");
  return `${subject}? (${workers} · ${cost})`;
}
