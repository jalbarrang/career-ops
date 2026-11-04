import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isTheme, storedTheme, THEME_COLORS, THEME_STORAGE_KEY } from "../../src/lib/theme.ts";

test("theme constants keep the persisted contract stable", () => {
  assert.equal(THEME_STORAGE_KEY, "career-ops:theme");
  assert.deepEqual(THEME_COLORS, { light: "#f7f6f3", dark: "#0a0a0a" });
});

test("the literal bootstrap script stays pinned to the shared theme contract", async () => {
  // The pre-paint theme bootstrap used to be a THEME_SCRIPT template in the Next
  // layout. It is now the inline <script> in app.html — same contract, read from
  // its new home.
  const shellSource = await readFile(new URL("../../src/app.html", import.meta.url), "utf8");
  const script = shellSource.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script, "app.html must define the pre-paint theme script");
  assert.doesNotMatch(script, /\$\{|%sveltekit\./, "the bootstrap must stay static — no templating inside it");
  assert.match(script, new RegExp(`localStorage\\.getItem\\(['"]${THEME_STORAGE_KEY}['"]\\)`));
  assert.match(script, /t === ['"]light['"] \|\| t === ['"]dark['"] \? t : null/);
  assert.ok(script.includes(THEME_COLORS.dark) && script.includes(THEME_COLORS.light));
});

test("theme helpers accept only the two supported modes", () => {
  for (const value of ["light", "dark"]) assert.equal(isTheme(value), true);
  for (const value of ["system", "LIGHT", "", null, undefined, 1]) assert.equal(isTheme(value), false);
  assert.equal(storedTheme("light"), "light");
  assert.equal(storedTheme("dark"), "dark");
  assert.equal(storedTheme("system"), "dark");
  assert.equal(storedTheme("system", "light"), "light");
});
