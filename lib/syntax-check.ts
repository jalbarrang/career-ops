/**
 * syntax-check.ts — "does every one of these .ts files parse?", answered in
 * one process instead of one process per file (#5078).
 *
 * Two things syntax-check this repository: `scripts/check-syntax.ts` (run as
 * `bun run lint`) and section 1 of `test-all.ts`. Both ran `node --check` once
 * per file. `test-all.ts` put them through a pool of 8 (#2387) and still spent
 * 22 s on ~1,190 files, because the cost was never the parsing: it was starting
 * node 1,190 times. Parsing all of them in one process takes about 0.3 s.
 *
 * HOW. `node --check` on an ES module does one thing with the source:
 * `new ModuleWrap(filename, undefined, source, 0, 0)` (node's
 * lib/internal/main/check_syntax.js). `new vm.SourceTextModule(source)` makes
 * the same call (lib/internal/vm/module.js), so it is the same parser entered
 * the same way, without the process. Neither one links, resolves an import or
 * runs a line of the file.
 *
 * `vm.SourceTextModule` only exists under `--experimental-vm-modules`, so the
 * pass is a child started with that flag: lib/syntax-check-child.ts.
 *
 * WHAT IT IS TRUSTED FOR. Only for "this file parses". A file the fast pass
 * does not vouch for goes through `node --check` exactly as before, so:
 *
 *   - a syntax error prints the diagnostic it always printed;
 *   - a file the fast pass rejects wrongly costs one spawn, not a wrong verdict;
 *   - a fast pass that cannot run at all (a node without the flag, a child that
 *     died, output that is not the expected JSON) vouches for nothing, and every
 *     file is checked the old way. Slower, never less strict.
 *
 * That leaves one way to be wrong: accepting a file `node --check` would
 * reject. The shared constructor call above is the argument that it cannot, and
 * `tests/syntax-check.test.ts` is the check: it runs both over a corpus of
 * broken and unusual modules and requires the same verdict on every one.
 *
 * ONLY FOR `.ts`. `node --check` picks the goal (module or CommonJS) from the
 * extension and the nearest package.json; this parses everything as a module.
 * `collectSourceFiles()` returns nothing else, and `checkSyntax` refuses a list
 * that does.
 */

import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const FAST_PASS_CHILD = fileURLToPath(new URL('./syntax-check-child.ts', import.meta.url));

/** Options shared by the fast pass and the per-file fallback. */
interface ParseOptions {
  /** Directory relative paths resolve against. */
  cwd?: string;
  /** Node binary to start. */
  node?: string;
  /** Flags for the fast-pass child. */
  nodeArgs?: string[];
}

/** Options for one `node --check` child. */
interface CheckOptions {
  /** Directory a relative path resolves against. */
  cwd?: string;
  /** Node binary to start. */
  node?: string;
}

/** What the fast pass vouched for, and why it could not run when it could not. */
interface FastPassResult {
  parsed: Set<number>;
  unavailable: string | null;
}

/** What a full syntax check found, one entry per input file. */
interface SyntaxCheckResult {
  /** `errors[i]` is null when `files[i]` parses, in the order given. */
  errors: (Error | null)[];
  /** Null when the fast pass ran, otherwise why not. */
  fastPassUnavailable: string | null;
}

/** True for a non-null object, so a thrown value can be read without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A thrown value's `message`, stringified when it has none. */
function errorMessage(err: unknown): string {
  if (isRecord(err) && err.message != null) return String(err.message);
  return String(err);
}

/**
 * The child's answer as file indexes, or null when it is not a list of indexes
 * this run could have produced.
 */
function asIndexList(value: unknown, limit: number): number[] | null {
  if (!Array.isArray(value)) return null;
  const entries: unknown[] = value;
  const indexes: number[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry >= limit) return null;
    indexes.push(entry);
  }
  return indexes;
}

// How many `node --check` children run at once. Only reached for the files the
// fast pass did not vouch for: none on a healthy tree, all of them when the
// fast pass is unavailable, which is the case this pool was sized for (#2387).
const CHECK_POOL_SIZE = 8;
// Exported so a caller describing a timed-out check names the real limit.
export const NODE_CHECK_TIMEOUT_MS = 30000;
// The fast pass parses the whole repository in well under a second. A child
// that has not answered in this long is not going to; the per-file path is
// still there, so this only bounds how long a hung child can delay it.
const FAST_PASS_TIMEOUT_MS = 60000;

/**
 * Parse every file in one child process and report which ones parsed.
 *
 * Never throws and never reports a file as broken: the answer is the set of
 * indexes the child vouched for, and the caller decides what to do with the
 * rest. `unavailable` is null when the child ran and answered, otherwise one
 * line saying why it did not.
 *
 * @param files - Paths, absolute or relative to `cwd`.
 * @param opts - See `ParseOptions`.
 */
export async function parseInOneProcess(
  files: string[],
  {
    cwd = process.cwd(),
    node = process.execPath,
    nodeArgs = ['--experimental-vm-modules', '--no-warnings'],
  }: ParseOptions = {},
): Promise<FastPassResult> {
  const none = (why: string): FastPassResult => ({ parsed: new Set<number>(), unavailable: why });
  let stdout: string;
  try {
    const running = execFileAsync(node, [...nodeArgs, FAST_PASS_CHILD], {
      cwd,
      timeout: FAST_PASS_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    // A child that exits before reading (a rejected flag) closes the pipe under
    // this write. That failure is already reported through the exit code.
    running.child.stdin?.on('error', () => {});
    running.child.stdin?.end(JSON.stringify(files));
    ({ stdout } = await running);
  } catch (err) {
    const stderrText = isRecord(err) ? err.stderr : undefined;
    const stderr = String(stderrText ?? '').trim().split('\n').filter(Boolean).pop();
    const killed = isRecord(err) && err.killed === true;
    return none(killed ? `no answer after ${FAST_PASS_TIMEOUT_MS}ms` : stderr || errorMessage(err));
  }
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    return none('its output was not JSON');
  }
  // All or nothing. An answer that names an index that does not exist did not
  // come from the child's loop over this list, and none of it is worth believing.
  const indexes = asIndexList(isRecord(payload) ? payload.parsed : undefined, files.length);
  if (indexes === null) return none('its output was not a list of file indexes');
  return { parsed: new Set(indexes), unavailable: null };
}

/**
 * Run `node --check` on one file.
 *
 * @param file - Path, absolute or relative to `cwd`.
 * @param opts - See `CheckOptions`.
 * @returns Null when the file parses; otherwise the `execFile` error, with the
 *   child's `stderr`, `code`, `signal` and `killed`.
 */
export async function nodeCheck(
  file: string,
  { cwd = process.cwd(), node = process.execPath }: CheckOptions = {},
): Promise<Error | null> {
  // Bun has no `--check`: it ignores the unknown flag and RUNS the file, so a
  // fallback that shells out under Bun would execute every module it was asked
  // to parse. Use the in-process transpiler instead (parse only, no imports
  // resolved, nothing executed).
  if (node === process.execPath && typeof globalThis.Bun?.Transpiler === 'function') {
    try {
      new globalThis.Bun.Transpiler({ loader: 'ts' }).transformSync(readFileSync(file, 'utf-8'));
      return null;
    } catch (err) {
      const message = `SyntaxError: ${errorMessage(err).split('\n')[0]} in ${file}`;
      return Object.assign(new Error(message), { stderr: `${message}\n`, message });
    }
  }
  try {
    await execFileAsync(node, ['--check', file], { cwd, timeout: NODE_CHECK_TIMEOUT_MS });
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/**
 * Syntax-check a list of `.ts` files.
 *
 * One fast pass over all of them, then `node --check` on each file the fast
 * pass did not vouch for. Every error returned is `node --check`'s own.
 *
 * @param files - `.ts` paths, absolute or relative to `cwd`.
 * @param opts - See `ParseOptions`.
 */
export async function checkSyntax(files: string[], opts: ParseOptions = {}): Promise<SyntaxCheckResult> {
  const notMjs = files.find((f: string) => !f.endsWith('.ts'));
  if (notMjs !== undefined) {
    throw new Error(`checkSyntax parses every file as an ES module and was given ${notMjs}`);
  }
  // Bun: parse in-process with Bun's own transpiler. `bun --check` is NOT a
  // substitute — it resolves imports and type-checks, so a file importing a
  // module that is absent (every optional provider, every generated file on a
  // fresh clone) is reported as a syntax error. The transpiler only parses,
  // which is what this gate has always meant. One parser, no child processes.
  if (typeof globalThis.Bun?.Transpiler === 'function') {
    const transpiler = new globalThis.Bun.Transpiler({ loader: 'ts' });
    const errors: (Error | null)[] = files.map((file: string) => {
      try {
        transpiler.transformSync(readFileSync(file, 'utf-8'));
        return null;
      } catch (err) {
        const message = `SyntaxError: ${errorMessage(err).split('\n')[0]} in ${file}`;
        return Object.assign(new Error(message), { stderr: `${message}\n`, message });
      }
    });
    return { errors, fastPassUnavailable: null };
  }
  const { parsed, unavailable } = await parseInOneProcess(files, opts);
  const errors = new Array<Error | null>(files.length).fill(null);
  const pending = files.map((_, i: number) => i).filter((i: number) => !parsed.has(i));
  // Collected by index, so the result does not depend on which child finishes
  // first.
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < pending.length) {
      const i = pending[next++];
      errors[i] = await nodeCheck(files[i], opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CHECK_POOL_SIZE, pending.length) }, worker));
  return { errors, fastPassUnavailable: unavailable };
}
