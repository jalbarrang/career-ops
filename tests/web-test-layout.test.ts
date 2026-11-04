// tests/web-test-layout.test.ts — freezes apps/web/'s test DISCOVERY contract (#2360).
//
// apps/web/ used to carry two conventions at once: suites under apps/web/tests/ plus two
// hand-enumerated at the web root, listed by name in apps/web/package.json's `test`
// script. A suite missing from that list never ran and the runner still exited
// 0. #1440, the parent issue, named that failure mode directly — "the runner
// should also fail hard if the glob matches zero files, so a path typo can't
// silently turn CI green" — and removed it from the root suite. apps/web/ kept it,
// and it nearly cost two suites for real during #2182, where either side of a
// package.json conflict would have dropped them with CI green.
//
// This guard lives in the ROOT suite, not apps/web/tests/, deliberately:
//   1. .github/workflows/test.yml runs test-all.ts on every PR with no paths
//      filter and is a required check. web-ci.yml is informative by design —
//      "a red here never blocks a core merge" — so it cannot be the enforcer.
//   2. A guard inside apps/web/tests/ would be discovered by the very glob it
//      validates: if the glob breaks, the guard silently stops running too.
// Same reach-into-web/ pattern as test-all.ts's 55.3c/55.3d freezes (#2369).
//
// ONE responsibility: apps/web/'s suites must be reachable by what `bun test`
// actually runs. Every assertion below is a facet of that — including the
// engines floor, which is checked because it is the runtime the suites need,
// not as general toolchain policy.
//
// It asserts PROPERTIES, not a frozen script string, so a legitimate
// restructure is not blocked.
import { pass, fail, ROOT, walkFiles } from './helpers.ts';
import { join, relative, sep } from 'path';
import { readFileSync, existsSync } from 'fs';
import { BUN_MIN } from '../packages/core/src/kernel/bun-floor.ts';

console.log('\nweb/ test discovery contract (#2360)');

const WEB = join(ROOT, 'apps/web');
const WEB_PKG = join(WEB, 'package.json');

// `bun test` discovers recursively with no CLI glob to expand, so the binding
// constraint on apps/web/'s floor is the Bun release the suites are developed and
// tested against — the same number packages/core/src/kernel/bun-floor.ts states once for the whole
// repository. vite's own node engines are unrelated and no longer consulted.
const RUNNER_FLOOR = BUN_MIN.split('.').map(Number);

/**
 * Run one scenario in isolation.
 *
 * Each case gets its own try/catch so a throw in one cannot collapse the rest
 * into a single unexplained failure (PIT — every case stands alone, in any
 * order). A guard that cannot inspect the tree must be loud, never a silent
 * pass — the same stance as test-all.ts's SYSTEM_PATHS coverage probe.
 *
 * @param {string} label - What this scenario checks, used in the error path.
 * @param {() => void} body - The When/Then; calls pass() or fail() itself.
 * @returns {void}
 */
function scenario(label, body) {
  try {
    body();
  } catch (err) {
    fail(`could not verify ${label} (#2360): ${err.message}`);
  }
}

/**
 * Translate a glob operand into an anchored matcher.
 *
 * Kept because a `test` script is allowed to pass an explicit pattern to
 * `bun test`, and this is what proves such a pattern still reaches every
 * suite. Supports exactly the two constructs the runner expands — `**`
 * spanning separators (and matching zero segments) and `*` within one
 * segment. Anything else is out of contract: it is treated literally, which
 * fails closed by reporting suites as unreachable rather than waving them
 * through.
 *
 * @param {string} pattern - A glob operand from the `test` script.
 * @returns {RegExp} Matcher for web-relative, `/`-separated paths.
 */
function globToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c !== '*') {
      out += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    } else if (pattern[i + 1] === '*') {
      out += '.*';
      i++;
      if (pattern[i + 1] === '/') i++;
    } else {
      out += '[^/]*';
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Lowest version an `engines` range provably admits, as [major, minor, patch].
 *
 * Validates the WHOLE range against one deliberately narrow grammar:
 * whitespace-separated comparators, each `>=`/`<=`/`<` followed by a 1-to-3
 * component version, with exactly one `>=` lower bound. Every upper bound must
 * leave that bound satisfiable, so `>=22 <25` and `>=22 <=22` are accepted
 * while `>=22.0.0 <20.0.0` and `>=22.0.0 <22.0.0` are not.
 *
 * Anything outside the grammar returns null and is reported as unverifiable
 * rather than guessed at, because guessing silently blesses a Node that cannot
 * run the suite. Refused, with the reason: `^22.0.0 || >=20.0.0` and
 * `^24 || ^20` (unions admitting 20), `<=23.0.0` (no lower bound at all),
 * `>=22.0.0 garbage` (trailing junk), `^22.0.0` / `22.x` (caret and x-range
 * semantics this guard does not parse).
 *
 * Evaluating the full npm range grammar properly needs a semver evaluator.
 * `semver` is not a dependency of this repo and is not installed, Node ships no
 * built-in equivalent, and `tests/` must stay dependency-free — it ships to end
 * users via SYSTEM_PATHS and #1440 requires the suite to run on a bare clone.
 * So the burden is inverted: prove the floor or refuse the range.
 *
 * @param {string} range - An `engines.bun` value.
 * @returns {number[]|null} [major, minor, patch], or null if not provable.
 */
function floorOf(range) {
  const terms = range.trim().split(/\s+/).filter(Boolean);
  const parsed = [];
  for (const term of terms) {
    const m = term.match(/^(>=|<=|<)(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (!m) return null;   // unknown operator, `||`, caret/x-range, or junk
    parsed.push({ op: m[1], version: [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)] });
  }
  const lowerBounds = parsed.filter((t) => t.op === '>=');
  if (lowerBounds.length !== 1) return null;
  const floor = lowerBounds[0].version;
  const order = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);
  for (const { op, version } of parsed) {
    // An upper bound at or below the floor makes the range unsatisfiable.
    if (op === '<' && order(version, floor) <= 0) return null;
    if (op === '<=' && order(version, floor) < 0) return null;
  }
  return floor;
}

// apps/web/ is NOT in packages/cli/src/commands/platform/update-system.ts's SYSTEM_PATHS but tests/ is, so this file
// ships to end users whose checkout has no apps/web/ at all. The invariant is
// conditional ("if apps/web/ exists, its suites are reachable") and vacuously true
// there — but say so out loud rather than skipping in silence.
if (!existsSync(WEB_PKG)) {
  pass('apps/web/ is not present in this checkout — discovery contract not applicable');
} else {
  // ── Given: what is on disk, and what apps/web/package.json claims to run ──

  // Anything a contributor would reasonably expect to be run: the sanctioned
  // {module}.test.{ext} and the legacy test-{module}.{ext}. Non-.ts
  // extensions are caught on purpose so a suite written in another shape is
  // named here instead of sitting in the tree looking like coverage.
  const TEST_FILE = /(?:\.test\.(?:mjs|js|ts|tsx)|^test-.*\.(?:mjs|js|ts|tsx))$/;
  // Scoped to what apps/web/ TRACKS (#3890): walkFiles enumerates the index now, so
  // `node_modules`, `.next`, `out`, `dist` and `coverage` drop out because git
  // does not track them, not because this file remembered to list them. That
  // list was also the narrowing hazard — an unlisted generated directory put a
  // built copy of every suite under the contract, and a suite added under a
  // listed one silently left it. node_modules mattered for speed too: a
  // populated apps/web/node_modules is ~400 MB (see test-all.ts's copy-exclusion
  // note), and the index never walks into it at all.
  const found = walkFiles(WEB, TEST_FILE)
    .map((p) => relative(WEB, p).split(sep).join('/'));

  const pkg = JSON.parse(readFileSync(WEB_PKG, 'utf8'));
  const script = pkg.scripts?.test ?? '';
  // Tokenize respecting quotes, then keep only path-shaped operands. Shape, not
  // position, decides what counts — so a flag value like `--test-reporter spec`
  // and any command prefix are both excluded without hardcoding an argv index.
  const operands = (script.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
    .map((t) => t.replace(/^["']|["']$/g, ''))
    .filter((t) => !t.startsWith('-'))
    .filter((t) => /\.(mjs|js|ts|tsx)$/.test(t) || t.includes('*'));
  const patterns = operands.filter((t) => t.includes('*'));
  const enumerated = operands.filter((t) => !t.includes('*'));

  const misplaced = found.filter((p) => !p.startsWith('tests/') || !p.endsWith('.test.ts'));

  // ── Every suite sits where the glob can see it, under the right name ──
  scenario('where web suites live', () => {
    if (misplaced.length === 0) {
      pass(`all ${found.length} web suites live under apps/web/tests/ as {module}.test.ts`);
    } else {
      fail(`web suites outside the discovered layout (#2360): ${misplaced.join(', ')}`
        + ' — web tests live at apps/web/tests/{dir}/{module}.test.ts mirroring apps/web/src/,'
        + " and must end in .test.ts for `bun test` discovery to reach them");
    }
  });

  // ── The script discovers by pattern; it never lists suites by name ──
  scenario('that the test script names no suites', () => {
    if (enumerated.length === 0) {
      pass('apps/web/package.json test script enumerates no suites by name');
    } else {
      fail(`apps/web/package.json test script names suites explicitly (#2360): ${enumerated.join(', ')}`
        + ' — a suite missing from a hand-maintained list never runs and `bun test` still exits 0;'
        + ' rely on automatic discovery under tests/ instead');
    }
  });

  scenario('that the test script runs the Bun test runner', () => {
    // `bun test` discovers tests/**/*.test.* on its own. A script that names a
    // different runner would still exit 0 while running nothing from this tree.
    const runner = (script.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
      .map((t) => t.replace(/^["']|["']$/g, ''))
      .find((t) => !t.startsWith('-'));
    if (runner === 'bun') {
      pass('web test script runs the Bun test runner');
    } else {
      fail(`apps/web/package.json test script does not run \`bun test\` (#2360, found ${JSON.stringify(script)})`
        + " — the suites are for Bun to discover; any other runner would exit 0 having run nothing");
    }
    for (const pattern of patterns) {
      const re = globToRegExp(pattern);
      const missed = found.filter((f) => !re.test(f));
      if (missed.length === 0) pass(`declared pattern ${pattern} reaches every suite`);
      else fail(`declared pattern ${pattern} misses ${missed.length} suite(s): ${missed.join(', ')}`);
    }
  });

  // ── A pattern that matches nothing exits 0 (#1440's zero-match rule) ──
  // Verified on Node 22: `node --test "zzz/**/*.test.ts"` exits 0 with zero
  // tests run. A missing literal path exits 1, so THIS is the silent case.
  scenario('that web discovery is non-empty', () => {
    if (found.length > 0) {
      pass(`web test discovery is non-empty (${found.length} suites on disk)`);
    } else {
      fail('no web test suites found under apps/web/ (#2360, #1440) — an empty glob exits 0,'
        + ' so zero web coverage would look identical to a green run');
    }
  });

  // ── ...and the declared pattern actually reaches each one ──
  scenario('that the declared glob reaches every suite', () => {
    // `bun test` with no operands discovers `tests/**/*.test.*` itself; there
    // is no glob to be wrong about. Only a script that DOES declare one has to
    // reach everything with it.
    if (patterns.length === 0) {
      pass('web test script declares no glob: `bun test` discovers tests/ itself');
      return;
    }
    const patternMatchers = patterns.map(globToRegExp);
    const unreachable = found.filter(
      (p) => !misplaced.includes(p) && !patternMatchers.some((re) => re.test(p)));
    if (unreachable.length === 0) {
      pass('every web suite on disk is matched by the declared glob');
    } else {
      fail(`web suites the declared glob cannot reach (#2360): ${unreachable.join(', ')}`
        + ` — pattern(s) ${patterns.join(', ')} run, but these files do not match,`
        + ' so they are dead weight that looks like coverage');
    }
  });

  // ── The floor parser itself, so a subtle range can't slip past ──
  // Regression table for the #2468 review: every entry here once passed, or
  // could plausibly be written by hand, and each would bless a Node that
  // cannot run the suite.
  scenario('that floorOf only accepts provable floors', () => {
    const PROVABLE = ['>=22', '>=22.0', '>=22.0.0', '>=22 <25', '>=22 <=22'];
    const REFUSED = [
      '^22.0.0 || >=20.0.0',  // union — admits Node 20
      '^24 || ^20',           // union — admits Node 20
      '<=23.0.0',             // no lower bound at all
      '>=22.0.0 <20.0.0',     // unsatisfiable
      '>=22.0.0 <22.0.0',     // unsatisfiable
      '>=22.0.0 garbage',     // trailing junk
      '>=22 >=24',            // two lower bounds — ambiguous
      '^22.0.0',              // caret semantics, not parsed here
      '22.x',                 // x-range semantics, not parsed here
      '',                     // absent
    ];
    const wrong = [
      ...PROVABLE.filter((r) => floorOf(r) === null).map((r) => `${JSON.stringify(r)} should be provable`),
      ...REFUSED.filter((r) => floorOf(r) !== null).map((r) => `${JSON.stringify(r)} should be refused`),
    ];
    if (wrong.length === 0) {
      pass(`floorOf accepts ${PROVABLE.length} provable floors, refuses ${REFUSED.length} unprovable ranges`);
    } else {
      fail(`floorOf misjudged engines ranges (#2360): ${wrong.join('; ')}`);
    }
  });

  // ── The declared runner floor must be satisfiable ──
  scenario("that web's engines floor meets the Bun floor", () => {
    const engines = pkg.engines?.bun ?? '';
    const declaredFloor = floorOf(engines);
    const required = RUNNER_FLOOR.join('.');
    if (!declaredFloor) {
      fail(`apps/web/package.json declares no verifiable engines.bun floor (#2360, got ${JSON.stringify(engines)})`
        + ` — the suites need >=${required}. State it as a single`
        + ` \`>=<version>\` lower bound (an upper bound may follow); \`||\` alternatives are refused`
        + ' because they can admit an older Bun than the first term suggests');
      return;
    }
    const [dMajor, dMinor, dPatch] = declaredFloor;
    const [rMajor, rMinor, rPatch] = RUNNER_FLOOR;
    const order = (dMajor - rMajor) || (dMinor - rMinor) || (dPatch - rPatch);
    if (order >= 0) {
      pass(`web engines.bun ${engines} meets the runner floor (>= ${required})`);
    } else {
      fail(`web engines.bun ${engines} is below >=${required} (#2360)`
        + ' — the suites are developed against that Bun, and claiming a lower floor promises compatibility nothing checks');
    }
  });
}
