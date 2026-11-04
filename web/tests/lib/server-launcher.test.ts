// The launcher must not be startable in a way that quietly binds every interface.
//
// An earlier version of this suite asserted that tokens appeared in server.ts's
// source text. Review showed that catches nothing: hardcoding `"-H", "0.0.0.0"`
// left it green, and so did dropping the bind from argv entirely while keeping the
// literal alive in an unused constant. Substring checks cannot see what the
// launcher does.
//
// So it is run for real, against a stub runner in a temp directory that prints the
// argv it was handed. No installed Vite, no socket, no network — the whole bind
// decision is observable from the child's output, and the startup notice from its
// stderr.
//
// The app is local-only now, so `vite dev` is the one runner and `--host` is the
// one carrier. Everything the suite is protecting is unchanged: the bind is
// decided in one place, a caller's own flag is never silently overridden, and the
// notice never claims a bind the launcher did not choose.
//
// Lives in tests/lib/ rather than mirroring server.ts's position at the web root
// because test-all.ts's web-suite parity check fails any web suite outside
// tests/lib.
//
// Run:  bun test tests/lib/server-launcher.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEV_STUB = "console.log(JSON.stringify(process.argv.slice(2)));\n";

/**
 * A throwaway web/ whose runner runs `body` instead of serving.
 *
 * @param {object} [options]
 * @param {string} [options.body]     the stub runner's source; defaults to printing what it was handed
 * @param {boolean} [options.install] false to omit the runner entirely
 */
function stubbedWebRoot({ body, install = true }: { body?: string; install?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "career-ops-launcher-"));
  cpSync(join(WEB_ROOT, "server.ts"), join(root, "server.ts"));
  cpSync(join(WEB_ROOT, "src", "lib"), join(root, "src", "lib"), { recursive: true });
  if (!install) return root;

  const viteDir = join(root, "node_modules", "vite");
  mkdirSync(join(viteDir, "bin"), { recursive: true });
  // No `exports` map, so the launcher's resolve of package.json + bin.vite works
  // the same way it does against the real package.
  writeFileSync(join(viteDir, "package.json"), JSON.stringify({ name: "vite", version: "0.0.0-stub", bin: { vite: "./bin/vite.js" } }));
  writeFileSync(join(viteDir, "bin", "vite.js"), body ?? DEV_STUB);
  return root;
}

/** Run the launcher in a stub tree and report what the runner actually received. */
function launch({ args = ["dev"], env = {}, ...stub }: { args?: string[]; env?: Record<string, string>; body?: string; install?: boolean; command?: string } = {}) {
  const root = stubbedWebRoot(stub);
  try {
    // --no-install keeps the run hermetic: Bun otherwise auto-installs a
    // missing package from its global cache, so a tree the test deliberately
    // left uninstalled would silently find a real vite and boot it.
    const nodeArgs = process.versions.bun ? ["--no-install"] : [];
    const result = spawnSync(process.execPath, [...nodeArgs, join(root, "server.ts"), ...args], {
      encoding: "utf8",
      timeout: 30_000,
      // Explicit env: the developer running the suite may have the variable set.
      env: { PATH: process.env.PATH, ...env },
    });
    assert.equal(result.error, undefined, `launcher failed to run: ${result.error?.message}`);
    return {
      status: result.status,
      signal: result.signal,
      stderr: result.stderr,
      out: result.stdout.trim() ? JSON.parse(result.stdout.trim()) : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- the bind the runner is actually told to use ----------------------------

test("with no opt-in, the dev server is told to bind loopback", () => {
  // Given a default developer run
  // When the launcher starts the dev server
  const run = launch({ args: ["dev"] });
  // Then nothing outside the machine can open a connection, and the notice names
  // the address — asserting only the phrase let a notice that announced the
  // resolved bind while the server opened every interface pass unnoticed.
  assert.deepEqual(run.out, ["dev", "--port", "3000", "--strictPort", "--host", "127.0.0.1"]);
  assert.ok(run.stderr.includes("binding 127.0.0.1"), `stderr was: ${run.stderr}`);
  assert.ok(run.stderr.includes("loopback only"), "a loopback bind should be stated plainly");
});

test("a blank opt-in is not an opt-in", () => {
  // Given a variable that is set but names nothing
  const run = launch({ args: ["dev"], env: { CAREER_OPS_WEB_ALLOWED_HOSTS: " , " } });
  // Then the bind is unchanged
  assert.deepEqual(run.out, ["dev", "--port", "3000", "--strictPort", "--host", "127.0.0.1"]);
});

test("an opt-in naming only loopback does not widen the bind", () => {
  // Given the value that used to open every interface while granting nothing
  const run = launch({ args: ["dev"], env: { CAREER_OPS_WEB_ALLOWED_HOSTS: "localhost" } });
  // Then the socket stays on loopback
  assert.deepEqual(run.out, ["dev", "--port", "3000", "--strictPort", "--host", "127.0.0.1"], "a loopback-only opt-in must not widen");
  assert.ok(!run.stderr.includes("reachable from your network"), "and must not claim exposure");
});

test("an opt-in naming a real host widens the bind and says so", () => {
  // Given a hostname, which the launcher cannot resolve to one address
  // When the launcher starts the dev server
  const run = launch({ args: ["dev"], env: { CAREER_OPS_WEB_ALLOWED_HOSTS: "nas.local" } });
  // Then it binds every interface and the user is told, with the reason
  const out = run.out as string[];
  assert.equal(out[out.indexOf("--host") + 1], "0.0.0.0", "vite carries the bind in --host");
  assert.equal(out[out.indexOf("--port") + 1], "3000");
  assert.ok(run.stderr.includes("binding 0.0.0.0"), `stderr was: ${run.stderr}`);
  assert.ok(run.stderr.includes("reachable from your network"), "widening must be announced");
  assert.ok(run.stderr.includes("nas.local"), "the notice should name what widened it");
});

test("an opt-in naming one address binds that address alone", () => {
  // Given a single LAN address. Binding 0.0.0.0 here would also publish the
  // dashboard on a VPN tunnel or a phone hotspot nobody opted in to.
  const run = launch({ args: ["dev"], env: { CAREER_OPS_WEB_ALLOWED_HOSTS: "192.168.1.50" } });
  // Then only that interface is published, and the cost is stated: one socket
  // carries one address, so localhost stops answering
  assert.deepEqual(run.out, ["dev", "--port", "3000", "--strictPort", "--host", "192.168.1.50"]);
  assert.ok(run.stderr.includes("binding 192.168.1.50"), `stderr was: ${run.stderr}`);
  assert.ok(!run.stderr.includes("binding 0.0.0.0"), "every interface must not be published");
  assert.ok(run.stderr.includes("http://localhost:3000 will not answer"), "the cost must be stated, with the real port");
});

test("naming a loopback host alongside an address opts back into every interface", () => {
  // Given the documented escape hatch for keeping localhost working
  const run = launch({ args: ["dev"], env: { CAREER_OPS_WEB_ALLOWED_HOSTS: "192.168.1.50, localhost" } });
  // Then the wider bind is taken deliberately, and not reported as costing loopback
  assert.deepEqual(run.out, ["dev", "--port", "3000", "--strictPort", "--host", "0.0.0.0"]);
  assert.ok(!run.stderr.includes("will not answer"), "0.0.0.0 still answers on loopback");
});

test("a value that reads as a switch refuses the run instead of widening", () => {
  // Given someone turning exposure off the way the variable's name suggests.
  // Every such word is a valid hostname, so this used to bind every interface.
  const run = launch({ args: ["dev"], env: { CAREER_OPS_WEB_ALLOWED_HOSTS: "off" } });
  // Then nothing starts, and the message explains what the variable is
  assert.equal(run.status, 1);
  assert.equal(run.out, null, "the dev server must not run on an unreadable opt-in");
  assert.ok(run.stderr.includes("is not a switch"), `stderr was: ${run.stderr}`);
});

// --- a caller's own host flag ------------------------------------------------

test("a caller's -H is honoured alone, with no competing bind flag", () => {
  // Given a bind override the launcher used to append after its own flag and rely
  // on commander keeping the last value — a bet against a dependency.
  const run = launch({ args: ["dev", "-H", "0.0.0.0"] });
  // Then exactly one bind flag exists, carrying the caller's value
  assert.deepEqual(run.out, ["dev", "--port", "3000", "--strictPort", "--host", "0.0.0.0"]);
  // And the run is reported as possibly exposed rather than claimed as loopback
  assert.ok(run.stderr.includes("may be reachable from your network"), "a host flag must warn");
  assert.ok(!run.stderr.includes("loopback only"), "it must not claim loopback");
  // And the combination with no honest reading is called out specifically
  assert.ok(run.stderr.includes("names no host beyond loopback"), "an open socket whose filter names nobody must be flagged");
});

test("every spelling of the host flag is recognised, including the attached short form", () => {
  // Given the spellings a shell will accept. This exact argv once printed
  // "binding 127.0.0.1 — loopback only" while opening every interface, and a LAN
  // client spoofing Host: localhost was served.
  for (const args of [["dev", "-H0.0.0.0"], ["dev", "-p", "4000", "-H0.0.0.0"], ["dev", "--hostname=0.0.0.0"], ["dev", "--host", "0.0.0.0"]]) {
    const run = launch({ args });
    // Then the caller's value is the bind, and no loopback claim is made
    assert.equal(run.out[run.out.length - 1], "0.0.0.0", `${args.join(" ")} must carry the caller's bind`);
    assert.equal(run.out.filter((token: string) => token === "--host").length, 1, `${args.join(" ")} must produce one bind flag`);
    assert.ok(!run.stderr.includes("loopback only"), `${args.join(" ")} must not claim loopback`);
  }
});

test("a loopback-only allow-list with an override is flagged, not silently passed", () => {
  // Given a non-empty allow-list that names nobody the guard could not already
  // serve — the state a length check mistook for a meaningful opt-in
  const run = launch({ args: ["dev", "-H", "0.0.0.0"], env: { CAREER_OPS_WEB_ALLOWED_HOSTS: "localhost" } });
  // Then the user is told the filter would protect nobody on an open port
  assert.ok(
    run.stderr.includes("names no host beyond loopback"),
    `a loopback-only list must not silence the notice; stderr was: ${run.stderr}`,
  );
});

test("an override alongside an opt-in still wins", () => {
  // Given an opt-in that would have widened, plus a caller pulling it back down
  const run = launch({ args: ["dev", "-H", "127.0.0.1"], env: { CAREER_OPS_WEB_ALLOWED_HOSTS: "nas.local" } });
  // Then the resolved 0.0.0.0 is neither injected nor announced
  assert.deepEqual(run.out, ["dev", "--port", "3000", "--strictPort", "--host", "127.0.0.1"]);
  assert.ok(!run.stderr.includes("binding 0.0.0.0"), "the unused resolved bind must not be announced");
});

// --- forwarding and failure modes -------------------------------------------

test("unrelated flags are forwarded untouched", () => {
  // Given a caller passing the runner's own options through npm's `--`
  const run = launch({ args: ["dev", "-p", "4000", "--open"] });
  // Then they arrive in order, after the launcher's own bind and port
  assert.deepEqual(run.out, ["dev", "--port", "4000", "--strictPort", "--host", "127.0.0.1", "--open"]);
});

test("a missing dev-server install is reported as a missing install", () => {
  // Given a checkout where bun install has not been run
  const run = launch({ args: ["dev"], install: false });
  // Then the message names the fix, rather than reporting a generic resolve error
  assert.equal(run.status, 1);
  assert.ok(run.stderr.includes("run `bun install` in web/"), `stderr was: ${run.stderr}`);
  // And the bind was still announced first, so a broken install does not hide the
  // fact that this run would have been network-reachable
  assert.ok(run.stderr.includes("loopback only"), "the bind is reported before the runner is resolved");
});

test("the child's exit code is forwarded", () => {
  // Given a dev server that fails with a distinctive status
  const run = launch({ args: ["dev"], body: "process.exit(3);\n" });
  // Then the caller sees its status, not a flattened 1
  assert.equal(run.status, 3);
});

test("a terminated child returns a non-zero platform-native status", () => {
  // Given a dev server killed by a signal rather than exiting
  const run = launch({ args: ["dev"], body: "process.kill(process.pid, 'SIGTERM');\n" });
  // Windows has no POSIX signal delivery: Node emulates SIGTERM as forced
  // termination, so only a non-zero native status is portable there. Unix reports
  // a real signal, which the launcher converts to 128+signal.
  if (process.platform === "win32") {
    assert.equal(run.signal, null, "the launcher exits normally after Windows terminates its child");
    assert.notEqual(run.status, 0, "a terminated child must not look successful");
    return;
  }
  assert.equal(run.status, 128 + os.constants.signals.SIGTERM);
  assert.notEqual(run.status, 1, "a killed server must not look like a failed launch");
});

test("an unknown command prints usage and exits 1 without starting anything", () => {
  // Given argv naming no supported subcommand
  const run = launch({ args: ["--probe-not-a-command"] });
  // Then nothing is spawned and the caller is told how to invoke it
  assert.equal(run.status, 1);
  assert.equal(run.out, null, "the runner must not start for an unknown command");
  assert.ok(run.stderr.includes("Usage: bun server.ts"), "usage should be printed");
});

// --- the scripts that reach it ----------------------------------------------

const pkg = JSON.parse(readFileSync(join(WEB_ROOT, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};

/** A script that starts a server itself, bypassing the launcher. */
const STARTS_A_SERVER_DIRECTLY = /(^|&&|\|\||\s)(next\s+(dev|start)|vite\s+dev|node\s+build\/index\.js)\b/;

test("the dev script routes through the launcher", () => {
  // Given the script a developer actually runs. `startsWith`, so that adding a
  // flag to the script is not mistaken for bypassing the launcher.
  assert.ok(scripts.dev?.startsWith("bun server.ts dev"), `dev script was: ${scripts.dev}`);
  // The packaged `start` path is gone: this app runs locally, in dev.
  assert.equal(scripts.start, undefined, "a start script would reintroduce a second runner");
});

test("no script starts a server on its own", () => {
  // Given every script in the package, not just the two above
  const offenders = Object.entries(scripts).filter(([, command]) => STARTS_A_SERVER_DIRECTLY.test(String(command)));
  assert.deepEqual(offenders, [], "a script bypassing server.ts would skip the bind decision");
});
