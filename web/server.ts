#!/usr/bin/env bun
// server.ts — starts the SvelteKit dashboard on the interface bind-host.ts chooses.
//
// A thin shell on purpose: every decision lives in src/lib/bind-host.ts, which is
// pure and unit-tested, so this file only resolves the runner, reports what is
// about to be exposed, and forwards the child's exit status. See that module and
// origin-guard.ts's header for why the bind is the access control.
//
// The dashboard runs locally only, so there is ONE runner: `vite dev`, with the
// bind carried as a flag. The bind DECISION is still bind-host.ts's; this file
// extracts a caller-supplied host once and hands it to the dev server.
//
// Imports nothing outside web/: this tree is excluded from the core's packaging
// and coverage contracts (validate-system-paths-coverage.ts EXCLUDE_PREFIXES),
// so lib/cli-flags.ts and lib/is-main-module.ts are out of reach by design.

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { planDevRun } from "./src/lib/bind-host.ts";

const requireHere = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const [command, ...extra] = process.argv.slice(2);

// The packaged UI has always been served on 3000; keeping it means a bookmark, a
// docs URL and scripts/ui-server.ts all keep working. It is a preference, not a
// contract: vite steps to the next free port when it is taken.
const DEFAULT_PORT = 3000;

const plan = planDevRun({
  command,
  extra,
  envValue: process.env.CAREER_OPS_WEB_ALLOWED_HOSTS,
});
if (!plan.ok) {
  console.error(plan.error);
  process.exit(1);
}

/** `--port <n>` / `--port=<n>` / `-p <n>` / `PORT`, in that order. */
function resolvePort(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i]);
    if (token === "--port" || token === "-p") {
      const next = Number(tokens[i + 1]);
      if (Number.isInteger(next) && next > 0) return next;
    }
    if (token.startsWith("--port=")) {
      const value = Number(token.slice("--port=".length));
      if (Number.isInteger(value) && value > 0) return value;
    }
  }
  const fromEnv = Number(process.env.PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

const port = resolvePort(extra);

// Every host spelling this launcher has ever accepted, read once. bind-host owns
// presence detection for the next-era flags (`-H`, `--hostname`); vite's `--host`
// is read here, because leaving it to the child would put the bind back outside
// this process's knowledge. Nothing here interprets the value — a hostname is not
// resolvable to one address from this side, which is why the notice says the run
// *may* be reachable.
function callerHost(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i]);
    if (token === "--host" || token === "-H" || token === "--hostname") {
      return { found: true, value: tokens[i + 1] === undefined ? null : String(tokens[i + 1]) };
    }
    if (token.startsWith("--host=") || token.startsWith("--hostname=")) {
      return { found: true, value: token.slice(token.indexOf("=") + 1) };
    }
    if (/^-H./.test(token)) return { found: true, value: token.slice(2) };
  }
  return { found: false, value: null };
}

const caller = callerHost(extra);
const userHostFlag = plan.hostFlagSupplied || caller.found;

// The bind the child is told to use. A caller's own flag wins over the resolved
// one and is never rewritten: a duplicate bind flag is exactly the ambiguity this
// launcher used to lose silently.
const bindHost = userHostFlag ? caller.value : plan.bindHost;

// Reported before the runner is resolved: a user whose install is broken should
// still learn their run would have been network-reachable.
if (userHostFlag) {
  // Saying "may be" is the whole point: the value is chosen by the caller, and a
  // hostname can resolve anywhere. The alternative is asserting a bind that could
  // be wrong, which is how this launcher once announced loopback while every
  // interface was open.
  console.error(
    "career-ops web: a host flag was supplied, so this run may be reachable from your network.",
  );
  if (plan.grantsNoNewHost) {
    // The one combination with no honest reading: an open port whose Host filter
    // names nobody it could not already serve on loopback. A list of only loopback
    // spellings counts as naming nobody, which is why this asks what the list
    // grants rather than its length.
    console.error(
      "career-ops web: CAREER_OPS_WEB_ALLOWED_HOSTS names no host beyond loopback, so if that " +
        "flag opens the socket the request guard will refuse honest clients on this interface " +
        "and admit spoofed loopback ones. Name the hosts that should reach it in that variable.",
    );
  }
} else if (plan.widened) {
  console.error(
    `career-ops web: binding ${plan.bindHost} — reachable from your network ` +
      `(allowed hosts: ${plan.allowedHosts.join(", ") || "none"}).`,
  );
  if (plan.loopbackUnreachable) {
    console.error(
      `career-ops web: one socket carries one address, so a localhost URL will not answer — ` +
        `open the address vite prints (${plan.bindHost}). Name a loopback host alongside it to bind every interface instead.`,
    );
  }
} else {
  console.error(`career-ops web: binding ${plan.bindHost} — loopback only.`);
}

/** Everything except the host and port flags this launcher owns. */
function forwardedFlags(tokens) {
  const kept = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i]);
    if (token === "--port" || token === "-p" || token === "--host" || token === "-H" || token === "--hostname") {
      i += 1;
      continue;
    }
    if (
      token.startsWith("--port=") ||
      token.startsWith("--host=") ||
      token.startsWith("--hostname=") ||
      /^-H./.test(token) ||
      /^-p\d/.test(token)
    ) {
      continue;
    }
    kept.push(tokens[i]);
  }
  return kept;
}

const rest = forwardedFlags(extra);

let child;
if (command === "dev") {
  // vite's declared entry, not the private dist path: node_modules/.bin/vite is a
  // .cmd on Windows that spawn() cannot exec without a shell, and a shell would
  // reparse every forwarded argument.
  let viteEntry;
  try {
    const manifest = requireHere.resolve("vite/package.json");
    viteEntry = join(dirname(manifest), requireHere(manifest).bin.vite);
    // Bun's require.resolve falls back to its global install cache, so a
    // checkout with no local install can still return a path — one that does
    // not exist when the cache has never held vite. Verify the entry itself, or
    // "not installed here" is reported as a spawn failure instead of the fix.
    if (!existsSync(viteEntry)) throw Object.assign(new Error("vite entry missing"), { code: "MODULE_NOT_FOUND" });
  } catch (err) {
    console.error(
      err.code === "MODULE_NOT_FOUND"
        ? "Cannot find vite — run `bun install` in web/ and retry."
        : `Cannot resolve vite (${err.code ?? "error"}): ${err.message}`,
    );
    process.exit(1);
  }
  // One bind flag, always: the caller's when they supplied one, otherwise the
  // resolved one. No strictPort: the port above is a preference, so a taken one
  // makes vite try the next free port and print the URL it bound. That printed
  // URL is the only place a URL is stated — asserting one here would be the lie
  // strictPort used to trade a failed start for.
  const hostArgs = bindHost ? ["--host", bindHost] : [];
  child = {
    argv: [viteEntry, "dev", "--port", String(port), ...hostArgs, ...rest],
    env: process.env,
    label: "the dev server",
  };
} else {
  // Local-only app: `dev` is the only supported runner. A packaged `start`
  // (adapter-node) used to live here; it was never reached by `bun run ui`.
  console.error(`Unknown command "${command}". Usage: bun server.ts dev [--port <n>] [--host <addr>]`);
  process.exit(2);
}

// cwd is pinned to this file's directory rather than inherited: career-ops.ts
// resolves the checkout as `resolve(process.cwd(), "..")`, so a run started from
// the repo root would otherwise read the repo's PARENT as the career-ops root.
//
// spawnSync because the child runs until Ctrl-C and this process has nothing to
// do meanwhile. The terminal delivers SIGINT to the whole foreground group, so the
// child shuts itself down; re-signalling it from here would only double up.
const result = spawnSync(process.execPath, child.argv, {
  cwd: here,
  env: child.env,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Could not start ${child.label}: ${result.error.message}`);
  process.exit(1);
}
// A signalled child reports status null. Exiting 128+signal keeps a SIGTERM
// distinguishable from a startup failure.
process.exit(result.signal ? 128 + (os.constants.signals[result.signal] ?? 0) : result.status ?? 1);
