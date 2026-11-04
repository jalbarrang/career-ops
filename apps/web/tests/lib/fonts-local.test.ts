import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// SvelteKit has no next/font/local, so the three vendored faces are declared as
// @font-face rules in app.css and lib/fonts.ts only maps them to utilities. Both
// halves are checked here so a face can never be configured without its asset.
const fontsSource = readFileSync(new URL("../../src/lib/fonts.ts", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../../src/app.css", import.meta.url), "utf8");
const assets = [
  "../../src/assets/fonts/inter/Inter-Latin-Variable.woff2",
  "../../src/assets/fonts/instrument-serif/InstrumentSerif-Latin-Regular.woff2",
  "../../src/assets/fonts/instrument-serif/InstrumentSerif-Latin-Italic.woff2",
];

test("web fonts are local and never use the Google build-time loader", () => {
  assert.match(appCss, /@font-face\s*\{/);
  // An import is what would pull a loader in; the module's comments name the old
  // Next mechanism on purpose, so match the import form only.
  assert.doesNotMatch(fontsSource, /from\s*["']next\/font/);
  for (const source of [fontsSource, appCss]) {
    assert.doesNotMatch(source, /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  }
});

test("every configured WOFF2 asset is vendored", () => {
  for (const relativePath of assets) {
    const bytes = readFileSync(new URL(relativePath, import.meta.url));
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "wOF2", `${relativePath} is not a WOFF2 file`);
    // app.css lives at src/, the assets at src/assets/ — so the @font-face url
    // is the asset path with the leading `src/` removed.
    const configuredPath = relativePath.replace("../../src/", "./");
    const escapedPath = configuredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(appCss, new RegExp(`url\\(["']${escapedPath}["']\\)`));
  }
});

test("both vendored font families include their OFL license", () => {
  for (const relativePath of [
    "../../src/assets/fonts/inter/OFL.txt",
    "../../src/assets/fonts/instrument-serif/OFL.txt",
  ]) {
    assert.match(readFileSync(new URL(relativePath, import.meta.url), "utf8"), /SIL OPEN FONT LICENSE Version 1\.1/);
  }
});
