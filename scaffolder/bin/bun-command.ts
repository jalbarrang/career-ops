// How the scaffolder launches Bun.
//
// The npm version of this module existed because npm on Windows is a
// `npm.cmd` batch shim, and Node refuses to run a .cmd or .bat file through
// execFile/spawn without a shell (CVE-2024-27980): `spawnSync npm.cmd EINVAL`
// left every Windows user with a clone and no dependencies. That whole class
// of problem is gone here: Bun ships one native executable (`bun`, `bun.exe`)
// on every platform, which execFileSync runs directly. There is no shim to
// dodge and no cmd.exe fallback to escape through.
//
// Arguments are still validated before they reach execFileSync: a caller that
// forwards user text must not be able to smuggle shell syntax into a command
// line, and the check keeps that property obvious at the one place a process
// is started.

const SAFE_ARG = /^[\w.@=:/-]+$/;

/**
 * Returns `{ file, args }` for execFileSync/spawnSync to run `bun <bunArgs>`.
 * `bunArgs` must be plain tokens (e.g. "install", "--version").
 */
export function bunCommand(bunArgs) {
  for (const arg of bunArgs) {
    if (!SAFE_ARG.test(arg)) throw new Error(`bunCommand: refusing unsafe bun argument ${JSON.stringify(arg)}`);
  }
  return { file: "bun", args: [...bunArgs] };
}
