// tests/openrouter-runner-429-reset.test.ts — a model's 429 count is reset
// when it answers, so only CONSECUTIVE 429s blacklist it.
//
// openrouter-runner.ts documents the rule ("auto-blacklist after 3 consecutive
// 429s") but rateLimitCounts[model] was only ever incremented. Three scattered
// 429s over a batch, with successful answers in between, blacklisted a model
// that was working, and the entry was persisted to data/model-blacklist.json for
// every later run.
//
// fetch() is scripted per model, so no network is used. The blacklist file is
// written under a throwaway data root.
//
// ── One child process per scenario ───────────────────────────────────────────
//
// The runner resolves its data root, model list and blacklist path at import
// time and keeps per-model counters at module scope, so each scenario needs its
// own module instance with its own environment. A cache-busting query string
// (`…openrouter-runner.ts?variant`) does that on Node but NOT on Bun, which
// resolves every `?query` spelling of a file URL to one module — the second
// scenario then ran against the first one's data root, and its assertions were
// about state no one had created. A child process is the isolation that holds on
// both runtimes.
//
// Run:  bun test tests/openrouter-runner-429-reset.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const MODEL_A = 'google/model-a:free';
const MODEL_B = 'qwen/model-b:free';

/**
 * A scripted fetch, serialized into the child. `script[model]` is the queue of
 * statuses that model returns; anything left over answers 200.
 *
 * @param {string[]} models
 * @param {Record<string, number[]>} script
 * @returns {string} JS source for the child.
 */
function scriptedFetchSource(models, script) {
  return `(() => {
    const queues = ${JSON.stringify(Object.fromEntries(Object.entries(script).map(([m, q]) => [m, [...q]])))};
    const models = ${JSON.stringify(models)};
    return async (url, init) => {
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: models.map((id) => ({ id, pricing: { prompt: '0', completion: '0' } })) }) };
      }
      const { model } = JSON.parse(init.body);
      const status = queues[model]?.shift() ?? 200;
      if (status !== 200) {
        return { ok: false, status, text: async () => (status === 429 ? 'rate limited' : 'server error') };
      }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'answer from ' + model } }], usage: {} }) };
    };
  })()`;
}

/**
 * Run one scenario in a child process and return everything the assertions need.
 *
 * @param {{label: string, models: string[], script: Record<string, number[]>, calls: number}} scenario
 * @returns {{outcomes: (string|null)[], snapshots: {counts: Record<string, number>, blacklisted: string[]}[], fileExists: boolean, fileContent: string|null}}
 */
function runScenario({ label, models, script, calls }) {
  const dataRoot = mkdtempSync(join(tmpdir(), 'career-ops-429-'));
  const driver = join(dataRoot, 'drive.ts');
  const runnerUrl = pathToFileURL(join(ROOT, 'openrouter-runner.ts')).href;
  const blacklistFile = join(dataRoot, 'data', 'model-blacklist.json');
  try {
    writeFileSync(driver, `
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
globalThis.fetch = ${scriptedFetchSource(models, script)};
const runner = await import(${JSON.stringify(runnerUrl)});
const outcomes = [];
const snapshots = [];
for (let i = 0; i < ${calls}; i++) {
  try { await runner.callOpenRouter('system', 'user'); outcomes.push(null); }
  catch (e) { outcomes.push(String(e.message)); }
  snapshots.push({
    counts: { ...runner.rateLimitCounts },
    blacklisted: [...runner.blacklistedModels],
    // Read after EVERY call: the "not blacklisted yet" assertions are about the
    // state before the third 429, which the final read cannot see.
    fileExists: existsSync(${JSON.stringify(blacklistFile)}),
  });
}
let fileContent = null;
if (existsSync(${JSON.stringify(blacklistFile)})) {
  try { fileContent = readFileSync(${JSON.stringify(blacklistFile)}, 'utf-8'); } catch { /* reported as exists */ }
}
console.log('__RESULT__' + JSON.stringify({
  outcomes,
  snapshots,
  fileExists: existsSync(${JSON.stringify(blacklistFile)}),
  fileContent,
}));
`);
    const env = {
      ...process.env,
      CAREER_OPS_ROOT: dataRoot,
      OPENROUTER_API_KEY: 'test-key',
    };
    delete env.CAREER_OPS_DATA_DIR;
    delete env.CAREER_OPS_MODEL;
    const r = spawnSync(process.execPath, [driver], { cwd: dataRoot, env, encoding: 'utf-8', timeout: 60_000 });
    if (r.status !== 0) throw new Error(outcomeLabel(label, r));
    const line = (r.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
    if (!line) throw new Error(outcomeLabel(label, r));
    return JSON.parse(line.slice('__RESULT__'.length));
  } finally {
    rmSync(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const outcomeLabel = (label, r) => `${label}: child exited ${r.status}\n${r.stdout || ''}\n${r.stderr || ''}`;

test('429, success, 429, success, 429 does not blacklist the model', () => {
  const { outcomes, snapshots, fileExists } = runScenario({
    label: 'scattered', models: [MODEL_A], script: { [MODEL_A]: [429, 200, 429, 200, 429] }, calls: 5,
  });
  assert.deepEqual(outcomes.map((o) => o === null), [false, true, false, true, false]);
  assert.deepEqual(snapshots.at(-1).blacklisted, [], 'three non-consecutive 429s blacklisted a working model');
  assert.equal(fileExists, false, 'the blacklist file was written');
});

test('three consecutive 429s still blacklist the model and persist it', () => {
  const { snapshots, fileExists, fileContent } = runScenario({
    label: 'consecutive', models: [MODEL_A], script: { [MODEL_A]: [429, 429, 429] }, calls: 3,
  });
  assert.deepEqual(snapshots[0].blacklisted, [], 'blacklisted before the third 429');
  assert.deepEqual(snapshots[1].blacklisted, [], 'blacklisted after two 429s');
  assert.equal(snapshots[1].fileExists, false, 'the blacklist file was written before the third 429');
  assert.deepEqual(snapshots[2].blacklisted, [MODEL_A]);
  assert.equal(fileExists, true);
  assert.deepEqual(JSON.parse(fileContent), [MODEL_A]);
});

test('429, 500, 429, 429 does not blacklist the model', () => {
  // The 500 breaks the run, so the last two 429s are only two in a row.
  const { outcomes, snapshots, fileExists } = runScenario({
    label: 'other-failure', models: [MODEL_A], script: { [MODEL_A]: [429, 500, 429, 429] }, calls: 4,
  });
  for (const outcome of outcomes) assert.notEqual(outcome, null, 'an error was expected on every call');
  assert.deepEqual(snapshots.at(-1).blacklisted, [], 'a 500 between 429s did not reset the count');
  assert.equal(fileExists, false, 'the blacklist file was written');
});

test('a 500 after two 429s resets the count to the next 429', () => {
  const { outcomes, snapshots, fileExists } = runScenario({
    label: 'reset-by-500', models: [MODEL_A], script: { [MODEL_A]: [429, 429, 500, 429] }, calls: 4,
  });
  for (const outcome of outcomes) assert.notEqual(outcome, null, 'an error was expected on every call');
  assert.equal(snapshots.at(-1).counts[MODEL_A], 1);
  assert.deepEqual(snapshots.at(-1).blacklisted, []);
  assert.equal(fileExists, false);
});

test('the 429 count is kept per model', () => {
  // A answers 429 twice; B answers 429 once and then succeeds. Three 429s in
  // total, but no single model reaches three.
  const { outcomes, snapshots, fileExists } = runScenario({
    label: 'per-model',
    models: [MODEL_A, MODEL_B],
    script: { [MODEL_A]: [429, 429], [MODEL_B]: [429] },
    calls: 2,
  });
  assert.notEqual(outcomes[0], null, 'both models answer 429 on the first call');
  assert.equal(outcomes[1], null, 'B answers on the second call');
  assert.equal(snapshots.at(-1).counts[MODEL_A], 2);
  assert.deepEqual(snapshots.at(-1).blacklisted, [], '429s on one model counted toward another');
  assert.equal(fileExists, false);
});
