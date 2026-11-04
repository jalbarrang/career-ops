/**
 * tests/updater-reexec-missing-template-import.test.ts — the target updater
 * survives a packages/cli/src/commands/cv/cv-templates.ts whose local imports were not checked out yet.
 *
 * The self-reexec checkout list is built by the CLIENT updater. #4999 taught
 * resolveReexecCheckout() to walk the fallback files' own imports, but an
 * install whose updater predates that fix still checks out the new
 * packages/cli/src/commands/cv/cv-templates.ts without the modules it newly imports. The target updater then
 * reaches `await import('../packages/cli/src/commands/cv/cv-templates.ts')` in
 * loadConfiguredTemplateVariants() against a tree that lacks them, which is the
 * ERR_MODULE_NOT_FOUND crash #4999 reported. Only the target's own code can
 * cover that transition.
 */
import {mkdirSync, copyFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {dirname, join } from 'path';
import { pathToFileURL } from 'url';
import { pass, fail, rmSync, ROOT } from './helpers.ts';

console.log('\n🧪 Testing the target updater against an old client\'s short re-exec checkout...');

const root = mkdtempSync(join(tmpdir(), 'reexec-target-'));
try {
  mkdirSync(dirname(join(root, 'packages/cli/src/commands/platform/update-system.ts')), { recursive: true });
  copyFileSync(join(ROOT, 'packages/cli/src/commands/platform/update-system.ts'), join(root, 'packages/cli/src/commands/platform/update-system.ts'));
 mkdirSync(dirname(join(root, 'packages/cli/src/commands/cv/cv-templates.ts')), { recursive: true });
  writeFileSync(join(root, 'packages/cli/src/commands/cv/cv-templates.ts'),
    "import { parseMeta } from './lib/not-checked-out-yet.ts';\nexport { parseMeta };\n");
  const profilePath = join(root, 'profile.yml');
  writeFileSync(profilePath, 'cv:\n  template: bw\ncover_letter:\n  template: concise\n');

  const target = await import(pathToFileURL(join(root, 'packages/cli/src/commands/platform/update-system.ts')).href);
  let configured;
  try {
    configured = await target.loadConfiguredTemplateVariants({ profilePath });
  } catch (err) {
    configured = err;
  }
  if (configured?.cv === 'bw' && configured?.cover === 'concise') {
    pass('target updater reads configured variants when a packages/cli/src/commands/cv/cv-templates.ts import is missing');
  } else {
    fail(`target updater did not fall back past a missing packages/cli/src/commands/cv/cv-templates.ts import: ${configured?.message || JSON.stringify(configured)}`);
  }

  let noProfile;
  try {
    noProfile = await target.loadConfiguredTemplateVariants({ profilePath: join(root, 'absent.yml') });
  } catch (err) {
    noProfile = err;
  }
  if (noProfile && !(noProfile instanceof Error) && Object.keys(noProfile).length === 0) {
    pass('target updater returns no variants when the profile is absent too');
  } else {
    fail(`target updater mishandled a missing import with no profile: ${noProfile?.message || JSON.stringify(noProfile)}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
