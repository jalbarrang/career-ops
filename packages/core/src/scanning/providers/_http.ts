// HTTP transport helpers shared across providers.
// Files prefixed with _ are never loaded as providers by scan.ts.

import './_dns-cache.ts'; // memoize dns.lookup process-wide (see that file)
import { isIP } from 'node:net';
import {
  DEFAULT_USER_AGENT,
  BROWSER_LIKE_USER_AGENT,
  MACOS_BROWSER_LIKE_USER_AGENT,
} from '../../kernel/user-agent.ts';
import { providerFetchContext, isBlockedAddress, blockedAddressError } from './_ip-guard.ts';
import { currentConnectionScope, currentAbortSignal } from './_connection-scope.ts';
import { normalizeUrl, aggregatorPostingId } from '../../kernel/url-key.ts';
import type { Context, FetchOptions } from './_types.ts';

/**
 * An `Error` carrying the HTTP response metadata this module attaches on a
 * non-2xx: `status`, the raw `body`, the `Retry-After` value, and (only under
 * `redirect: 'manual'`) the `Location` it would have followed. `attempts` is
 * added by the retry loop — the real request count, not the `retries + 1`
 * ceiling.
 */
export interface HttpError extends Error {
  status?: number;
  body?: string;
  retryAfter?: string | null;
  location?: string | null;
  attempts?: number;
}

/** Per-request options, plus the in-flight hook makeHttpCtx() installs. */
export interface RequestOptions extends FetchOptions {
  /** Called with the live Response before its body is read. */
  onResponse?: (res: Response) => void;
}

/** A clock a caller can substitute so tests never wall-clock wait. */
export interface SleepContext {
  sleep?: (ms: number) => Promise<void>;
}

/** Transport surface the JSON retry helper needs. */
export interface JsonFetchContext extends SleepContext {
  fetchJson: (url: string, opts?: RequestOptions) => Promise<unknown>;
}

/** Transport surface the text retry helper needs. */
export interface TextFetchContext extends SleepContext {
  fetchText: (url: string, opts?: RequestOptions) => Promise<string>;
}

/** Transport surface the raw-Response retry helper needs. */
export interface ResponseFetchContext extends SleepContext {
  fetchResponse: (url: string, opts?: RequestOptions) => Promise<Response>;
}

/** Bounded-retry policy shared by every provider that paginates a large board. */
export interface RetryPolicy {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * The request init this module builds. `dispatcher` is undici's — opaque here
 * because undici is an optional runtime dependency — so it is respelled as
 * `unknown` rather than dragged in as a type.
 */
export type FetchInit = Omit<RequestInit, 'dispatcher'> & { dispatcher?: unknown };

/**
 * The minimal call shape both the global `fetch` and undici's `fetch` satisfy:
 * a URL plus an init object, resolving to a `Response`.
 */
export type FetchCall = (url: string, init: FetchInit) => Promise<Response>;

/** Whether a caught value is a non-null object — an `Error` included. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The `typeof` test the retry loop applies before attaching `.attempts`: a
 * rejection is not guaranteed to be an object, and primitive values refuse
 * property assignment.
 */
function canCarryProperties(value: unknown): value is Record<string, unknown> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** Narrow any fetch-shaped value (global fetch or undici's) to {@link FetchCall}. */
function asFetchCall(value: unknown): FetchCall | null {
  return typeof value === 'function' ? (value as FetchCall) : null;
}

/** The global fetch in this module's call shape. */
function globalFetchCall(): FetchCall {
  const impl = asFetchCall(fetch);
  if (!impl) throw new Error('providers/_http: global fetch is unavailable');
  return impl;
}

/** The HTTP status attached to a caught value, or undefined when it carries none. */
function statusOf(err: unknown): unknown {
  return isRecord(err) ? err.status : undefined;
}

/** The `Retry-After` header value attached to a caught value, or null. */
function retryAfterOf(err: unknown): string | null {
  const value = isRecord(err) ? err.retryAfter : null;
  return typeof value === 'string' ? value : null;
}

/** The board-level abort signal of the unit of work currently running, if any. */
function boardAbortSignal(): AbortSignal | null {
  const signal = currentAbortSignal();
  return signal instanceof AbortSignal ? signal : null;
}

export { BROWSER_LIKE_USER_AGENT, MACOS_BROWSER_LIKE_USER_AGENT };

const MAX_TIMER_MS = 2_147_483_647; // setTimeout rewrites anything above this to 1ms

/**
 * Resolve the default per-request timeout from the environment.
 *
 * 10s suits almost every board, but a provider that returns its whole catalogue
 * in one response can legitimately need longer, and when it does the abort
 * surfaces as an unreachable portal rather than as a timeout — so the board
 * reads as broken instead of slow. Raising the budget is a deployment concern
 * rather than a code change, so it is read from the environment.
 *
 * Unusable values fall back to the default rather than failing a scan at
 * request time: a typo in an env var should not take the scanner down.
 *
 * "Unusable" includes anything outside setTimeout's honored range, not just
 * values that fail to parse. A delay below 1ms or above 2_147_483_647ms is
 * silently rewritten to 1ms, so accepting one would abort every request almost
 * immediately — the failure this variable exists to prevent, arrived at by a
 * typo instead of a slow board. Falling back is the quieter outcome: a scan at
 * the 10s default beats a scan where every portal reads as unreachable.
 *
 * @param {unknown} raw - Raw env value (CAREER_OPS_HTTP_TIMEOUT_MS).
 * @param {number} [fallback=10_000] - Value used when `raw` is unusable.
 * @returns {number} Milliseconds.
 */
export function resolveDefaultTimeoutMs(raw: unknown, fallback = 10_000): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_TIMER_MS) return fallback;
  return parsed;
}

const DEFAULT_TIMEOUT_MS = resolveDefaultTimeoutMs(process.env.CAREER_OPS_HTTP_TIMEOUT_MS);
let proxyAgent: unknown;
let proxySignature: string | undefined;

/** What one request needs from the proxy configuration, if any. */
interface ProxySelection {
  /** An undici `Dispatcher`, or undefined when this request goes direct. */
  dispatcher: unknown;
  /** The trusted proxy's own host, exempt from the pre-flight DNS check. */
  proxyHost: string | undefined;
  /** The fetch implementation paired with `dispatcher`. */
  fetchImpl?: FetchCall;
}

async function proxyFor(url: string): Promise<ProxySelection> {
  if (process.env.CAREER_OPS_TRUST_PROXY_EGRESS !== '1') return { dispatcher: undefined, proxyHost: undefined };
  const target = new URL(url);
  const httpProxy = process.env.http_proxy || process.env.HTTP_PROXY || '';
  const httpsProxy = process.env.https_proxy || process.env.HTTPS_PROXY || httpProxy;
  const noProxy = process.env.no_proxy || process.env.NO_PROXY || '';
  const proxyUrl = target.protocol === 'https:' ? httpsProxy : httpProxy;
  if (!proxyUrl) return { dispatcher: undefined, proxyHost: undefined };
  for (const configuredProxy of [httpProxy, httpsProxy]) {
    if (!configuredProxy) continue;
    const parsed = new URL(configuredProxy);
    if ((parsed.username || parsed.password) && parsed.protocol !== 'https:') {
      throw new Error('Proxy URLs containing credentials must use HTTPS to protect proxy authentication.');
    }
  }
  const proxyHost = new URL(proxyUrl).hostname.replace(/^\[|\]$/g, '');
  // The agent honours NO_PROXY and is scoped to this one provider request.
  // Unrelated fetches keep their normal dispatcher. A direct NO_PROXY request
  // still resolves its destination under the provider DNS guard.
  const signature = [process.env.http_proxy, process.env.HTTP_PROXY, process.env.https_proxy,
    process.env.HTTPS_PROXY, process.env.no_proxy, process.env.NO_PROXY].join('\0');
  // Bun: its `undici` is a built-in shim, and its fetch already honours the
  // proxy environment variables itself (HTTP_PROXY et al., including NO_PROXY).
  // Handing it a Dispatcher would do nothing, so use the global fetch. The
  // difference that matters: Node's proxy support is per-request through this
  // agent, Bun's is process-wide, so anything else in the process talks to the
  // proxy too while the variables are set.
  if (typeof globalThis.Bun !== 'undefined') {
    return { dispatcher: undefined, proxyHost, fetchImpl: asFetchCall(fetch) ?? undefined };
  }
  // Existing installations can keep direct transport without installing undici.
  // Resolve the optional transport only after both the trust flag and proxy URL.
  const { EnvHttpProxyAgent, fetch: undiciFetch } = await import('undici').catch((cause: unknown) => {
    throw new Error('Trusted proxy egress requires undici; run bun install in the career-ops directory, then retry.', { cause });
  });
  if (signature !== proxySignature) {
    proxyAgent = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy });
    proxySignature = signature;
  }
  return { dispatcher: proxyAgent, proxyHost, fetchImpl: asFetchCall(undiciFetch) ?? undefined };
}

/**
 * Run a fetch under an `AbortController` timeout, inside the provider-fetch
 * async context so the patched DNS lookup validates the addresses it resolves.
 * `consume` reads the body while the timer is still armed.
 *
 * @param {string} url
 * @param {FetchOptions} [opts]
 * @param {(res: Response) => Promise<T>} consume
 * @param {boolean} [allowManualRedirectResponse]
 * @returns {Promise<T>}
 */
async function fetchWithTimeout<T>(url: string, opts: FetchOptions = {}, consume: (res: Response) => Promise<T>, allowManualRedirectResponse = false): Promise<T> {
  const targetHost = new URL(url).hostname.replace(/^\[|\]$/g, '');
  const { dispatcher, proxyHost, fetchImpl } = await proxyFor(url);
  // A literal IP host never reaches dns.lookup, so the lookup-time guard in
  // _ip-guard.ts never sees it: http://127.0.0.1/, http://[::ffff:127.0.0.1]/
  // and http://2130706433/ were all dialled on the direct path while
  // http://localhost/ was refused. Check the literal here, on every path, not
  // only behind a proxy. `new URL()` has already normalised the integer, octal
  // and hex spellings of IPv4 to a dotted quad, and isBlockedAddress unwraps
  // the IPv4-mapped IPv6 form.
  if (isIP(targetHost) && isBlockedAddress(targetHost)) throw blockedAddressError(targetHost, targetHost);
  // Bun's fetch resolves names natively (it does not go through node:dns), so
  // the lookup-time guard never runs there and a hostname with an A record
  // pointing at loopback would be dialled. Resolve the name once, before the
  // request, and refuse. This is a pre-flight check, not the lookup-time one:
  // it cannot see a DNS-rebinding answer that changes between resolve and
  // connect, which is exactly why the Node path keeps validating inside
  // dns.lookup. The trusted proxy's own host is exempt for the same reason it
  // is exempt there — its operator resolves the destination remotely.
  if (typeof globalThis.Bun !== 'undefined' && !isIP(targetHost) && targetHost !== proxyHost) {
    const { lookup } = await import('node:dns/promises');
    const answers = await lookup(targetHost, { all: true }).catch(() => []);
    for (const { address } of answers) {
      if (isBlockedAddress(address)) throw blockedAddressError(address, targetHost);
    }
  }
  // Mark this request as provider traffic for the whole of its async life, so
  // the patched dns.lookup validates the addresses it resolves (#3096). The
  // guard is scoped rather than global because _dns-cache.ts patches
  // node:dns process-wide, and loopback has to keep working for everything
  // that is not a provider fetch — see providers/_ip-guard.ts.
  //
  // AsyncLocalStorage.run wraps the ENTIRE fetch, not just the call that
  // starts it: the DNS lookup happens inside connect, well after the
  // synchronous part of fetch() has returned, and the context has to still be
  // entered when it does.
  return providerFetchContext.run({ url: String(url), targetHost, proxyHost },
    () => fetchInContext(url, opts, consume, dispatcher, allowManualRedirectResponse, fetchImpl));
}

// redirect defaults to 'error': a provider fetch must never follow a 3xx, or a
// server-side redirect could point the request at a private address after the
// ip guard already passed the original host (#4079). Callers that really need
// to follow redirects opt in explicitly.
/**
 * @param {string} url
 * @param {RequestOptions} [opts]
 * @param {(res: Response) => Promise<T>} consume
 * @param {import('undici').Dispatcher} [dispatcher]
 * @param {boolean} [allowManualRedirectResponse]
 * @param {unknown} [fetchImpl] undici's fetch when a proxy dispatcher is used; global fetch otherwise.
 * @returns {Promise<T>}
 */
async function fetchInContext<T>(
  url: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, redirect = 'error', onResponse }: RequestOptions = {},
  consume: (res: Response) => Promise<T>,
  dispatcher: unknown,
  allowManualRedirectResponse = false,
  fetchImpl: unknown = fetch,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Defaults go through Headers so a caller's override wins whatever its
    // capitalization. An object spread only replaces an identical key: a caller's
    // 'User-Agent' sat beside the default 'user-agent', and fetch JOINED the two
    // into one comma-separated value instead of replacing it.
    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has('user-agent')) requestHeaders.set('user-agent', DEFAULT_USER_AGENT);
    // accept-encoding is pinned to the codecs undici decodes correctly.
    // Left unset, Node negotiates zstd, and amazon.jobs' zstd response comes
    // back TRUNCATED AT 1024 BYTES with a 200 status — so the failure surfaces
    // as an unrelated-looking "Unterminated string in JSON at position 1024"
    // rather than a transport error. curl on the same URL returns the full
    // ~900KB. Callers can still override via `headers`.
    if (!requestHeaders.has('accept-encoding')) requestHeaders.set('accept-encoding', 'gzip, deflate, br');
    // A sweep runs each board inside withConnectionScope() so its sockets are
    // released when the board is done (see _connection-scope.ts). The scope
    // brings its own fetch: undici's Agent is only safe with undici's fetch.
    // A trusted-proxy dispatcher, when configured, still takes precedence,
    // together with the fetchImpl proxyFor() paired it with.
    const scope = dispatcher ? undefined : currentConnectionScope();
    // A sweep's per-company watchdog aborts the board's signal when it times
    // out; fold it into this request's own timeout so an abandoned board stops
    // mid-flight instead of running on in the background (#5570). Read straight
    // from the store so it also applies on the trusted-proxy path, where the
    // pool `scope` is left undefined.
    const boardSignal = boardAbortSignal();
    const requestSignal = boardSignal
      ? AbortSignal.any([controller.signal, boardSignal])
      : controller.signal;
    // A scope carries undici's own fetch alongside its pool, so the two stay
    // paired (see _connection-scope.ts). Narrowed structurally: the shared
    // module is JavaScript-first, so its store is only known to be an object.
    const scopedFetch = isRecord(scope) ? asFetchCall(scope.fetch) : null;
    const scopedAgent = isRecord(scope) ? scope.agent : undefined;
    const impl = scopedFetch ?? asFetchCall(fetchImpl) ?? globalFetchCall();
    let res: Response;
    try {
      res = await impl(url, {
        method,
        headers: requestHeaders,
        body,
        redirect,
        signal: requestSignal,
        dispatcher: dispatcher ?? scopedAgent,
      });
    } catch (err) {
      const cause = isRecord(err) ? err.cause : undefined;
      const code = isRecord(cause) ? cause.code : undefined;
      if (!dispatcher && (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
        && (process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY)) {
        if (isRecord(err)) {
          err.message = `${String(err.message)} (proxy variables are set but provider requests use direct fetch; set CAREER_OPS_TRUST_PROXY_EGRESS=1 only if your proxy blocks private destination addresses)`;
        }
      }
      throw err;
    }
    onResponse?.(res);
    const isInspectableManualRedirect = allowManualRedirectResponse
      && redirect === 'manual'
      && res.status >= 300
      && res.status < 400;
    if (!res.ok && !isInspectableManualRedirect) {
      const responseText = await res.text().catch(() => '');
      // WAF/CDN challenge pages (seen live: Workday 429s) carry no actionable
      // text — HTML markup or a generic interstitial message, not worth
      // parsing or displaying. The status code and its standard reason
      // phrase are what a log line needs; the raw body is still attached as
      // err.body for callers that want to inspect it.
      const err: HttpError = Object.assign(
        new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`),
        {
          status: res.status,
          body: responseText,
          retryAfter: res.headers.get('retry-after'),
          // Only ever populated under redirect:'manual', where the 3xx arrives as a
          // non-ok response instead of being followed or thrown. Attached so a
          // caller can tell WHICH redirect it hit without gaining the ability to
          // follow it: jobvite distinguishes a feed pointing at NoJobs.htm (an
          // empty board) from a board pointing at search.jobvite.com?invalid=1 (a
          // retired tenant), and those two need opposite handling. Relative, as the
          // server wrote it — resolve against the request URL before matching.
          location: res.headers.get('location'),
        },
      );
      throw err;
    }
    // Body consumption must stay inside the timer window: a server that sends
    // headers and then stalls the body otherwise hangs the caller forever
    // (this froze full-directory sweeps silently — 20 workers all stuck on
    // stalled reads with the abort timer already cleared).
    return await consume(res);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a JSON response, with the shared timeout and non-2xx guard.
 *
 * @param {string} url
 * @param {FetchOptions} [opts]
 * @returns {Promise<unknown>} Parsed JSON.
 * @throws {HttpError} On a non-2xx response.
 */
export async function fetchJson(url: string, opts: FetchOptions = {}): Promise<unknown> {
  return fetchWithTimeout(url, opts, (res) => res.json());
}

/**
 * Fetch only the head of a text response.
 *
 * Board landing pages carry the owner's name in <title>, but the page itself can
 * be a megabyte of embedded job JSON (jobs.lever.co ships ~950KB and ignores a
 * Range request). Reading the whole thing to learn one string would be exactly the
 * "slow and rude to the careers site" behavior the probe path avoids elsewhere, so
 * this stops at maxBytes and cancels the body.
 *
 * @param {string} url
 * @param {{ maxBytes?: number }} [opts]
 * @returns {Promise<string>} The first maxBytes of the body, decoded as UTF-8.
 * @throws {HttpError} On a non-2xx response.
 */
export async function fetchTextHead(url: string, opts: { maxBytes?: number } = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? 8192;
  return fetchWithTimeout(url, opts, async (res) => {
    const reader = res.body?.getReader?.();
    if (!reader) return String(await res.text()).slice(0, maxBytes);
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(Buffer.from(value));
        total += value.length;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* body already closed */
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  });
}

/**
 * Fetch a response body as text, with the shared timeout and non-2xx guard.
 *
 * @param {string} url
 * @param {FetchOptions} [opts]
 * @returns {Promise<string>}
 * @throws {HttpError} On a non-2xx response.
 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  return fetchWithTimeout(url, opts, (res) => res.text());
}

// Returns a Response (after the timeout + non-2xx guard) so providers that need
// response headers — csod.ts reads Set-Cookie to prime the session its search
// API requires — can route through ctx instead of re-implementing fetch. Pass
// redirect:'error' is the default here like everywhere else, so a 3xx can't be
// followed to a private IP.
//
// The body is read here, inside the timer window, and handed back as an
// equivalent Response. Under redirect:'manual', a 3xx is also returned so a
// stateful provider can inspect and validate Location before following it;
// fetchText/fetchJson retain their existing structured-error contract. Two
// reasons the response is reconstructed: returning the live Response would let a
// server that stalls its body hang the caller forever with the abort timer
// already cleared (the failure fetchWithTimeout documents above), and this
// function previously omitted the `consume` argument entirely, so it threw
// "consume is not a function" on every call — it had no working callers to
// preserve bug-compatibility with. Header identity, including repeated
// Set-Cookie (getSetCookie()), survives the reconstruction.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
/**
 * Like {@link fetchJson} / {@link fetchText}, but resolves to a reconstructed
 * `Response` (body already read inside the timeout window) so a provider can
 * read response headers — csod.ts reads Set-Cookie to prime its session. Pass
 * `redirect: 'error'` like every other provider call.
 *
 * @param {string} url
 * @param {FetchOptions} [opts]
 * @returns {Promise<Response>}
 * @throws {HttpError} On a non-2xx response.
 */
export async function fetchResponse(url: string, opts: FetchOptions = {}): Promise<Response> {
  return await fetchWithTimeout(url, opts, async (res) => {
    const body = NULL_BODY_STATUSES.has(res.status) ? null : await res.text();
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  }, true);
}

/** Jitter added to a backoff so concurrent retries don't re-collide in lockstep. */
const JITTER_MS = 250;

/**
 * Retry policy shared by providers that paginate a large board.
 *
 * Two retries = three total attempts, matching what #2506 asked for. Not every
 * provider wants this exact cadence — workday.ts and oraclecloud.ts pass
 * `{ retries: 3 }` explicitly to keep their own tuning — which is why the
 * policy is a parameter rather than baked in.
 */
const RETRY_DEFAULTS = { retries: 2, baseDelayMs: 500, maxDelayMs: 8_000 };

/**
 * undici's `err.cause.message` for a `fetch(url, { redirect: 'error' })` that
 * met a 3xx — the shape every provider's mandatory SSRF guard (#1440) produces
 * on a refused redirect. Not documented anywhere; pinned here (and by the test
 * in tests/providers/_http.test.ts) so a future Node/undici bump that changes
 * the wording fails loudly instead of silently reverting to over-retrying.
 * Present since Node 18.5; older Node reports `cause` as `undefined`, so this
 * check doesn't fire and isRetryableError() falls through to its old
 * (retryable) classification.
 */
const REDIRECT_REFUSAL_CAUSE_MESSAGE = 'unexpected redirect';

/**
 * Awaitable sleep that honours a ctx-supplied clock, so tests never wall-clock
 * wait. `ctx` is the SECOND argument — a swapped `sleep(ctx, ms)` hands an
 * object to `setTimeout` and resolves on the next tick instead of pacing.
 *
 * @param {number} ms - Delay in milliseconds.
 * @param {{ sleep?: (ms: number) => Promise<void> }} [ctx] - Transport context; a
 *   `sleep` clock on it (tests supply one) is awaited instead of `setTimeout`.
 * @returns {Promise<void>}
 */
export function sleep(ms: number, ctx?: SleepContext): Promise<void> {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * sleep(), but resolves at once if `signal` aborts partway — a retry backoff
 * must not keep a board the watchdog has already given up on pending for its
 * full delay (#5570).
 *
 * @param {number} ms
 * @param {{ sleep?: (ms: number) => Promise<void> }} [ctx]
 * @param {AbortSignal | null} [signal]
 * @returns {Promise<void>}
 */
export function abortableSleep(ms: number, ctx?: SleepContext, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return sleep(ms, ctx);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); resolve(); };
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    // Settle with the sleep's own result so a rejecting clock propagates
    // instead of hanging the promise and surfacing as an unhandled rejection.
    Promise.resolve(sleep(ms, ctx)).then(
      (value) => { cleanup(); resolve(value); },
      (err: unknown) => { cleanup(); reject(err); },
    );
  });
}

/**
 * Milliseconds from a Retry-After header, in either permitted form (delta
 * seconds or an HTTP-date). Null when absent or unparseable.
 *
 * @param {(string | null | undefined)} value - Raw `Retry-After` header value.
 * @returns {(number | null)}
 */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

/**
 * Whether a failure is a redirect refused by the mandatory SSRF guard —
 * `redirect:'error'` meeting a 3xx (#1440). It arrives as a bare TypeError
 * with no `.status`, indistinguishable by shape from a timeout or a DNS
 * failure, and only `err.cause.message` tells them apart.
 *
 * Exported because the verdict has two consumers, not one. isRetryableError()
 * below needs it to stop retrying; packages/cli/src/commands/scanning/discover-ats.ts needs it to stop telling a
 * human to re-run. Before it was shared, those two disagreed about the same
 * error object: the retry layer called it deterministic while the CLI reported
 * "board status unknown — re-run", and 48 of one user's 62 companies were
 * BambooHR answering "no such tenant" with a 302 (#3788).
 *
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRefusedRedirectError(err: unknown): boolean {
  if (statusOf(err) !== undefined) return false;
  if (!(err instanceof TypeError)) return false;
  const cause = isRecord(err.cause) ? err.cause : undefined;
  return isRecord(cause) && cause.message === REDIRECT_REFUSAL_CAUSE_MESSAGE;
}

/**
 * Whether a failed request is worth retrying: 429, any 5xx, or a transport
 * error (no status — timeout/abort/DNS). A 4xx other than 429 is the server
 * telling us the request itself is wrong, and retrying it just burns time.
 *
 * A refused redirect (redirect:'error' meeting a 3xx) surfaces as a bare
 * TypeError with no .status — the same shape as a transient network error —
 * but it's deterministic and will never succeed on retry. See
 * isRefusedRedirectError() above for how it's distinguished.
 *
 * @param {unknown} err - A thrown value: an Error with an optional `.status`, or anything else.
 * @returns {boolean}
 */
export function isRetryableError(err: unknown): boolean {
  const status = statusOf(err);
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  if (isRefusedRedirectError(err)) return false;
  return status === undefined; // network error / timeout / abort — no status set
}

/**
 * Bounded retry on transient failures, around any request.
 *
 * Shared by every provider that retries a fetch (a16z-speedrun-talent.ts,
 * workday.ts, oraclecloud.ts, each via its own `policy` override — see
 * RETRY_DEFAULTS above) so all of them get the same mature semantics —
 * exponential backoff, jitter, and a Retry-After that is honoured but
 * CLAMPED so a hostile or misconfigured `Retry-After: 86400` cannot stall a
 * sweep — instead of each one re-deriving them independently.
 *
 * Deliberately does NOT decide what happens when retries are exhausted: it
 * rethrows, and the caller chooses. That policy genuinely differs per provider
 * — workday truncates the tenant with a warning and keeps the pages it has,
 * while a16z must fail loudly rather than return a silent partial board. The
 * rethrown error carries `.attempts` (how many requests were actually made)
 * so a caller logging a summary doesn't have to assume the full `retries + 1`
 * — a non-retryable error can end the loop after just one.
 *
 * Nothing in the loop ever inspected the response body, so it is parameterised
 * by the request rather than duplicated per content type: `fetchJsonWithRetry`
 * and `fetchTextWithRetry` are the same policy over a different transport call.
 * Splitting them into two copies is how the entity decoders drifted (#1555,
 * #1639).
 *
 * @param {() => Promise<T>} request - Performs one attempt.
 * @param {{ sleep?: (ms: number) => Promise<void> }} ctx - Transport context (may supply a test clock).
 * @param {{ retries?: number, baseDelayMs?: number, maxDelayMs?: number }} [policy]
 * @returns {Promise<T>} Whatever `request` resolves to on its first success.
 */
async function withRetry<T>(request: () => Promise<T>, ctx: SleepContext, policy: RetryPolicy = {}): Promise<T> {
  const { retries, baseDelayMs, maxDelayMs } = { ...RETRY_DEFAULTS, ...policy };
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await request();
    } catch (err) {
      lastErr = err;
      // A rejection isn't guaranteed to be an object — assigning a property to
      // a primitive (a string, a number) throws in strict mode (ESM always is),
      // which would replace the real rejection with an unrelated TypeError
      // right here in the catch, before any caller sees it.
      if (canCarryProperties(err)) err.attempts = attempt + 1;
      // A board whose watchdog has already fired must not keep retrying: that is
      // the 4-attempts-per-slice storm a timed-out Workday board left running in
      // the background (#5570). The abort is terminal, not a transient failure.
      if (attempt === retries || !isRetryableError(err) || boardAbortSignal()?.aborted) throw err;
      // Cap the backoff at maxDelayMs MINUS the jitter, so the jittered total
      // still honours the policy limit. Clamping the sum instead would erase
      // the jitter exactly at the cap — where every retry has converged on the
      // same delay and de-synchronising them matters most.
      //
      // The jitter itself is clamped to maxDelayMs first: a caller passing a
      // maxDelayMs below JITTER_MS would otherwise drive the backoff negative
      // and hand ctx.sleep a negative delay.
      const jitterMs = Math.min(JITTER_MS, Math.max(0, maxDelayMs));
      const ceiling = Math.max(0, maxDelayMs - jitterMs);
      const backoff = Math.min(baseDelayMs * 2 ** attempt, ceiling);
      const retryAfterMs = parseRetryAfterMs(retryAfterOf(err));
      const delayMs = retryAfterMs !== null
        ? Math.min(retryAfterMs, maxDelayMs * 4)
        : backoff + Math.random() * jitterMs;
      // Interruptible: if the board's watchdog fires during the backoff, stop
      // waiting and give up rather than sleeping out the delay and then issuing
      // a doomed attempt (#5570).
      await abortableSleep(delayMs, ctx, boardAbortSignal());
      if (boardAbortSignal()?.aborted) throw lastErr;
    }
  }
  throw lastErr;
}

/**
 * Fetch JSON with bounded retry on transient failures.
 *
 * @param {{ fetchJson: (url: string, opts?: FetchOptions) => Promise<unknown>, sleep?: (ms: number) => Promise<void> }} ctx - Transport context.
 * @param {string} url - Absolute URL.
 * @param {FetchOptions} [opts] - Passed through to ctx.fetchJson.
 * @param {{ retries?: number, baseDelayMs?: number, maxDelayMs?: number }} [policy]
 * @returns {Promise<unknown>} Parsed JSON.
 */
export async function fetchJsonWithRetry(ctx: JsonFetchContext, url: string, opts: FetchOptions = {}, policy: RetryPolicy = {}): Promise<unknown> {
  return withRetry(() => ctx.fetchJson(url, opts), ctx, policy);
}

/**
 * Fetch text with bounded retry on transient failures.
 *
 * Same policy as the JSON form; exists because rate limiting is not a property
 * of the content type. jobvite's XML feed answers `429 Retry-After: 30` from
 * the second request onward — reliably enough that scanning two tenants
 * back-to-back trips it — and a scraped HTML board is just as capable of a
 * transient 5xx as a JSON API. Also used by providers that resolve config
 * (e.g. a board id) from a one-shot page fetch before pagination even starts
 * — that single request used to have no retry at all, so a single
 * DNS/TLS/connection blip on it failed the whole provider before a single
 * page was ever fetched.
 *
 * @param {{ fetchText: (url: string, opts?: FetchOptions) => Promise<string>, sleep?: (ms: number) => Promise<void> }} ctx - Transport context.
 * @param {string} url - Absolute URL.
 * @param {FetchOptions} [opts] - Passed through to ctx.fetchText.
 * @param {{ retries?: number, baseDelayMs?: number, maxDelayMs?: number }} [policy]
 * @returns {Promise<string>} Response body.
 */
export async function fetchTextWithRetry(ctx: TextFetchContext, url: string, opts: FetchOptions = {}, policy: RetryPolicy = {}): Promise<string> {
  return withRetry(() => ctx.fetchText(url, opts), ctx, policy);
}

/**
 * Fetch a raw Response (headers included — e.g. Set-Cookie) with bounded
 * retry on transient failures. Same policy as fetchJsonWithRetry /
 * fetchTextWithRetry; exists for providers that need response headers on a
 * retried request (a stateful multi-hop scrape carrying a session cookie
 * across GET/POST steps, e.g. peoplesoft.ts) instead of just the body.
 *
 * @param {{fetchResponse: (url: string, opts?: FetchOptions) => Promise<Response>, sleep?: (ms: number) => Promise<void>}} ctx - Transport context.
 * @param {string} url - Absolute URL.
 * @param {FetchOptions} [opts] - Passed through to ctx.fetchResponse.
 * @param {{retries?: number, baseDelayMs?: number, maxDelayMs?: number}} [policy]
 * @returns {Promise<Response>}
 */
export async function fetchResponseWithRetry(ctx: ResponseFetchContext, url: string, opts: FetchOptions = {}, policy: RetryPolicy = {}): Promise<Response> {
  return withRetry(() => ctx.fetchResponse(url, opts), ctx, policy);
}

/** Counters a caller can watch without touching the transport itself. */
export interface HttpObserver {
  onRequest?: () => void;
  onResponse?: (status: number) => void;
}

/**
 * Build the default HTTP transport context passed to `provider.fetch()` when
 * no test stub is injected.
 *
 * @param {{ onRequest?: () => void, onResponse?: (status: number) => void }} [observer]
 * @returns {Context}
 */
export function makeHttpCtx(observer?: HttpObserver): Context {
  const ctx: Context = {
    transport: 'http',
    fetchJson,
    fetchText,
    fetchResponse,
    // The canonical posting-URL key, so a provider can deduplicate its own
    // results the way the tracker and scanner do. Handing it over through ctx
    // is what keeps the behaviour identical: `packages/core/src/kernel/url-key.ts` is dependency-free,
    // so a standalone provider receives the same function the core calls rather
    // than importing the file or copying its body (#4218).
    normalizePostingUrl: normalizeUrl,
    // The requisition id an aggregator URL carries, for the same reason: a
    // provider that reads LinkedIn or Indeed links gets the extractor the
    // tracker's merge uses, not a regex of its own that drifts from it.
    aggregatorPostingId,
  };
  if (!observer) return ctx;
  // Wraps one transport call so the observer sees the request and the response
  // status, while a caller's own onResponse hook keeps firing unchanged.
  const observed = <T>(original: (url: string, opts?: RequestOptions) => Promise<T>) =>
    (url: string, opts: RequestOptions = {}): Promise<T> => {
      observer.onRequest?.();
      return original(url, {
        ...opts,
        onResponse: (response: Response) => {
          opts.onResponse?.(response);
          observer.onResponse?.(response.status);
        },
      });
    };
  ctx.fetchJson = observed(fetchJson);
  ctx.fetchText = observed(fetchText);
  ctx.fetchResponse = observed(fetchResponse);
  return ctx;
}
