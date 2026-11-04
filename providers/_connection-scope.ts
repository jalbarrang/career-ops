// providers/_connection-scope.ts — give one unit of work (one board in a
// sweep) its own connection pool, and release every socket in it when the
// unit ends.
//
// Why: Node's fetch keeps one keep-alive socket open per origin it has talked
// to, and in practice those sockets stay ESTABLISHED for the rest of the
// process. Shortening keepAliveTimeout does not release them, and neither does
// a `connection: close` request header; only closing the pool does. That is
// harmless for a provider that serves a whole directory from one hostname
// (greenhouse, lever, ashby), and ruinous for one that gives every tenant its
// own hostname (workday, icims, bamboohr): a full sweep visits tens of
// thousands of distinct origins and so holds tens of thousands of idle sockets.
//
// Measured on macOS, Node 26, 2,000 BambooHR boards in one fresh process:
// established sockets grew in a straight line, ~1 per board, to 1,927 at the
// end. In the full nightly order (greenhouse, lever, ashby, workday, icims,
// bamboohr) the later stages then fail wholesale: on two consecutive nights
// Workday successes collapsed after its first 3,500-5,000 tenants, iCIMS lost
// 60-86% of its boards and BambooHR 99.9%, while the same BambooHR boards
// answered normally when fetched on their own.
//
// The scope uses undici's OWN fetch together with its Agent. Mixing the npm
// package's Agent with Node's built-in fetch is not safe across versions: an
// undici 6 Agent handed to Node 26's fetch fails every request with
// "invalid onError method", because the dispatcher handler interface changed.
// A matched pair works on every Node version this project supports.
//
// undici is optional at runtime, exactly as for trusted proxy egress in
// _http.ts: if it cannot be imported, withConnectionScope() just runs the
// work with the default pool. CAREER_OPS_CONNECTION_SCOPE=0 opts out.
//
// ON BUN. Bun resolves `undici` to its own built-in module, not the npm
// package: `mod.fetch` and `mod.Agent` exist, but the Agent has no destroy()
// (it is not a Dispatcher), and Bun's fetch already bounds its own idle pool.
// So the scope degrades to the same default-pool path as "undici unavailable"
// instead of creating an agent whose cleanup would throw. The capability check
// below is what draws that line — no Bun-specific branch, because the property
// that matters is "is this a destroyable Dispatcher", not which runtime it is.

import { AsyncLocalStorage } from 'node:async_hooks';
// Type-only: erased at build time, so undici stays optional at runtime (see
// the header). It is a declared dependency, so the types are always present
// when the project is type-checked.
import type { fetch as undiciFetch } from 'undici';

/** The one method this module needs from an undici Agent. */
export interface ConnectionScopeAgent {
  /** Abort in-flight requests and free the pool's sockets now. */
  destroy(): Promise<void>;
}

/** Constructor shape of undici's Agent, narrowed to what is used here. */
export interface ConnectionScopeAgentConstructor {
  new (options?: object): ConnectionScopeAgent;
}

/**
 * A fetch callable: undici's own fetch, which does not carry the global
 * fetch's extra statics (`preconnect`) and takes undici's RequestInit.
 */
export type ScopedFetch = typeof undiciFetch;

/** undici's own fetch, paired with its Agent. */
export interface UndiciModule {
  Agent: ConnectionScopeAgentConstructor;
  fetch: ScopedFetch;
}

/**
 * The plumbing carried for the unit of work currently running.
 *
 * `agent` and `fetch` are present only when a private pool was created, so a
 * scoped unit that only needed cancellation carries `signal` alone.
 */
export interface ConnectionScope {
  agent?: ConnectionScopeAgent;
  fetch?: ScopedFetch;
  signal?: AbortSignal;
}

/** Options for {@link withConnectionScope}. */
export interface ConnectionScopeOptions {
  /** Constructor options for the private undici Agent. */
  agentOptions?: object;
  /** Board-level abort signal, folded into every request made inside. */
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<ConnectionScope>();

let undiciModule: UndiciModule | false | null = null; // null = not tried yet, false = unavailable

async function loadUndici(): Promise<UndiciModule | false> {
  if (undiciModule !== null) return undiciModule;
  let loaded: UndiciModule | false = false;
  try {
    const mod = await import('undici');
    if (typeof mod.Agent === 'function'
      && typeof mod.fetch === 'function'
      && typeof mod.Agent.prototype?.destroy === 'function') {
      loaded = { Agent: mod.Agent, fetch: mod.fetch };
    }
  } catch {
    loaded = false;
  }
  undiciModule = loaded;
  return loaded;
}

/**
 * The pool and fetch for the unit of work currently running, if any.
 */
export function currentConnectionScope(): ConnectionScope | undefined {
  return storage.getStore();
}

/**
 * Run `fn` with a private connection pool, then destroy the pool.
 *
 * `destroy` (not `close`) is deliberate: when a caller's watchdog has already
 * given up on `fn`, its requests may still be in flight, and close() would
 * wait for them. Destroying aborts them and frees their sockets now.
 */
export async function withConnectionScope<T>(
  fn: () => Promise<T>,
  { agentOptions, signal }: ConnectionScopeOptions = {},
): Promise<T> {
  // The board-level abort signal (a sweep's per-company watchdog) rides in the
  // same store, so every scoped request can fold it into its own timeout and a
  // timed-out board stops issuing work instead of running on in the background
  // (#5570). It is carried even when the pool itself is skipped, so cancellation
  // never depends on undici being present.
  if (process.env.CAREER_OPS_CONNECTION_SCOPE === '0') {
    return signal ? storage.run({ signal }, fn) : fn();
  }
  const undici = await loadUndici();
  if (!undici) return signal ? storage.run({ signal }, fn) : fn();
  const agent = new undici.Agent(agentOptions);
  try {
    return await storage.run({ agent, fetch: undici.fetch, signal }, fn);
  } finally {
    await agent.destroy().catch(() => {});
  }
}

/**
 * Run `fn` carrying only a board-level abort signal, with no private pool.
 * Single-host sources deliberately share one pool, but a timed-out board still
 * needs its work cancelled (#5570), so they carry the signal this way.
 */
export function withAbortScope<T>(signal: AbortSignal, fn: () => T): T {
  return storage.run({ signal }, fn);
}

/**
 * The board-level abort signal for the unit of work currently running, if any.
 */
export function currentAbortSignal(): AbortSignal | null {
  return storage.getStore()?.signal ?? null;
}

/** Test hook: forget the cached import result. */
export function _resetConnectionScopeForTests(): void {
  undiciModule = null;
}
