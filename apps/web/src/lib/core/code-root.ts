import fs from "node:fs";
import path from "node:path";
import { COMMANDS } from "../../../../../packages/core/src/kernel/command-catalog.ts";

/**
 * Resolve the directory holding the engine's root `*.ts` scripts (doctor,
 * scan-ats-full, verify-portals, tracker, …).
 *
 * Scripts live in the **engine checkout** — never in the data root. Under the
 * #524 split layout (`CAREER_OPS_ROOT` pointing at a data-only directory, or a
 * `.career-ops-data` marker), the data root must NOT be consulted here, or
 * every script-driven Web UI endpoint reports the checkout as missing.
 *
 * `CAREER_OPS_CODE_ROOT` selects the checkout explicitly — needed when the web
 * runtime lives outside the engine checkout (isolated build/deploy dirs). The
 * fallback assumes the process cwd is `<checkout>/apps/web` (the app moved there
 * in the monorepo split), so the checkout is two levels up. A relative override
 * resolves against `cwd` too.
 *
 * Pure and dependency-injected (cwd + env passed in) so `node --test` can
 * exercise it, matching the data-root.ts precedent.
 *
 * @param {string} cwd process working directory (expected: <checkout>/apps/web)
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path to the engine checkout
 */
export function resolveCodeRoot(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.CAREER_OPS_CODE_ROOT || "").trim();
  if (explicit) return path.resolve(cwd, explicit);
  // The app runs from <checkout>/apps/web, so the checkout is two levels up —
  // but a `bun test` from the repository root is at the checkout itself. Pick
  // the first ancestor that actually holds the engine, so both invocations
  // agree instead of one of them resolving to <checkout>/apps.
  for (const candidate of [cwd, path.resolve(cwd, ".."), path.resolve(cwd, "..", "..")]) {
    if (fs.existsSync(path.join(candidate, "packages", "core", "src"))) return candidate;
  }
  return path.resolve(cwd, "..", "..");
}

/**
 * Absolute path to one engine root script. The `.ts` is assembled from the
 * bare name so the literal never appears as a direct execFile/spawn argument —
 * The bundler statically traces such literals and fails the build otherwise.
 *
 * @param {string} codeRoot absolute engine checkout directory
 * @param {string} nameNoExt e.g. "doctor", "scan-ats-full"
 */
export function resolveRootScript(codeRoot: string, nameNoExt: string): string {
  // The command catalog is the one place that knows where each script lives, so
  // the web UI and the CLI binary cannot disagree about it.
  const known = COMMANDS[nameNoExt]?.script;
  if (known) {
    // `script` is relative to packages/cli/src/bin; translate it to a checkout path.
    const fromBin = path.join(/* @vite-ignore */ codeRoot, "packages", "cli", "src", "bin", known);
    return path.resolve(fromBin);
  }
  // Legacy flat checkout / an unlisted script: the scripts used to live at the root.
  return path.join(/* @vite-ignore */ codeRoot, `${nameNoExt}.ts`);
}
