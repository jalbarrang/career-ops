// Type catalog for the career-ops plugin contract.
//
// Plugin authors import these types directly:
//
//   import type { PluginManifest, PluginContext, PluginHooks } from '../_types.ts';
//
// The runtime contract is enforced by _engine.ts (validateManifest) — the
// compiler checks the static half. Exactly the packages/core/src/scanning/providers/_types.ts + packages/core/src/scanning/scan.ts
// split.
//
// Files prefixed with _ are shared helpers and are NEVER discovered as plugins.

import type { Job } from '../packages/core/src/scanning/providers/_types.ts';

/** Hook types a manifest may declare. There is deliberately no auto-submit hook. */
export type PluginHookName = 'provider' | 'ingest' | 'search' | 'notify' | 'export';

/**
 * The plugin manifest — `plugins/<id>/manifest.json`. Named manifest.json (NOT
 * plugin.json) to avoid colliding with the repo's existing
 * `.claude-plugin/plugin.json` (the unrelated Claude Code plugin marketplace).
 */
export interface PluginManifest {
  /** REQUIRED. ^[a-z0-9][a-z0-9-]*$. MUST equal the directory name. */
  id: string;
  /** REQUIRED. Must be 1. */
  apiVersion: number;
  /** REQUIRED. One line, mission-framed. */
  description: string;
  /** REQUIRED, non-empty. Subset of PluginHookName. */
  hooks: PluginHookName[];
  /** REQUIRED (may be []). Env VARIABLE NAMES only, never values. */
  requiredEnv: string[];
  /** Optional human label for `doctor`/CLI listings. */
  name?: string;
  /** Optional semver of the plugin itself. */
  version?: string;
  /** Optional. Default 'index.ts'. Traversal-guarded relative path. */
  entry?: string;
  /** Optional extra env var names. */
  optionalEnv?: string[];
  /** Optional egress allowlist; REQUIRED when requiredEnv is non-empty. */
  allowedHosts?: string[];
  /** REQUIRED true. The loader hard-rejects false. */
  humanInTheLoop: boolean;
  /** Optional URL. */
  homepage?: string;
}

/**
 * The capability object the engine builds per plugin and passes to every hook.
 * Least-privilege by construction, but a CONVENIENCE, not a security sandbox.
 */
export interface PluginContext {
  transport: 'http';
  /** Guarded primitive (HTTPS-only, allowedHosts-pinned). Throws on non-2xx. */
  fetch: (url: string, opts?: Record<string, unknown>) => Promise<Response>;
  fetchText: (url: string, opts?: Record<string, unknown>) => Promise<string>;
  fetchJson: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  /** Frozen, scoped to the plugin's declared env names. NOT an isolation boundary. */
  env: Readonly<Record<string, string>>;
  /** Frozen non-secret settings block from config/plugins.yml. */
  settings: Readonly<Record<string, unknown>>;
  /** Console logger that redacts declared env values. */
  log: (...args: unknown[]) => void;
  /** True when invoked with --dry-run; side-effecting hooks must honor it. */
  dryRun: boolean;
  /** Absolute path of the user's data root. */
  dataRoot: string;
  /** Canonical posting-URL key used by the tracker and scanner. */
  normalizePostingUrl: (raw: string) => string;
  /** Requisition id an aggregator URL carries, keyed on the registrable domain. */
  aggregatorPostingId: (raw: string) => { domain: string; id: string } | null;
}

/** Normalized job posting — the same shape providers produce. */
export type PluginJob = Job;

/** Provider hook: byte-identical to the provider contract, plus ctx.env. */
export interface PluginProviderHook {
  id: string;
  detect?: (entry: object) => { url: string } | null;
  fetch: (entry: object, ctx: PluginContext) => Promise<PluginJob[]>;
}

/**
 * The default export of a plugin's entry module — an object with one function
 * per declared hook. Only the hooks named in the manifest are loaded.
 */
export interface PluginHooks {
  provider?: PluginProviderHook;
  ingest?: (ctx: PluginContext) => Promise<PluginJob[]>;
  search?: (query: string, ctx: PluginContext) => Promise<PluginJob[]>;
  export?: (snapshot: Readonly<object>, ctx: PluginContext) => Promise<{ pushed: number } | void>;
  notify?: (payload: Readonly<object>, ctx: PluginContext) => Promise<void>;
}
