// Type catalog for the provider plugin contract.
//
// This file is the single source of truth for the shapes every provider
// implements and every consumer (packages/core/src/scanning/scan.ts, packages/cli/src/commands/scanning/scan-ats-full.ts, packages/cli/src/commands/scanning/audit-portals.ts,
// packages/core/src/scanning/verify-portals.ts) reads. Provider authors import these types directly:
//
//   import type { Job, PortalEntry, Context, Provider } from './_types.ts';
//
// The runtime contract is still enforced by packages/core/src/scanning/scan.ts (id presence, fetch is a
// function, fetch returns an array) — the compiler checks the static half.
//
// Prose companion (checklist, mandatory guards, tests): ADDING_A_PROVIDER.md
// in this directory.
//
// Files prefixed with _ are never loaded as providers by scan.ts.

/** Salary range attached to a posting, in the source's own currency. */
export interface JobSalary {
  min?: number;
  max?: number;
  currency?: string;
}

/** Trust classification derived from `trustScore`. */
export type TrustLevel = 'high' | 'medium' | 'low';

/**
 * Normalized job posting — the unit of currency throughout the scanner.
 */
export interface Job {
  /** Required, non-empty after trim. */
  title: string;
  /** Required, absolute URL — used as the dedup key. */
  url: string;
  /**
   * May be empty when the source can't expose it at the list-page level;
   * populated downstream.
   */
  company: string;
  /** May be empty. */
  location: string;
  /**
   * Job description text, populated ONLY when the provider's list payload
   * carries it for free (no extra per-job request — the scanner is
   * zero-token), or when a board opts into vdab/smartrecruiters-style
   * `fetchDetails` (bounded per-job enrichment, skipped while probing).
   * Consumed by packages/core/src/scanning/scan.ts's content_filter; an empty/absent value always passes.
   */
  description?: string;
  /**
   * Epoch ms when the posting was published. Omitted when the source doesn't
   * expose a usable date.
   */
  postedAt?: number;
  /**
   * Annualized compensation, attached ONLY when the source exposes real
   * figures — never inferred.
   */
  salary?: JobSalary;
  /**
   * The ATS's own id for this POSTING, unique within that ATS. Not read by the
   * scanner, whose per-posting identity is the URL.
   */
  externalId?: string;
  /**
   * The EMPLOYER's requisition id — the schema.org/JobPosting `identifier`
   * concept. MANY-TO-ONE with postings: never use it alone to conclude two
   * rows are the same opening. packages/core/src/scanning/scan.ts reads it only in the safe direction:
   * two same-titled postings with DIFFERENT ids are two requisitions.
   */
  requisitionId?: string;
  /** 0-100 trust score from _trust-validator.ts. */
  trustScore?: number;
  /** Flags raised by trust validation (e.g. 'invalid_url'). */
  trustFlags?: string[];
  /** Classification derived from `trustScore`. */
  trustLevel?: TrustLevel;
  /**
   * Language the posting is written in, as the source names it: a code
   * (`de`, `en-GB`, `en_GLOBAL`) or a name (`German`).
   */
  language?: string;
  /** Provider that produced this posting, when known. */
  source?: string;
  /** Free-form note attached by a provider or by packages/core/src/scanning/scan.ts enrichment. */
  note?: string;
  /** True when packages/core/src/scanning/scan.ts annotated a posting on the user's do-not-apply list. */
  blacklisted?: boolean;
  /** True when the posting's company careers domain could be resolved. */
  tracked?: boolean;
  /** Careers-site domain used by the 404/410 rediscovery fallback. */
  careersUrlDomain?: string | null;
  /** Cross-listing fingerprint computed by scan.ts. */
  fingerprint?: string;
  /** Extra provider-specific fields are allowed and preserved. */
  [key: string]: unknown;
}

/**
 * Result returned by the trust validator for a single job posting.
 */
export interface TrustResult {
  /** 0-100, where 100 = fully trusted. */
  score: number;
  /** Flags raised (e.g. 'invalid_url', 'suspicious_domain'). */
  flags: string[];
  /** Classification: 90-100 high, 60-89 medium, 0-59 low. */
  level: TrustLevel;
}

/**
 * A single portal entry from `portals.yml` — `tracked_companies` or
 * `job_boards`.
 *
 * Provider-specific fields are opaque to packages/core/src/scanning/scan.ts and validated by the provider
 * itself.
 */
export interface PortalEntry {
  /** User-facing label; appears in logs and placeholders. */
  name: string;
  /** Default: true. */
  enabled?: boolean;
  /** Public listing URL; consumed by detect(). */
  careers_url?: string;
  /** JSON API URL; used directly by greenhouse/ashby providers. */
  api?: string;
  /** Explicit provider id — bypasses detect(). */
  provider?: string;
  /** Default: 'http'. Reserved for future transports. */
  transport?: 'http';
  /** Provider-specific pagination cap (avature, workday). */
  max_pages?: number;
  /** avature only: pins the pagination query key. */
  offset_param?: string;
  /** provider-specific extra fields */
  [key: string]: unknown;
}

/**
 * Returned by `detect()` when a provider claims an entry. `url` is
 * informational (used in logs); routing only checks for a non-null return.
 */
export interface DetectHit {
  url: string;
}

/**
 * Options forwarded to the underlying `fetch` call.
 */
export interface FetchOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  method?: string;
  body?: string | null;
  redirect?: 'error' | 'follow' | 'manual';
  [key: string]: unknown;
}

/**
 * What packages/core/src/scanning/scan.ts hands to `provider.fetch()`.
 */
export interface Context {
  transport: 'http';
  fetchText: (url: string, opts?: FetchOptions) => Promise<string>;
  fetchJson: (url: string, opts?: FetchOptions) => Promise<unknown>;
  /** Raw Response (timeout + non-2xx guard applied). */
  fetchResponse: (url: string, opts?: FetchOptions) => Promise<Response>;
  /** Optional pagination hint (packages/core/src/scanning/verify-portals.ts's health probe passes 1). */
  maxPages?: number;
  /** Optional cross-provider pacing hook. */
  sleep?: (ms: number) => Promise<void>;
  /** Whether the scan keeps language versions of one posting apart. */
  dedupIncludeLanguage?: boolean;
  /** Place of a language code in `preferred_languages`, best first, or -1. */
  preferredLanguageRank?: (language: string) => number;
  /** This scan's own title decision, for providers that pay extra per posting. */
  titleWanted?: (title: string) => boolean;
  /** Postings older than this many ms before now can be skipped early. */
  sinceMs?: number;
  /** Whether undated postings should be returned rather than dropped early. */
  includeUndated?: boolean;
  /** Location hints from `portals.yml`'s `location_filter`. */
  locationHints?: unknown;
  [key: string]: unknown;
}

/**
 * The provider contract — the default export of every `providers/*.ts` file
 * (excluding `_`-prefixed shared helpers).
 */
export interface Provider {
  /** Unique across all loaded providers. */
  id: string;
  /** Optional auto-detection. */
  detect?: (entry: PortalEntry) => DetectHit | null;
  /** Required. */
  fetch: (entry: PortalEntry, ctx: Context) => Promise<Job[]>;
  /**
   * Optional provider-scoped identifier for a job, precise where URL
   * normalization isn't. Return null when no such key is derivable.
   */
  dedupKey?: (job: Job) => string | null;
}
