// tests/verifiers-plugin-providers.test.ts — the scanner and every tool that
// builds its own provider map must resolve providers through the SAME path
// (#4026).
//
// packages/core/src/scanning/scan.ts folds enabled provider plugins into its map with
// mergeProviderPlugins(). packages/cli/src/commands/platform/verify-pipeline.ts and packages/core/src/scanning/verify-portals.ts did not,
// so a supported `provider: <plugin-id>` portals entry was reported as an
// "unknown provider" that "never scans" — while the scanner scanned it.
// packages/cli/src/commands/scanning/audit-portals.ts, packages/cli/src/commands/pipeline/coverage-check.ts and packages/cli/src/commands/platform/doctor.ts --strict build their own
// maps too and had the same gap. The divergence is the bug and it can reappear
// the moment a caller drifts, so it is pinned structurally (every builder must
// run the call) AND behaviorally (the real tools resolve an enabled plugin
// instead of flagging it).
import {
  readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync,
  readdirSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pass, fail, warn, linkNodeModules, stripJsComments, NODE } from './helpers.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('\nverifiers resolve provider plugins like the scanner (#4026)');

// A throwaway checkout that verify-pipeline/verify-portals run FROM, so the
// test never reads, writes, or deletes the developer's real files. Plugin code
// resolves from this CODE_ROOT while config/plugins.yml resolves from the
// separate Data Root, matching a split checkout. Copies the flat scripts plus
// the dirs the verifiers reach into (scaffolder/ for packages/cli/src/commands/platform/doctor.ts); node_modules
// is symlinked.
function prepareFixtureCodeRoot(tmp) {
  const codeRoot = join(tmp, 'code-root');
  mkdirSync(codeRoot, { recursive: true });
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (entry.isFile() && /\.(ts|cjs|json)$/.test(entry.name)) {
      mkdirSync(dirname(join(codeRoot, entry.name)), { recursive: true });
      cpSync(join(ROOT, entry.name), join(codeRoot, entry.name));
    }
  }
  // The engine lives under packages/ now; carry the whole tree so every verifier
  // resolves its imports from the fixture code root.
  for (const dir of ['packages', 'plugins', 'templates', 'batch', 'scaffolder']) {
    if (existsSync(join(ROOT, dir))) cpSync(join(ROOT, dir), join(codeRoot, dir), { recursive: true });
  }
  // Through the shared helper, so this site and the one in test-all.ts cannot
  // drift again: each had half of the pair (a guard here, the Windows junction
  // type there) and the halves are now one function.
  //
  // The reason used to be dropped, on the stated grounds that an absent tree
  // already failed two of this fixture's assertions. Two of four, measured: the
  // spawned verifier dies ERR_MODULE_NOT_FOUND, and the FIRST check reads that
  // crash output, finds no "unknown provider: apify" in it, and passes. It then
  // reports that packages/cli/src/commands/platform/verify-pipeline.ts resolves the plugin, about a run that never
  // reached the resolution code. A false green is the failure this whole file
  // exists to remove, so the reason is carried out and the caller skips on it.
  const depsReason = linkNodeModules(codeRoot, ROOT);
  return { codeRoot, depsReason };
}

const MINIMAL_TRACKER =
  '# Applications Tracker\n\n' +
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n' +
  '|---|------|---------|------|-------|--------|-----|--------|-------|\n' +
  '| 1 | 2026-01-05 | Northwind | Backend Engineer | 4.2/5 | Applied | ❌ | - | fixture |\n';

// ── 1. Structural: every provider-map builder runs mergeProviderPlugins ──
// packages/cli/src/commands/scanning/scan-ats-full.ts is not one of them on purpose: it scans boards derived
// from ATS datasets and tracker URLs, never a `provider:` portals entry.
{
  const callers = [
    'packages/core/src/scanning/scan.ts', 'packages/cli/src/commands/platform/verify-pipeline.ts', 'packages/core/src/scanning/verify-portals.ts',
    'packages/cli/src/commands/scanning/audit-portals.ts', 'packages/cli/src/commands/pipeline/coverage-check.ts', 'packages/cli/src/commands/platform/doctor.ts',
  ];
  const missing = callers.filter(
    (f) => !/\bmergeProviderPlugins\s*\(/.test(stripJsComments(readFileSync(join(ROOT, f), 'utf8'))),
  );
  if (missing.length === 0) {
    pass(`${callers.join(', ')} all run mergeProviderPlugins()`);
  } else {
    fail(`these provider-map builders skip mergeProviderPlugins() and will disagree with the scanner: ${missing.join(', ')}`);
  }
}

// ── 2. Behavioral: run the real verifiers against a portals entry using the
//    bundled `apify` plugin, enabled. Before the fix both printed
//    "unknown provider: apify"; after, apify resolves to an actionable
//    "missing env APIFY_TOKEN" stub. A minimal tracker is seeded so
//    verify-pipeline gets past its "no applications.md" early exit and actually
//    reaches the provider-resolution check. ──
providerFixture: {
  const tmp = mkdtempSync(join(tmpdir(), 'co-4026-'));
  try {
    const { codeRoot, depsReason } = prepareFixtureCodeRoot(tmp);
    if (depsReason) {
      // break, not return: this is a labeled block, and the finally below still
      // runs so the temp tree is removed.
      warn(`skipping the provider-resolution checks: ${depsReason}`);
      break providerFixture;
    }

    // packages/cli/src/commands/platform/verify-pipeline.ts resolves CAREER_OPS via getCareerOpsRoot() and, past
    // the tracker, mkdir's/reads real-looking data/reports paths under it
    // (line 54 `mkdirSync(join(CAREER_OPS, 'data'), ...)`). The spawn below
    // inherits the full process.env, so a developer's own CAREER_OPS_ROOT
    // would otherwise leak in and the check would touch their real checkout.
    const dataRoot = join(tmp, 'data-root');
    mkdirSync(join(dataRoot, 'config'), { recursive: true });
    writeFileSync(join(dataRoot, 'config', 'plugins.yml'), 'plugins:\n  apify: { enabled: true }\n');

    const tracker = join(tmp, 'applications.md');
    writeFileSync(tracker, MINIMAL_TRACKER);

    const portals = join(tmp, 'portals.yml');
    writeFileSync(portals,
      'tracked_companies:\n' +
      '  - name: "apify entry"\n    provider: apify\n    actor: x/y\n    enabled: true\n' +
      '  - name: "bogus entry"\n    provider: definitely-not-a-provider\n    enabled: true\n');

    const runVerifier = (script, extraArgs = []) => {
      try {
        return {
          out: execFileSync(NODE, [join(codeRoot, script), ...extraArgs], {
            cwd: codeRoot, encoding: 'utf8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              CAREER_OPS_ROOT: dataRoot,
              // Explicitly undefined (not omitted): a bare ...process.env
              // spread would otherwise leak the developer's own
              // CAREER_OPS_REPORTS in unchanged, and packages/cli/src/commands/platform/verify-pipeline.ts
              // resolves it as an absolute-or-relative-to-CAREER_OPS override
              // that wins over dataRoot entirely (CodeRabbit, #4046). An
              // undefined value drops the key from the child's env, so
              // packages/cli/src/commands/platform/verify-pipeline.ts falls back to its default, dataRoot/reports.
              CAREER_OPS_REPORTS: undefined,
              CAREER_OPS_PORTALS: portals,
              CAREER_OPS_TRACKER: tracker,
              APIFY_TOKEN: '',
            },
          }),
          code: 0,
        };
      } catch (e) {
        return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status ?? 1 };
      }
    };

    const pipeline = runVerifier('packages/cli/src/commands/platform/verify-pipeline.ts');
    if (/unknown provider:\s*apify/i.test(pipeline.out)) {
      fail(`packages/cli/src/commands/platform/verify-pipeline.ts still reports the enabled apify plugin as an unknown provider (exit ${pipeline.code})`);
    } else {
      pass('packages/cli/src/commands/platform/verify-pipeline.ts resolves an enabled `apify` plugin provider instead of "unknown provider"');
    }
    // Negative direction: a genuinely unknown id must STILL be flagged — the
    // fix must not turn the check into accept-everything.
    if (/unknown provider:\s*definitely-not-a-provider/i.test(pipeline.out)) {
      pass('packages/cli/src/commands/platform/verify-pipeline.ts still flags a genuinely unknown provider id');
    } else {
      fail('packages/cli/src/commands/platform/verify-pipeline.ts stopped flagging an unknown provider id — the resolution check is now too permissive');
    }

    const portalsRun = runVerifier('packages/core/src/scanning/verify-portals.ts', ['--file', portals]);
    if (/unknown provider:\s*apify/i.test(portalsRun.out)) {
      fail(`packages/core/src/scanning/verify-portals.ts still reports the enabled apify plugin as an unknown provider (exit ${portalsRun.code})`);
    } else if (/missing env APIFY_TOKEN/i.test(portalsRun.out)) {
      pass('packages/core/src/scanning/verify-portals.ts resolves `apify` to the actionable missing-env plugin stub');
    } else {
      fail(`packages/core/src/scanning/verify-portals.ts did not prove apify reached the missing-env plugin path (exit ${portalsRun.code})`);
    }

    // packages/cli/src/commands/scanning/audit-portals.ts: before the fix the apify entry audited as
    // `no-provider`; now it reaches the plugin stub and reports its error.
    const auditRun = runVerifier('packages/cli/src/commands/scanning/audit-portals.ts', ['--file', portals, '--json']);
    let auditRows = null;
    try { auditRows = JSON.parse(auditRun.out); } catch { /* reported below */ }
    const auditApify = Array.isArray(auditRows) ? auditRows.find((r) => r.name === 'apify entry') : null;
    const auditBogus = Array.isArray(auditRows) ? auditRows.find((r) => r.name === 'bogus entry') : null;
    if (auditApify?.provider === 'apify' && /missing env APIFY_TOKEN/i.test(auditApify.detail || '')) {
      pass('packages/cli/src/commands/scanning/audit-portals.ts resolves `apify` to the actionable missing-env plugin stub');
    } else {
      fail(`packages/cli/src/commands/scanning/audit-portals.ts did not resolve the apify plugin: ${JSON.stringify(auditApify) ?? auditRun.out.slice(0, 300)}`);
    }
    if (auditBogus && auditBogus.verdict !== 'ok' && auditBogus.provider !== 'definitely-not-a-provider') {
      pass('packages/cli/src/commands/scanning/audit-portals.ts still does not resolve a genuinely unknown provider id');
    } else {
      fail(`packages/cli/src/commands/scanning/audit-portals.ts resolved an unknown provider id: ${JSON.stringify(auditBogus)}`);
    }

    // packages/cli/src/commands/pipeline/coverage-check.ts: before the fix the same entry was diagnosed as
    // tracked-no-provider ("unknown provider: apify").
    const coverageRun = runVerifier('packages/cli/src/commands/pipeline/coverage-check.ts', [
      'https://example.com/jobs/1', '--company', 'apify entry', '--title', 'Backend Engineer', '--json',
    ]);
    let coverage = null;
    try { coverage = JSON.parse(coverageRun.out); } catch { /* reported below */ }
    const coverageEvidence = (coverage?.evidence || []).join(' | ');
    if (/provider: apify/.test(coverageEvidence) && !/unknown provider:\s*apify/i.test(coverageEvidence)) {
      pass('packages/cli/src/commands/pipeline/coverage-check.ts resolves an enabled `apify` plugin provider instead of "unknown provider"');
    } else {
      fail(`packages/cli/src/commands/pipeline/coverage-check.ts did not resolve the apify plugin (exit ${coverageRun.code}): ${coverageRun.out.slice(0, 300)}`);
    }
    // The plugin is enabled but has no token, so the scanner never reads the
    // board: the fix must say so rather than "newer than the last scan".
    if (/APIFY_TOKEN/.test(coverage?.fix || '')) {
      pass('packages/cli/src/commands/pipeline/coverage-check.ts names the missing APIFY_TOKEN in its fix for an inactive plugin provider');
    } else {
      fail(`packages/cli/src/commands/pipeline/coverage-check.ts fix does not name the inactive plugin's reason: ${JSON.stringify(coverage?.fix)}`);
    }

    // packages/cli/src/commands/platform/doctor.ts --strict probes portals.yml through its own provider map.
    // Before the fix the apify entry was skipped as unclaimed and doctor said
    // every entry resolves; now it reaches the stub, whose probe fails.
    const doctorRun = runVerifier('packages/cli/src/commands/platform/doctor.ts', ['--strict']);
    if (/1 portals\.yml entry do not resolve/i.test(doctorRun.out)) {
      pass('packages/cli/src/commands/platform/doctor.ts --strict reports the apify portal entry as unresolved instead of skipping it');
    } else {
      fail(`packages/cli/src/commands/platform/doctor.ts --strict did not report the apify portal entry (exit ${doctorRun.code}): ${doctorRun.out.slice(0, 600)}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
