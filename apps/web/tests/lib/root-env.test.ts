import assert from "node:assert/strict";
import { test } from "node:test";

import { rootScriptEnv } from "../../src/lib/core/root-env.ts";

/**
 * The bug this prevents, caught live: an import aimed at a scratch data root
 * wrote its profile into the checkout, because the spawned core script resolved
 * its own root and never saw the one the route had resolved.
 */
test("the resolved root is handed to the child, not left to the child to guess", () => {
  const env = rootScriptEnv("/data/root", {});
  assert.equal(env.CAREER_OPS_ROOT, "/data/root");
});

test("an inherited CAREER_OPS_DATA_DIR cannot outrank the root this process used", () => {
  // packages/core/src/kernel/path-resolver.ts prefers CAREER_OPS_ROOT over CAREER_OPS_DATA_DIR, so
  // setting ROOT is what pins the child; leaving a stale DATA_DIR in place
  // would otherwise be enough to move it when ROOT was the unset one.
  const env = rootScriptEnv("/data/root", { CAREER_OPS_DATA_DIR: "/somewhere/else" });
  assert.equal(env.CAREER_OPS_ROOT, "/data/root");
});

test("the rest of the environment survives, so the core keeps its own settings", () => {
  const env = rootScriptEnv("/data/root", { PATH: "/usr/bin", CAREER_OPS_CLI: "pi" });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.CAREER_OPS_CLI, "pi");
});

test("the caller's env object is not mutated", () => {
  const base = { PATH: "/usr/bin" };
  rootScriptEnv("/data/root", base);
  assert.deepEqual(base, { PATH: "/usr/bin" });
});
