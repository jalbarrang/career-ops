// tests/bun-floor.test.ts
//
// The project's Bun floor (packages/core/src/kernel/bun-floor.ts) and every place that restates
// it. The transformation from the npm toolchain to Bun is only real if the
// declared floor, the CI floor step and the published scaffolder agree — a
// Renovate bump or a hand edit that moves one of them silently leaves the
// others promising compatibility nothing checks (#4801).
//
// These pin the verdict (whose failing branch can't be reached through doctor
// on a machine running a current Bun) and make each restatement fail loudly if
// it drifts from BUN_MIN.

import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.ts';
import { bunFloor, BUN_MIN, BUN_ENGINES } from '../packages/core/src/kernel/bun-floor.ts';

console.log('\n🔎 Bun floor (one number, every restatement in step)');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));
const floor = BUN_MIN.split('.').slice(0, 2).join('.');

// ── The verdict ──────────────────────────────────────────────────────
{
  ok(BUN_MIN === '1.4.3', 'the floor is 1.4.3, the release the toolchain is tested against');

  for (const v of ['1.0.0', '1.2.0', '1.4.0', '0.8.1']) {
    const r = bunFloor(v);
    ok(r.pass === false, `Bun ${v} fails the floor`);
    ok(r.label.includes(v) && r.label.includes(floor), `  and its label names both ${v} and ${floor}`);
    ok(Array.isArray(r.fix) && r.fix.length >= 1, '  and it offers a fix');
  }

  for (const v of ['1.4.3', '1.4.4', '1.5.0', '2.0.0', 'v1.4.3']) {
    ok(bunFloor(v).pass === true, `Bun ${v} passes the floor`);
  }

  for (const junk of ['', 'unknown', undefined, '1']) {
    const r = bunFloor(junk);
    ok(r.pass === false, `an unreadable version (${JSON.stringify(junk)}) fails closed instead of passing`);
  }
}

// ── Every restatement matches ────────────────────────────────────────
{
  const engines = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8')).engines?.bun;
  for (const rel of ['package.json', 'scaffolder/package.json']) {
    const got = engines(rel);
    ok(got === BUN_ENGINES, `${rel} engines.bun is "${BUN_ENGINES}" (found ${JSON.stringify(got)})`);
  }

  // The CI floor step. Exact on purpose: a bare major ('1') resolves to the
  // newest 1.x, so it would never run the declared floor.
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'test.yml'), 'utf8');
  const step = wf.match(/- name: Set up the Bun floor[^\n]*\n(?:[^\n]*\n){0,3}?\s*bun-version:\s*'([^']+)'/);
  ok(step !== null, 'test.yml has a "Set up the Bun floor" step with a bun-version');
  if (step) ok(step[1] === BUN_MIN, `test.yml's floor step runs Bun '${BUN_MIN}' (found '${step[1]}')`);
}
