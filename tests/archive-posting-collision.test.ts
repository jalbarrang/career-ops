// Exercise actual capture writes without a browser or a network request.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
// The CJS `node:fs` exports object, not the ESM default import: on Bun those
// are different objects, and the fault cases below reassign fs.promises.open /
// fs.promises.unlink expecting packages/cli/src/commands/evaluation/archive-posting.ts to see the replacement.
const fs = createRequire(import.meta.url)('node:fs');
// packages/cli/src/commands/evaluation/archive-posting.ts imports `open`/`unlink` from `fs/promises`, which is its
// own module object; patching that one is what the code under test reads.
const fsp = createRequire(import.meta.url)('fs/promises');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pass, fail, ROOT } from './helpers.ts';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const root = mkdtempSync(join(tmpdir(), 'career-ops-capture-collision-'));
const previousRoot = process.env.CAREER_OPS_ROOT;
process.env.CAREER_OPS_ROOT = root;
const { archiveUrl } = await import('../packages/cli/src/commands/evaluation/archive-posting.ts?archive-posting-collision');
function browser() {
  return { async newContext() {
    let url;
    return { async route() {}, async close() {}, async newPage() {
      return { async goto(value) { url = value; return { status: () => 200 }; }, url() { return url; },
        async waitForTimeout() {}, async title() { return 'Engineer | Fictional'; }, async $eval() { return 'Engineer'; },
        async evaluate() { return 'Fictional engineering role with responsibilities and requirements. '.repeat(40); },
        async pdf() { return Buffer.from('%PDF-fixture ' + url); } };
    } };
  } };
}
function check(label, fn) { try { fn(); pass(label); } catch (e) { fail(`${label}: ${e.message}`); process.exitCode = 1; } }
const capture = url => archiveUrl(browser(), url, { company: 'Fictional', role: 'Engineer' });
const read = result => readFileSync(join(root, 'jds', result.filename), 'utf8');
try {
  const urls = [101, 202].map(n => `https://boards.greenhouse.io/fictional/jobs/${n}`);
  const first = await capture(urls[0]);
  const firstBytes = read(first);
  const second = await capture(urls[1]);
  check('distinct same-title postings retain independent captures', () => {
    assert.notEqual(first.filename, second.filename);
    assert.equal(read(first), firstBytes);
    assert.equal(read(second), '%PDF-fixture ' + urls[1]);
    assert.match(first.filename, /^\d{4}-\d{2}-\d{2}_fictional_engineer.*\.pdf$/);
  });
  const repeated = await capture(urls[0]);
  check('repeated URL preserves the earlier snapshot', () => {
    assert.notEqual(repeated.filename, first.filename);
    assert.equal(read(first), firstBytes);
    assert.equal(read(repeated), firstBytes);
  });
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => capture(urls[0])));
  check('concurrent writers reserve separate destinations without overwrite', () => {
    assert.equal(new Set(concurrent.map(r => r.filename)).size, 4);
    assert.equal(read(first), firstBytes);
    assert.equal(readdirSync(join(root, 'jds')).length, 7);
    for (const result of concurrent) assert.equal(read(result), firstBytes);
  });
  // The fault cases run in a CHILD, with `fs/promises` patched before
  // packages/cli/src/commands/evaluation/archive-posting.ts is imported. Patching it in this process is too late on
  // Bun: a builtin's named imports are bound when the importing module is
  // linked, so reassigning fsp.open afterwards leaves the already-loaded
  // archiveUrl calling the real one (Node re-links them; Bun does not).
  const runFaultCase = ({ writeFails, closeFails, unlinkFails }) => {
    const script = `
      const { mkdtempSync, readdirSync } = require('node:fs');
      const fsp = require('fs/promises');
      const { tmpdir } = require('node:os');
      const { join } = require('node:path');
      const root = process.env.CAREER_OPS_ROOT;
      const realOpen = fsp.open, realUnlink = fsp.unlink;
      let cleanupAttempts = 0;
      const writeError = new Error('injected write failure');
      const closeError = new Error('injected close failure');
      fsp.open = async (...args) => {
        const file = await realOpen(...args);
        return {
          async writeFile(buffer) {
            await file.writeFile(${writeFails} ? buffer.subarray(0, 4) : buffer);
            if (${writeFails}) throw writeError;
          },
          async close() {
            await file.close();
            if (${closeFails}) throw closeError;
          },
        };
      };
      fsp.unlink = async (path) => {
        cleanupAttempts++;
        if (${unlinkFails}) throw new Error('injected cleanup failure');
        return realUnlink(path);
      };
      const { archiveUrl } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'packages/cli/src/commands/evaluation/archive-posting.ts')).href)});
      const browser = ${browser.toString()};
      let errorMessage = null;
      try { await archiveUrl(browser(), 'https://boards.greenhouse.io/fictional/jobs/101', { company: 'Fictional', role: 'Engineer' }); }
      catch (err) { errorMessage = err.message; }
      console.log('__RES__' + JSON.stringify({ errorMessage, cleanupAttempts, files: readdirSync(join(root, 'jds')) }));
    `;
    const caseRoot = mkdtempSync(join(tmpdir(), 'career-ops-capture-fault-'));
    try {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        encoding: 'utf-8',
        timeout: 60_000,
        env: { ...process.env, CAREER_OPS_ROOT: caseRoot },
      });
      const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__RES__'));
      assert.ok(line, `fault child failed (exit ${r.status}): ${r.stderr || r.stdout}`);
      return JSON.parse(line.slice('__RES__'.length));
    } finally {
      rmSync(caseRoot, { recursive: true, force: true });
    }
  };
  for (const [label, writeFails, closeFails, unlinkFails] of [
    ['write failure removes the partial capture', true, false, false],
    ['close failure cannot mask a write failure or skip cleanup', true, true, false],
    ['close failure after writing removes the unconfirmed capture', false, true, false],
    ['cleanup failure preserves the original write error', true, false, true],
  ]) {
    check(label, () => {
      const res = runFaultCase({ writeFails, closeFails, unlinkFails });
      assert.equal(res.errorMessage, writeFails ? 'injected write failure' : 'injected close failure');
      assert.equal(res.cleanupAttempts, 1);
      if (!unlinkFails) assert.deepEqual(res.files, []);
    });
  }
} finally {
  if (previousRoot === undefined) delete process.env.CAREER_OPS_ROOT;
  else process.env.CAREER_OPS_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true, maxRetries: 10 });
}
