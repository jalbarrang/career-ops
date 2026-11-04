// tests/core-test-layout.test.ts — a suite that is not under tests/ does not run.
//
// test-all.ts discovers `tests/**/*.test.ts` and nothing else (#1440), and
// that limit is deliberate: it keeps the runner away from standalone files at
// the repository root. The cost is that a suite written anywhere else is
// invisible in the quietest possible way: the file exists, it is committed,
// `--only <name>` says "no test files matched", and the suite prints green
// assertions the moment somebody runs it by hand.
//
// lib/context-budget.test.ts sat there with the #2234 guard that every
// modes/_shared.md heading is classified in SECTION_PRIORITY, so a
// scoring-critical section cannot silently become compressible. That guard
// had never run in CI. The sibling check for web/'s own discovery glob is
// tests/web-test-layout.test.ts; this is the core half, kept in tests/
// rather than inline in test-all.ts so `--only` can reach it.
import { pass, fail, ROOT } from './helpers.ts';
import { collectSourceFiles } from '../lib/source-files.ts';
import { relative, sep } from 'path';

console.log('\ncore test layout — every suite lives where a runner can find it');

// The two trees a runner actually discovers: test-all.ts's discoverTests()
// over tests/, and web/'s own `bun test` glob over web/tests/.
const DISCOVERED_ROOTS = ['tests/', 'web/tests/'];

// collectSourceFiles() skips node_modules, output/, data/ and any nested checkout
// (a linked worktree marks itself with a `.git` FILE, #3499), so a developer
// with a worktree open is not graded on somebody else's tree.
const suites = collectSourceFiles(ROOT)
  .map((f) => relative(ROOT, f).split(sep).join('/'))
  .filter((rel) => rel.endsWith('.test.ts'))
  // fork/core/ is a STAGING copy of the checkout root: fork/apply.ts copies it
  // over the tree, at which point fork/core/tests/x.test.ts lands as
  // tests/x.test.ts and is discovered. It is not a live test location until
  // then, so it is not an orphan.
  .filter((rel) => !rel.startsWith('fork/core/tests/'));

if (suites.length === 0) {
  // An empty walk means the walk is broken, not that the repo has no tests;
  // passing here would report health while checking nothing.
  fail('collectSourceFiles() found no *.test.ts at all: the walk is broken, not the repo');
} else {
  const orphans = suites.filter((rel) => !DISCOVERED_ROOTS.some((dir) => rel.startsWith(dir)));
  if (orphans.length === 0) {
    pass(`all ${suites.length} *.test.ts files live under ${DISCOVERED_ROOTS.join(' or ')}`);
  } else {
    for (const rel of orphans) {
      fail(`${rel} is a *.test.ts outside ${DISCOVERED_ROOTS.join(' and ')}: no runner discovers it, move it under tests/`);
    }
  }
}
