// tests/providers/inter-page-sleep-shared.test.ts — a lexical guard: every
// provider's inter-page / inter-request pacing must go through the ctx-aware
// `sleep(ms, ctx)` helper exported by _http.ts, never a hand-rolled local
// copy. A local copy has no ctx-based test-clock hook, so it wall-clock-waits
// during tests and can silently skip pacing if mis-implemented.
//
// Two things are checked: a provider declaring its own `sleep` binding
// (function/const/let/var) instead of importing it, and a provider calling
// `setTimeout` directly anywhere outside `_http.ts`. A hand-rolled
// ctx.sleep-fallback, in any syntax (ternary, if/return, optional chaining,
// typeof-guard, named helper or inlined), still bottoms out in a literal
// `setTimeout` call — that call is the invariant checked, not the wrapper
// around it. The one legitimate direct use is arming an abort timer
// (`setTimeout(() => controller.abort(), ...)`, as in consider.ts); anything
// else calling `setTimeout` outside `_http.ts` is reimplementing pacing that
// belongs in the shared `sleep()`.
import { pass, fail, ROOT } from '../helpers.ts';
import { join } from 'path';
import { readdirSync, readFileSync } from 'fs';

console.log('\nProviders — inter-page sleep routes through _http.ts (#2723)');

// A local declaration of `sleep`: `function sleep(`, `function* sleep(`,
// `const sleep =`, `let sleep =`, `var sleep =`. A destructure
// (`const { sleep } = …`) has a brace after `const` and does not match.
const LOCAL_SLEEP_DECL = /(?:function\s*\*?\s+sleep\s*\(|(?:const|let|var)\s+sleep\s*=)/;
const SHARED_SLEEP_IMPORT = /\bimport\s*\{[^}]*\bsleep\b[^}]*\}\s*from\s*['"]\.\/_http\.ts['"]/;
const SET_TIMEOUT_CALL = /setTimeout\s*\(/;
const ABORT_TIMER_LINE = /\.abort\s*\(/;

/** @returns {string|null} offender line, or null when the file is clean. */
const classify = (file, src) => {
  if (LOCAL_SLEEP_DECL.test(src)) {
    return SHARED_SLEEP_IMPORT.test(src)
      ? `${file} (declares its own sleep alongside the shared import)`
      : `${file} (declares its own sleep and does not import it from ./_http.ts)`;
  }
  const rawTimeoutLine = src
    .split('\n')
    .find((line) => SET_TIMEOUT_CALL.test(line) && !ABORT_TIMER_LINE.test(line));
  if (rawTimeoutLine) {
    return `${file} (calls setTimeout directly instead of routing pacing through the shared sleep from ./_http.ts)`;
  }
  return null;
};

// ── Positive control ──
// A regex that later matches nothing keeps every run green over a real private
// copy — plant the shapes this guard exists to catch and assert they fire.
{
  const IMPORT_LINE = "import { BROWSER_LIKE_USER_AGENT, sleep } from './_http.ts';\n";
  const FALLBACK_OFFENCE = 'x.ts (calls setTimeout directly instead of routing pacing through the shared sleep from ./_http.ts)';
  const planted = [
    ['function sleep(ms, ctx) { return ctx?.sleep?.(ms); }',
      'x.ts (declares its own sleep and does not import it from ./_http.ts)'],
    ['function sleep(ctx, ms) { return ctx?.sleep?.(ms); }',
      'x.ts (declares its own sleep and does not import it from ./_http.ts)'],
    ['const sleep = (ms) => new Promise((r) => setTimeout(r, ms));',
      'x.ts (declares its own sleep and does not import it from ./_http.ts)'],
    [IMPORT_LINE + 'function sleep(ms, ctx) { return ctx?.sleep?.(ms); }',
      'x.ts (declares its own sleep alongside the shared import)'],
    // Every syntactic variant of the hand-rolled fallback — ternary,
    // if/return, optional chaining, typeof-guard, named or inlined — still
    // bottoms out in a literal `setTimeout` call, so one check catches all.
    ['const wait = (ms) => (ctx.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));', FALLBACK_OFFENCE],
    ['await (ctx.sleep ? ctx.sleep(PAGE_DELAY_MS) : new Promise(r => setTimeout(r, PAGE_DELAY_MS)));', FALLBACK_OFFENCE],
    ["const wait = (ms) => (typeof ctx?.sleep === 'function' ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));", FALLBACK_OFFENCE],
    ["function wait(ms, ctx) { if (typeof ctx?.sleep === 'function') return ctx.sleep(ms); return new Promise((r) => setTimeout(r, ms)); }", FALLBACK_OFFENCE],
    ['const wait = (ms) => (ctx?.sleep ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));', FALLBACK_OFFENCE],
    // No ctx.sleep check at all — an unconditional wall-clock delay is
    // flagged the same way as a fallback with a check.
    ['await new Promise(resolve => setTimeout(resolve, 200));', FALLBACK_OFFENCE],
  ];
  const missed = planted.filter(([src, want]) => classify('x.ts', src) !== want);
  if (missed.length === 0) {
    pass('positive control: every known local-sleep / raw-setTimeout shape is still detected');
  } else {
    fail(`guard no longer fires on: ${JSON.stringify(missed.map(([src]) => src.slice(0, 60)))}`);
  }

  // Negative control: importing and calling the shared helper is correct usage.
  const legitimate = IMPORT_LINE + 'if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);\n';
  if (classify('x.ts', legitimate) === null) {
    pass('negative control: importing and calling the shared sleep is not an offence');
  } else {
    fail(`guard flags legitimate usage: ${classify('x.ts', legitimate)}`);
  }

  // Negative control: arming an abort timer is the one legitimate direct
  // setTimeout use (consider.ts, _http.ts's own fetchInContext).
  const abortTimer = 'const timer = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);\n';
  if (classify('x.ts', abortTimer) === null) {
    pass('negative control: an abort timer is not flagged as a sleep fallback');
  } else {
    fail(`guard flags a legitimate abort timer: ${classify('x.ts', abortTimer)}`);
  }
}

let files;
try {
  files = readdirSync(join(ROOT, 'packages/core/src/scanning/providers'));
} catch (e) {
  files = null;
  fail(`cannot read providers/: ${e.message}`);
}

if (files) {
  const offenders = [];
  for (const file of files) {
    if (!file.endsWith('.ts') || file.startsWith('_')) continue;
    let src;
    try {
      src = readFileSync(join(ROOT, 'packages/core/src/scanning/providers', file), 'utf-8');
    } catch (e) {
      offenders.push(`${file} (unreadable: ${e.message})`);
      continue;
    }
    const verdict = classify(file, src);
    if (verdict) offenders.push(verdict);
  }

  if (offenders.length === 0) {
    pass('no provider hand-rolls its own sleep instead of importing it from _http.ts');
  } else {
    fail(`local sleep helper re-introduced in: ${offenders.join(', ')}`);
  }
}
