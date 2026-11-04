/**
 * Environment for a core script the web app runs on the user's behalf.
 *
 * Every core script resolves the user's files through `getCareerOpsRoot()`,
 * which honours `CAREER_OPS_ROOT` / `CAREER_OPS_DATA_DIR` and the
 * `.career-ops-data` marker. The web app resolves the SAME root independently
 * (`careerOpsRoot()`) and then spawns the script — so unless the resolved root
 * is handed to the child, the two disagree the moment the data root is not the
 * checkout:
 *
 *   - the route reads `cv.md`, `cv.md.bak-*` and the profile from the user's
 *     data root,
 *   - the spawned script reads them from the checkout it was launched from,
 *   - and a write lands in the wrong one. It did exactly that during
 *     development: an import test aimed at a scratch root wrote
 *     `<checkout>/data/career-profile.yml` instead (#— local find).
 *
 * Passing the resolved root explicitly makes the child resolve what the caller
 * already resolved, whatever the caller had configured. `CAREER_OPS_ROOT` is
 * set rather than only copied because it takes precedence over
 * `CAREER_OPS_DATA_DIR` in packages/core/src/kernel/path-resolver.ts, so an inherited DATA_DIR cannot
 * win over the root this process actually used.
 *
 * @param {string} root - The data root the caller resolved.
 * @param {NodeJS.ProcessEnv} [base] - Defaults to this process's env.
 * @returns {NodeJS.ProcessEnv}
 */
export function rootScriptEnv(root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, CAREER_OPS_ROOT: root };
}
