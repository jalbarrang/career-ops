import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './helpers.ts';
import { describeCliFailure } from '../rank-pipeline.ts';

test('a CLI that fails every batch exits 1 with a one-line reason and no prompt echo', t => {
  const root = mkdtempSync(join(tmpdir(), 'rank-fail-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'cv.md'), '# Jordan Rivera\n\nFICTIONAL-CV-MARKER senior engineer\n');
  const pipeline = join(root, 'data', 'pipeline.md');
  const original = Array.from({ length: 12 }, (_, i) => `- [ ] https://example.test/${i} | Example | Engineer`).join('\n') + '\n';
  writeFileSync(pipeline, original);
  // A stub `claude` that exits 1 with a SyntaxError line: an offline stand-in
  // for a CLI whose login has expired. It is named `claude` rather than pointed
  // at the runtime directly because each CLI gets its own argv shape, and
  // `bun -p` is `--package` (the bunx flag), not "print/evaluate" — using the
  // runtime as the failing binary fails for an unrelated reason.
  const stubDir = join(root, 'bin');
  mkdirSync(stubDir, { recursive: true });
  const stub = join(stubDir, 'claude');
  writeFileSync(stub, '#!/bin/sh\necho "SyntaxError: unexpected token < in JSON" >&2\nexit 1\n');
  chmodSync(stub, 0o755);
  writeFileSync(join(stubDir, 'claude.cmd'), '@echo SyntaxError: unexpected token 1>&2\r\n@exit /b 1\r\n');
  const result = spawnSync(process.execPath, [join(ROOT, 'rank-pipeline.ts'), '--cli', 'claude'], {
    env: {
      ...process.env,
      CAREER_OPS_ROOT: root,
      CAREER_OPS_DATA_DIR: root,
      PATH: `${stubDir}${delimiter}${process.env.PATH}`,
    },
    encoding: 'utf8', timeout: 30_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.doesNotMatch(result.stderr, /FICTIONAL-CV-MARKER/);
  assert.doesNotMatch(result.stderr, /Command failed/);
  assert.equal(result.stderr.match(/CLI call failed \(.* exited with code 1: SyntaxError/g)?.length, 2, result.stderr);
  assert.match(result.stderr, /Every call to .* failed/);
  assert.equal(readFileSync(pipeline, 'utf8'), original);
});

test('describeCliFailure picks the error line and strips color codes', () => {
  const err = { status: 1, stderr: '\x1b[0m\n> build · some-model\n\x1b[0m\n\x1b[91m\x1b[1mError: \x1b[0mAPI key expired.\n', message: 'Command failed: opencode run SECRET PROMPT' };
  assert.equal(describeCliFailure(err, 'opencode'), 'opencode exited with code 1: Error: API key expired.');
  assert.equal(describeCliFailure({ code: 'ETIMEDOUT', message: 'spawnSync opencode ETIMEDOUT' }, 'opencode'), 'opencode timed out');
  assert.equal(describeCliFailure({ status: 2, stderr: '' }, 'codex'), 'codex exited with code 2');
});
