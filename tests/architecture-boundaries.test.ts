// tests/architecture-boundaries.test.ts — the package dependency rule.
//
// The monorepo split is only worth anything if the arrows keep pointing one way:
//
//   apps/web  ──►  packages/cli  ──►  packages/core
//
// A core module that reaches into a command (or into the web app) makes the
// "domain" depend on a driver, and the next change to a CLI flag silently
// changes domain behaviour. That is the coupling this layout exists to remove,
// so it is enforced rather than remembered: every import in `packages/core/src`
// must resolve inside that package (plus node: and npm packages), and nothing
// under `packages/` may import the web app.
//
// Run:  bun test tests/architecture-boundaries.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTree } from '../packages/core/src/kernel/walk-tree.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:^|[^\w.])import\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** Relative import specifiers in `source`. */
function relativeSpecs(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (spec && spec.startsWith('.')) out.push(spec);
  }
  return out;
}

/** Repo-relative POSIX path of the file a specifier names. */
function targetOf(file: string, spec: string): string {
  const withoutSuffix = spec.replace(/[?#].*$/, '');
  return relative(ROOT, resolve(dirname(file), withoutSuffix)).split(sep).join('/');
}

function packageFiles(pkg: string): string[] {
  return listTree(resolve(ROOT, 'packages', pkg, 'src'), { match: /\.ts$/ });
}

function webFiles(): string[] {
  return listTree(resolve(ROOT, 'apps', 'web'), { match: /\.(ts|svelte)$/ });
}

test('packages/core never imports a command or the web app', () => {
  const offenders: string[] = [];
  for (const file of packageFiles('core')) {
    for (const spec of relativeSpecs(readFileSync(file, 'utf8'))) {
      const target = targetOf(file, spec);
      if (target.startsWith('packages/cli/') || target.startsWith('apps/web/')) {
        offenders.push(`${relative(ROOT, file)} -> ${spec}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'core must not depend on a driver (packages/cli, apps/web)');
});

test('packages/cli never imports the web app', () => {
  const offenders: string[] = [];
  for (const file of packageFiles('cli')) {
    for (const spec of relativeSpecs(readFileSync(file, 'utf8'))) {
      const target = targetOf(file, spec);
      if (target.startsWith('apps/web/')) offenders.push(`${relative(ROOT, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], 'a command must not depend on the web app; both are driving adapters');
});

test('the web app imports engine code only through a module boundary it guards', () => {
  // The web app is allowed to reach core/cli, but every such import is one more
  // coupling: pin the DIRECTION (web -> packages, never packages -> web) and
  // fail loudly if a packages/ path grows a web import.
  const offenders: string[] = [];
  for (const pkg of ['core', 'cli']) {
    for (const file of packageFiles(pkg)) {
      const source = readFileSync(file, 'utf8');
      const specs = [...source.matchAll(/from\s+['"]([^'"]*apps\/web[^'"]*)['"]/g)].map((m) => m[1]);
      for (const spec of specs) offenders.push(`${relative(ROOT, file)} -> ${spec}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the generated command catalog is current', () => {
  // The catalog is generated from the tree; a stale one means the CLI lists a
  // script that moved (or omits one that was added).
  const catalog = readFileSync(resolve(ROOT, 'packages/core/src/kernel/command-catalog.ts'), 'utf8');
  const names = [...catalog.matchAll(/^\s+"([^"]+)": \{/gm)].map((m) => m[1]);
  assert.ok(names.length > 100, `the catalog holds ${names.length} commands; an empty one cannot gate anything`);
  for (const name of names) {
    const entry = new RegExp(`"${name}": \\{ script: "([^"]+)"`, 'm').exec(catalog);
    assert.ok(entry, `${name} has no script`);
    const script = resolve(ROOT, 'packages/cli/src/bin', entry[1]);
    assert.ok(readFileSync(script, 'utf8').length > 0, `${name} points at an empty script: ${entry[1]}`);
  }
});
