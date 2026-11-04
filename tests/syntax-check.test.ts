// tests/syntax-check.test.ts — the single-process syntax pass gives the same
// verdict as `node --check` (#5078).
//
// packages/core/src/kernel/syntax-check.ts parses every .ts file in one process and only hands a
// file to `node --check` when that pass does not vouch for it. A file it
// rejects wrongly costs one spawn. A file it ACCEPTS wrongly is a syntax error
// the gate no longer sees, and the log would look exactly as green as before.
// That is the case this suite exists for.
//
// Four parts:
//
//   1. EQUIVALENCE — both checkers run over a corpus of broken, unusual and
//      version-dependent modules and must agree on every one. Agreement is the
//      assertion, not a fixed verdict: `using` parses on one node and not on
//      another, and either way the two must say the same thing. A handful of
//      anchors that every supported node accepts or rejects keep "they agree"
//      from being satisfied by two checkers that accept everything.
//   2. THIS REPOSITORY — the same agreement over the files the gate really
//      checks.
//   3. FALLBACK — when the fast pass cannot run, or answers with something
//      other than what was asked, nothing is vouched for and `node --check`
//      still finds the broken file.
//   4. CONVENTION — both gates go through the shared module, and neither
//      spawns `node --check` on its own.
import { pass, fail, ROOT } from './helpers.ts';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectSourceFiles } from '../packages/core/src/kernel/source-files.ts';
import { checkSyntax, nodeCheck, parseInOneProcess } from '../packages/core/src/kernel/syntax-check.ts';

console.log('\nsyntax-check — one process, the same verdict as the runtime it runs on');

// Bun parses in-process with Bun.Transpiler (packages/core/src/kernel/syntax-check.ts), so the
// corpus below — which records which constructs NODE's parser accepts — only
// applies to the Node path. Under Bun the properties that matter are asserted
// directly: real syntax errors are rejected, and a file importing something
// absent is not (that is the false positive `bun --check` would produce).
const IS_BUN = typeof globalThis.Bun?.Transpiler === 'function';

const ENDS_THE_PROCESS = ['process', 'exit(7);'].join('.');

// [label, source, expected]. `expected` is 'reject', 'accept', or null where
// the answer depends on the node version and only agreement is asserted.
const CORPUS = [
  // ── Broken on every node this package supports ──
  ['a missing binding name', 'const = ;\n', 'reject'],
  ['a missing initializer', 'const a;\n', 'reject'],
  ['an unclosed parameter list', 'function f(a, b {\n}\n', 'reject'],
  ['an unclosed object literal', 'const o = { a: 1, ;\n', 'reject'],
  ['an unterminated string', "const s = 'no end;\n", 'reject'],
  ['an unterminated template', 'const s = `no end;\n', 'reject'],
  ['an unterminated block comment', '/* no end\nconst a = 1;\n', 'reject'],
  ['a duplicate export', 'export const a = 1;\nexport const a = 2;\n', 'reject'],
  ['two default exports', 'export default 1;\nexport default 2;\n', 'reject'],
  ['an export of an undeclared name', 'export { nope };\n', 'reject'],
  ['a duplicate import binding', "import a from './a.ts';\nimport a from './b.ts';\n", 'reject'],
  ['an import inside a block', "if (true) { import x from './x.ts'; }\n", 'reject'],
  ['an import with no specifier', 'import { a } from;\n', 'reject'],
  ['a redeclared let', 'let a;\nlet a;\n', 'reject'],
  ['await in a function that is not async', 'function f() { await x; }\n', 'reject'],
  ['a break outside a loop', 'break;\n', 'reject'],
  ['a return at the top level', 'return 1;\n', 'reject'],
  ['a duplicate label', 'again: again: ;\n', 'reject'],
  ['an undeclared private name', 'class A { m() { return this.#x; } }\n', 'reject'],
  ['super outside a class', 'super();\n', 'reject'],
  ['new.target at the top level', 'new.target;\n', 'reject'],
  ['a hashbang that is not on the first line', '\n#!/usr/bin/env node\n', 'reject'],
  // Modules are strict. Each of these parses as a classic script.
  ['a legacy octal literal', 'var x = 010;\n', 'reject'],
  ['a with statement', 'with (Math) { round(1); }\n', 'reject'],
  ['delete of a plain name', 'var x;\ndelete x;\n', 'reject'],
  ['a duplicate parameter name', 'function f(a, a) {}\n', 'reject'],
  ['an assignment to eval', 'var eval = 1;\n', 'reject'],
  ['an HTML-style comment', '<!-- not a comment in a module\n', 'reject'],
  // The error is inside a function body the parser may skip over at first.
  ['an error in a nested function body', 'function outer() {\n  function inner() { const = ; }\n}\n', 'reject'],
  ['an error on the last line of a long file', `${'// filler\n'.repeat(5000)}const = ;\n`, 'reject'],

  // ── Fine on every node this package supports ──
  ['an empty file', '', 'accept'],
  ['a file that is only a comment', '// nothing here\n', 'accept'],
  ['a hashbang', '#!/usr/bin/env node\nconsole.log(1);\n', 'accept'],
  ['a byte order mark', '﻿export const a = 1;\n', 'accept'],
  ['CRLF line endings', 'const a = 1;\r\nexport { a };\r\n', 'accept'],
  ['top-level await', 'const x = await Promise.resolve(1);\nexport { x };\n', 'accept'],
  // Not a syntax error: neither checker resolves an import.
  ['imports that resolve to nothing', "import a from './does-not-exist.ts';\nimport b from 'no-such-package';\nexport { a, b };\n", 'accept'],
  ['re-exports', "export * as ns from './x.ts';\nexport { default } from './y.ts';\n", 'accept'],
  ['import.meta and a dynamic import', "export const here = import.meta.url;\nexport const later = () => import('./x.ts');\n", 'accept'],
  ['class fields, private names and a static block', 'class A {\n  #x = 1;\n  static #y;\n  static { A.#y = 2; }\n  get x() { return this.#x; }\n}\nexport { A };\n', 'accept'],
  ['bigint, optional chaining and logical assignment', 'let a = 1n ** 2n;\nconst b = a?.b ?? 3;\na ||= b;\n', 'accept'],
  ['a labelled loop', 'outer: for (;;) { break outer; }\n', 'accept'],
  // Parsing is all either checker does. If this ran, the fast pass would die
  // with the rest of the corpus unanswered. (Spelled in two pieces because the
  // runner refuses a suite whose source contains the call.)
  ['a file that would end the process if it ran', `${ENDS_THE_PROCESS}\nthrow new Error('this file was executed');\n`, 'accept'],

  // ── Depends on the node version: only agreement is asserted ──
  ['an import attribute', "import data from './x.json' with { type: 'json' };\nexport { data };\n", null],
  ['a using declaration', '{\n  using handle = open();\n}\n', null],
  ['a deferred namespace import', "import defer * as ns from './x.ts';\nexport { ns };\n", null],
  ['a source-phase import', "import source mod from './x.wasm';\nexport { mod };\n", null],
  ['a decorator', '@decorate class A {}\n', null],
  ['a regular expression with the v flag', 'export const re = /[\\p{L}--[a-z]]/v;\n', null],
  ['an invalid regular expression', 'export const re = /(/;\n', null],
  ['a type annotation', 'const x: number = 1;\n', null],
  ['a byte order mark before a hashbang', '﻿#!/usr/bin/env node\n', null],
  ['bytes that are not UTF-8', Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xff, 0xfe, 0x20, 0x3d, 0x20, 0x31, 0x3b, 0x0a]), null],
];

const dir = mkdtempSync(join(tmpdir(), 'career-ops-syntax-check-'));
const say = (ok) => (ok ? 'accepts' : 'rejects');

try {
  if (IS_BUN) {
    // ── 1 (Bun). What the gate must decide ──
    const BUN_CORPUS = [
      ['an empty file', '', null],
      ['a valid module', 'export const a = 1;\n', null],
      ['a top-level await module', 'const x = await Promise.resolve(1);\nexport { x };\n', null],
      // The property `bun --check` gets wrong: it resolves imports, so every
      // optional provider and every not-yet-generated file would be a "syntax
      // error". The gate must stay a parser.
      ['a module importing something absent', "import a from './does-not-exist.ts';\nimport b from 'no-such-package';\nexport { a, b };\n", null],
      ['a re-export', "export * as ns from './x.ts';\n", null],
      // The repository is TypeScript now: a type annotation is valid source,
      // not the parse error it was when every file was .mjs.
      ['a type annotation', 'const x: number = 1;\n', null],
      ['an obvious syntax error', 'export const = 1;\n', /Parse error|SyntaxError/],
      ['an unterminated function body', 'function f() {\n', /Parse error|SyntaxError/],
    ];
    const files = BUN_CORPUS.map(([, source], i) => {
      const file = join(dir, `bun-${i}.ts`);
      writeFileSync(file, source);
      return file;
    });
    const out = await checkSyntax(files, { cwd: dir });
    if (out.fastPassUnavailable === null) pass('checkSyntax parses in-process on Bun');
    else fail(`checkSyntax reported its Bun parse as unavailable: ${out.fastPassUnavailable}`);
    BUN_CORPUS.forEach(([label, , want], i) => {
      const err = out.errors[i];
      if (want === null) {
        if (err === null) pass(`${label}: accepted`);
        else fail(`${label}: rejected, but it parses (${String(err.message).slice(0, 120)})`);
      } else if (err !== null && want.test(String(err.message))) {
        pass(`${label}: rejected with a parse error`);
      } else {
        fail(`${label}: expected a parse error, got ${err === null ? 'accepted' : JSON.stringify(String(err.message).slice(0, 120))}`);
      }
    });
  } else {
  // ── 1 (Node). Equivalence over the corpus ──
  const files = CORPUS.map(([, source], i) => {
    const file = join(dir, `${String(i).padStart(2, '0')}.ts`);
    writeFileSync(file, source);
    return file;
  });
  const fast = await parseInOneProcess(files, { cwd: dir });
  // One at a time: this suite shares the machine with others, and fifty node
  // processes started at once would be the largest thing running on it.
  const slow = [];
  for (const f of files) slow.push(await nodeCheck(f, { cwd: dir }));

  if (fast.unavailable === null) {
    pass('the single-process pass runs on this node');
  } else {
    // Every assertion below would then compare `node --check` with nothing,
    // and "they agree" would be decided by the checker that did not run.
    fail(`the single-process pass did not run on this node (${process.version}): ${fast.unavailable}`);
  }

  CORPUS.forEach(([label, , expected], i) => {
    const fastOk = fast.parsed.has(i);
    const slowOk = slow[i] === null;
    if (fastOk !== slowOk) {
      fail(`${label}: the single-process pass ${say(fastOk)} it and node --check ${say(slowOk)} it`);
    } else if (expected !== null && slowOk !== (expected === 'accept')) {
      fail(`${label}: both checkers ${slowOk ? 'accept' : 'reject'} it, expected them to ${expected} it`);
    } else {
      pass(`${label}: both ${slowOk ? 'accept' : 'reject'}`);
    }
  });
  }

  // ── 2. The same agreement on the files the gate checks ──
  // Agreement, not "every file parses": another suite may be creating or
  // removing a file under the repository while this one runs, and a file that
  // is gone is rejected by both, which is still agreement. A file with a real
  // syntax error is section 1 of test-all.ts's to report.
  if (IS_BUN) {
    // No second checker to agree with: Bun.Transpiler IS the gate. Assert it
    // vouches for every repository file, which is the observation the
    // agreement test is a proxy for.
    const repoFiles = collectSourceFiles(ROOT);
    const out = await checkSyntax(repoFiles, { cwd: ROOT });
    const bad = repoFiles.filter((_, i) => out.errors[i] !== null).map((f) => f.slice(ROOT.length + 1));
    if (out.fastPassUnavailable !== null) fail(`the Bun parse did not run over the repository: ${out.fastPassUnavailable}`);
    else if (bad.length > 0) fail(`the Bun parse rejects ${bad.length} repository file(s): ${bad.slice(0, 5).join(', ')}`);
    else pass(`every repository file parses (${repoFiles.length} checked)`);
  } else {
    const repoFiles = collectSourceFiles(ROOT);
    const repoFast = await parseInOneProcess(repoFiles, { cwd: ROOT });
    const unvouched = repoFiles.filter((_, i) => !repoFast.parsed.has(i));
    const wronglyRejected = [];
    for (const f of unvouched) {
      if (await nodeCheck(f, { cwd: ROOT }) === null) wronglyRejected.push(f.slice(ROOT.length + 1));
    }
    if (repoFast.unavailable !== null) {
      fail(`the single-process pass did not run over the repository: ${repoFast.unavailable}`);
    } else if (wronglyRejected.length > 0) {
      fail(`the single-process pass rejects ${wronglyRejected.length} file(s) node --check accepts, so each costs a spawn on every run: ${wronglyRejected.join(', ')}`);
    } else {
      pass(`the single-process pass vouches for every repository file node --check accepts (${repoFiles.length - unvouched.length} of ${repoFiles.length})`);
    }
  }

  // ── 3. checkSyntax, and what happens when the fast pass cannot be believed ──
  const good = join(dir, 'good.ts');
  const broken = join(dir, 'broken.ts');
  const missing = join(dir, 'never-written.ts');
  writeFileSync(good, 'export const a = 1;\n');
  writeFileSync(broken, 'export const = 1;\n');
  const trio = [good, broken, missing];

  const expectVerdicts = (label, { errors }) => {
    if (errors.length === 3 && errors[0] === null && errors[1] !== null && errors[2] !== null) {
      pass(`${label}: the good file passes, the broken and the missing one do not`);
    } else {
      fail(`${label}: expected [ok, error, error], got [${errors.map((e) => (e === null ? 'ok' : 'error')).join(', ')}]`);
    }
  };

  const normal = await checkSyntax(trio, { cwd: dir });
  expectVerdicts('checkSyntax', normal);
  if (normal.fastPassUnavailable === null) pass('checkSyntax reports that the fast pass ran');
  else fail(`checkSyntax reports the fast pass as unavailable: ${normal.fastPassUnavailable}`);

  // The diagnostic a reader sees has to be node's own, naming the file, as it
  // was when every file went through `node --check`.
  const diagnostic = String(normal.errors[1]?.stderr ?? '');
  if (diagnostic.includes('SyntaxError') && diagnostic.includes('broken.ts')) {
    pass('a syntax error carries node --check\'s own diagnostic');
  } else {
    fail(`a syntax error should carry node --check's diagnostic, got: ${JSON.stringify(diagnostic.slice(0, 300))}`);
  }

  // Stand-ins for a child that is not the fast pass. `-e` makes node run the
  // given code and ignore the script path that follows it.
  const impostors = [
    ['a node that rejects the flag', ['--no-such-flag-for-syntax-check']],
    ['a node without vm.SourceTextModule', []],
    ['a child that prints something else', ['-e', 'console.log("all good")']],
    ['a child that vouches for a file it was not given', ['-e', 'console.log(JSON.stringify({ parsed: [0, 1, 2, 3] }))']],
    ['a child that answers with no list', ['-e', 'console.log(JSON.stringify({ parsed: "all" }))']],
    ['a child that exits without answering', ['-e', '0']],
  ];
  if (IS_BUN) {
    // These stand-ins exercise the Node path's child process. Bun parses
    // in-process, so there is no child to substitute; the equivalent property
    // (a parse that cannot run reports why) is covered by the Bun corpus above,
    // where checkSyntax must return fastPassUnavailable === null.
    console.log('  ⏭  node-child stand-ins — not applicable: Bun parses in-process');
  } else {
    for (const [label, nodeArgs] of impostors) {
      const out = await checkSyntax(trio, { cwd: dir, nodeArgs });
      expectVerdicts(label, out);
      if (typeof out.fastPassUnavailable === 'string' && out.fastPassUnavailable.length > 0) {
        pass(`${label}: reported as unavailable, with a reason`);
      } else {
        fail(`${label}: should be reported as unavailable, got ${JSON.stringify(out.fastPassUnavailable)}`);
      }
    }
  }

  // A node that cannot be started at all is an answer too, not a rejection
  // nobody is listening for.
  {
    const out = await parseInOneProcess(trio, { cwd: dir, node: join(dir, 'no-such-node') });
    if (out.parsed.size === 0 && typeof out.unavailable === 'string' && out.unavailable.length > 0) {
      pass('a node binary that cannot be started: nothing vouched for, with a reason');
    } else {
      fail(`a node binary that cannot be started should vouch for nothing, got ${out.parsed.size} file(s) and ${JSON.stringify(out.unavailable)}`);
    }
  }

  // Everything is parsed as a module. A CommonJS file would be judged by the
  // wrong grammar, so the list is refused instead of half-checked.
  try {
    await checkSyntax([good, join(dir, 'script.cjs')], { cwd: dir });
    fail('checkSyntax should refuse a file that is not .ts');
  } catch (err) {
    if (String(err?.message).includes('script.cjs')) pass('checkSyntax refuses a file that is not .ts, and names it');
    else fail(`checkSyntax refused a non-.ts file without naming it: ${err?.message}`);
  }

  // ── 4. Both gates use it ──
  for (const rel of ['test-all.ts', 'scripts/check-syntax.ts']) {
    const src = readFileSync(join(ROOT, rel), 'utf-8');
    if (/\bcheckSyntax\(/.test(src) && /from '[^']*syntax-check\.ts'/.test(src)) {
      pass(`${rel} checks syntax through packages/core/src/kernel/syntax-check.ts`);
    } else {
      fail(`${rel} should check syntax through checkSyntax() from packages/core/src/kernel/syntax-check.ts`);
    }
    // `--check` as the FIRST argument is a hand-rolled `node --check` spawn.
    // (`['packages/cli/src/commands/tracker/dedup-tracker.ts', '--check']` is a script's own flag and is fine.)
    if (/\[\s*['"]--check['"]\s*,/.test(src)) {
      fail(`${rel} spawns node --check itself; a second syntax gate is free to drift from the shared one`);
    } else {
      pass(`${rel} does not spawn node --check itself`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
