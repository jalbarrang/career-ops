// Provider registry — loading and routing shared by the scanner and the portal
// health check. Files prefixed with _ are never loaded as providers by scan.ts,
// so this helper module lives safely alongside the provider plugins.
//
// Extracted from scan.ts (#1451-era inline definitions) so verify-portals.ts
// can route non-ATS boards through the SAME provider layer the scanner uses,
// without importing scan.ts itself (which has top-level side effects and would
// form an import cycle via classifyFetchError).

import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import type { DetectHit, PortalEntry, Provider } from './_types.ts';

/** The provider id whose detect() runs before any other provider's. */
const LOCAL_PARSER_ID = 'local-parser';

/** Options for {@link resolveProvider}. */
export interface ResolveProviderOptions {
  /**
   * Provider ids to skip (e.g. 'local-parser' so a network-only health check
   * never execs a configured local command). A skipped id is skipped however
   * the entry reached it: an explicit `provider:` naming one resolves as if the
   * field were absent, the same way the same entry resolves when it relies on
   * detect().
   */
  skipIds?: string[];
}

/** A routed entry: the provider that claimed it, or why nothing could. */
export type ResolvedProvider = { provider: Provider } | { error: string };

/** The message of a caught value, without assuming it is an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Runtime shape check for a loaded module's default export. The contract is
 * enforced at runtime here (scan.ts relies on it); the compiler checks the
 * static half via the `Provider` predicate.
 */
function isProvider(candidate: unknown): candidate is Provider {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const shape = candidate as { id?: unknown; fetch?: unknown };
  return typeof shape.fetch === 'function' && typeof shape.id === 'string' && shape.id !== '';
}

/** The default export of a freshly imported module, as unknown. */
function defaultExportOf(mod: unknown): unknown {
  if (typeof mod !== 'object' || mod === null) return undefined;
  return (mod as { default?: unknown }).default;
}

/**
 * Load every provider plugin in a directory into an id→provider Map.
 *
 * Alphabetical order so detect() priority is deterministic across machines.
 * Malformed modules (wrong shape, duplicate id, import error) are logged and
 * skipped, never fatal.
 *
 * @param dir - Absolute path to the providers directory.
 */
export async function loadProviders(dir: string): Promise<Map<string, Provider>> {
  const providers = new Map<string, Provider>();
  if (!existsSync(dir)) return providers;
  const entries = readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.startsWith('_'))
    .sort();
  for (const file of entries) {
    const full = path.join(dir, file);
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(full).href);
    } catch (err) {
      console.error(`⚠️  ${file}: failed to load — ${errorMessage(err)}`);
      continue;
    }
    const p = defaultExportOf(mod);
    if (!isProvider(p)) {
      console.error(`⚠️  ${file}: skipping — default export must be { id, fetch }`);
      continue;
    }
    if (providers.has(p.id)) {
      console.error(`⚠️  ${file}: duplicate provider id "${p.id}" — keeping first`);
      continue;
    }
    providers.set(p.id, p);
  }
  return providers;
}

/**
 * Resolve which provider handles a portals.yml entry (tracked_companies or job_boards).
 *   1. Explicit `provider:` field wins (skips detect()).
 *   2. local-parser when parser.command + script are configured (before API detect).
 *   3. Otherwise each provider's detect() runs in load order; first hit wins.
 *
 * @param entry - portals.yml entry (tracked_companies or job_boards).
 * @param providers - id→provider Map from loadProviders().
 * @param opts - Provider ids to skip (see {@link ResolveProviderOptions}).
 */
export function resolveProvider(
  entry: PortalEntry,
  providers: Map<string, Provider>,
  { skipIds = [] }: ResolveProviderOptions = {},
): ResolvedProvider | null {
  if (entry.provider && !skipIds.includes(entry.provider)) {
    const p = providers.get(entry.provider);
    if (!p) return { error: `unknown provider: ${entry.provider}` };
    return { provider: p };
  }

  const localParser = providers.get(LOCAL_PARSER_ID);
  if (localParser && !skipIds.includes(LOCAL_PARSER_ID)) {
    try {
      const hit = localParser.detect?.(entry);
      if (hit) return { provider: localParser };
    } catch (err) {
      console.error(`⚠️  local-parser: detect() threw for "${entry.name}" — ${errorMessage(err)}`);
    }
  }

  for (const p of providers.values()) {
    if (skipIds.includes(p.id)) continue;
    let hit: DetectHit | null | undefined;
    try {
      hit = p.detect?.(entry);
    } catch (err) {
      console.error(`⚠️  ${p.id}: detect() threw for "${entry.name}" — ${errorMessage(err)}`);
      continue;
    }
    if (hit) return { provider: p };
  }
  return null;
}
