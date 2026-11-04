// Data-root defaults must not depend on the caller's working directory.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, pass, fail } from './helpers.ts';
const root = mkdtempSync(join(tmpdir(), 'career-ops-artifact-root-'));
const data = join(root, 'data-root'), cwd = join(root, 'caller'), explicit = join(root, 'explicit'), code = join(root, 'code');
for (const dir of [data, cwd, code]) mkdirSync(dir);
const args = ['--report', '42', '--company', 'Fictional', '--role', 'Engineer', '--init'];
function check(label, fn) { try { fn(); pass(label); } catch (e) { fail(`${label}: ${e.message}`); process.exitCode = 1; } }
const run = (script, env, extra = []) => spawnSync(process.execPath, [script, ...args, ...extra], { cwd, env: { ...process.env, CAREER_OPS_ROOT: '', CAREER_OPS_DATA_DIR: '', ...env }, encoding: 'utf8' });
try {
  for (const variable of ['CAREER_OPS_ROOT', 'CAREER_OPS_DATA_DIR']) {
    const r = run(join(ROOT, 'packages/cli/src/commands/evaluation/application-artifacts.ts'), { [variable]: data });
    check(variable + ' selects the default output directory', () => {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(JSON.parse(r.stdout).root, join(data, 'output', '042-fictional-engineer'));
      assert.equal(existsSync(join(cwd, 'output')), false);
    });
  }
  const override = run(join(ROOT, 'packages/cli/src/commands/evaluation/application-artifacts.ts'), { CAREER_OPS_ROOT: data }, ['--root', explicit]);
  check('explicit CLI output root remains authoritative', () => {
    assert.equal(override.status, 0, override.stderr);
    assert.equal(JSON.parse(override.stdout).root, join(explicit, '042-fictional-engineer'));
  });
  // Marker tests use a copy; never overwrite the real checkout's marker.
  mkdirSync(dirname(join(code, 'packages/cli/src/commands/evaluation/application-artifacts.ts')), { recursive: true });
  cpSync(join(ROOT, 'packages/cli/src/commands/evaluation/application-artifacts.ts'), join(code, 'packages/cli/src/commands/evaluation/application-artifacts.ts'));
  mkdirSync(dirname(join(code, 'packages/core/src/kernel/path-resolver.ts')), { recursive: true });
  cpSync(join(ROOT, 'packages/core/src/kernel/path-resolver.ts'), join(code, 'packages/core/src/kernel/path-resolver.ts'));
  cpSync(join(ROOT, 'packages/core/src/kernel'), join(code, 'packages/core/src/kernel'), { recursive: true });
  writeFileSync(join(code, '.career-ops-data'), data);
  const marker = run(join(code, 'packages/cli/src/commands/evaluation/application-artifacts.ts'), {});
  check('the data marker controls defaults independently of cwd', () => {
    assert.equal(marker.status, 0, marker.stderr);
    assert.equal(JSON.parse(marker.stdout).root, join(data, 'output', '042-fictional-engineer'));
  });
  const { applicationArtifactPaths } = await import('../packages/cli/src/commands/evaluation/application-artifacts.ts');
  check('explicit function root remains authoritative', () => {
    assert.equal(applicationArtifactPaths({ reportNum: 42, company: 'Fictional', role: 'Engineer', root: explicit }).root, join(explicit, '042-fictional-engineer'));
  });
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 10 }); }
