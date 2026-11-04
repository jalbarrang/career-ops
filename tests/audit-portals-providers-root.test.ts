// tests/audit-portals-providers-root.test.ts — audit-portals.ts loads its
// provider registry from the CHECKOUT, not from the user's data root (#4171).
//
// `providers/` is system layer: it ships with the code and never travels to a
// data root. Anchoring it to getCareerOpsRoot() worked only while the data root
// and the checkout were the same directory. Under the external-data-root layout
// (CAREER_OPS_ROOT / CAREER_OPS_DATA_DIR, or a `.career-ops-data` marker),
// loadProviders() read a directory that does not exist and returned an EMPTY
// registry — so audit-portals.ts, the script whose whole job is catching the
// silent "enabled but nothing scans it" state, reported `0 audited` and exited
// 0. A green run that audited nothing is the worst shape this failure can take.
//
// The two assertions are deliberately a pair: the registry must follow the code
// root, and portals.yml must still follow the data root. Moving both onto one
// anchor is how this broke, so over-correcting has to fail here too.
//
// Run:  bun test tests/audit-portals-providers-root.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadProviders } from '../providers/_registry.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Import audit-portals.ts with the data root pointed OUTSIDE the checkout and
 * report what it resolved, in a CHILD process.
 *
 * A cache-busting query string is not enough: Bun resolves `file:///x.ts?a` and
 * `file:///x.ts?b` to one module, so the second case reused the first case's
 * instance — which still pointed at the first (already deleted) temp root. A
 * child process is the isolation that actually holds on both runtimes, and it
 * is also the only way to set the environment before the module's anchors are
 * evaluated without mutating this process's env for later suits.
 *
 * @param {string} dataRoot
 * @param {string} expr - Statements run after `m` is imported; must print JSON.
 * @returns {any} The parsed JSON the child printed.
 */
function probeUnderDataRoot(dataRoot, expr) {
  const env = { ...process.env, CAREER_OPS_ROOT: dataRoot };
  delete env.CAREER_OPS_DATA_DIR;
  delete env.CAREER_OPS_PORTALS;
  const src = `const m = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'audit-portals.ts')).href)});\n${expr}`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], {
    cwd: ROOT, env, encoding: 'utf-8', timeout: 60_000,
  });
  if (r.status !== 0) throw new Error(`probe exited ${r.status}: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout.trim());
}

function fixture() {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-auditproviders-'));
  mkdirSync(join(dataRoot, 'data'), { recursive: true });
  writeFileSync(
    join(dataRoot, 'portals.yml'),
    ['job_boards: []', 'tracked_companies:', '  - name: Data Root Co', '    careers_url: https://job-boards.greenhouse.io/datarootco', '    enabled: true', ''].join('\n'),
    'utf-8',
  );
  return dataRoot;
}

test('the provider registry is loaded from the checkout under an external data root', async () => {
  const dataRoot = fixture();
  try {
    const providersDir = probeUnderDataRoot(dataRoot, 'console.log(JSON.stringify(m.PROVIDERS_DIR));');

    assert.equal(providersDir, join(ROOT, 'providers'), 'PROVIDERS_DIR must point at the checkout copy of providers/');
    assert.ok(!providersDir.startsWith(dataRoot), `PROVIDERS_DIR followed the data root: ${providersDir}`);

    const providers = await loadProviders(providersDir);
    assert.ok(providers.size > 0, 'the registry is empty, so every enabled board would be reported as no-provider');
  } finally {
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('portals.yml still follows the data root', async () => {
  const dataRoot = fixture();
  try {
    const names = probeUnderDataRoot(dataRoot, 'console.log(JSON.stringify(m.loadCompanies().map((c) => c.name)));');
    assert.deepEqual(
      names,
      ['Data Root Co'],
      'the default portals path must read the user data root, not the checkout',
    );
  } finally {
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
