// tests/scan-json-stdout.test.ts — packages/core/src/scanning/scan.ts must keep stdout clean so that
// --json output stays machine-parseable (issue #1906).
//
// packages/core/src/scanning/scan.ts loads dotenv at module top level. dotenv v17 prints a startup
// banner to stdout, gated on the `quiet` option rather than on isTTY, so it
// fires even when stdout is a pipe. packages/cli/src/commands/scanning/scan-ats-full.ts imports packages/core/src/scanning/scan.ts, which
// means the import alone is enough to put that banner on the stdout channel
// that --json reserves for a single JSON object. Consumers that accumulate
// stdout and JSON.parse it then fail on the leading banner.
//
// Both checks run packages/core/src/scanning/scan.ts in a child process: stdout has to be measured on a
// real pipe, and the parent's own stdout carries the suite log.
import { pass, fail, warn, run, NODE, ROOT } from './helpers.ts';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nscan.ts — --json stdout stays machine-parseable (#1906)');

try {
  const scanUrl = JSON.stringify(pathToFileURL(join(ROOT, 'packages/core/src/scanning/scan.ts')).href);

  // dotenv is an optional import in scan.ts. If it is not installed the
  // banner cannot fire and both checks below would pass without proving
  // anything, so say so rather than reporting a green that means nothing.
  const dotenvPresent = run(NODE, ['-e', 'await import("dotenv")']) !== null;

  if (!dotenvPresent) {
    warn('dotenv is not installed — cannot verify the stdout channel stays clean');
  } else {
    // Importing packages/core/src/scanning/scan.ts must be silent on stdout. packages/core/src/scanning/scan.ts guards its CLI
    // entry point, so the import runs module top level only.
    const importOut = run(NODE, ['-e', `await import(${scanUrl})`]);
    if (importOut === '') {
      pass('importing packages/core/src/scanning/scan.ts writes nothing to stdout');
    } else if (importOut === null) {
      fail('importing packages/core/src/scanning/scan.ts failed');
    } else {
      fail(`importing packages/core/src/scanning/scan.ts wrote to stdout: ${JSON.stringify(importOut.slice(0, 80))}`);
    }

    // The contract a --json consumer depends on: accumulate the child's stdout,
    // JSON.parse it, get the object back. Emitting the JSON after the import
    // reproduces the ordering that packages/cli/src/commands/scanning/scan-ats-full.ts --json produces.
    const jsonOut = run(NODE, [
      '-e',
      `await import(${scanUrl}); process.stdout.write(JSON.stringify({ date: '2026-01-01', offers: [] }));`,
    ]);
    if (jsonOut === null) {
      fail('child emitting JSON after importing packages/core/src/scanning/scan.ts failed');
    } else {
      try {
        const parsed = JSON.parse(jsonOut);
        if (parsed.date === '2026-01-01' && Array.isArray(parsed.offers)) {
          pass('stdout of a --json run parses as a single JSON object');
        } else {
          fail(`parsed stdout is not the emitted object: ${JSON.stringify(parsed).slice(0, 80)}`);
        }
      } catch (e) {
        fail(`stdout of a --json run does not parse as JSON: ${e.message}`);
      }
    }
  }
} catch (e) {
  fail(`scan --json stdout tests crashed: ${e.message}`);
}
