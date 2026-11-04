/**
 * repo-root.ts — where the checkout lives, now that the code no longer sits at
 * the checkout root.
 *
 * Before the monorepo split every script was a root-level file, so
 * `dirname(fileURLToPath(import.meta.url))` WAS the repository root and ~75
 * scripts spelled it that way. Those files now live under
 * `packages/{core,cli}/src/...`, and that expression answers a different
 * question than the one they are asking.
 *
 * `repoRoot()` answers the question they meant: the nearest ancestor that is a
 * workspace root (a `package.json` declaring `workspaces`), or — when there is
 * none, which is the case for a script copied standalone into a test fixture —
 * the module's own directory. That fallback is deliberate: a copy in a temp
 * directory has no monorepo above it, and the fixture's own directory is
 * exactly the root its test is exercising.
 *
 * The walk is bounded so a path outside any checkout cannot escape upward into
 * an unrelated tree.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_DEPTH = 8;
let cached: string | null = null;

/**
 * Directory of the running module, for callers that need their own location.
 * (Kept here so a file that needs BOTH this and the repo root imports one
 * module instead of two spellings.)
 */
export function moduleDir(moduleUrl: string = import.meta.url): string {
  return dirname(fileURLToPath(moduleUrl));
}

/**
 * The checkout root: the nearest ancestor with a workspace `package.json`.
 *
 * @param moduleUrl - `import.meta.url` of the caller (the default is this file)
 * @returns Absolute path to the checkout root, or the module's directory when
 *   no workspace marker is found above it (a standalone copy in a fixture)
 */
export function repoRoot(moduleUrl: string = import.meta.url): string {
  if (cached !== null) return cached;
  const start = moduleDir(moduleUrl);
  // Every module under `packages/` knows its own checkout exactly: it is the
  // directory above the topmost `packages` segment. Checked FIRST, because a
  // test fixture that copies this tree into a scratch directory inside the
  // repository also has the repository's package.json above it, and the
  // ancestor walk would answer with the wrong checkout.
  const fromPackages = packageSegmentPrefix(start);
  if (fromPackages) {
    cached = fromPackages;
    return fromPackages;
  }
  let dir = start;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    if (isWorkspaceRoot(dir)) {
      cached = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/**
 * `/x/y/packages/core/src/kernel` -> `/x/y`. Null when the path has no
 * `packages/` segment, which is the flat-copy case (the fixture directory is
 * the root).
 */
function packageSegmentPrefix(start: string): string | null {
  const parts = start.split(sep);
  const at = parts.lastIndexOf('packages');
  if (at <= 0) return null;
  const prefix = parts.slice(0, at).join(sep);
  return prefix === '' ? sep : prefix;
}

/** True when `dir` holds a package.json declaring workspaces. */
function isWorkspaceRoot(dir: string): boolean {
  const pkg = join(dir, 'package.json');
  if (!existsSync(pkg)) return false;
  try {
    const parsed = JSON.parse(readFileSync(pkg, 'utf-8')) as { workspaces?: unknown };
    return Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0;
  } catch {
    return false;
  }
}

/** Test seam: forget the memoized root (the suite swaps checkouts). */
export function resetRepoRootCache(): void {
  cached = null;
}
