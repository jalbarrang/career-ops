// _profile-keywords.ts — shared fallback for keyword-required providers.
// Currently used by vdab.ts; other keyword-required providers (e.g.
// arbeitsagentur.ts) can opt in later. Files prefixed with _ are never
// loaded as providers by scan.ts (see _registry.ts), so this is a helper
// module.
//
// A user who has completed onboarding already has target roles recorded in
// config/profile.yml. Without this, a keyword-required provider's portals.yml
// block with no `keywords:` set just throws — forcing the same information to
// be duplicated into every such provider's config by hand. This lets a
// provider fall back to the candidate's own profile instead.
//
// Scoped deliberately: providers only ever receive their own portals.yml
// entry (never the scanner's top-level config), so this only covers the
// config/profile.yml tier — not a title_filter.positive fallback, which
// would require changing the Provider.fetch(entry, ctx) contract itself.

import { existsSync, readFileSync } from 'fs';
import { loadYaml } from '../lib/yaml-document.ts';
import { getProfilePath } from '../path-resolver.ts';

// Matches the CAREER_OPS_PROFILE override already honored by scan.ts,
// cv-templates.ts, followup-cadence.ts, plugins/_engine.ts, and
// test-all.ts — without this, a user with that env var set would get
// silently different fallback behavior here than everywhere else.
// Read at call time, not at import: a module-level constant froze whatever
// the variable held when the first provider loaded, so a test could not
// isolate the fallback from a developer's own CAREER_OPS_PROFILE.
function defaultProfilePath(): string {
  return getProfilePath();
}

/** Whether a value is a non-null, non-array object bag. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanKeywords(value: unknown): string[] {
  const arr = Array.isArray(value) ? value : [];
  return [...new Set(
    arr
      .filter((k): k is string => typeof k === 'string')
      .map(k => k.trim())
      .filter(Boolean),
  )];
}

/**
 * Extracts candidate search keywords from a parsed profile.yml's
 * `target_roles` block: `primary[]` plus `archetypes[].name`.
 */
export function profileTargetKeywords(profile: unknown): string[] {
  const roles = isRecord(profile) ? profile.target_roles : undefined;
  if (!isRecord(roles)) return [];
  return cleanKeywords([
    ...(Array.isArray(roles.primary) ? roles.primary : []),
    ...(Array.isArray(roles.archetypes)
      ? roles.archetypes.map((a: unknown) => (isRecord(a) ? a.name : undefined))
      : []),
  ]);
}

/**
 * Reads config/profile.yml (if present) and returns its target-role
 * keywords. Fails open (empty array) on a missing/unparseable file — this is
 * a convenience fallback, never a hard requirement, so it must never throw.
 */
export function resolveProfileKeywords(profilePath: string = defaultProfilePath()): string[] {
  if (!existsSync(profilePath)) return [];
  try {
    const profile: unknown = loadYaml(readFileSync(profilePath, 'utf-8')) || {};
    return profileTargetKeywords(profile);
  } catch {
    return [];
  }
}
