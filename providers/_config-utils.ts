// _config-utils.ts — shared config-parsing helpers for provider plugins.
// Files prefixed with _ are never loaded as providers by scan.ts (see
// _registry.ts).

/**
 * Clamp a runtime integer into [min, max], falling back to `def` for NaN, so
 * a stray portals.yml value can't produce an empty (e.g. size=0) or
 * pathological query.
 */
export function intInRange(val: unknown, def: number, min: number, max: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
