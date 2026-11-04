// tests/set-status-lock-scope.test.ts — packages/cli/src/commands/tracker/set-status.ts must hold the tracker
// lock before it reads and atomically replaces applications.md; the dashboard
// delegates its status writes to this script.
import { readFileSync } from 'fs';
import { join } from 'path';
import { pass, fail, ROOT } from './helpers.ts';

console.log('\nset-status.ts — tracker lock transaction scope');

const source = readFileSync(join(ROOT, 'packages/cli/src/commands/tracker/set-status.ts'), 'utf-8');
const lockAt = source.indexOf('await acquireTrackerLockForCli(');
const replaceAt = source.indexOf('writeFileAtomic(APPS_FILE');
const readAt = source.indexOf('readFileSync(APPS_FILE', lockAt);
if (lockAt >= 0 && readAt > lockAt && replaceAt > readAt) {
  pass('packages/cli/src/commands/tracker/set-status.ts acquires the tracker lock before reading and atomically replacing the tracker');
} else {
  fail('packages/cli/src/commands/tracker/set-status.ts escapes the shared tracker lock transaction scope');
}
