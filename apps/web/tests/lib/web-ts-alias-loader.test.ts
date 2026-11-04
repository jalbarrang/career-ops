/**
 * web-ts-alias-loader.test.ts — `@/…` specifier resolution for the web suites.
 *
 * apps/web/tsconfig.json maps `"@/*" -> "./src/*"`. Bun reads that `paths` map
 * natively when the test run is rooted at web/, so a suite can import a module
 * through the alias without any hook. The `tests/helpers/web-ts-alias-loader.ts`
 * helper still exists for anyone running the suites under `node --test`, where
 * the alias needs an explicit ESM resolve hook.
 *
 * This file asserts the behaviour that actually ships: from web/, the alias
 * resolves to a real module, an explicit extension is honoured, unrelated
 * specifiers are left alone, and a miss still names the alias. Running it
 * in-process is the point — the Bun runner is the thing being checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";


test("an extensionless @/ specifier resolves to a .ts module", async () => {
  const m = await import("@/lib/career-ops");
  assert.equal(typeof m.careerOpsRoot, "function");
});

test("a @/ specifier that already names an extension is used as-is", async () => {
  const m = await import("@/lib/company-slug.ts");
  assert.equal(typeof m.companySlug, "function");
});

test("bare and relative specifiers still resolve", async () => {
  const p = await import("node:path");
  const rel = await import("../../src/lib/company-slug.ts");
  assert.equal(typeof p.join, "function");
  assert.equal(typeof rel.companySlug, "function");
});

test("an unresolvable @/ specifier still reports the alias it could not find", async () => {
  await assert.rejects(
    // A variable specifier: a literal one would be a compile-time resolution
    // error, which is a different failure from the runtime one under test.
    () => import(String("@/lib/this-module-does-not-exist")),
    /@\//,
    "a miss must name the alias, not report a bare ENOENT",
  );
});

test("the Node resolve-hook helper is import-safe here", async () => {
  // It is not load-bearing under Bun, but many suites import it for side effect,
  // so importing it twice must not throw or break resolution afterwards.
  await import("../helpers/web-ts-alias-loader.ts");
  await import("../helpers/web-ts-alias-loader.ts");
  const m = await import("@/lib/career-ops");
  assert.equal(typeof m.careerOpsRoot, "function");
});
