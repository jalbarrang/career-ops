// tests/reply-watch-delegates-status.test.ts — reply-watch writes no status
// of its own (#5536).
//
// Every accepted update goes through packages/cli/src/commands/tracker/set-status.ts, so the status hooks
// (ledger row, JD archive on Interview, follow-up seeding on Applied) run for
// it as they do for any other status change. A tracker transaction or a
// Status-cell edit reappearing in packages/cli/src/commands/outreach/reply-watch.ts would be a second status
// writer, and the next hook added to set-status would skip it. The behaviour
// is covered end to end in tests/status-hooks-writers.test.ts; this pins the
// boundary, the way test-all.ts pins it for the dashboard's status writer.
//
// Run:  bun test tests/reply-watch-delegates-status.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.ts';

const source = readFileSync(join(ROOT, 'packages/cli/src/commands/outreach/reply-watch.ts'), 'utf8');

test('reply-watch hands its writes to packages/cli/src/commands/tracker/set-status.ts with the row-scoped review guard', () => {
  assert.ok(source.includes("'packages/cli/src/commands/tracker/set-status.ts'"), 'packages/cli/src/commands/outreach/reply-watch.ts no longer spawns packages/cli/src/commands/tracker/set-status.ts');
  assert.ok(source.includes("'--expect-row'"), 'packages/cli/src/commands/outreach/reply-watch.ts no longer passes the reviewed row to packages/cli/src/commands/tracker/set-status.ts');
});

test('reply-watch has no tracker writer of its own', () => {
  for (const writer of ['openTrackerTransaction', 'acquireTrackerLock', 'writeFileAtomic', 'rebuildRow', 'appendLedgerRows']) {
    assert.ok(!source.includes(writer), `packages/cli/src/commands/outreach/reply-watch.ts uses ${writer}, so it writes the tracker or the ledger itself`);
  }
  assert.doesNotMatch(source, /\[\s*(?:colmap|COLMAP|COLS)\.status\s*\]\s*=/, 'packages/cli/src/commands/outreach/reply-watch.ts assigns a Status cell');
});
