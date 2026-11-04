#!/usr/bin/env node
// packages/core/src/kernel/syntax-check-child.ts — the single-process parse behind
// packages/core/src/kernel/syntax-check.ts (#5078). Not a CLI and not imported by anything:
// parseInOneProcess() starts it, once per syntax check.
//
//   node --experimental-vm-modules packages/core/src/kernel/syntax-check-child.ts < paths.json
//
// stdin:  a JSON array of .ts paths.
// stdout: {"parsed": [the indexes of the files that parsed]}
//
// A file that cannot be read or does not parse is left out of the answer and
// nothing more is said about it: the parent runs `node --check` on every file
// this does not vouch for, and that is where the diagnostic comes from.
import { readFileSync } from 'fs';
import vm from 'vm';

if (typeof vm.SourceTextModule !== 'function') {
  console.error('vm.SourceTextModule is not available (start node with --experimental-vm-modules)');
  process.exitCode = 2;
} else {
  // Read as a stream, not with readFileSync(0): a synchronous read of a piped
  // stdin has platform-specific ways to fail (EAGAIN, EOF), and a failure here
  // would only ever show up as a slower run.
  let input = '';
  process.stdin.setEncoding('utf-8');
  for await (const chunk of process.stdin) input += String(chunk);
  const files: string[] = JSON.parse(input);
  const parsed: number[] = [];
  files.forEach((file: string, i: number) => {
    try {
      // Read the way node's check_syntax.js reads it: utf-8, nothing stripped.
      // A hashbang and a byte order mark are both the parser's business.
      new vm.SourceTextModule(readFileSync(file, 'utf-8'), { identifier: file });
      parsed.push(i);
    } catch {
      // Not vouched for.
    }
  });
  process.stdout.write(JSON.stringify({ parsed }));
}
