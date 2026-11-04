/**
 * tests/updater-reexec-closure.test.ts — the self-reexec checkout includes the static
 * imports of REEXEC_FALLBACK_FILES, not only of packages/cli/src/commands/platform/update-system.ts (#4999).
 *
 * The v1.35.0 → v1.36.0 apply crashed with ERR_MODULE_NOT_FOUND: packages/cli/src/commands/cv/cv-templates.ts, a
 * fallback file loaded by the target updater, gained `import … from
 * 'packages/core/src/cv/template-manifest.ts'`, and resolveReexecCheckout() appended the fallback
 * files without walking their imports. The tree below reproduces that shape without a
 * repo, through the `readAt` seam.
 */
import { pass, fail } from './helpers.ts';
import { resolveReexecCheckout, REEXEC_FALLBACK_FILES } from '../packages/cli/src/commands/platform/update-system.ts';

const TREE = {
  'packages/cli/src/commands/platform/update-system.ts': "import { helper } from '../../../../core/src/kernel/updater-helper.ts';\n",
  'packages/core/src/kernel/updater-helper.ts': "import { readFileSync } from 'fs';\n",
  'packages/cli/src/commands/cv/cv-templates.ts': "import { MANIFEST } from '../../../../core/src/cv/template-manifest.ts';\nimport { isMainModule } from '../../../../core/src/kernel/is-main-module.ts';\n",
  'packages/core/src/cv/template-manifest.ts': "import { existsSync } from 'fs';\n",
  'packages/core/src/kernel/is-main-module.ts': '',
  'packages/core/src/kernel/path-resolver.ts': '',
  // scaffolder/bin/skill-entrypoints.ts deliberately absent: an older target lacks it.
};
const readAt = (file) => {
  if (!Object.prototype.hasOwnProperty.call(TREE, file)) throw new Error(`absent: ${file}`);
  return TREE[file];
};

if (!REEXEC_FALLBACK_FILES.includes('packages/cli/src/commands/cv/cv-templates.ts')) {
  fail('fixture assumes packages/cli/src/commands/cv/cv-templates.ts is a REEXEC_FALLBACK_FILES entry — update this test with the list');
} else {
  const files = resolveReexecCheckout('FETCH_HEAD', 'packages/cli/src/commands/platform/update-system.ts', readAt);

  if (files.includes('packages/core/src/cv/template-manifest.ts')) pass('a fallback file\'s own static import is checked out before the re-exec (#4999)');
  else fail(`packages/core/src/cv/template-manifest.ts missing from the re-exec checkout: ${JSON.stringify(files)}`);

  if (files.includes('packages/core/src/kernel/updater-helper.ts') && files[0] === 'packages/cli/src/commands/platform/update-system.ts') pass('the entry and its own imports still come first');
  else fail(`entry closure missing or not first: ${JSON.stringify(files)}`);

  if (!files.includes('scaffolder/bin/skill-entrypoints.ts')) pass('a fallback absent from the target tree is skipped, not checked out');
  else fail('an absent fallback file was listed for checkout');

  if (new Set(files).size === files.length) pass('each file is listed once, even when reached twice');
  else fail(`duplicates in the re-exec checkout: ${JSON.stringify(files)}`);
}
