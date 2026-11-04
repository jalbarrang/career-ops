/**
 * Applies the DDD/monorepo move plan: rewrites imports, moves files, and
 * rewrites path literals. Staged so each step can be inspected.
 *
 * Run: bun scripts/migration/apply.ts [--dry-run] [--step=imports|moves|literals]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ROOT, buildMap, resolveImport } from './plan.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const stepArg = args.find((a) => a.startsWith('--step='))?.slice('--step='.length);
const steps = stepArg ? new Set(stepArg.split(',')) : new Set(['imports', 'moves', 'literals']);

const map = buildMap();
const mapAbs = new Map<string, string>();
for (const [from, to] of map) mapAbs.set(join(ROOT, from), join(ROOT, to));

/** Extra docs that move with their directory. */
const EXTRA_MOVES: Record<string, string> = {
  'providers/README.md': 'packages/core/src/scanning/providers/README.md',
  'providers/ADDING_A_PROVIDER.md': 'packages/core/src/scanning/providers/ADDING_A_PROVIDER.md',
  'seeds/README.md': 'packages/core/src/scanning/seeds/README.md',
};
for (const [from, to] of Object.entries(EXTRA_MOVES)) map.set(from, to);

const newPathOf = (oldAbs: string): string => mapAbs.get(oldAbs) ?? oldAbs;

const SKIP_WALK = new Set(['node_modules', '.git', 'output', 'data', 'test-results', '.impeccable', '.career-ops-locks', '.career-ops-web']);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_WALK.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'dist' || name === 'build') continue;
      walkFiles(full, out);
    } else out.push(full);
  }
  return out;
}

const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.[^'"]+)\2/g;

/** Rewrite relative import specifiers in one file from old to new locations. */
function rewriteImports(file: string, oldPath: string, nextPath: string): boolean {
  const src = readFileSync(file, 'utf8');
  let changed = false;
  const out = src.replace(IMPORT_RE, (whole, prefix: string, quote: string, spec: string) => {
    const targetOld = resolveImport(oldPath, spec);
    if (!targetOld || !mapAbs.has(targetOld)) return whole;
    const targetNew = newPathOf(targetOld);
    let nextSpec = relative(dirname(nextPath), targetNew).split(sep).join('/');
    if (!nextSpec.startsWith('.')) nextSpec = './' + nextSpec;
    if (nextSpec === spec) return whole;
    changed = true;
    return `${prefix}${quote}${nextSpec}${quote}`;
  });
  if (changed && !dryRun) writeFileSync(file, out);
  return changed;
}

if (steps.has('imports')) {
  let count = 0;
  for (const file of walkFiles(ROOT)) {
    if (!file.endsWith('.ts') && !file.endsWith('.svelte')) continue;
    const oldPath = file;
    const nextPath = newPathOf(file);
    if (rewriteImports(file, oldPath, nextPath)) count++;
  }
  console.log(`imports: ${count} files rewritten${dryRun ? ' (dry run)' : ''}`);
}

if (steps.has('moves')) {
  let count = 0;
  for (const [from, to] of [...map.entries()].sort()) {
    const fromAbs = join(ROOT, from);
    const toAbs = join(ROOT, to);
    if (!existsSync(fromAbs)) {
      console.log(`skip (missing): ${from}`);
      continue;
    }
    if (existsSync(toAbs)) throw new Error(`destination exists: ${to}`);
    if (dryRun) {
      console.log(`mv ${from} -> ${to}`);
      count++;
      continue;
    }
    mkdirSync(dirname(toAbs), { recursive: true });
    try {
      execFileSync('git', ['mv', from, to], { cwd: ROOT, stdio: 'pipe' });
    } catch {
      renameSync(fromAbs, toAbs);
    }
    count++;
  }
  console.log(`moves: ${count} files${dryRun ? ' (dry run)' : ''}`);
}

// --- literal path rewriting -------------------------------------------------

/** Every path literal that names a moved file. */
const literals = [...map.entries()]
  .map(([from, to]) => ({ from, to }))
  .sort((a, b) => b.from.length - a.from.length);

/**
 * Rewrite path literals in `src`. Multi-argument joins (`join(ROOT, 'lib',
 * 'x.ts')`) are folded into the single new path.
 */
function rewriteLiterals(src: string): string {
  let out = src;
  for (const { from, to } of literals) {
    const segments = from.split('/');
    if (segments.length > 1) {
      // join(..., 'lib', 'x.ts') / 'lib/x.ts' as one literal
      const dir = segments.slice(0, -1).join('/');
      const name = segments.at(-1)!;
      const pair = new RegExp(
        `(['"])${escapeRe(dir)}\\1\\s*,\\s*(['"])${escapeRe(name)}\\2`,
        'g',
      );
      out = out.replace(pair, (_m, _q1: string, _q2: string) => `'${to}'`);
    }
    const re = new RegExp(`(?<![\\w./-])(?:\\./)?${escapeRe(from)}(?![\\w./-])`, 'g');
    out = out.replace(re, to);
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const LITERAL_FILES = /\.(ts|svelte|json|ya?ml|md|sh|html|toml)$/;
const DOC_DIRS = ['docs', '.github', 'modes', 'templates', 'batch', 'plugins', 'scripts'];

if (steps.has('literals')) {
  let count = 0;
  for (const file of walkFiles(ROOT)) {
    const rel = relative(ROOT, file);
    if (file.endsWith('plan.ts') || file.endsWith('apply.ts')) continue;
    const inDocDir = DOC_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
    const atRoot = !rel.includes('/');
    if (!LITERAL_FILES.test(file)) continue;
    if (!(atRoot || inDocDir || rel.startsWith('tests/'))) continue;
    // Never rewrite generated or user data.
    if (rel.startsWith('data/') || rel.startsWith('output/') || rel.startsWith('reports/')) continue;
    const before = readFileSync(file, 'utf8');
    const after = rewriteLiterals(before);
    if (after !== before) {
      count++;
      if (!dryRun) writeFileSync(file, after);
    }
  }
  console.log(`literals: ${count} files rewritten${dryRun ? ' (dry run)' : ''}`);
}

console.log(dryRun ? 'dry run complete' : 'apply complete');
