// tests/cli-flag-validation.test.ts — CLIs must reject a mistyped flag
// instead of answering from their defaults (#2980).
//
// The failure class packages/core/src/kernel/cli-flags.ts exists to end: an unrecognized flag is
// ignored, the value flag it was meant to be falls back to its default, and
// the script reports a result for inputs nobody asked for at exit 0. Already
// fixed in packages/cli/src/commands/scanning/scan-ats-full.ts (#1633/#1635), packages/cli/src/commands/outreach/reply-watch.ts (#2743/#2745),
// packages/cli/src/commands/tracker/dedup-tracker.ts (#2744/#2746), packages/core/src/scanning/scan.ts (#2270), packages/cli/src/commands/platform/doctor.ts (#2874),
// packages/cli/src/commands/scanning/fix-slugs.ts (#2980), and packages/cli/src/commands/evaluation/application-artifacts.ts (#2774).
//
// HERMETIC: paths use tmpdir fixtures; nothing reads or writes the real data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describeSpawn } from './helpers/describe-spawn.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// `env` overrides entries of the inherited environment; pass CAREER_OPS_ROOT
// here for any script that reads the tracker, so the child never touches the
// checkout's data/ (or whatever root the developer's env already points at).
function runScriptWithEnv(env, script, ...args) {
  const r = spawnSync(process.execPath, [join(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  assert.equal(r.error, undefined, `${script} failed to spawn: ${r.error?.message}`);
  assert.equal(r.signal, null, `${script} was killed by ${r.signal} (timeout?)`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function runScript(script, ...args) {
  return runScriptWithEnv({}, script, ...args);
}

// Each script paired with a realistic typo of one of ITS OWN flags
const SCRIPTS = [
  ['packages/cli/src/commands/scanning/fix-slugs.ts', '--dryrun'],
  ['packages/cli/src/commands/scanning/fix-slugs.ts', '--fle'],
  ['packages/cli/src/commands/outreach/linkedin-join.ts', '--csvv'],
  ['packages/cli/src/commands/outreach/linkedin-join.ts', '--sinse'],
  ['packages/cli/src/commands/evaluation/application-artifacts.ts', '--reprot'],
  ['packages/cli/src/commands/platform/clean-markers.ts', '--dryrun'],
  ['packages/cli/src/commands/tracker/normalize-statuses.ts', '--dryrun'],
  ['packages/cli/src/commands/cv/cv-sync-check.ts', '--hlep'],
  ['packages/cli/src/commands/scanning/scan-interamt.ts', '--dryrun'],
  ['packages/cli/src/commands/scanning/validate-portals.ts', '--fiel'],
  ['packages/cli/src/commands/scanning/validate-portals.ts', '--self-tst'],
  ['packages/core/src/scanning/verify-portals.ts', '--stict'],
  ['packages/core/src/scanning/verify-portals.ts', '--flie'],
];

for (const [script, typo] of SCRIPTS) {
  test(`${script} rejects ${typo} instead of falling back to its default`, () => {
    const r = runScript(script, typo, 'some-value');
    assert.equal(r.status, 1, `${script} ${typo} exited ${r.status}, want 1`);
    assert.match(r.all, /unrecognized flag/i, `${script} did not name the unrecognized flag`);
    assert.ok(r.all.includes(typo), `${script} did not echo ${typo} back`);
  });
}


test('packages/cli/src/commands/scanning/fix-slugs.ts --help exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--help');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/scanning/fix-slugs.ts --help exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/scanning/fix-slugs.ts --help printed no usage block');
});

test('packages/cli/src/commands/scanning/fix-slugs.ts -h exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '-h');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/scanning/fix-slugs.ts -h exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/scanning/fix-slugs.ts -h printed no usage block');
});

test('packages/cli/src/commands/scanning/fix-slugs.ts --help --bogus still errors', () => {
  const r = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--help', '--bogus');
  assert.equal(r.status, 1, `packages/cli/src/commands/scanning/fix-slugs.ts --help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});


test('packages/cli/src/commands/evaluation/application-artifacts.ts --help exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/evaluation/application-artifacts.ts', '--help');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/evaluation/application-artifacts.ts --help exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/evaluation/application-artifacts.ts --help printed no usage block');
});

test('packages/cli/src/commands/evaluation/application-artifacts.ts -h exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/evaluation/application-artifacts.ts', '-h');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/evaluation/application-artifacts.ts -h exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/evaluation/application-artifacts.ts -h printed no usage block');
});

test('packages/cli/src/commands/evaluation/application-artifacts.ts --help --bogus still errors', () => {
  const r = runScript('packages/cli/src/commands/evaluation/application-artifacts.ts', '--help', '--bogus');
  assert.equal(r.status, 1, `packages/cli/src/commands/evaluation/application-artifacts.ts --help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});

// --help must not reach the required-argument check: before #2774 the flag was
// swallowed by parseArgs's strict mode and reported as an unknown option.
test('packages/cli/src/commands/evaluation/application-artifacts.ts --help wins over the missing-required-args error', () => {
  const r = runScript('packages/cli/src/commands/evaluation/application-artifacts.ts', '--help');
  assert.doesNotMatch(r.all, /Unknown option/i, '--help was still treated as an unrecognized option');
});


test('packages/cli/src/commands/platform/clean-markers.ts --help exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/platform/clean-markers.ts', '--help');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/platform/clean-markers.ts --help exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/platform/clean-markers.ts --help printed no usage block');
  assert.doesNotMatch(r.all, /not found/i, '--help was still read as a filename');
});

test('packages/cli/src/commands/platform/clean-markers.ts -h exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/platform/clean-markers.ts', '-h');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/platform/clean-markers.ts -h exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/platform/clean-markers.ts -h printed no usage block');
});

test('packages/cli/src/commands/platform/clean-markers.ts --help --bogus still errors', () => {
  const r = runScript('packages/cli/src/commands/platform/clean-markers.ts', '--help', '--bogus');
  assert.equal(r.status, 1, `packages/cli/src/commands/platform/clean-markers.ts --help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});

// Exit 2 means no files were given and exit 1 means a file failed the audit.
// A pre-send gate needs both codes to stay distinct.
test('packages/cli/src/commands/platform/clean-markers.ts still exits 2 with usage when given no files', () => {
  const r = runScript('packages/cli/src/commands/platform/clean-markers.ts');
  assert.equal(r.status, 2, `no-args exited ${r.status}, want 2`);
  assert.match(r.all, /Usage:/i);
});

test('packages/cli/src/commands/platform/clean-markers.ts still accepts --ascii as a known flag', () => {
  const r = runScript('packages/cli/src/commands/platform/clean-markers.ts', 'clean', '--ascii', join(tmpdir(), 'career-ops-no-such-file.md'));
  assert.doesNotMatch(r.all, /unrecognized flag/i, '--ascii must not be rejected as unrecognized');
});

// The argument has to start with a dash for this to test anything, so the child
// runs inside the fixture dir and gets the bare relative name. An absolute path
// would begin with a slash and never reach the flag check.
test('packages/cli/src/commands/platform/clean-markers.ts audits a dash-leading path after --', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-clean-markers-'));
  try {
    writeFileSync(join(dir, '-draft.md'), 'plain text\n');
    const r = spawnSync(process.execPath, [join(ROOT, 'packages/cli/src/commands/platform/clean-markers.ts'), 'audit', '--', '-draft.md'], {
      cwd: dir, encoding: 'utf-8', timeout: 30_000,
    });
    const all = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    assert.equal(r.status, 0, describeSpawn(r, `dash-leading path exited ${r.status}, want 0`));
    assert.doesNotMatch(all, /unrecognized flag/i, '-draft.md must not be read as a flag after --');
    assert.match(all, /PASS/, 'the dash-leading path should have been audited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packages/cli/src/commands/platform/clean-markers.ts still rejects an unknown flag before --', () => {
  const r = runScript('packages/cli/src/commands/platform/clean-markers.ts', 'audit', '--dryrun', '--', 'x.md');
  assert.equal(r.status, 1, `unknown flag before -- exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag\(s\): --dryrun/);
});

test('fix-slugs rejects unknown flags before checking or reading portals file', () => {
  const r = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--file', join(tmpdir(), 'non-existent-portals.yml'), '--unknown-flag');
  assert.equal(r.status, 1);
  assert.match(r.all, /unrecognized flag\(s\): --unknown-flag/);
  assert.doesNotMatch(r.all, /no portals file at/i);
});

test('fix-slugs honours both --file <path> and --file=<path> syntax', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-fixslugs-flag-'));
  try {
    const customPortals = join(dir, 'custom.yml');
    const r1 = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--file', customPortals);
    assert.match(r1.all, new RegExp(`no portals file at ${customPortals.replace(/\\/g, '\\\\')}`));

    const r2 = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', `--file=${customPortals}`);
    assert.match(r2.all, new RegExp(`no portals file at ${customPortals.replace(/\\/g, '\\\\')}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fix-slugs rejects missing --file values (bare, empty, or next-is-flag)', () => {
  const rBare = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--file');
  assert.equal(rBare.status, 1, 'bare --file must exit 1');
  assert.match(rBare.all, /--file requires a value/);

  const rEmpty = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--file=');
  assert.equal(rEmpty.status, 1, '--file= must exit 1');
  assert.match(rEmpty.all, /--file requires a value/);

  const rFlag = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--file', '--fix');
  assert.equal(rFlag.status, 1, '--file --fix must exit 1 without treating --fix as a filename');
  assert.match(rFlag.all, /--file requires a value/);

  const rApply = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--file', '--apply');
  assert.equal(rApply.status, 1, '--file --apply must exit 1');
  assert.match(rApply.all, /--file requires a value/);

  const rDryRun = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--file', '--dry-run');
  assert.equal(rDryRun.status, 1, '--file --dry-run must exit 1');
  assert.match(rDryRun.all, /--file requires a value/);

  const rShortFlag = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--file', '-h');
  assert.equal(rShortFlag.status, 1, '--file -h must exit 1 without treating -h as a filename');
  assert.match(rShortFlag.all, /--file requires a value/);
  assert.doesNotMatch(rShortFlag.all, /no portals file at/i);

  const rShortFlagEq = runScript('packages/cli/src/commands/scanning/fix-slugs.ts', '--file=-h');
  assert.equal(rShortFlagEq.status, 1, '--file=-h must exit 1 without treating -h as a filename');
  assert.match(rShortFlagEq.all, /--file requires a value/);
  assert.doesNotMatch(rShortFlagEq.all, /no portals file at/i);
});

// --- analyze-patterns specific: numeric value flags must be strict ----------
for (const [form, args] of [
  ['space-separated', ['--min-threshold', 'abc']],
  ['negative', ['--min-threshold', '-5']],
  ['decimal', ['--min-threshold', '1.5']],
  ['extra characters', ['--min-threshold', '10abc']],
  ['unsafe integer', ['--min-threshold=9007199254740992']],
]) {
  test(`analyze-patterns rejects ${form} threshold values`, () => {
    const r = runScript('packages/cli/src/commands/insights/analyze-patterns.ts', ...args);
    assert.equal(r.status, 1, `exited ${r.status}, want 1`);
    assert.match(r.all, /--min-threshold requires a non-negative integer, got/);
  });
}

for (const [form, args] of [
  ['space-separated', ['--min-vendor-n', 'abc']],
  ['zero', ['--min-vendor-n', '0']],
  ['negative', ['--min-vendor-n=-1']],
  ['decimal', ['--min-vendor-n=1.5']],
  ['unsafe integer', ['--min-vendor-n', '9007199254740992']],
]) {
  test(`analyze-patterns rejects ${form} vendor sample values`, () => {
    const r = runScript('packages/cli/src/commands/insights/analyze-patterns.ts', ...args);
    assert.equal(r.status, 1, `exited ${r.status}, want 1`);
    assert.match(r.all, /--min-vendor-n requires a positive integer, got/);
  });
}

test('analyze-patterns rejects a trailing --min-threshold without an operand', () => {
  const r = runScript('packages/cli/src/commands/insights/analyze-patterns.ts', '--min-threshold');
  assert.equal(r.status, 1, `exited ${r.status}, want 1`);
  assert.match(r.all, /--min-threshold requires a value/);
});

test('analyze-patterns rejects a trailing --min-vendor-n without an operand', () => {
  const r = runScript('packages/cli/src/commands/insights/analyze-patterns.ts', '--min-vendor-n');
  assert.equal(r.status, 1, `exited ${r.status}, want 1`);
  assert.match(r.all, /--min-vendor-n requires a value/);
});


// --- missing operand for a RECOGNIZED value-taking flag (#3087) ------------
//
// A different defect than an unrecognized flag: the flag is spelled right,
// but nothing (or another flag) follows it, so flagValue()/indexOf() reads
// the wrong thing as the value and the script proceeds on it silently at
// exit 0 — packages/cli/src/commands/platform/doctor.ts diagnosing a directory literally named "--json" is the
// sharpest case. validateFlags's `requireOperand` option closes this for
// callers that opt in; each case below fails inside validateFlags itself,
// before any data/ access, so — like the --today/--summary case above — no
// fixture is needed.

test('doctor: --target --json does not diagnose a directory named "--json"', () => {
  const r = runScript('packages/cli/src/commands/platform/doctor.ts', '--target', '--json');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--target requires a value/);
});

test('detect-reposts: --window --summary does not silently fall back to the default window', () => {
  const r = runScript('packages/cli/src/commands/insights/detect-reposts.ts', '--window', '--summary');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--window requires a value/);
});

test('process-quality: --file --min-threshold does not read --min-threshold as a path', () => {
  const r = runScript('packages/cli/src/commands/outreach/process-quality.ts', '--file', '--min-threshold');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--file requires a value/);
});

test('process-quality: --min-threshold --summary does not silently fall back to threshold 1', () => {
  const r = runScript('packages/cli/src/commands/outreach/process-quality.ts', '--min-threshold', '--summary');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--min-threshold requires a value/);
});

test('weekly-digest: --dir --summary does not scan a directory named "--summary"', () => {
  const r = runScript('packages/cli/src/commands/interview/weekly-digest.ts', '--dir', '--summary');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--dir requires a value/);
});

test('upskill: --min-reports --summary does not silently fall back to 5 reports', () => {
  const r = runScript('packages/cli/src/commands/insights/upskill.ts', '--min-reports', '--summary');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--min-reports requires a value/);
});

test('upskill: --url-text --help reports the missing operand instead of printing usage at exit 0', () => {
  const r = runScript('packages/cli/src/commands/insights/upskill.ts', '--url-text', '--help');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--url-text requires a value/);
});

test('audit-portals: --help --bogus still reports the unrecognized flag', () => {
  const r = runScript('packages/cli/src/commands/scanning/audit-portals.ts', '--help', '--bogus');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /unrecognized flag\(s\): --bogus/);
});

test('audit-portals: --file --help reports the missing operand, not usage at exit 0', () => {
  const r = runScript('packages/cli/src/commands/scanning/audit-portals.ts', '--file', '--help');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--file requires a value/);
});

test('audit-portals: --company --strict does not audit every board instead of one', () => {
  const r = runScript('packages/cli/src/commands/scanning/audit-portals.ts', '--company', '--strict');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--company requires a value/);
});

test('audit-portals: a trailing --baseline does not silently skip the comparison', () => {
  const r = runScript('packages/cli/src/commands/scanning/audit-portals.ts', '--baseline');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--baseline requires a value/);
});

test('audit-portals: --help alone still prints usage and exits 0', () => {
  const r = runScript('packages/cli/src/commands/scanning/audit-portals.ts', '--help');
  assert.equal(r.status, 0, describeSpawn(r, `want exit 0, got ${r.status}`));
  assert.match(r.all, /Usage:/i);
});

// packages/cli/src/commands/evaluation/archive-posting.ts hand-rolls its own argv loop rather than going through
// validateFlags, so its --company/--role handling needed its own adjacency
// check (the same class of bug through a different door — see packages/cli/src/commands/evaluation/archive-posting.ts).
test('archive-posting: --company --pipeline does not set the company slug to "--pipeline"', () => {
  const r = runScript('packages/cli/src/commands/evaluation/archive-posting.ts', 'https://example.com/job', '--company', '--pipeline');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--company requires a value/);
});

test('archive-posting: --role --dry-run does not set the role slug to "--dry-run"', () => {
  const r = runScript('packages/cli/src/commands/evaluation/archive-posting.ts', 'https://example.com/job', '--role', '--dry-run');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--role requires a value/);
});

// packages/cli/src/commands/evaluation/application-artifacts.ts opts in rather than carrying its own guard, so
// every one of its value flags relies on requireOperand. `--report --help` is
// the shape that matters: without the option it printed usage at exit 0 and
// the malformed flag was never named.
test('packages/cli/src/commands/evaluation/application-artifacts.ts rejects a value flag with no operand', () => {
  for (const flag of ['--report', '--company', '--role', '--version', '--root']) {
    const r = runScript('packages/cli/src/commands/evaluation/application-artifacts.ts', flag);
    assert.equal(r.status, 1, `bare ${flag} exited ${r.status}, want 1`);
    assert.ok(r.all.includes(`${flag} requires a value`), `bare ${flag} was not reported`);
  }
});

test('application-artifacts: --report --help does not print usage at exit 0', () => {
  const r = runScript('packages/cli/src/commands/evaluation/application-artifacts.ts', '--report', '--help');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--report requires a value/);
});

test('application-artifacts: --report --company does not read "--company" as the value', () => {
  const r = runScript('packages/cli/src/commands/evaluation/application-artifacts.ts', '--report', '--company', 'Acme');
  assert.equal(r.status, 1, `want exit 1, got ${r.status}`);
  assert.match(r.all, /--report requires a value/);
});

// packages/cli/src/commands/outreach/linkedin-join.ts hand-rolled its argv before #3200 review, so `--csv=<path>`
// was discarded and the tool read the default export instead: a plausible
// report about a file nobody asked for, exit 0. The `=` form is the case a
// typo-only table would not catch.
test('packages/cli/src/commands/outreach/linkedin-join.ts honours the --flag=value form', () => {
  const r = runScript('packages/cli/src/commands/outreach/linkedin-join.ts', '--csv=/nonexistent/probe.csv', '--summary');
  assert.equal(r.status, 1, `exited ${r.status}, want 1`);
  assert.ok(r.all.includes('/nonexistent/probe.csv'),
    'the supplied path was discarded — the script fell back to its default export');
});

test('packages/cli/src/commands/outreach/linkedin-join.ts rejects a value flag with no operand', () => {
  const r = runScript('packages/cli/src/commands/outreach/linkedin-join.ts', '--csv', '--summary');
  assert.equal(r.status, 1, `exited ${r.status}, want 1`);
  assert.match(r.all, /--csv requires a value/i);
});

test('packages/cli/src/commands/outreach/linkedin-join.ts --help exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/outreach/linkedin-join.ts', '--help');
  assert.equal(r.status, 0, describeSpawn(r, `--help exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i);
});

test('packages/cli/src/commands/outreach/linkedin-join.ts --help --bogus still errors', () => {
  const r = runScript('packages/cli/src/commands/outreach/linkedin-join.ts', '--help', '--bogus');
  assert.equal(r.status, 1, `--help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});

// packages/cli/src/commands/tracker/normalize-statuses.ts rewrites applications.md, so a mistyped --dry-run used
// to be ignored and the tracker was edited at exit 0.
test('packages/cli/src/commands/tracker/normalize-statuses.ts --help exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/tracker/normalize-statuses.ts', '--help');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/tracker/normalize-statuses.ts --help exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/tracker/normalize-statuses.ts --help printed no usage block');
});

test('packages/cli/src/commands/tracker/normalize-statuses.ts -h exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/tracker/normalize-statuses.ts', '-h');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/tracker/normalize-statuses.ts -h exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/tracker/normalize-statuses.ts -h printed no usage block');
});

test('packages/cli/src/commands/tracker/normalize-statuses.ts rejects --bogus and lists the valid flags', () => {
  const r = runScript('packages/cli/src/commands/tracker/normalize-statuses.ts', '--bogus');
  assert.equal(r.status, 1, `packages/cli/src/commands/tracker/normalize-statuses.ts --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag\(s\): --bogus/i);
  assert.match(r.all, /--help, -h, --dry-run/, 'the valid flags were not listed');
});

test('packages/cli/src/commands/tracker/normalize-statuses.ts --help --bogus still errors', () => {
  const r = runScript('packages/cli/src/commands/tracker/normalize-statuses.ts', '--help', '--bogus');
  assert.equal(r.status, 1, `packages/cli/src/commands/tracker/normalize-statuses.ts --help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});

// --dry-run still READS and parses the tracker, and the module creates
// {root}/data/ on load, so the child gets its own CAREER_OPS_ROOT rather than
// whatever tracker the checkout (or an inherited CAREER_OPS_ROOT) points at.
// The fixture row carries a non-canonical status so the run has real work to do.
test('packages/cli/src/commands/tracker/normalize-statuses.ts still accepts --dry-run as a known flag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'career-ops-normalize-'));
  try {
    mkdirSync(join(dir, 'data'), { recursive: true });
    writeFileSync(join(dir, 'data', 'applications.md'), [
      '# Applications Tracker',
      '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
      '|---|------|---------|------|-------|--------|-----|--------|-------|',
      '| 1 | 2026-01-15 | Acme | Engineer | 4.2/5 | **Aplicado** | ✅ | [1](reports/001-acme-2026-01-15.md) | — |',
      '',
    ].join('\n'));

    const r = runScriptWithEnv(
      { CAREER_OPS_ROOT: dir, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '' },
      'packages/cli/src/commands/tracker/normalize-statuses.ts', '--dry-run',
    );
    assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/tracker/normalize-statuses.ts --dry-run exited ${r.status}, want 0`));
    assert.doesNotMatch(r.all, /unrecognized flag/i, '--dry-run must not be rejected as unrecognized');
    assert.doesNotMatch(r.all, /No applications\.md found/i, 'the fixture tracker was not the one read');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// packages/cli/src/commands/pipeline/rank-pipeline.ts read its flags with hasFlag/flagValue and never looked for
// one it did not know, so `--dryrun` did a live run and wrote annotations into
// data/pipeline.md, the one outcome --dry-run exists to prevent (#4600). These
// cases are not SCRIPTS rows: runScript inherits the real environment and
// checkout, and a regression here would re-rank the real pipeline through
// whatever agent CLI is installed. Each case gets a throwaway CAREER_OPS_ROOT,
// and CAREER_OPS_RANK_CLI names a binary that does not exist, so even a
// regressed run reaches no user data, no model and no network.
function runRankPipeline(root, ...args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'packages/cli/src/commands/pipeline/rank-pipeline.ts'), ...args], {
    cwd: root,
    encoding: 'utf-8',
    timeout: 30_000,
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_RANK_CLI: 'career-ops-no-such-cli' },
  });
  assert.equal(r.error, undefined, `packages/cli/src/commands/pipeline/rank-pipeline.ts failed to spawn: ${r.error?.message}`);
  assert.equal(r.signal, null, `packages/cli/src/commands/pipeline/rank-pipeline.ts was killed by ${r.signal} (timeout?)`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('packages/cli/src/commands/pipeline/rank-pipeline.ts rejects --dryrun instead of writing data/pipeline.md', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-rank-pipeline-'));
  try {
    mkdirSync(join(root, 'data'));
    const pipeline = join(root, 'data', 'pipeline.md');
    const before = '## Pending\n- [ ] https://x.test/1 | Acme | Backend Engineer\n';
    writeFileSync(pipeline, before);
    const r = runRankPipeline(root, '--dryrun');
    assert.equal(r.status, 1, `packages/cli/src/commands/pipeline/rank-pipeline.ts --dryrun exited ${r.status}, want 1`);
    assert.match(r.all, /unrecognized flag\(s\): --dryrun/, 'packages/cli/src/commands/pipeline/rank-pipeline.ts did not name --dryrun');
    assert.equal(readFileSync(pipeline, 'utf-8'), before, '--dryrun changed data/pipeline.md');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Its usage block has no `Usage:` header, so the synopsis line identifies it.
test('packages/cli/src/commands/pipeline/rank-pipeline.ts --help exits 0 and prints usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-rank-pipeline-'));
  try {
    const r = runRankPipeline(root, '--help');
    assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/pipeline/rank-pipeline.ts --help exited ${r.status}, want 0`));
    assert.match(r.all, /career-ops rank-pipeline \[--limit N\]/, 'packages/cli/src/commands/pipeline/rank-pipeline.ts --help printed no usage block');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// packages/cli/src/commands/tracker/merge-tracker.ts read every flag with process.argv.includes() and never
// looked for one it did not know, so `--dryrun` ran the real merge: it rewrote
// applications.md and moved the TSV into merged/, the outcome --dry-run exists
// to prevent. Like the rank-pipeline cases above these are not SCRIPTS rows: a
// regression would merge into whatever tracker the environment points at, so
// each case gets a throwaway tracker, additions dir, lock, index and reports dir.
function runMergeTracker(root, ...args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'packages/cli/src/commands/tracker/merge-tracker.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_TRACKER: join(root, 'applications.md'),
      CAREER_OPS_ADDITIONS: join(root, 'tracker-additions'),
      CAREER_OPS_TRACKER_LOCK: join(root, 'lock'),
      CAREER_OPS_TRACKER_DB: join(root, 'applications.db'),
      CAREER_OPS_REPORTS: join(root, 'reports'),
    },
  });
  assert.equal(r.error, undefined, `packages/cli/src/commands/tracker/merge-tracker.ts failed to spawn: ${r.error?.message}`);
  assert.equal(r.signal, null, `packages/cli/src/commands/tracker/merge-tracker.ts was killed by ${r.signal} (timeout?)`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('packages/cli/src/commands/tracker/merge-tracker.ts rejects --dryrun instead of merging into the tracker', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-merge-tracker-'));
  try {
    mkdirSync(join(root, 'tracker-additions'));
    mkdirSync(join(root, 'reports'));
    const tracker = join(root, 'applications.md');
    const before = '# Applications Tracker\n\n'
      + '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n'
      + '|---|------|---------|------|-------|--------|-----|--------|-------|\n'
      + '| 1 | 2026-01-01 | Acme | Engineer | 4.0/5 | Applied | ✅ | — | seed row |\n';
    writeFileSync(tracker, before);
    const tsv = join(root, 'tracker-additions', '2-globex.tsv');
    writeFileSync(tsv, '2\t2026-02-02\tGlobex\tManager\tApplied\tN/A\t✅\t—\tnew row\n');
    const r = runMergeTracker(root, '--dryrun');
    assert.equal(r.status, 1, `packages/cli/src/commands/tracker/merge-tracker.ts --dryrun exited ${r.status}, want 1`);
    assert.match(r.all, /unrecognized flag\(s\): --dryrun/, 'packages/cli/src/commands/tracker/merge-tracker.ts did not name --dryrun');
    assert.equal(readFileSync(tracker, 'utf-8'), before, '--dryrun changed applications.md');
    assert.equal(readFileSync(tsv, 'utf-8').startsWith('2\t'), true, '--dryrun moved the TSV out of tracker-additions');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('packages/cli/src/commands/tracker/merge-tracker.ts --help exits 0 and prints usage', () => {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-merge-tracker-'));
  try {
    const r = runMergeTracker(root, '--help');
    assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/tracker/merge-tracker.ts --help exited ${r.status}, want 0`));
    assert.match(r.all, /Usage: career-ops merge-tracker \[options\]/, 'packages/cli/src/commands/tracker/merge-tracker.ts --help printed no usage block');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// packages/cli/src/commands/cv/cv-sync-check.ts parsed no arguments before #3565, so a mistyped flag ran
// the whole check suite and the caller had no way to discover the right
// spelling. Its exit code is data-dependent (1 when cv.md is missing, which is
// the normal state of a checkout), so the flag paths are asserted on their own
// rather than through the bare-invocation expectation in test-all.ts.
test('packages/cli/src/commands/cv/cv-sync-check.ts --help exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/cv/cv-sync-check.ts', '--help');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/cv/cv-sync-check.ts --help exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/cv/cv-sync-check.ts --help printed no usage block');
  assert.doesNotMatch(r.all, /sync check/i, '--help still ran the checks');
});

test('packages/cli/src/commands/cv/cv-sync-check.ts -h exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/cv/cv-sync-check.ts', '-h');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/cv/cv-sync-check.ts -h exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/cv/cv-sync-check.ts -h printed no usage block');
});

test('packages/cli/src/commands/cv/cv-sync-check.ts --help --bogus still errors', () => {
  const r = runScript('packages/cli/src/commands/cv/cv-sync-check.ts', '--help', '--bogus');
  assert.equal(r.status, 1, `packages/cli/src/commands/cv/cv-sync-check.ts --help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});

// packages/cli/src/commands/scanning/scan-interamt.ts matched its flags with args.includes() before #4599, so
// --help, or --dryrun for --dry-run, started a live Playwright scan of
// interamt.de and appended the offers to data/pipeline.md. Every case here has
// to exit before main() launches a browser, which is what keeps them hermetic.
test('packages/cli/src/commands/scanning/scan-interamt.ts --help exits 0 and prints usage without scanning', () => {
  const r = runScript('packages/cli/src/commands/scanning/scan-interamt.ts', '--help');
  assert.equal(r.status, 0, describeSpawn(r, `packages/cli/src/commands/scanning/scan-interamt.ts --help exited ${r.status}, want 0`));
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/scanning/scan-interamt.ts --help printed no usage block');
  assert.match(r.all, /--debug/, 'packages/cli/src/commands/scanning/scan-interamt.ts --help does not list --debug');
  assert.doesNotMatch(r.all, /Searching "|Fatal:/, '--help still started a scan');
});

test('packages/cli/src/commands/scanning/scan-interamt.ts -h exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/scanning/scan-interamt.ts', '-h');
  assert.equal(r.status, 0, `packages/cli/src/commands/scanning/scan-interamt.ts -h exited ${r.status}, want 0`);
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/scanning/scan-interamt.ts -h printed no usage block');
});

test('packages/cli/src/commands/scanning/scan-interamt.ts --help --bogus still errors', () => {
  const r = runScript('packages/cli/src/commands/scanning/scan-interamt.ts', '--help', '--bogus');
  assert.equal(r.status, 1, `packages/cli/src/commands/scanning/scan-interamt.ts --help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});

// The missing-operand check predates #4599 and keeps its own wording.
for (const [form, args] of [
  ['a trailing --keyword', ['--keyword']],
  ['--keyword --help', ['--keyword', '--help']],
  ['--keyword --dry-run', ['--keyword', '--dry-run']],
  ['an empty --keyword=', ['--keyword=']],
]) {
  test(`packages/cli/src/commands/scanning/scan-interamt.ts rejects ${form} instead of scanning`, () => {
    const r = runScript('packages/cli/src/commands/scanning/scan-interamt.ts', ...args);
    assert.equal(r.status, 1, `packages/cli/src/commands/scanning/scan-interamt.ts ${args.join(' ')} exited ${r.status}, want 1`);
    assert.match(r.all, /--keyword requires a value/);
  });
}

// packages/cli/src/commands/scanning/validate-portals.ts read --self-test and --file with nothing else before
// #4601: there was no --help, and a mistyped flag was dropped, so
// `--fiel templates/portals.example.yml` validated the user's own portals.yml
// instead and exited 0 with its counts. The path on the first output line was
// the only hint that the named file was never read — the exact failure class
// packages/core/src/kernel/cli-flags.ts exists to end.
test('packages/cli/src/commands/scanning/validate-portals.ts --help exits 0 and prints usage without validating', () => {
  const r = runScript('packages/cli/src/commands/scanning/validate-portals.ts', '--help');
  assert.equal(r.status, 0, `packages/cli/src/commands/scanning/validate-portals.ts --help exited ${r.status}, want 0`);
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/scanning/validate-portals.ts --help printed no usage block');
  assert.match(r.all, /--self-test/, 'packages/cli/src/commands/scanning/validate-portals.ts --help does not list --self-test');
  assert.doesNotMatch(r.all, /errors, \d+ warnings/, '--help still ran the validation');
});

test('packages/cli/src/commands/scanning/validate-portals.ts -h exits 0 and prints usage', () => {
  const r = runScript('packages/cli/src/commands/scanning/validate-portals.ts', '-h');
  assert.equal(r.status, 0, `packages/cli/src/commands/scanning/validate-portals.ts -h exited ${r.status}, want 0`);
  assert.match(r.all, /Usage:/i, 'packages/cli/src/commands/scanning/validate-portals.ts -h printed no usage block');
});

test('packages/cli/src/commands/scanning/validate-portals.ts --help --bogus still errors', () => {
  const r = runScript('packages/cli/src/commands/scanning/validate-portals.ts', '--help', '--bogus');
  assert.equal(r.status, 1, `packages/cli/src/commands/scanning/validate-portals.ts --help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
});

// requireOperand: without it, `--file --self-test` reads --self-test as the
// file path (flagValue() returns args[idx+1] unconditionally), and a bare
// trailing --file reaches resolve('') — the current directory — which the
// reader then rejects with a raw filesystem error instead of a usage error.
// Same shape, same fix as packages/core/src/scanning/verify-portals.ts (#4250/#4254).
for (const [form, args] of [
  ['a trailing --file', ['--file']],
  ['--file --self-test', ['--file', '--self-test']],
  ['--file --help', ['--file', '--help']],
]) {
  test(`packages/cli/src/commands/scanning/validate-portals.ts rejects ${form} instead of validating`, () => {
    const r = runScript('packages/cli/src/commands/scanning/validate-portals.ts', ...args);
    assert.equal(r.status, 1, `packages/cli/src/commands/scanning/validate-portals.ts ${args.join(' ')} exited ${r.status}, want 1`);
    assert.match(r.all, /--file requires a value/);
    assert.doesNotMatch(r.all, /errors, \d+ warnings/, 'a missing operand still ran the validation');
  });
}

// An explicit but empty `--file=` is rejected as a missing operand by requireOperand (#5127).
test('packages/cli/src/commands/scanning/validate-portals.ts rejects an empty --file= as a missing operand', () => {
  const r = runScript('packages/cli/src/commands/scanning/validate-portals.ts', '--file=');
  assert.equal(r.status, 1, `packages/cli/src/commands/scanning/validate-portals.ts --file= exited ${r.status}, want 1`);
  assert.match(r.all, /--file requires a value/, 'the empty --file= must report a missing operand');
  assert.doesNotMatch(r.all, /unrecognized flag/i, '--file= must not read as an unrecognized flag');
});

// The two working paths test-all.ts already depends on, pinned here so the
// flag validation cannot regress them: --file must still accept its value in
// both spellings and exit 0 on the shipped example.
for (const [form, args] of [
  ['--file <path>', ['--file', 'templates/portals.example.yml']],
  ['--file=<path>', ['--file=templates/portals.example.yml']],
]) {
  test(`packages/cli/src/commands/scanning/validate-portals.ts still validates the example file with ${form}`, () => {
    const r = runScript('packages/cli/src/commands/scanning/validate-portals.ts', ...args);
    assert.equal(r.status, 0, `packages/cli/src/commands/scanning/validate-portals.ts ${args.join(' ')} exited ${r.status}, want 0`);
    assert.match(r.all, /portals\.example\.yml/, 'the named file was not the one read');
    assert.doesNotMatch(r.all, /unrecognized flag|requires a value/i);
  });
}

test('packages/cli/src/commands/scanning/validate-portals.ts --self-test still runs the self-test', () => {
  const r = runScript('packages/cli/src/commands/scanning/validate-portals.ts', '--self-test');
  assert.equal(r.status, 0, `packages/cli/src/commands/scanning/validate-portals.ts --self-test exited ${r.status}, want 0`);
  assert.doesNotMatch(r.all, /unrecognized flag|Usage:/i, '--self-test no longer reaches the self-test');
});
