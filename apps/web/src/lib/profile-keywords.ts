/**
 * profile-keywords.ts — read search keywords out of `config/profile.yml`'s
 * `target_roles` block.
 *
 * The core already does this in `packages/core/src/scanning/providers/_profile-keywords.ts`
 * (`profileTargetKeywords`), and this is a deliberate mirror of it, not a
 * second design: the web build root is pinned to `web/` and refuses modules
 * outside it (see tracker-table.ts's header), so a
 * build-time import of the core helper is not available here.
 *
 * It exists as a named, tested function because the inline version it replaces
 * had drifted from the core's in both fields it reads, and did so silently:
 *
 *   ...(typeof roles.primary === "string" ? [roles.primary] : []),
 *   ...(Array.isArray(roles.archetypes) ? roles.archetypes : []),
 *
 * `primary` is a LIST in `config/profile.example.yml` — and in what the web's
 * own writer emits (`api/profile/route.ts` → `{ primary: roles.slice(0, 6) }`)
 * — so the string test never fired. `archetypes` is a list of
 * `{name, level, fit}` objects, so spreading it raw yielded objects that the
 * caller's string cleaner then dropped. Both halves returned nothing, which
 * made `seedExploreFilters`'s profile.yml fallback dead code: the web wrote a
 * profile it could not read back.
 *
 * Plain `.ts`, same pattern as clean-chips.ts, so the test can import the
 * real module under Node without a TypeScript runner.
 */

/**
 * Extract candidate search keywords from a parsed profile.yml's `target_roles`
 * block: `primary[]` plus `archetypes[].name`. Order is preserved and matches
 * the core helper's. Never throws — a missing or malformed block yields [].
 *
 * Returns raw strings; de-duplication and trimming are the caller's, so the
 * web can run them through the same `cleanChips` as every other keyword list.
 *
 * @param {unknown} profile - A parsed profile.yml (or anything at all).
 * @returns {string[]}
 */
export function profileTargetKeywords(profile: unknown): string[] {
  const source = profile && typeof profile === "object" ? (profile as { target_roles?: unknown }) : null;
  const roles = source?.target_roles;
  if (!roles || typeof roles !== "object") return [];
  const groups = roles as { primary?: unknown; archetypes?: unknown };
  return [
    ...(Array.isArray(groups.primary) ? groups.primary : []),
    ...(Array.isArray(groups.archetypes) ? groups.archetypes.map((a: { name?: string } | null) => a && a.name) : []),
  ].filter((k) => typeof k === "string");
}
