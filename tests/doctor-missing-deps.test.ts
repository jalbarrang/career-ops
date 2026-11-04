/**
 * doctor-missing-deps.test.ts — doctor reports missing Bun dependencies
 * instead of crashing at import.
 *
 * packages/cli/src/commands/platform/doctor.ts is the first-run gate every agent runs, and it already has a
 * "Dependencies missing → bun install" check. It never got to run on a copy
 * with no node_modules: doctor imported js-yaml (through packages/core/src/kernel/yaml-document.ts)
 * and dotenv statically, and a static import of a missing package fails while
 * Node links the module graph, before any of doctor's code runs. The user got
 * an ERR_MODULE_NOT_FOUND stack trace from the onboarding check.
 *
 * The fixture copies packages/cli/src/commands/platform/doctor.ts and the local modules it imports, with no
 * node_modules anywhere above it. A second copy with node_modules linked is
 * the control: every module loads there, so the first run fails on the
 * packages and not on a module this test forgot to copy. The control asserts
 * only that loading succeeds; the data files doctor reads once it is running
 * are not copied, so a full run is not expected from it.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'fs';
import { spawnSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { pass, fail, NODE, ROOT, rmSync, linkNodeModules } from './helpers.ts';

console.log('\n🧪 Testing doctor with dependencies not installed...');

// packages/cli/src/commands/platform/doctor.ts plus every local module it reaches through a static import or a
// literal dynamic import(), and package.json, which the dependency check reads.
// The scan is textual, so it also sees example imports inside comments; those
// name files that do not exist and are skipped.
function doctorClosure() {
  const files = new Set(['package.json', 'packages/core/package.json']);
  const queue = [join(ROOT, 'packages/cli/src/commands/platform/doctor.ts')];
  while (queue.length) {
    const file = queue.pop();
    const rel = relative(ROOT, file);
    if (files.has(rel) || !existsSync(file)) continue;
    files.add(rel);
    const src = readFileSync(file, 'utf-8');
    for (const m of src.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      queue.push(resolve(dirname(file), m[1]));
    }
  }
  return [...files];
}

function makeCopy(withDeps) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'co-doctor-nodeps-')));
  for (const rel of doctorClosure()) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(ROOT, rel), join(dir, rel));
  }
  const linkReason = withDeps ? linkNodeModules(dir, ROOT) : null;
  return { dir, linkReason };
}

function runDoctor(dir) {
  // --no-install: Bun auto-installs a missing package from its global cache
  // when the runtime is the one starting the process, so without it the copy
  // with no node_modules would resolve `dotenv` from the cache and never reach
  // doctor's dependency message at all. The flag keeps this a real "nothing is
  // installed here" run; Node ignores an argument it does not know? It does
  // not, so it is passed only when the running runtime is Bun.
  const bunArgs = process.versions.bun ? ['--no-install'] : [];
  return spawnSync(NODE, [...bunArgs, 'packages/cli/src/commands/platform/doctor.ts', '--json'], {
    cwd: dir,
    encoding: 'utf-8',
    timeout: 60000,
    env: { ...process.env, CAREER_OPS_ROOT: dir, CAREER_OPS_DATA_DIR: '' },
  });
}

// ── 1. Control: with node_modules linked, every module in the copy loads ──
{
  const { dir, linkReason } = makeCopy(true);
  try {
    if (linkReason) {
      fail(`could not link node_modules into the control copy: ${linkReason}`);
    } else {
      const res = runDoctor(dir);
      if (!/ERR_MODULE_NOT_FOUND|dependencies are not installed/.test(res.stderr)) {
        pass('control: the copied tree loads when node_modules resolves');
      } else {
        fail(`control: the copied tree is missing a module: ${JSON.stringify(res.stderr.slice(0, 300))}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 2. No node_modules: a clear message, not a module-resolution crash ──
{
  const { dir } = makeCopy(false);
  try {
    const res = runDoctor(dir);
    if (res.status === 1) {
      pass('doctor exits 1 when its dependencies are not installed');
    } else {
      fail(`doctor exited ${res.status} with dependencies missing`);
    }
    if (/dependencies are not installed/.test(res.stderr) && res.stderr.includes('bun install') && res.stderr.includes('js-yaml')) {
      pass('doctor names the missing packages and the bun install fix');
    } else {
      fail(`doctor's message lacks the missing packages or the fix: ${JSON.stringify(res.stderr.slice(0, 300))}`);
    }
    if (!/ERR_MODULE_NOT_FOUND|node:internal/.test(res.stderr)) {
      pass('doctor prints no module-resolution stack trace');
    } else {
      fail(`doctor still crashed at import: ${JSON.stringify(res.stderr.slice(0, 300))}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
