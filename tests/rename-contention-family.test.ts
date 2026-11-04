// tests/rename-contention-family.test.ts
//
// #3006 fixed the Windows rename-contention class (bare `renameSync` racing a
// LIVE destination handle, answered with EPERM/EACCES/EBUSY) in
// `writeFileAtomic`'s closing rename inside tracker-utils.ts. #3046 is the
// census of the other files carrying the same shape: write-tmp-then-rename
// over a destination that already exists and can be held open by a transient
// reader (AV scanner, Search indexer, a concurrent readFileSync).
//
// This is tests/rename-contention.test.ts §4 repeated per migrated file
// instead of pinning tracker-utils.ts alone: renameSyncWithRetry is the only
// code allowed to call renameSync in each of the five files below. A bare
// call reintroduced by a future edit reopens the exact class #3006 closed —
// which is what happened twice already to the mkdir/rm side of this same
// family (#2777, #2984) before the derived-list test in
// tests/lock-rm-contention.test.ts pinned it shut.
//
// merge-tracker.ts and plugin-install.ts are deliberately NOT in this list:
// merge-tracker.ts's renameSync moves a freshly processed TSV into merged/,
// a destination that does not pre-exist (mkdirSync'd immediately above, one
// file per run); plugin-install.ts's renameSync is already wrapped in a
// tolerant catch with a documented in-place fallback. Neither is the
// write-tmp-then-rename-over-a-live-file shape this test guards.

import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.ts';

console.log('\n📝 rename contention: the #3006 fix carries to the other five vulnerable call sites (#3046)');

const ok = (cond, msg) => (cond ? pass(msg) : fail(msg));

// The five files #3046 classified as the vulnerable shape — write-tmp then
// rename over a destination that already exists at write time.
const MIGRATED_FILES = [
  'followup-seed.ts',
  'scan-ats-full.ts',
  'discover-ats.ts',
  'paste-reply.ts',
  'update-system.ts',
];

for (const file of MIGRATED_FILES) {
  const src = readFileSync(join(ROOT, file), 'utf-8');

  // renameSync must never be INVOKED directly in these files. It may appear
  // in an import list (paste-reply.ts never imports it by name at all — it
  // called fs.renameSync) but never as a call; renameSyncWithRetry is the
  // only permitted seam.
  const directCalls = [
    ...src.matchAll(/(?<![\w.])renameSync\s*\(/g),
    ...src.matchAll(/(?<![\w])fs\.renameSync\s*\(/g),
  ].length;
  ok(directCalls === 0, `${file}: no direct renameSync() call remains (found ${directCalls})`);

  // And the migrated write path actually routes through the shared helper —
  // a file could pass the check above by deleting the write entirely.
  // writeFileAtomic counts as the seam too: it is tracker-utils.ts's own
  // write-tmp-then-rename, and its closing rename is the one
  // tests/rename-contention.test.ts §4 pins to renameSyncWithRetry.
  // paste-reply.ts moved onto it in #4920 to get a per-write temp name.
  const seamCalls = [...src.matchAll(/\b(?:renameSyncWithRetry|writeFileAtomic)\s*\(/g)].length;
  ok(seamCalls >= 1, `${file}: renames through renameSyncWithRetry or writeFileAtomic (found ${seamCalls} call(s))`);

  // The helper has to come from the one canonical definition, not a local
  // reimplementation — that drift is exactly what #2984 cost weeks chasing.
  // update-system.ts must stay self-loading (#1706, see its top-of-file
  // note): no static top-level relative import, so it pulls the helper in
  // via a lazy `await import(...)` instead — both forms count here.
  const importsFromTrackerUtils = new RegExp(
    `import\\s*\\{[^}]*\\b(?:renameSyncWithRetry|writeFileAtomic)\\b[^}]*\\}\\s*from\\s*['"]\\.\\/tracker-utils\\.ts['"]`,
  ).test(src);
  const lazyImportsFromTrackerUtils =
    /(?:const|let|var)\s*\{[^}]*\b(?:renameSyncWithRetry|writeFileAtomic)\b[^}]*\}\s*=\s*await\s+import\(\s*['"]\.\/tracker-utils\.ts['"]\s*\)/.test(src);
  ok(
    importsFromTrackerUtils || lazyImportsFromTrackerUtils,
    `${file}: the rename helper is imported from the canonical tracker-utils.ts (not reimplemented)`,
  );
}
