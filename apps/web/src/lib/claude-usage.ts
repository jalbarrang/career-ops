/**
 * Return every token represented by a Claude Code usage event.
 *
 * Claude reports cache reads separately from ordinary input. Include them so
 * the dashboard shows total token activity instead of hiding repeatedly-read
 * prompt context. This is a volume signal, not a dollar-cost estimate: cache
 * reads remain discounted by Claude even though each token appears here.
 */
export function claudeUsageTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;

  const fields = usage as Record<string, unknown>;

  return [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ].reduce((total, key) => {
    const value = fields[key];
    return total + (typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0);
  }, 0);
}
