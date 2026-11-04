// profile-path.ts — the web's resolver for config/profile.yml.
//
// A mirror of core `getProfilePath()` (packages/core/src/kernel/path-resolver.ts, #5026). The web build
// cannot import the core helper (its bundler root is pinned to web/), so the
// contract is duplicated on purpose and pinned by
// tests/web-profile-path-parity.test.ts. Two deliberate differences from core:
//
//   - the first argument is the DATA root, and CAREER_OPS_PROFILE wins over it
//     unless `explicitRoot` is set (core: an explicit rootDir always wins);
//   - a RELATIVE override resolves against that root, not the process cwd. The
//     web's own cwd is web/, one directory too deep; the core scripts it spawns
//     run with the data root as their cwd.
import { isAbsolute, join, resolve } from "node:path";

/** Options for {@link getProfilePath}. */
export interface ProfilePathOptions {
  /** Environment to read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** When true, the root decides and the override is ignored. */
  explicitRoot?: boolean;
}

/**
 * The profile.yml path for a data root.
 *
 * @param root - The data root (absolute, or resolvable against the cwd).
 * @param options - Environment and explicit-root flag.
 */
export function getProfilePath(root: string, options: ProfilePathOptions = {}): string {
  const env = options.env ?? process.env;
  const fallback = join(root, "config", "profile.yml");
  if (options.explicitRoot) return fallback;

  const override = env.CAREER_OPS_PROFILE?.trim();
  if (!override) return fallback;
  return isAbsolute(override) ? override : resolve(root, override);
}

/** The repository-relative name prompts use when no override is set. */
export const DEFAULT_PROFILE_REF = "config/profile.yml";

/**
 * What a prompt should tell the agent to read. Not the resolved absolute path
 * for the default case: `config/profile.yml` is repo-relative prose that the
 * agent resolves from its own cwd, exactly as the modes are written.
 *
 * @param root - The data root.
 * @param options - Environment to read.
 */
export function profileRef(root: string, options: ProfilePathOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.CAREER_OPS_PROFILE?.trim();
  if (!override) return DEFAULT_PROFILE_REF;
  return isAbsolute(override) ? override : resolve(root, override);
}

/**
 * A sentence naming the overridden profile, or "" for the default.
 *
 * @param ref - A value from {@link profileRef}.
 */
export function profileNote(ref: string): string {
  if (!ref || ref === DEFAULT_PROFILE_REF) return "";
  return `Profile location: ${ref} (CAREER_OPS_PROFILE overrides config/profile.yml).`;
}
