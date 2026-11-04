#!/usr/bin/env bun
/**
 * career-ops — the one command entrypoint.
 *
 * Every command keeps its own file and its own `isMainModule` guard, so
 * `career-ops scan` still works exactly as it always has. This binary
 * only resolves a command NAME to that file and runs it, which is what gives
 * the monorepo one documented entrypoint instead of a list of paths.
 *
 *   career-ops scan --since 14
 *   career-ops merge --dry-run
 *   career-ops --list
 *
 * The registry is generated from the migration map (scripts/migration), so it
 * cannot drift from the tree: a command that moves is still listed.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS } from '../../../core/src/kernel/command-catalog.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

function usage(): never {
  const grouped = new Map<string, string[]>();
  for (const [name, entry] of Object.entries(COMMANDS)) {
    const group = entry.group;
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group)!.push(name);
  }
  console.error('career-ops — AI job search, on your machine\n');
  for (const group of [...grouped.keys()].sort()) {
    console.error(`${group}:`);
    for (const name of grouped.get(group)!.sort()) console.error(`  ${name}`);
    console.error('');
  }
  console.error('Run `career-ops <command> --help` for the command\'s own usage.');
  process.exit(1);
}

if (!command || command === '--help' || command === '-h' || command === 'help' || command === '--list') {
  usage();
}

const entry = COMMANDS[command];
if (!entry) {
  console.error(`career-ops: unknown command "${command}"\n`);
  usage();
}

/** Path to a command's script, relative to packages/cli/src/bin. */
const scriptPath = join(HERE, entry.script);
if (!existsSync(scriptPath)) {
  console.error(`career-ops: command "${command}" points at a missing file: ${scriptPath}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, [scriptPath, ...rest], { stdio: 'inherit' });
if (result.error) {
  console.error(`career-ops: could not run "${command}": ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
