// tests/plugin-install-cli-flags.test.ts — plugin-install.ts must answer
// --help and reject an unrecognized flag instead of exiting 0 in silence.
//
// docs/SCRIPTS.md lists `bun plugin-install.ts` as a runnable command, but
// the file had no CLI tail at all: every direct invocation — `--help`, `-h`,
// a typo, a repo argument — printed nothing and exited 0. The same
// silent-success class lib/cli-flags.ts collects the fix for (#2775), and
// the shape stats.ts already uses.
//
// HERMETIC: every case fails inside the flag gate, so nothing clones, writes
// to plugins.local/, or touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeSpawn } from './helpers/describe-spawn.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function run(...args) {
  const r = spawnSync(process.execPath, [join(ROOT, 'plugin-install.ts'), ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  });
  assert.equal(r.error, undefined, `plugin-install.ts failed to spawn: ${r.error?.message}`);
  assert.equal(r.signal, null, `plugin-install.ts was killed by ${r.signal} (timeout?)`);
  return { ...r, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

test('plugin-install.ts --help exits 0 and prints usage', () => {
  const r = run('--help');
  assert.equal(r.status, 0, describeSpawn(r, `--help exited ${r.status}, want 0`));
  assert.match(r.stdout, /Usage:/, '--help printed no usage block');
});

test('plugin-install.ts -h exits 0 and prints usage', () => {
  const r = run('-h');
  assert.equal(r.status, 0, describeSpawn(r, `-h exited ${r.status}, want 0`));
  assert.match(r.stdout, /Usage:/, '-h printed no usage block');
});

test('plugin-install.ts rejects an unrecognized flag', () => {
  const r = run('--nonsense');
  assert.equal(r.status, 1, `--nonsense exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i, 'the unrecognized flag was not reported');
  assert.ok(r.all.includes('--nonsense'), 'the unrecognized flag was not echoed back');
});

// The ordering CodeRabbit caught on #2745/#2746: unknown-flag validation runs
// BEFORE --help short-circuits, or a typo alongside --help exits 0 unreported.
test('plugin-install.ts --help --bogus still errors', () => {
  const r = run('--help', '--bogus');
  assert.equal(r.status, 1, `--help --bogus exited ${r.status}, want 1`);
  assert.match(r.all, /unrecognized flag/i);
  assert.doesNotMatch(r.stdout, /Usage:/, '--help was honoured despite the unrecognized flag');
});

// An operand aimed at a command this file does not have (plugins.ts owns
// `add`/`new`) must not read as a silent success either.
test('plugin-install.ts rejects a stray operand and names plugins.ts', () => {
  const r = run('santifer/career-ops-plugin-example');
  assert.equal(r.status, 1, `a stray operand exited ${r.status}, want 1`);
  assert.match(r.stderr, /takes no arguments/i);
  assert.match(r.stderr, /plugins\.ts/, 'the error did not say where the commands live');
});

// The regression that matters most: plugins.ts imports this module, so the
// CLI tail must stay behind isMainModule and never fire on import.
test('importing plugin-install.ts runs no CLI tail', async () => {
  const mod = await import('../plugin-install.ts');
  assert.equal(typeof mod.installFromRepo, 'function');
  assert.equal(typeof mod.scaffoldNew, 'function');
  assert.equal(typeof mod.parseRepoArg, 'function');
  assert.equal(typeof mod.auditRegistryEntry, 'function');
  assert.equal(typeof mod.safeClone, 'function');
  assert.equal(typeof mod.validateInstall, 'function');
});
