// tests/self-test-registration.test.ts — every root script that answers
// `--self-test` must be run by something.
//
// A `--self-test` block lives inside the script it checks, so test discovery
// (tests/**/*.test.ts, #1440) never sees it. It runs only when someone names
// it: an entry in the `scripts` list in test-all.ts, or a suite under tests/
// that spawns `<script> --self-test`. Forgetting that entry costs nothing
// visible. packages/cli/src/commands/outreach/linkedin-join.ts (43 checks) and packages/cli/src/commands/profile/validate-profile.ts (14 checks)
// both shipped that way and were never run by CI, the same shape
// tests/root-tests-registration.test.ts guards for root *-tests.ts suites
// and that #3303 found for a root *.test.ts.
//
// The rule, kept deliberately narrow so a mention can never read as a run:
//
//   declares a self-test   a tracked root-level .ts with a non-comment line
//                          holding the string literal '--self-test' (its
//                          argv check). A comment or unquoted usage line
//                          does not.
//   reached by test-all    a non-comment line inside the `scripts` array is
//                          the entry `'<script> --self-test'` and expects
//                          exit 0. An entry expecting failure does not count:
//                          the harness passes it while the self-test fails.
//   reached by a suite     a non-comment line of a tests/**/*.test.ts calls
//                          a process launcher (run, runScript, spawnSync,
//                          execFileSync, ...), names the script as a quoted
//                          string AND passes the quoted '--self-test' flag,
//                          all on that same line. An array or string that
//                          only mentions the two does not.
//
// Both directions of error are possible and the safe one is chosen: a suite
// that builds the flag or the filename some other way reads as unreachable,
// a false red resolved by registering the script in test-all.ts.
import { readFileSync } from 'fs';
import { basename, join, relative, sep } from 'path';
import { trackedFiles } from '../packages/core/src/kernel/source-files.ts';
import { pass, fail, ROOT } from './helpers.ts';

console.log('\ntest-all.ts — every --self-test is run by something');

const SELF_TEST_FLAG = /['"`]--self-test['"`]/;
/**
 * `src` with every `//` and `/* *\/` comment blanked out, newlines kept, so a
 * launch call quoted inside a block comment is not read as code. String and
 * regex literals are copied through untouched: `'https://…'` is not a comment
 * opener, and `/['"]x['"]/` does not open a string. A `/` starts a regex only
 * where a value cannot just have ended, the same rule
 * tests/root-tests-registration.test.ts uses.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let prev = '';
  const regexPos = () => prev === '' || '([{,;:=!&|?+-*%~^<>'.includes(prev);
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || (c === '/' && regexPos())) {
      const close = c;
      let inClass = false;
      out += src[i++];
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        if (d === '\n' && close !== '`') break;
        out += d;
        i++;
        if (close === '/' && d === '[') inClass = true;
        else if (close === '/' && d === ']') inClass = false;
        else if (d === close && !inClass) break;
      }
      prev = 'x';
      continue;
    }
    if (!/\s/.test(c)) prev = c;
    out += c;
    i++;
  }
  return out;
}

const codeLines = (src) => stripComments(src).split('\n');
const LAUNCH_CALL = /\b(?:run|runScript|runNode|spawn|spawnSync|execFile|execFileSync)\s*\(/;

/** Whether a root script's own code (not its comments) handles `--self-test`. */
function declaresSelfTest(src) {
  return codeLines(src).some((line) => SELF_TEST_FLAG.test(line));
}

/** The `scripts` array of test-all.ts, or null when it cannot be found. */
function scriptsBlock(harnessSrc) {
  const m = harnessSrc.match(/const scripts\s*=\s*\[([\s\S]*?)\n\];/);
  return m ? m[1] : null;
}

/** Whether test-all.ts's `scripts` array registers `<name> --self-test`. */
function registeredInHarness(block, name) {
  // Scripts live under packages/ now, so the harness entry carries a path and
  // the scan yields a basename: match the basename of the entry's first token.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`name:\\s*'(?:[^']*/)?${escaped} --self-test'`);
  return codeLines(block).some((line) => re.test(line) && /\bexpectExit:\s*0\b/.test(line));
}

/** Whether a test suite's source launches `<name> --self-test` on one line. */
function spawnedBySuite(suiteSrc, name) {
  const quoted = [`'${name}'`, `"${name}"`, `\`${name}\``];
  return codeLines(suiteSrc).some((line) =>
    LAUNCH_CALL.test(line) && SELF_TEST_FLAG.test(line) && quoted.some((q) => line.includes(q)));
}

// The rule itself, against fixtures, before it grades the tree: a rule that
// accepts a comment would pass on any tree.
{
  const failures = [];
  const block = [
    "  { name: 'real.ts --self-test', expectExit: 0 },",
    "  // { name: 'commented.ts --self-test', expectExit: 0 },",
    "  { name: 'failing.ts --self-test', expectExit: 1, allowFail: true },",
  ].join('\n');
  if (!registeredInHarness(block, 'real.ts')) failures.push('a scripts entry was not read as a registration');
  if (registeredInHarness(block, 'commented.ts')) failures.push('a commented-out scripts entry read as a registration');
  if (registeredInHarness(block, 'al.ts')) failures.push('a filename suffix read as a registration');
  if (registeredInHarness(block, 'failing.ts')) failures.push('an entry expecting a non-zero exit read as a registration');
  if (!spawnedBySuite("const r = run(NODE, ['x.ts', '--self-test']);", 'x.ts')) failures.push('a spawn line was not read as a run');
  if (spawnedBySuite("// run(NODE, ['x.ts', '--self-test'])", 'x.ts')) failures.push('a commented spawn read as a run');
  if (spawnedBySuite("import { f } from '../x.ts';\nconst flag = '--self-test';", 'x.ts')) failures.push('the name and the flag on different lines read as a run');
  if (spawnedBySuite("const ARGS = ['x.ts', '--self-test'];", 'x.ts')) failures.push('a bare literal with no launch call read as a run');
  if (spawnedBySuite("/*\n  run(NODE, ['x.ts', '--self-test']);\n*/", 'x.ts')) failures.push('a launch inside a block comment read as a run');
  if (spawnedBySuite("cleanup(); // run(NODE, ['x.ts', '--self-test'])", 'x.ts')) failures.push('a launch in a trailing comment read as a run');
  if (!spawnedBySuite("const u = 'https://x.test/a'; run(NODE, ['x.ts', '--self-test']);", 'x.ts')) failures.push('a // inside a string hid the launch after it');
  if (!spawnedBySuite("const re = /['\"]x/; run(NODE, ['x.ts', '--self-test']);", 'x.ts')) failures.push('a quote inside a regex literal hid the launch after it');
  if (!declaresSelfTest("if (args.includes('--self-test')) runSelfTest();")) failures.push('an argv check was not read as a declaration');
  if (declaresSelfTest("// Run with '--self-test' to check it.\nmain();")) failures.push('a comment mentioning the flag read as a declaration');
  if (declaresSelfTest("/**\n Usage: bun x.ts '--self-test'\n */\nmain();")) failures.push('a block comment mentioning the flag read as a declaration');
  if (failures.length === 0) pass('the reachability rule rejects comments of both kinds, suffixes, split lines, failing entries and bare literals, and keeps strings and regexes intact (15 fixtures)');
  else fail(`reachability rule fixtures failed:\n${failures.map((f) => `    ${f}`).join('\n')}`);
}

const harnessSrc = readFileSync(join(ROOT, 'test-all.ts'), 'utf-8');
const block = scriptsBlock(harnessSrc);
if (block === null) {
  fail('test-all.ts has no `const scripts = [ ... ];` array — this guard is reading the wrong shape and would pass on any tree');
} else {
  // The engine tree, not the root: scripts moved under packages/ in the monorepo
  // split, and a root-only scan reads as "nothing to check" instead.
  const rootScripts = trackedFiles(ROOT, (rel) => rel.startsWith('packages/') && rel.endsWith('.ts'));
  const declaring = rootScripts
    .filter((abs) => declaresSelfTest(readFileSync(abs, 'utf-8')))
    .map((abs) => basename(abs));

  // An empty set means the scan looked nowhere, not that the tree is clean.
  if (declaring.length === 0) {
    fail(`no tracked root script declares --self-test (${ROOT}) — the scan did not find what it grades`);
  } else {
    const suites = trackedFiles(ROOT, (rel) => rel.split('/')[0] === 'tests' && rel.endsWith('.test.ts'))
      .map((abs) => ({ rel: relative(ROOT, abs).split(sep).join('/'), src: readFileSync(abs, 'utf-8') }));

    const unreachable = declaring.filter((name) =>
      !registeredInHarness(block, name) && !suites.some((s) => spawnedBySuite(s.src, name)));

    if (unreachable.length === 0) {
      pass(`every root script with a --self-test is run by test-all.ts or a tests/ suite (${declaring.length} checked)`);
    } else {
      fail(
        `${unreachable.length} --self-test block(s) are never run — no scripts entry in test-all.ts and no tests/ suite launches them:\n` +
          unreachable.map((n) => `    ${n}`).join('\n') +
          "\n  Add an entry to the `scripts` list in test-all.ts: { name: '<file> --self-test', expectExit: 0 }",
      );
    }
  }
}
