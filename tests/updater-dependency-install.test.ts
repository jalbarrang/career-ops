/**
 * updater-dependency-install.test.ts — the updater's bun step, on apply and on rollback.
 *
 * Three properties:
 *
 *   1. A failed `bun install` is reported as a failure, with Bun's own reason.
 *      apply() printed "install skipped (may need manual run)" and then
 *      "Update complete", and the error output had already been thrown away.
 *   2. The install does only the install. package.json's postinstall downloads
 *      Chromium unless PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set, and both had to
 *      fit inside BUN_INSTALL_TIMEOUT_MS. The updater installs the browser
 *      itself right after, under PLAYWRIGHT_INSTALL_TIMEOUT_MS.
 *   3. rollback() reinstalls. It restores package.json from the backup branch,
 *      and node_modules kept whatever the update had installed.
 *
 * 1 and 2 drive the exported helpers through their exec seam. 3 runs the real
 * rollback CLI in a throwaway repository with `bun` and `bunx` shadowed on PATH
 * (a POSIX script and a .cmd, as in postinstall-script.test.ts), and checks
 * which package.json Bun saw. The apply() side runs end to end in
 * `upgrade-tests.ts --failed-install`.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUN_INSTALL_TIMEOUT_MS,
  PLAYWRIGHT_INSTALL_TIMEOUT_MS,
  UPDATE_APPLIED_INSTALL_FAILED_EXIT,
  installDependencies,
  refreshDependencies,
} from '../update-system.ts';
import { fail, makeUpdaterRepo, pass, rmSync } from './helpers.ts';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const updaterSource = readFileSync(join(ROOT, 'update-system.ts'), 'utf8');
// The updater reads its system-layer list from here (#5554); rollback refuses without it.
const manifestSource = readFileSync(join(ROOT, 'lib', 'update-manifest.ts'), 'utf8');

function check(condition, passMessage, failMessage) {
  if (condition) pass(passMessage);
  else fail(failMessage);
}

/** An exec double: records each call, and fails the commands `failures` names. */
function fakeExec(failures = {}) {
  const calls = [];
  const exec = (command, options) => {
    calls.push({ command, options });
    for (const [prefix, error] of Object.entries(failures)) {
      if (command.startsWith(prefix)) throw error;
    }
    return '';
  };
  return { exec, calls };
}

function commandFailure(stderr) {
  const err = new Error('Command failed: bun install');
  err.status = 1;
  err.stderr = stderr;
  return err;
}

console.log('\n🧪 Testing the updater dependency install (apply + rollback)...');

// ── 1. installDependencies: command, budget, browser skip ──
{
  const { exec, calls } = fakeExec();
  const result = installDependencies({ exec, root: '/fixture' });
  const [call] = calls;
  check(
    result.ok === true && calls.length === 1,
    'a successful bun install returns ok',
    `unexpected result ${JSON.stringify(result)} after ${calls.length} call(s)`,
  );
  check(
    call?.command === 'bun install',
    'bun install is run as-is, so Bun keeps printing its own errors',
    `bun install command was ${JSON.stringify(call?.command)}`,
  );
  check(
    call?.options.env?.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1',
    "bun install skips the postinstall's Chromium download",
    `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD was ${JSON.stringify(call?.options.env?.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD)}`,
  );
  check(
    call?.options.timeout === BUN_INSTALL_TIMEOUT_MS && call?.options.cwd === '/fixture',
    'bun install runs in the install root under BUN_INSTALL_TIMEOUT_MS',
    `bun install options were ${JSON.stringify({ cwd: call?.options.cwd, timeout: call?.options.timeout })}`,
  );
}

// ── 2. installDependencies: failures carry a reason ──
{
  const { exec } = fakeExec({
    'bun install': commandFailure('\nerror: GET https://registry.npmjs.org/js-yaml - getaddrinfo ENOTFOUND\n'),
  });
  const result = installDependencies({ exec, root: '/fixture' });
  check(
    result.ok === false && result.reason === 'error: GET https://registry.npmjs.org/js-yaml - getaddrinfo ENOTFOUND',
    "a failed bun install reports Bun's first error line",
    `failed install returned ${JSON.stringify(result)}`,
  );

  const timedOut = Object.assign(new Error('spawnSync /bin/sh ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' });
  const timeoutResult = installDependencies({ exec: fakeExec({ 'bun install': timedOut }).exec, root: '/fixture' });
  check(
    timeoutResult.ok === false
      && timeoutResult.reason.includes(`timed out after ${Math.round(BUN_INSTALL_TIMEOUT_MS / 1000)}s`)
      && timeoutResult.reason.includes('CAREER_OPS_BUN_INSTALL_TIMEOUT_MS'),
    'a timed-out bun install says so and names the variable that raises the budget',
    `timed-out install returned ${JSON.stringify(timeoutResult)}`,
  );

  const silent = installDependencies({ exec: fakeExec({ 'bun install': commandFailure('') }).exec, root: '/fixture' });
  check(
    silent.ok === false && silent.reason.startsWith('Command failed'),
    'a failure with no stderr still carries a reason',
    `stderr-less failure returned ${JSON.stringify(silent)}`,
  );
}

// ── 3. refreshDependencies: browser after the install, and only after a working one ──
{
  const dir = mkdtempSync(join(tmpdir(), 'co-deps-refresh-'));
  try {
    const none = fakeExec();
    check(
      refreshDependencies({ exec: none.exec, root: dir }).ok === true && none.calls.length === 0,
      'without a package.json there is nothing to install, and nothing runs',
      `ran ${JSON.stringify(none.calls.map((c) => c.command))} with no package.json`,
    );

    writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n');
    const ok = fakeExec();
    const okResult = refreshDependencies({ exec: ok.exec, root: dir });
    check(
      okResult.ok === true
        && ok.calls.length === 2
        && ok.calls[0].command === 'bun install'
        && ok.calls[1].command === 'bunx playwright install chromium'
        && ok.calls[1].options.timeout === PLAYWRIGHT_INSTALL_TIMEOUT_MS,
      'the browser is installed after bun install, under its own budget',
      `refresh ran ${JSON.stringify(ok.calls.map((c) => [c.command, c.options.timeout]))}`,
    );

    const installFails = fakeExec({ 'bun install': commandFailure('error: package not found\n') });
    const failed = refreshDependencies({ exec: installFails.exec, root: dir });
    check(
      failed.ok === false && failed.reason === 'error: package not found' && installFails.calls.length === 1,
      'a failed bun install is returned to the caller, and the browser step is skipped',
      `refresh after a failed bun install returned ${JSON.stringify(failed)} after ${installFails.calls.length} call(s)`,
    );

    const browserFails = fakeExec({ bunx: new Error('download failed') });
    check(
      refreshDependencies({ exec: browserFails.exec, root: dir }).ok === true,
      'a failed browser install does not fail the dependency step',
      'a failed browser install was reported as a failed bun install',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 4. apply() withholds "Update complete" over a failed install ──
{
  const applyStart = updaterSource.indexOf('\nasync function apply()');
  const applyEnd = updaterSource.indexOf('\n// ── DEPENDENCIES', applyStart);
  const applyBody = updaterSource.slice(applyStart, applyEnd);
  const refresh = applyBody.indexOf('refreshDependencies()');
  const guard = applyBody.indexOf('if (!dependencies.ok)');
  const complete = applyBody.indexOf('Update complete:');
  check(
    applyStart > 0 && refresh > 0 && guard > refresh && complete > guard
      && /if \(!dependencies\.ok\) \{[\s\S]*?process\.exitCode = UPDATE_APPLIED_INSTALL_FAILED_EXIT;\s*return;/.test(applyBody),
    'apply() checks the install result and exits with its own code before printing "Update complete"',
    'apply() no longer guards "Update complete" with the bun install result',
  );

  // The parent of the re-exec sees that code as "applied", not as a failure:
  // no "self-reexec failed", and no restore over the committed updater files.
  const parentCatch = applyBody.match(/\} catch \(err\) \{\s*([\s\S]*?)const timedOut = isTimeoutLikeError\(err\);/);
  check(
    UPDATE_APPLIED_INSTALL_FAILED_EXIT !== 0 && UPDATE_APPLIED_INSTALL_FAILED_EXIT !== 1
      && Boolean(parentCatch)
      && /if \(err\?\.status === UPDATE_APPLIED_INSTALL_FAILED_EXIT\) \{\s*process\.exitCode = UPDATE_APPLIED_INSTALL_FAILED_EXIT;\s*return;\s*\}/.test(parentCatch[1]),
    'the re-exec parent passes the applied-but-not-installed exit through before any restore',
    'the re-exec parent no longer recognizes the applied-but-not-installed exit code',
  );
}

// ── 5. Real rollback CLI reinstalls against the restored package.json ──

/** `bun` and `bunx` stand-ins. Bun copies the package.json it was run against. */
function writeStubs(stubDir, { installFails }) {
  mkdirSync(stubDir, { recursive: true });
  const saw = join(stubDir, 'bun-saw-package.json');
  const skip = join(stubDir, 'bun-skip-env');
  const bunxRan = join(stubDir, 'bunx-ran');
  writeFileSync(join(stubDir, 'bun'), [
    '#!/bin/sh',
    'case "$1" in install) ;; *) exit 0 ;; esac',
    `cp package.json "${saw}"`,
    `printf '%s' "$PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD" > "${skip}"`,
    ...(installFails ? ['echo "error: getaddrinfo ENOTFOUND registry.npmjs.org" >&2', 'exit 1'] : []),
    '',
  ].join('\n'));
  writeFileSync(join(stubDir, 'bun.cmd'), [
    `@copy /y package.json "${saw}" >nul`,
    // Redirection first: `echo 1> file` is cmd's "redirect handle 1", so the
    // value would never reach the file.
    `@> "${skip}" echo %PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD%`,
    ...(installFails ? ['@echo error: getaddrinfo ENOTFOUND registry.npmjs.org 1>&2', '@exit /b 1'] : []),
    '',
  ].join('\r\n'));
  writeFileSync(join(stubDir, 'bunx'), `#!/bin/sh\necho ran > "${bunxRan}"\n`);
  writeFileSync(join(stubDir, 'bunx.cmd'), `@echo ran> "${bunxRan}"\r\n`);
  chmodSync(join(stubDir, 'bun'), 0o755);
  chmodSync(join(stubDir, 'bunx'), 0o755);
  return { saw, skip, bunxRan };
}

function runRollback(dir, stubDir) {
  const env = { ...process.env, CAREER_OPS_GIT_TIMEOUT_MS: '10000' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  env[pathKey] = `${stubDir}${delimiter}${env[pathKey] || ''}`;
  const result = spawnSync(process.execPath, ['update-system.ts', 'rollback'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60_000,
    env,
  });
  return { ...result, output: `${result.stdout || ''}\n${result.stderr || ''}` };
}

const BACKUP_PACKAGE = '{\n  "name": "fixture",\n  "dependencies": { "js-yaml": "^4.1.1" }\n}\n';
const TARGET_PACKAGE = '{\n  "name": "fixture",\n  "dependencies": { "js-yaml": "^5.3.0" }\n}\n';

/** Backup commit, then an "update" that changes package.json, as apply() leaves it. */
function seedRepo(prefix) {
  const fixture = makeUpdaterRepo({ prefix });
  const { dir, g } = fixture;
  writeFileSync(join(dir, 'update-system.ts'), updaterSource);
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'update-manifest.ts'), manifestSource);
  writeFileSync(join(dir, 'package.json'), BACKUP_PACKAGE);
  g('add', '-A');
  g('commit', '-qm', 'backup state');
  g('branch', 'backup-pre-update-1.0.0-20260101T000000Z');
  writeFileSync(join(dir, 'package.json'), TARGET_PACKAGE);
  g('add', '-A');
  g('commit', '-qm', 'chore: auto-update system files to v1.1.0');
  return fixture;
}

const readOrNull = (path) => {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
};

{
  const { dir } = seedRepo('co-deps-rollback-ok-');
  const stubDir = join(dir, '.git', 'co-stubs');
  try {
    const { saw, skip, bunxRan } = writeStubs(stubDir, { installFails: false });
    const result = runRollback(dir, stubDir);
    check(
      result.status === 0 && result.output.includes('Rollback complete'),
      'rollback with a working bun install exits 0 and reports completion',
      `rollback exited ${result.status}: ${result.output.slice(-600)}`,
    );
    check(
      readOrNull(saw) === BACKUP_PACKAGE,
      'rollback runs bun install against the restored package.json',
      `bun saw ${JSON.stringify(readOrNull(saw))}, expected the backup's package.json`,
    );
    check(
      (readOrNull(skip) || '').trim() === '1' && existsSync(bunxRan),
      'rollback skips the postinstall download and installs the browser itself',
      `skip env ${JSON.stringify(readOrNull(skip))}, bunx ran: ${existsSync(bunxRan)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, g } = seedRepo('co-deps-rollback-fail-');
  const stubDir = join(dir, '.git', 'co-stubs');
  try {
    writeStubs(stubDir, { installFails: true });
    const result = runRollback(dir, stubDir);
    check(
      result.status === 1
        && result.output.includes('Rollback incomplete')
        && result.output.includes('error: getaddrinfo ENOTFOUND registry.npmjs.org')
        && result.output.includes('Run `bun install`')
        && !result.output.includes('Rollback complete'),
      'rollback with a failing bun install exits 1, gives Bun\'s reason and the command to run',
      `rollback exited ${result.status}: ${result.output.slice(-600)}`,
    );
    check(
      readOrNull(join(dir, 'package.json')) === BACKUP_PACKAGE
        && g('log', '-1', '--format=%s').startsWith('chore: rollback system files from backup-pre-update-1.0.0'),
      'a failed reinstall does not undo the restored and committed files',
      `package.json ${JSON.stringify(readOrNull(join(dir, 'package.json')))}, HEAD ${g('log', '-1', '--format=%s')}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
