// Child process for tests/suite-ignores-inherited-tracker.test.ts. It is
// started WITH an inherited CAREER_OPS_TRACKER, loads the shared helpers the way
// a suite does, pins the fixture root given as argv[2], reports the tracker
// that root resolves to, and runs the status normaliser through run().
import { run, NODE } from '../helpers.ts';
import { resolveTrackerPathForWrite } from '../../path-resolver.ts';

const fixtureRoot = process.argv[2];
process.env.CAREER_OPS_ROOT = fixtureRoot;
console.log(`RESOLVED=${resolveTrackerPathForWrite(fixtureRoot)}`);
run(NODE, ['normalize-statuses.ts']);
