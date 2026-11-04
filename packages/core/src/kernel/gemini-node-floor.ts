// packages/core/src/kernel/gemini-node-floor.ts — the one place that knows the Gemini integration
// needs a higher Node than the rest of the project.
//
// This exists because the fact used to live only in prose. docs/SETUP.md stated
// it, the docs site did not, and a user on Node 18 who followed the site and
// picked the Gemini path hit the requirement at runtime with nothing warning
// them. Worse, the Spanish and French pages had drifted the other way and
// asserted Node 20 as a *general* requirement, which is false.
//
// Prose copies drift. A runtime verdict does not: doctor emits it, and every
// surface that renders doctor's output gets it without keeping a second copy.
// So the number lives here, once, and everything else derives.
//
// Scoped on purpose: it returns null unless the CLI actually in use is Gemini.
//
// career-ops itself runs on Bun, so this floor is about the `node` binary the
// Gemini CLI runs on, which doctor resolves from PATH. It is deliberately
// independent of the Bun floor: career-ops no longer has a Node requirement of
// its own.


export const GEMINI_MIN_MAJOR = 20;

/**
 * Verdict on whether the running Node satisfies the Gemini integration's floor.
 *
 * @param activeCli - The CLI in use, as resolved by doctor.
 * @param versionStr - A Node version string, e.g. "18.20.4".
 * @returns null when the check does not apply (any CLI other than Gemini).
 */
export function geminiNodeFloor(
  activeCli: string,
  versionStr: string | null,
): { pass: boolean; label: string; fix?: string[] } | null {
  if (activeCli !== 'gemini') return null;

  const major = Number(String(versionStr).split('.')[0]);

  // An unparseable version — including `null`, which is what doctor passes
  // when no `node` binary is on PATH — is not a pass. Reporting "fine" because
  // we could not read the number is the failure mode this project keeps
  // finding elsewhere: a check that cannot look must not answer "all clear".
  if (!Number.isFinite(major)) {
    return {
      pass: false,
      label: `Could not read the Node.js version ("${versionStr}"), so the Gemini integration's Node ${GEMINI_MIN_MAJOR}+ requirement could not be verified`,
      fix: [`Check that Node.js ${GEMINI_MIN_MAJOR}+ is on your PATH, then confirm with: node --version`],
    };
  }

  if (major >= GEMINI_MIN_MAJOR) {
    return { pass: true, label: `Node.js >= ${GEMINI_MIN_MAJOR} for the Gemini CLI integration (v${versionStr})` };
  }

  return {
    pass: false,
    label: `The Gemini CLI integration requires Node.js ${GEMINI_MIN_MAJOR}+ (found v${versionStr})`,
    fix: [
      `Install Node.js ${GEMINI_MIN_MAJOR} or later from https://nodejs.org — the Gemini CLI runs on Node (career-ops itself runs on Bun).`,
    ],
  };
}
