import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acquirePipelineLock } from '../pipeline-lock.ts';
import { describeSpawn } from './helpers/describe-spawn.ts';

// FORK: schema v2. An experience is a COMPANY with nested ROLES, so the
// assertions reach through `experiences[i].roles[j]`. Every scenario upstream
// covers for v1 is kept — the rules did not change, only where the facts live.
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'career-profile.ts');
const CV = `# Candidate\n\n## Experience\n### Acme — Analyst\n- Built dashboards with SQL.\n\n## Skills\n- SQL, Excel\n`;

/** First role of the first company — the common single-role assertion. */
const firstRole = (profile) => profile.experiences[0].roles[0];

function withProfileRoot(run) {
  const root = mkdtempSync(join(tmpdir(), 'career-profile-test-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'cv.md'), CV);
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

function runCli(root, args, input, timeout = 5000) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_ROOT: root },
    encoding: 'utf8', input, timeout,
  });
}

test('reviewed import consumes piped answers one line at a time and writes approved facts', () => {
  withProfileRoot((root) => {
    const result = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\ny\ny\n');
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, describeSpawn(result));
    const profile = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));
    assert.equal(profile.schema_version, 2);
    assert.equal(firstRole(profile).facts[0].text, 'Built dashboards with SQL.');
    assert.equal(profile.skills.length, 2);
    assert.equal(profile.skills[0].review_status, 'verified');
    assert.equal(profile.skills[0].evidence.quote, '- SQL, Excel');
    const validation = runCli(root, ['validate']);
    assert.equal(validation.status, 0, describeSpawn(validation));
  });
});

test('a role block is classified into company, role and period', () => {
  withProfileRoot((root) => {
    writeFileSync(join(root, 'cv.md'), [
      '# Candidate', '', '## Experience',
      '### Series Entertainment', '**Senior Full Stack Engineer:**', 'March 2025 - September 2026',
      '- Shipped Creator Quests.', '- Built the publishing pipeline.', '',
    ].join('\n'));
    const result = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\ny\ny\ny\n');
    assert.equal(result.status, 0, describeSpawn(result));
    const profile = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));

    assert.equal(profile.experiences.length, 1);
    assert.equal(profile.experiences[0].company.name, 'Series Entertainment');
    const role = firstRole(profile);
    assert.equal(role.name, 'Senior Full Stack Engineer'); // the trailing colon is trimmed
    assert.equal(role.period, 'March 2025 - September 2026');
    assert.deepEqual(role.facts.map((fact) => fact.text), ['Shipped Creator Quests.', 'Built the publishing pipeline.']);
  });
});

test('two roles at one company become one company with two roles, in CV order', () => {
  withProfileRoot((root) => {
    writeFileSync(join(root, 'cv.md'), [
      '# Candidate', '', '## Experience',
      '### Acme', '**Senior Engineer**', '2023 - 2026', '- Led the platform.',
      '### Acme', '**Engineer**', '2021 - 2023', '- Shipped the editor.', '', '',
    ].join('\n'));
    const result = runCli(root, ['import', 'cv.md', '--review'], Array(11).fill('y').join('\n'));
    assert.equal(result.status, 0, describeSpawn(result));
    const profile = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));

    assert.equal(profile.experiences.length, 1, 'the same employer is one company');
    const roles = profile.experiences[0].roles;
    assert.equal(roles.length, 2);
    assert.deepEqual(roles.map((role) => role.name), ['Senior Engineer', 'Engineer']);
    assert.deepEqual(roles.map((role) => role.period), ['2023 - 2026', '2021 - 2023']);
    assert.deepEqual(roles.map((role) => role.facts[0].text), ['Led the platform.', 'Shipped the editor.']);
    assert.notEqual(roles[0].id, roles[1].id);
  });
});

test('re-import after line shifts updates evidence without duplicating approved facts', () => {
  withProfileRoot((root) => {
    const first = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\ny\ny\n');
    assert.equal(first.status, 0, describeSpawn(first));
    writeFileSync(join(root, 'cv.md'), `<!-- moved -->\n<!-- moved again -->\n${CV}`);
    const second = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\ny\ny\n');
    assert.equal(second.status, 0, describeSpawn(second));
    const profile = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));
    assert.equal(profile.experiences.length, 1);
    assert.equal(firstRole(profile).facts.length, 1);
    assert.equal(profile.skills.length, 2);
    assert.equal(firstRole(profile).facts[0].evidence.line, 7);
  });
});

test('preview does not create a profile, and validation rejects missing evidence', () => {
  withProfileRoot((root) => {
    const preview = runCli(root, ['import', 'cv.md']);
    assert.equal(preview.status, 0, describeSpawn(preview));
    assert.match(preview.stdout, /Preview only/);
    assert.throws(() => readFileSync(join(root, 'data', 'career-profile.yml')),
      { code: 'ENOENT' });

    const invalidPath = join(root, 'invalid.yml');
    writeFileSync(invalidPath, `schema_version: 2\ncandidate: {}\nsummary: []\nexperiences: []\nprojects: []\neducation: []\ncertifications: []\nskills:\n  - id: skill-1\n    text: SQL\n    review_status: verified\n    evidence:\n      source: cv.md\n`);
    const invalid = runCli(root, ['validate', invalidPath]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /evidence requires source, positive line, and quote/);
  });
});

test('a v1 profile is rejected, so the fork cannot silently read the old shape', () => {
  withProfileRoot((root) => {
    const v1Path = join(root, 'v1.yml');
    writeFileSync(v1Path, `schema_version: 1\ncandidate: {}\nsummary: []\nexperiences: []\nprojects: []\neducation: []\ncertifications: []\nskills: []\n`);
    const result = runCli(root, ['validate', v1Path]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /schema_version must be 2/);
  });
});

test('source paths outside the data root retain their complete absolute path', () => {
  withProfileRoot((root) => {
    const sibling = `${root}-archive`;
    mkdirSync(sibling, { recursive: true });
    const sourcePath = join(sibling, 'cv.md');
    writeFileSync(sourcePath, CV);
    try {
      const result = runCli(root, ['import', sourcePath]);
      assert.equal(result.status, 0, describeSpawn(result));
      assert.ok(result.stdout.includes(sourcePath), result.stdout);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

test('identical statements under different companies retain distinct IDs', () => {
  withProfileRoot((root) => {
    const cv = `# Candidate\n## Experience\n### North Co — Analyst\n- Shipped reports.\n### South Co — Analyst\n- Shipped reports.\n`;
    writeFileSync(join(root, 'cv.md'), cv);
    const result = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\ny\ny\n');
    assert.equal(result.status, 0, describeSpawn(result));
    const profile = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));
    const ids = profile.experiences.map((company) => company.roles[0].facts[0].id);
    assert.equal(profile.experiences.length, 2);
    assert.notEqual(ids[0], ids[1]);
    assert.notEqual(profile.experiences[0].roles[0].id, profile.experiences[1].roles[0].id);
  });
});

test('repeated facts are deduplicated, and two untitled roles at one company stay distinct', () => {
  withProfileRoot((root) => {
    const cv = `# Candidate\n## Experience\n### Acme — Analyst\n- Built reports.\n- Built reports.\n### Acme — Analyst\n- Built dashboards.\n## Skills\n- SQL, SQL\n`;
    writeFileSync(join(root, 'cv.md'), cv);
    const first = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\ny\ny\ny\n');
    assert.equal(first.status, 0, describeSpawn(first));
    const before = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));
    assert.equal(before.experiences.length, 1);
    assert.equal(before.experiences[0].roles.length, 2);
    assert.notEqual(before.experiences[0].roles[0].id, before.experiences[0].roles[1].id);
    assert.equal(before.experiences[0].roles[0].facts.length, 1);
    assert.equal(before.skills.length, 1);

    writeFileSync(join(root, 'cv.md'), `<!-- moved -->\n${cv}`);
    const second = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\ny\ny\ny\n');
    assert.equal(second.status, 0, describeSpawn(second));
    const after = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));
    assert.equal(after.experiences.length, 1);
    assert.equal(after.experiences[0].roles.length, 2);
    assert.deepEqual(after.experiences[0].roles.map((role) => role.facts[0].text).sort(), ['Built dashboards.', 'Built reports.']);
    assert.equal(after.skills.length, 1);
  });
});

test('reordering same-title roles keeps each identity attached to its facts on re-import', () => {
  withProfileRoot((root) => {
    const firstOrder = `# Candidate\n## Experience\n### Acme — Analyst\n- Built reports.\n### Acme — Analyst\n- Built dashboards.\n`;
    writeFileSync(join(root, 'cv.md'), firstOrder);
    const first = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\ny\ny\n');
    assert.equal(first.status, 0, describeSpawn(first));
    const profilePath = join(root, 'data', 'career-profile.yml');
    const initial = yaml.load(readFileSync(profilePath, 'utf8'));
    initial.experiences.forEach((company, index) => {
      company.id = `legacy-company-${index}`;
      company.roles.forEach((role, roleIndex) => {
        role.id = `legacy-role-${roleIndex}`;
        // The fact id must vary by ROLE, not just by company: v1 had one entry per
        // block, v2 nests two roles under one company, so a company-indexed id
        // collides and the profile no longer validates.
        role.facts.forEach((fact, factIndex) => { fact.id = `legacy-fact-${roleIndex}-${factIndex}`; });
      });
    });
    writeFileSync(profilePath, yaml.dump(initial, { noRefs: true }));
    // v2 keeps role ids across a re-import (a saved CV selection is bound to
    // them), so the reference is the ids as they stand before the reorder.
    const idsByFact = new Map(initial.experiences[0].roles.map((role) => [role.facts[0].text, role.id]));

    writeFileSync(join(root, 'cv.md'), `# Candidate\n## Experience\n### Acme — Analyst\n- Built dashboards.\n### Acme — Analyst\n- Built reports.\n`);
    const second = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\ny\ny\n');
    assert.equal(second.status, 0, describeSpawn(second));
    const reordered = yaml.load(readFileSync(profilePath, 'utf8'));
    assert.equal(reordered.experiences.length, 1);
    assert.equal(reordered.experiences[0].roles.length, 2);
    for (const role of reordered.experiences[0].roles) {
      assert.equal(role.id, idsByFact.get(role.facts[0].text), 'a role id must follow its facts, not its position');
    }
  });
});

test('skipping a company line also skips its facts', () => {
  withProfileRoot((root) => {
    const result = runCli(root, ['import', 'cv.md', '--review'], 'n\ny\ny\n');
    assert.equal(result.status, 0, describeSpawn(result));
    const profile = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));
    assert.equal(profile.experiences.length, 0);
    assert.equal(profile.skills.length, 2);
  });
});

test('re-import applies explicit wording edits but plain approval preserves prior edits', () => {
  withProfileRoot((root) => {
    const initial = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\nn\nn\n');
    assert.equal(initial.status, 0, describeSpawn(initial));

    const edited = runCli(root, ['import', 'cv.md', '--review'], 'e\nAcme — Lead Analyst\ne\nDesigned verified dashboards.\nn\nn\n');
    assert.equal(edited.status, 0, describeSpawn(edited));
    let profile = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));
    assert.equal(profile.experiences.length, 1, 'an edited company name must not create a second company');
    assert.equal(profile.experiences[0].company.name, 'Acme — Lead Analyst');
    assert.equal(firstRole(profile).facts[0].text, 'Designed verified dashboards.');

    const approvedAgain = runCli(root, ['import', 'cv.md', '--review'], 'y\ny\nn\nn\n');
    assert.equal(approvedAgain.status, 0, describeSpawn(approvedAgain));
    profile = yaml.load(readFileSync(join(root, 'data', 'career-profile.yml'), 'utf8'));
    assert.equal(profile.experiences.length, 1);
    assert.equal(profile.experiences[0].company.name, 'Acme — Lead Analyst');
    assert.equal(firstRole(profile).facts[0].text, 'Designed verified dashboards.');
  });
});

test('an import with nothing approved does not read the existing profile', () => {
  withProfileRoot((root) => {
    const profilePath = join(root, 'data', 'career-profile.yml');
    const invalid = 'schema_version: 2\ncandidate: {}\n';
    writeFileSync(profilePath, invalid);
    const result = runCli(root, ['import', 'cv.md', '--review'], 'n\nn\nn\n');
    assert.equal(result.status, 0, describeSpawn(result));
    assert.match(result.stdout, /No approved items; profile was not changed\./);
    assert.equal(readFileSync(profilePath, 'utf8'), invalid);
  });
});

test('a failed save removes its temporary file and reports the original error', () => {
  withProfileRoot((root) => {
    // Launcher: make the final rename fail after the temporary file is written, then run the CLI.
    const launcher = join(root, 'fail-rename.ts');
    writeFileSync(launcher, [
      // Patch the CommonJS `node:fs` object, then import the CLI dynamically:
      // Bun binds a module's named imports at link time, and this import
      // happens after the patch, so the wrapper is what the CLI links against.
      // Node needs syncBuiltinESMExports() to push the same patch into ESM
      // named imports; Bun reads the object directly and ignores the call.
      "import { createRequire, syncBuiltinESMExports } from 'node:module';",
      "const fs = createRequire(import.meta.url)('node:fs');",
      'const realRename = fs.renameSync;',
      'fs.renameSync = (from, to) => {',
      "  if (String(from).endsWith('career-profile.yml.tmp')) throw new Error('simulated rename failure');",
      '  return realRename(from, to);',
      '};',
      'syncBuiltinESMExports();',
      `await import(${JSON.stringify(pathToFileURL(CLI).href)});`,
    ].join('\n'));
    const result = spawnSync(process.execPath, [launcher, 'import', 'cv.md', '--review'], {
      cwd: ROOT,
      env: { ...process.env, CAREER_OPS_ROOT: root },
      encoding: 'utf8', input: 'y\ny\ny\ny\n', timeout: 5000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /simulated rename failure/);
    const profilePath = join(root, 'data', 'career-profile.yml');
    assert.equal(existsSync(`${profilePath}.tmp`), false, 'temporary file is removed after a failed save');
    assert.equal(existsSync(profilePath), false);
  });
});

test('profile save waits for a held profile lock before merging and writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'career-profile-lock-test-'));
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'cv.md'), `# Candidate\n## Skills\n- SQL\n`);
  const profilePath = join(root, 'data', 'career-profile.yml');
  const lock = await acquirePipelineLock(profilePath, { timeoutMs: 3000, retryMs: 20 });
  let child;
  try {
    child = spawn(process.execPath, [CLI, 'import', 'cv.md', '--review'], {
      cwd: ROOT,
      env: { ...process.env, CAREER_OPS_ROOT: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let exitCode = null;
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise((resolveExit) => child.once('exit', (code) => {
      exitCode = code;
      resolveExit(code);
    }));
    child.stdin.end('y\ny\n');
    const deadline = Date.now() + 5000;
    while ((stdout.match(/\[y\] approve/g) ?? []).length < 1 && Date.now() < deadline && exitCode === null) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    assert.equal((stdout.match(/\[y\] approve/g) ?? []).length, 1, `import did not finish review prompt: ${stdout}`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    assert.equal(exitCode, null, 'import must wait for the profile lock');

    lock.release();
    const status = await exited;
    assert.equal(status, 0, stderr);
    assert.equal(existsSync(`${profilePath}.lock`), false, 'profile lock is released after the save');
    const profile = yaml.load(readFileSync(profilePath, 'utf8'));
    assert.equal(profile.skills[0].text, 'SQL');
  } finally {
    lock.release();
    if (child && child.exitCode === null) child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});
