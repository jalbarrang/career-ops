// tests/flag-equals-form-parity.test.ts — `--flag=value` must mean the same
// thing as `--flag value` in packages/cli/src/commands/platform/doctor.ts, packages/cli/src/commands/insights/upskill.ts and update-system.ts.
//
// packages/core/src/kernel/cli-flags.ts's validateFlags() accepts `--target=<path>` whenever
// `--target` is a declared value flag, but these scripts then read the value
// with `argv.indexOf('--flag')`, which cannot see the `=` form. The value was
// dropped and the default ran, at exit 0:
//   - `packages/cli/src/commands/platform/doctor.ts --target=<dir>` diagnosed the current checkout, not <dir>;
//   - `packages/cli/src/commands/insights/upskill.ts --url-text=<path>` ran the aggregate map instead;
//   - `packages/cli/src/commands/insights/upskill.ts --min-reports=3` used the default threshold of 5;
//   - `packages/cli/src/commands/platform/update-system.ts apply --channel=main` resolved to the release
//     channel, and `--channel=<typo>` skipped the unknown-channel error;
//   - `packages/cli/src/commands/platform/update-system.ts dismiss --version=X.Y.Z` dismissed the latest
//     release instead of the one named.
//
// Every case runs both spellings and asserts they agree, so a fix to one form
// that breaks the other fails here too. Synthetic data only, in a tmpdir.
//
// Auto-discovered by test-all.ts (tests/**/*.test.ts) and imported
// in-process, so it must never exit the process itself — only pass()/fail().
import { pass, fail, NODE, ROOT } from './helpers.ts';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolveTargetRef, dismiss } from '../packages/cli/src/commands/platform/update-system.ts';

console.log('\n🧪 Testing --flag=value parity (doctor, upskill, update-system)...');

const sandbox = mkdtempSync(join(tmpdir(), 'co-flag-equals-'));

/** Spawn a script with a sandboxed data root. */
function run(script, args, dataRoot) {
  const res = spawnSync(NODE, [join(ROOT, script), ...args], {
    cwd: ROOT, encoding: 'utf-8', timeout: 60000, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CAREER_OPS_ROOT: dataRoot, CAREER_OPS_DATA_DIR: '', CAREER_OPS_TRACKER: '', CAREER_OPS_CLI: 'claude' },
  });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const parseJson = (text) => { try { return JSON.parse(text); } catch { return null; } };

try {
  // ── packages/cli/src/commands/platform/doctor.ts --target ──────────────────────────────────────────────
  // The doctor starts with its data root on an EMPTY directory; the target
  // has cv.md. Only a target that is actually read drops cv.md from missing.
  {
    const startRoot = join(sandbox, 'doctor-start');
    const target = join(sandbox, 'doctor-target');
    mkdirSync(startRoot);
    mkdirSync(target);
    writeFileSync(join(target, 'cv.md'), '# Synthetic CV\n');

    const spaced = parseJson(run('packages/cli/src/commands/platform/doctor.ts', ['--json', '--target', target], startRoot).stdout);
    const equals = parseJson(run('packages/cli/src/commands/platform/doctor.ts', ['--json', `--target=${target}`], startRoot).stdout);
    if (spaced && !spaced.missing.includes('cv.md')) pass('doctor --target <dir> diagnoses <dir>');
    else fail(`doctor --target <dir> output: ${JSON.stringify(spaced)}`);
    if (equals && !equals.missing.includes('cv.md')) pass('doctor --target=<dir> diagnoses <dir>, not the starting root');
    else fail(`doctor --target=<dir> reported cv.md missing (read the wrong root): ${JSON.stringify(equals?.missing)}`);
  }

  // ── packages/cli/src/commands/platform/doctor.ts --cli ─────────────────────────────────────────────────
  // An unknown name surfaces as a warning naming it; a dropped value never does.
  {
    const root = join(sandbox, 'doctor-cli');
    mkdirSync(root);
    const bogus = 'not-a-real-cli';
    const spaced = run('packages/cli/src/commands/platform/doctor.ts', ['--json', '--cli', bogus], root);
    const equals = run('packages/cli/src/commands/platform/doctor.ts', ['--json', `--cli=${bogus}`], root);
    if (spaced.stdout.includes(`Unknown --cli \\"${bogus}\\"`)) pass('doctor --cli <name> reads the name');
    else fail(`doctor --cli <name> did not report the name: ${spaced.stdout.slice(0, 200)}`);
    if (equals.stdout.includes(`Unknown --cli \\"${bogus}\\"`)) pass('doctor --cli=<name> reads the name');
    else fail(`doctor --cli=<name> dropped the name: ${equals.stdout.slice(0, 200)}`);
  }

  // ── packages/cli/src/commands/insights/upskill.ts --min-reports ────────────────────────────────────────
  // An empty tracker always lands on "not enough data", which echoes the
  // threshold in effect.
  {
    const root = join(sandbox, 'upskill-root');
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(join(root, 'data', 'applications.md'),
      '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|\n');

    const spaced = parseJson(run('packages/cli/src/commands/insights/upskill.ts', ['--min-reports', '3'], root).stdout);
    const equals = parseJson(run('packages/cli/src/commands/insights/upskill.ts', ['--min-reports=3'], root).stdout);
    if (spaced?.threshold === 3) pass('upskill --min-reports 3 uses threshold 3');
    else fail(`upskill --min-reports 3 output: ${JSON.stringify(spaced)}`);
    if (equals?.threshold === 3) pass('upskill --min-reports=3 uses threshold 3, not the default');
    else fail(`upskill --min-reports=3 used threshold ${equals?.threshold}`);

    // ── packages/cli/src/commands/insights/upskill.ts --url-text ─────────────────────────────────────────
    // A missing file is the targeted branch's own Fatal: line; the aggregate
    // branch would instead print JSON at exit 0.
    const missing = join(sandbox, 'no-such-jd.txt');
    for (const [label, args] of [['--url-text <path>', ['--url-text', missing]], ['--url-text=<path>', [`--url-text=${missing}`]]]) {
      const res = run('packages/cli/src/commands/insights/upskill.ts', args, root);
      if (res.code === 1 && res.stderr.includes('Fatal:') && res.stderr.includes(missing) && res.stdout.trim() === '') {
        pass(`upskill ${label} runs the targeted branch`);
      } else {
        fail(`upskill ${label}: code=${res.code} stdout=${JSON.stringify(res.stdout.slice(0, 160))} stderr=${JSON.stringify(res.stderr.slice(0, 160))}`);
      }
    }
  }

  // ── packages/cli/src/commands/platform/update-system.ts --channel ──────────────────────────────────────
  {
    const curlGet = async () => JSON.stringify({ tag_name: 'career-ops-v1.32.0' });
    for (const args of [['apply', '--channel', 'main', '--confirm'], ['apply', '--channel=main', '--confirm']]) {
      const ref = await resolveTargetRef(args, {}, { curlGet });
      if (ref === 'main') pass(`resolveTargetRef(${args.join(' ')}) → main`);
      else fail(`resolveTargetRef(${args.join(' ')}) → ${ref}, expected main`);
    }
    for (const args of [['apply', '--channel', 'mian'], ['apply', '--channel=mian']]) {
      let threw = null;
      try { await resolveTargetRef(args, {}, { curlGet }); } catch (err) { threw = err; }
      if (threw && /Unknown --channel 'mian'/.test(threw.message)) pass(`resolveTargetRef(${args.join(' ')}) rejects the typo`);
      else fail(`resolveTargetRef(${args.join(' ')}) accepted an unknown channel`);
    }
    // The flag still wins over the re-exec'd child's env copy, in both forms.
    const viaEnv = await resolveTargetRef(['apply', '--channel=release'], { CAREER_OPS_UPDATE_CHANNEL: 'main' }, { curlGet });
    if (viaEnv === 'career-ops-v1.32.0') pass('--channel=release wins over CAREER_OPS_UPDATE_CHANNEL=main');
    else fail(`--channel=release with env main resolved to ${viaEnv}`);
  }

  // ── packages/cli/src/commands/platform/update-system.ts dismiss --version ──────────────────────────────
  {
    const quietly = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
    for (const args of [['dismiss', '--version', '1.34.0'], ['dismiss', '--version=1.34.0']]) {
      const root = mkdtempSync(join(sandbox, 'dismiss-'));
      let asked = 0;
      // The network would answer with a DIFFERENT release, so a dropped
      // --version shows up as 1.40.0 rather than passing by coincidence.
      const curlGet = async () => { asked++; return JSON.stringify({ tag_name: 'career-ops-v1.40.0' }); };
      await quietly(() => dismiss(args, { root, curlGet, now: () => new Date('2026-10-01T00:00:00Z') }));
      const written = JSON.parse(readFileSync(join(root, '.update-dismissed'), 'utf-8'));
      if (written.version === '1.34.0' && asked === 0) pass(`${args.join(' ')} dismisses 1.34.0 without asking the network`);
      else fail(`${args.join(' ')} wrote ${JSON.stringify(written)} (network asked ${asked}×)`);
    }
    let threw = null;
    try { await quietly(() => dismiss(['dismiss', '--version=latest'], { root: sandbox, curlGet: async () => null })); } catch (err) { threw = err; }
    if (threw && /X\.Y\.Z/.test(threw.message)) pass('dismiss --version=<non-version> refuses');
    else fail('dismiss --version=latest was accepted');
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10 });
}
