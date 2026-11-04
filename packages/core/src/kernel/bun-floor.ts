// packages/core/src/kernel/bun-floor.ts — the project's minimum Bun version, stated once.
//
// career-ops runs on Bun: `bun install` for dependencies, `bun <script>.ts`
// for every entrypoint, `bun test` for the suites, `bunx` for one-off CLIs.
// Bun supplies the Node-compatible modules the code imports (`node:sqlite`
// for packages/cli/src/commands/tracker/tracker.ts's index, `node:fs`, `node:child_process`, ...), so the old
// Node floor is gone with the npm toolchain it belonged to.
//
// 1.4.3 is the release this repository is developed and tested against, and
// the first one where every module imported by the root CLI is available
// without flags — `node:sqlite` in particular, which packages/cli/src/commands/tracker/tracker.ts imports
// plainly. A lower version is not promised compatibility that nothing checks.
//
// package.json `engines.bun` (BUN_ENGINES), scaffolder/package.json `engines`,
// and the CI floor step in .github/workflows/test.yml carry the same number;
// tests/bun-floor.test.ts fails if any of them drifts from these.

export const BUN_MIN = '1.4.3';

export const BUN_ENGINES = `>=${BUN_MIN}`;

const parse = (v: string): number[] => String(v).replace(/^v/, '').split('.').map(Number);

/**
 * Verdict on whether a Bun version meets the project floor.
 *
 * @param versionStr - A Bun version string, e.g. "1.4.3".
 */
export function bunFloor(versionStr: string): { pass: boolean; label: string; fix?: string[] } {
  const [major, minor, patch = 0] = parse(versionStr);
  const [minMajor, minMinor, minPatch] = parse(BUN_MIN);
  const floor = `${minMajor}.${minMinor}.${minPatch}`;

  // An unreadable version is not a pass: a check that cannot look must not
  // answer "all clear".
  if (![major, minor, patch].every(Number.isFinite)) {
    return {
      pass: false,
      label: `Could not read the Bun version ("${versionStr}"), so the Bun ${floor}+ requirement could not be verified`,
      fix: [`Check your Bun install, then confirm it is ${floor} or later: bun --version`],
    };
  }

  const meets = major > minMajor
    || (major === minMajor && minor > minMinor)
    || (major === minMajor && minor === minMinor && patch >= minPatch);

  if (meets) {
    return { pass: true, label: `Bun >= ${floor} (v${versionStr})` };
  }

  return {
    pass: false,
    label: `Bun >= ${floor} required (found v${versionStr})`,
    fix: [
      `Install Bun ${floor} or later from https://bun.sh (curl -fsSL https://bun.sh/install | bash)`,
      'Every career-ops entrypoint runs on Bun; Node and npm are no longer used by the toolchain.',
    ],
  };
}
