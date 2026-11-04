// The follow-ups lock exists to stop a LOST UPDATE, so the test has to produce one.
//
// data/follow-ups.md is read-modify-written from two directions: the web's
// log/override routes and the core's cadence seeder (packages/core/src/outreach/followup-seed.ts). Each
// writer reads the whole file, adds its own line, and writes the whole file
// back. Unserialized, two overlapping writers each start from the same snapshot
// and the second's full-file write discards the first's line — no error, a
// well-formed file, one pin silently gone (the same shape as the tracker, #2900).
//
// This asserts the failure FIRST (unlocked writers lose data) and then that the
// core lock removes it. Without the negative half, a lock that never engaged
// would pass just as happily. Verified red by hand: swap withFollowupsLock for a
// passthrough and the "both survive" assertion fails.
//
// Run:  bun test tests/lib/followups-lock.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolved from this file, not the cwd: test-all.ts runs these suites from the
// repo root, where `cwd/..` points outside the checkout and every core case
// would skip as "not resolvable" while reporting green.
const CORE =
  process.env.CAREER_OPS_ROOT ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const coreSeed = path.join(CORE, "packages/core/src/outreach/followup-seed.ts");

// The guard has to answer "can this be imported", not "is the file there".
// packages/core/src/outreach/followup-seed.ts imports js-yaml, so a web-only install (web-ci.yml runs
// `bun install --frozen-lockfile` in web/ alone) has the file and not its dependencies; existsSync
// would call that runnable and the cases would fail on ERR_MODULE_NOT_FOUND
// instead of skipping (mirrors tracker-lock.test.ts / #2922).
/** The one entry this suite needs from the core's followup-seed.ts. */
interface FollowupSeedModule {
  withFollowupsLock: <T>(
    file: string,
    fn: () => T | Promise<T>,
    options: { timeoutMs: number; retryMs: number },
  ) => Promise<T>;
}

let core: FollowupSeedModule | null = null;
/** False when the core is importable; otherwise why these cases skip. */
let skipCore: string | false = false;
try {
  core = (await import(pathToFileURL(coreSeed).href)) as FollowupSeedModule;
} catch (err) {
  const info = err as { code?: string; url?: string | null };
  const coreAbsent = !fs.existsSync(coreSeed);
  const packageUnresolvable = info.url == null;
  const depsAbsent = !fs.existsSync(path.join(CORE, "node_modules"));
  if (info.code !== "ERR_MODULE_NOT_FOUND") throw err;
  if (coreAbsent) skipCore = `no core checkout at ${CORE}`;
  else if (packageUnresolvable && depsAbsent) skipCore = `core dependencies are not installed at ${CORE} (web-only checkout)`;
  else throw err;
}

function makeFollowups(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flwlock-"));
  const file = path.join(root, "follow-ups.md");
  fs.writeFileSync(file, "# Follow-ups\n\n");
  return { root, file };
}

/** The override route's read-modify-write, verbatim in shape: read the whole
 *  file, add THIS app's pin, write the whole file back. The pause widens the
 *  read→write window so two callers reliably overlap. */
function addPin(file: string, appNum: number, date: string, pauseMs: number): Promise<void> {
  const existing = fs.readFileSync(file, "utf8");
  return new Promise<void>((resolve) => setTimeout(() => {
    const base = existing.endsWith("\n") ? existing : existing + "\n";
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, base + `- next #${appNum} ${date} (set ${date})\n`);
    fs.renameSync(tmp, file);
    resolve();
  }, pauseMs));
}

const pinCount = (file: string): number =>
  fs.readFileSync(file, "utf8").split("\n").filter((l) => /^- next #\d+ /.test(l)).length;

test("WITHOUT a lock, two concurrent pin writers lose one update silently", async () => {
  const { root, file } = makeFollowups();
  try {
    await Promise.all([addPin(file, 1, "2026-07-10", 60), addPin(file, 2, "2026-07-11", 10)]);
    // The bug: no error, file well-formed, only the last writer's pin remains.
    assert.equal(pinCount(file), 1, "expected the classic lost update to reproduce");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("WITH the core lock, both pins survive", { skip: skipCore }, async () => {
  const { root, file } = makeFollowups();
  const guarded = (appNum: number, date: string, pauseMs: number): Promise<void> =>
    core!.withFollowupsLock(file, () => addPin(file, appNum, date, pauseMs), { timeoutMs: 5_000, retryMs: 25 });
  try {
    await Promise.all([guarded(1, "2026-07-10", 60), guarded(2, "2026-07-11", 10)]);
    assert.equal(pinCount(file), 2, "a pin was lost even under the lock");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the lock is released on a throwing path, not just the happy one", { skip: skipCore }, async () => {
  // A leaked lock on a long-lived server is worse than the bug: the holder's pid
  // stays alive, so the core's stale-recovery will not reclaim it and the user's
  // own CLI is locked out until staleMs.
  const { root, file } = makeFollowups();
  try {
    await assert.rejects(
      core!.withFollowupsLock(file, () => { throw new Error("boom"); }, { timeoutMs: 5_000, retryMs: 25 }),
      /boom/,
    );
    // If the lock had leaked, this second acquire would time out.
    await core!.withFollowupsLock(file, () => addPin(file, 9, "2026-07-12", 0), { timeoutMs: 2_000, retryMs: 25 });
    assert.equal(pinCount(file), 1, "second acquire after a throw should have written");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
