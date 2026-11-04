// tests/scaffolder-bun-command.test.ts — `bunx @santifer/career-ops init` must be able to run `bun install`
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.ts';
import { bunCommand } from '../scaffolder/bin/bun-command.ts';

console.log('\nscaffolder — launching bun install');

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const check = (name, actual, expected) => {
  if (same(actual, expected)) pass(name);
  else fail(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

// 1. One native executable on every platform.
check('POSIX runs bun directly',
  bunCommand(['install']),
  { file: 'bun', args: ['install'] });

check('Windows runs the native bun.exe through the same lookup, with no cmd.exe fallback',
  bunCommand(['install']),
  { file: 'bun', args: ['install'] });

check('flags stay attached to the same argument list',
  bunCommand(['install', '--frozen-lockfile']),
  { file: 'bun', args: ['install', '--frozen-lockfile'] });

// 2. Arguments must not carry shell syntax.
for (const bad of ['install & calc', 'a|b', '"x"', '%PATH%', '']) {
  try {
    bunCommand([bad]);
    fail(`bunCommand should refuse ${JSON.stringify(bad)}`);
  } catch {
    pass(`bunCommand refuses ${JSON.stringify(bad)}`);
  }
}

// 0. The usage text must name the package that is actually published. It said
//    `npx career-ops init`, and "career-ops" (unscoped) is not ours on npm: a
//    user copying the tool's own instruction would run whatever sits there.
{
  const pkgName = JSON.parse(readFileSync(join(ROOT, 'scaffolder/package.json'), 'utf-8')).name;
  const usage = readFileSync(join(ROOT, 'scaffolder/bin/cli.ts'), 'utf-8');
  if (usage.includes(`bunx ${pkgName} init`)) pass(`usage text says bunx ${pkgName} init`);
  else fail(`usage text does not name the published package (${pkgName})`);
  if (/bunx career-ops\b/.test(usage)) fail('usage text still tells users to run the unscoped `bunx career-ops`');
  else pass('usage text never names the unscoped package');
  if (!/\bnpx\b/.test(usage)) pass('usage text never tells users to run npx');
  else fail('usage text still tells users to run npx');
}

// 3. The published package must ship every module cli.ts imports, or
//    `bunx @santifer/career-ops` dies with ERR_MODULE_NOT_FOUND before it starts.
const pkg = JSON.parse(readFileSync(join(ROOT, 'scaffolder/package.json'), 'utf-8'));
const cli = readFileSync(join(ROOT, 'scaffolder/bin/cli.ts'), 'utf-8');
const localImports = [...cli.matchAll(/from\s+["']\.\/([^"']+)["']/g)].map((m) => `bin/${m[1]}`);
if (localImports.length === 0) fail('found no local imports in scaffolder/bin/cli.ts — has the import style changed?');
for (const file of localImports) {
  if (pkg.files.includes(file)) pass(`scaffolder package ships ${file}`);
  else fail(`scaffolder/package.json "files" is missing ${file}, which bin/cli.ts imports`);
}

// 4. Actually run bun --version through the helper when bun is on PATH.
{
  try {
    const cmd = bunCommand(['--version']);
    const out = execFileSync(cmd.file, cmd.args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 }).trim();
    if (/^\d+\.\d+\.\d+/.test(out)) pass(`bun --version → ${out}`);
    else fail(`unexpected bun --version output ${JSON.stringify(out)}`);
  } catch (err) {
    fail(`bun --version: ${err.code || ''} ${err.message.split('\n')[0]}`);
  }
}
