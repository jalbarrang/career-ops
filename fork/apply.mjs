#!/usr/bin/env node
/**
 * fork/apply.mjs — install this fork's copies of the core files it owns.
 *
 * WHY THIS EXISTS
 *
 * `data/career-profile.yml` schema v2 (company -> roles) is a change inside the
 * engine, not a web-app feature: the importer writes the file, the validator
 * gates every save, and the selection code reads it. Those three files
 * (`career-profile.mjs`, `lib/career-profile.mjs`, `lib/profile-cv-selection.mjs`)
 * plus their tests are in the updater's manifest, so `node update-system.mjs
 * apply` checks them out from upstream and the fork's versions are gone. The
 * updater does leave a `.bak` of each local edit, so nothing is lost — it is
 * just reverted.
 *
 * This script puts the fork's versions back, and REFUSES when upstream has
 * moved the same file: a hash mismatch means a human has to decide whether the
 * fork's schema still belongs on top of the new upstream code.
 *
 * USAGE
 *
 *   node fork/apply.mjs                # install the fork's copies
 *   node fork/apply.mjs --check        # report drift, change nothing
 *   node fork/apply.mjs --force        # install even when the base does not match
 *   node fork/apply.mjs --reset-base   # record the CURRENT files as the new base
 *
 * `--reset-base` is the "I reviewed upstream's change and the fork still holds"
 * answer: it hashes what is on disk now and rewrites fork/base.json, so later
 * runs compare against reality instead of the release the fork was cut from.
 *
 * Exit codes: 0 installed / already current, 1 drift detected, 2 usage error.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORK_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(FORK_DIR);
const CORE_DIR = join(FORK_DIR, 'core');
const BASE_FILE = join(FORK_DIR, 'base.json');

const KNOWN_FLAGS = ['--check', '--force', '--reset-base', '--help', '-h'];

const USAGE = `Usage: node fork/apply.mjs [--check] [--force] [--reset-base]

  --check        report drift, change nothing
  --force        install even when the recorded base does not match
  --reset-base   record the files on disk as the new base (after reviewing upstream)
`;

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
// fork/core/ mirrors the checkout, so a file's path under CORE_DIR is also its
// path under ROOT — one spelling drives both sides of the copy and base.json.
const toRepoPath = (file) => relative(CORE_DIR, file).split('\\').join('/');

/** Every file the fork ships, read from fork/core/ so nothing is hand-listed. */
function forkFiles() {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() ? [full] : [];
    });
  return walk(CORE_DIR).map(toRepoPath);
}

function readBase() {
  try {
    return JSON.parse(readFileSync(BASE_FILE, 'utf8'));
  } catch {
    return { files: {}, installed: {} };
  }
}

function resetBase(base, files) {
  const next = { '//': base['//'], upstream_version: base.upstream_version, files: {}, installed: {} };
  for (const file of files) {
    const target = join(ROOT, file);
    if (existsSync(target)) {
      next.files[file] = sha256(target);
      next.installed[file] = sha256(join(CORE_DIR, file));
    }
  }
  writeFileSync(BASE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`Recorded ${Object.keys(next.files).length} file(s) in fork/base.json (upstream ${base.upstream_version}).`);
  return 0;
}

function main(argv) {
  const flags = argv.slice(2);
  const unknown = flags.filter((flag) => !KNOWN_FLAGS.includes(flag));
  if (unknown.length > 0) {
    console.error(`Unknown flag(s): ${unknown.join(', ')}\n\n${USAGE}`);
    return 2;
  }
  if (flags.includes('--help') || flags.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const check = flags.includes('--check');
  const force = flags.includes('--force');
  const base = readBase();
  const files = forkFiles();
  if (files.length === 0) {
    console.error('fork/core is empty — nothing to install.');
    return 1;
  }
  if (flags.includes('--reset-base')) return resetBase(base, files);

  const installed = [];
  const current = [];
  const drifted = [];
  // What the fork last put on disk. Without it, moving the fork forward (editing
  // fork/core) would read as drift against the upstream base, and the installer
  // would refuse to install its own next version.
  const lastInstalled = base.installed ?? {};
  let recordedSomething = false;

  for (const file of files) {
    const target = join(ROOT, file);
    if (!existsSync(target)) {
      drifted.push({ file, why: 'missing from the checkout' });
      continue;
    }
    const live = sha256(target);
    const forkHash = sha256(join(CORE_DIR, file));
    if (live === forkHash) {
      current.push(file);
      // Record it as installed too: without this, editing this file in fork/core
      // next time leaves no "what the fork last wrote" hash to compare against,
      // and the installer mistakes its own file for upstream drift.
      if (lastInstalled[file] !== forkHash) {
        lastInstalled[file] = forkHash;
        recordedSomething = true;
      }
      continue;
    }
    // Clean states: upstream's original bytes, or the version the fork installed
    // last time. Anything else is an edit neither side made.
    const expectedBase = base.files?.[file];
    const expectedInstalled = lastInstalled[file];
    if (!force && expectedBase && live !== expectedBase && live !== expectedInstalled) {
      drifted.push({ file, why: `changed upstream since ${base.upstream_version}` });
      continue;
    }
    if (!check) {
      copyFileSync(join(CORE_DIR, file), target);
      lastInstalled[file] = forkHash;
      recordedSomething = true;
    }
    installed.push(file);
  }

  if (recordedSomething) {
    writeFileSync(BASE_FILE, `${JSON.stringify({ ...base, files: base.files ?? {}, installed: lastInstalled }, null, 2)}\n`, 'utf8');
  }

  if (installed.length > 0) console.log(`${check ? 'would install' : 'installed'}: ${installed.join(', ')}`);
  if (current.length > 0) console.log(`already current: ${current.join(', ')}`);
  if (installed.length === 0 && current.length > 0 && drifted.length === 0) {
    console.log('nothing to do — the fork\'s files are already in place.');
  }

  if (drifted.length > 0) {
    console.error('\nDRIFT — these files changed underneath the fork and were NOT touched:');
    for (const { file, why } of drifted) console.error(`  ${file}: ${why}`);
    console.error('\nReview upstream\'s version against fork/core/<file>, then either port the fork');
    console.error('change onto the new file by hand, or accept what is installed as the new base:');
    console.error('  node fork/apply.mjs --reset-base');
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv);
