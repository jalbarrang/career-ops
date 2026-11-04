#!/usr/bin/env node
/**
 * discover-ats.ts — Company-list → scannable ATS board resolver for career-ops
 *
 * Takes a list of companies and resolves each to a scannable ATS board by
 * probing the public JSON APIs career-ops already supports (see VENDOR_ORDER)
 * via the existing providers/ layer — zero LLM tokens, zero auth. A company
 * "resolves" when a vendor's board exists AND currently lists ≥1 job.
 *
 * portals.yml is a USER-LAYER file, so by DEFAULT this command is preview-only:
 * it prints the entries it WOULD add (pendingEntries) and writes nothing. Pass
 * --write to explicitly opt in to appending them to portals.yml `tracked_companies`
 * (a text splice that preserves the file's comments and formatting; deduped;
 * idempotent; atomic temp-then-rename). Companies that don't resolve —
 * JS-rendered portals, non-standard slugs, or Workday without a hint — are
 * flagged for manual follow-up instead of being silently dropped.
 *
 * Input: a YAML file `companies: [{name, slug?, website?}]` (via --in), and/or
 * bare company names as positional CLI args.
 *
 * Run: bun discover-ats.ts --in companies.yml            (preview — writes nothing)
 *      bun discover-ats.ts --in companies.yml --write    (opt in: append to portals.yml)
 *      bun discover-ats.ts Stripe Ramp Mollie            (bare names)
 *      bun discover-ats.ts --in companies.yml --summary  (human table)
 *      bun discover-ats.ts --in companies.yml --vendors gh,ashby
 *      bun discover-ats.ts --self-test
 *
 * Probing hits live third-party APIs, so honor CAREER_OPS_PORTALS to point at a
 * scratch portals file during tests/experiments.
 *
 * Issue #1864 — github.com/career-ops-hq/career-ops
 */

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadYaml } from './lib/yaml-document.ts';
import { renameSyncWithRetry } from './tracker-utils.ts';

import { makeHttpCtx, isRefusedRedirectError } from './providers/_http.ts';
import type { Context, DetectHit, PortalEntry } from './providers/_types.ts';
import greenhouse from './providers/greenhouse.ts';
import ashby from './providers/ashby.ts';
import lever from './providers/lever.ts';
import workday from './providers/workday.ts';
import workable from './providers/workable.ts';
import smartrecruiters from './providers/smartrecruiters.ts';
import recruitee from './providers/recruitee.ts';
import breezy from './providers/breezy.ts';
import bamboohr from './providers/bamboohr.ts';
import pinpoint from './providers/pinpoint.ts';
import rippling from './providers/rippling.ts';
import joinProvider from './providers/join.ts';
import { isMainModule } from './lib/is-main-module.ts';
import { getCareerOpsRoot } from './path-resolver.ts';
import { DEFAULT_SMALL_THRESHOLD, isSmallBoard, smallBoardDetail } from './lib/small-board.ts';
import { findBlacklistEntry, loadBlacklist } from './scan.ts';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = getCareerOpsRoot();
const PORTALS_PATH = process.env.CAREER_OPS_PORTALS || join(DATA_ROOT, 'portals.yml');
const BLACKLIST_PATH = process.env.CAREER_OPS_BLACKLIST || join(DATA_ROOT, 'data', 'blacklist.md');

// Safe charset for a slug that will be interpolated into an ATS URL. Consistent
// with the SLUG_RE guard in scan-ats-full.ts and seeds/vc-portfolios.ts — a
// tampered or malformed input can never inject unexpected characters into a URL.
// Mixed case is intentional: Ashby boards are case-sensitive (AlephAlpha, DeepL).
export const SLUG_RE = /^[A-Za-z0-9._-]+$/;

// Bounded concurrency for live probes — lower than scan-ats-full.ts's 20
// because Ashby's provider holds a ~30s connection per board.
const DEFAULT_CONCURRENCY = 8;

// ── Types ─────────────────────────────────────────────────────────────

/** A Workday coordinate hint in its object form (`workday: {tenant, site}`). */
export interface WorkdayHintObject {
  tenant?: unknown;
  instance?: unknown;
  site?: unknown;
  [key: string]: unknown;
}

/** One company to resolve (an input-file entry, or a bare CLI name). */
export interface Company {
  name: string;
  slug?: string;
  website?: string;
  workday?: string | WorkdayHintObject;
  careers_url?: string;
}

/** Any field parseWorkdayHint() reads a Workday link out of. */
export interface WorkdaySource {
  name?: string;
  workday?: string | WorkdayHintObject;
  careers_url?: string;
  website?: string;
}

/** Workday coordinates whose every segment passed WORKDAY_SEGMENT_RE. */
export interface WorkdayCoords {
  tenant: string;
  instance: string | null;
  site: string;
}

/** One probeable {vendor, slug, careers_url} candidate for a company. */
export interface Candidate {
  vendor: string;
  slug: string;
  careers_url: string;
}

/** A vendor probe registry entry. */
export interface VendorConfig {
  id: string;
  provider: ProviderContract;
  /** Constant hostname buildCandidateUrls asserts against. */
  host?: string;
  /** Slug-dependent hostname, for vendors that put the company in a subdomain. */
  hostFor?: (slug: string) => string;
  buildUrl: (slug: string) => string;
  api?: (slug: string) => string;
}

/**
 * The slice of the provider contract this file drives. `fetch` resolves
 * `unknown` because only the posting count is read here, and one count is all
 * a discovery probe needs.
 */
export interface ProviderContract {
  detect: (entry: PortalEntry) => DetectHit | null;
  fetch: (entry: PortalEntry, ctx: Context) => Promise<unknown>;
}

/** A resolved board, as reported (and rendered into portals.yml). */
export interface ResolvedMatch {
  name: string;
  careers_url: string;
  api?: string;
  provider?: string;
  notes?: string;
  smallBoard?: boolean;
  jobCount?: number;
  vendor?: string;
  slug?: string;
}

/** One vendor that answered "the board is not here / nothing is there". */
export interface EmptyBoard {
  vendor: string;
  careers_url: string;
}

/** One vendor whose probe failed, with the discriminators the verdict reads. */
export interface ProbeError {
  vendor: string;
  error?: string;
  httpStatus?: number;
  refusedRedirect?: boolean;
  definitive?: boolean;
}

/** Outcome of probing a single vendor candidate. */
export interface ProbeResult {
  status: 'match' | 'empty' | 'error';
  jobCount: number;
  error?: string;
  httpStatus?: number;
  refusedRedirect?: boolean;
}

/** A company that could not be resolved to a scannable board. */
export interface UnresolvedCompany {
  name: string;
  triedVendors: string[];
  reason: string;
  skippedUnsafeSlug?: string[];
  unsupportedSlugShape?: string[];
  emptyBoards?: EmptyBoard[];
  errors?: ProbeError[];
  website?: string;
}

/** resolveCompany's result: exactly one of the two shapes. */
export type ResolveResult = { resolved: ResolvedMatch } | { unresolved: UnresolvedCompany };

/** resolveWorkday's result: a match, or why there was none. */
export type WorkdayResult =
  | { resolved: ResolvedMatch }
  | { status: 'empty'; tried: string[]; careers_url: string }
  | { status: 'error'; tried: string[]; detail?: string; refusedRedirect?: boolean };

/** An entry of data/blacklist.md, as scan.ts's loadBlacklist() returns it. */
export interface BlacklistEntry {
  company: string;
  since?: string;
  scope?: string;
  reason?: string;
}

/** The blacklist table: normalized key → entry. */
export type Blacklist = ReadonlyMap<string, BlacklistEntry>;

/** A company split out by a blacklist hit. */
export interface BlacklistedCompany {
  name: string;
  entry: string;
  reason: string;
}

export interface ResolveOptions {
  /** Subset of VENDOR_ORDER (slug vendors only; Workday is a separate toggle). */
  vendors?: readonly string[];
  ctx?: Context;
  includeWorkday?: boolean;
}

export interface DiscoveryOptions {
  vendors?: readonly string[];
  ctx?: Context;
  concurrency?: number;
  includeWorkday?: boolean;
}

export interface DiscoveryResult {
  resolved: ResolvedMatch[];
  unresolved: UnresolvedCompany[];
}

export interface CliOptions {
  smallThreshold: number;
  inPath: string | null;
  vendors: string[];
  includeWorkday: boolean;
  write: boolean;
  summary: boolean;
  selfTest: boolean;
  names: string[];
}

// ── Narrowing helpers (YAML input and thrown values cross here as unknown) ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Message of a thrown value: Error.message (or .stack) when present, else String(). */
function errorText(err: unknown): string {
  if (isRecord(err)) {
    if (typeof err.stack === 'string' && err.stack) return err.stack;
    if (typeof err.message === 'string') return err.message;
  }
  return String(err);
}

/** One-line message of a thrown value, without the stack. */
function errorMessage(err: unknown): string {
  if (isRecord(err) && typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

/** The message on a thrown error's `cause` (where a refused redirect keeps it). */
function causeMessage(err: unknown): string {
  const cause = isRecord(err) ? err.cause : undefined;
  const message = isRecord(cause) ? cause.message : undefined;
  return typeof message === 'string' ? message : '';
}

// Vendor probe registry. buildUrl(slug) produces a careers_url in the exact
// shape each provider's detect() recognizes, so the probe reuses the real scan
// path — a board we confirm here is exactly one scan.ts can later read.
//
// Greenhouse/Ashby/Lever resolve from a single slug. Workday is different: it
// needs <tenant>.<instance>.myworkdayjobs.com/<site> — three coordinates, only
// one of which (tenant ≈ slug) is derivable from a name. The site name in
// particular is unguessable (e.g. "NVIDIAExternalCareerSite" vs
// "External_Career_Site"), so a name alone can't resolve a Workday board. It
// resolves from a Workday hint instead (see resolveWorkday): a full careers URL,
// or an explicit {tenant, site[, instance]} block — with a bounded instance
// auto-probe when the instance is the only missing coordinate.
// `host` pins the hostname buildCandidateUrls asserts against. Vendors that put
// the company in a SUBDOMAIN have a slug-dependent host, so they supply
// `hostFor(slug)` instead of a constant; `buildCandidateUrls` prefers it when
// present. Those hosts are matched lowercase-only by their providers, so their
// buildUrl lowercases the slug rather than emitting a URL the provider would
// then reject (Ashby is the reason slugs are not lowercased globally: its boards
// are case-sensitive).
const lower = (s: string): string => String(s).toLowerCase();

const VENDORS: Record<string, VendorConfig> = {
  gh:    { id: 'greenhouse', provider: greenhouse, host: 'job-boards.greenhouse.io', buildUrl: (s) => `https://job-boards.greenhouse.io/${s}`, api: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs` },
  ashby: { id: 'ashby',      provider: ashby,      host: 'jobs.ashbyhq.com',        buildUrl: (s) => `https://jobs.ashbyhq.com/${s}` },
  lever: { id: 'lever',      provider: lever,      host: 'jobs.lever.co',           buildUrl: (s) => `https://jobs.lever.co/${s}` },

  // Long tail, probed only after the three above miss (see VENDOR_ORDER).
  workable:        { id: 'workable',        provider: workable,        host: 'apply.workable.com',          buildUrl: (s) => `https://apply.workable.com/${s}` },
  smartrecruiters: { id: 'smartrecruiters', provider: smartrecruiters, host: 'careers.smartrecruiters.com', buildUrl: (s) => `https://careers.smartrecruiters.com/${s}` },
  rippling:        { id: 'rippling',        provider: rippling,        host: 'ats.rippling.com',            buildUrl: (s) => `https://ats.rippling.com/${s}/jobs` },
  join:            { id: 'join',            provider: joinProvider,            host: 'join.com',                    buildUrl: (s) => `https://join.com/companies/${s}` },
  recruitee:       { id: 'recruitee',       provider: recruitee,       hostFor: (s) => `${lower(s)}.recruitee.com`,  buildUrl: (s) => `https://${lower(s)}.recruitee.com` },
  breezy:          { id: 'breezy',          provider: breezy,          hostFor: (s) => `${lower(s)}.breezy.hr`,      buildUrl: (s) => `https://${lower(s)}.breezy.hr` },
  bamboohr:        { id: 'bamboohr',        provider: bamboohr,        hostFor: (s) => `${lower(s)}.bamboohr.com`,   buildUrl: (s) => `https://${lower(s)}.bamboohr.com` },
  pinpoint:        { id: 'pinpoint',        provider: pinpoint,        hostFor: (s) => `${lower(s)}.pinpointhq.com`, buildUrl: (s) => `https://${lower(s)}.pinpointhq.com` },
};
// Slug-resolvable vendors, probed in order for each company (first match wins).
// Probe order is also a cost decision. resolveCompany probes candidates in this
// order and returns on the FIRST match, so a resolvable company pays only for the
// vendors ahead of its own: one probe on Greenhouse, two on Ashby, three on
// Lever. Keeping the three highest-hit-rate vendors first therefore leaves every
// company they can resolve costing exactly what it did before this list grew, and
// the long tail is paid for only by a company none of the three could resolve.
// A company on no supported board is the case that got more expensive: it now
// probes every vendor before giving up, which is the honest price of the extra
// coverage.
const VENDOR_ORDER: readonly string[] = ['gh', 'ashby', 'lever', 'workable', 'smartrecruiters', 'recruitee', 'bamboohr', 'breezy', 'pinpoint', 'rippling', 'join'];

// Workday instance subdomains, most common first. Used only when the user gives
// a tenant + site but no instance: we try each `<tenant>.<inst>.myworkdayjobs.com`
// CXS endpoint and stop at the first that returns jobs. Bounded and ordered so a
// probe is cheap and polite (a handful of requests, not a brute-force sweep).
const WORKDAY_INSTANCES: readonly string[] = ['wd1', 'wd2', 'wd3', 'wd5', 'wd10', 'wd12', 'wd101', 'wd103'];

const USAGE = `Usage:
  bun discover-ats.ts --in companies.yml            # PREVIEW — resolve + print entries, write nothing
  bun discover-ats.ts --in companies.yml --write    # opt in: append resolved entries to portals.yml
  bun discover-ats.ts Stripe Ramp Mollie            # company names as positional args
  bun discover-ats.ts --in companies.yml --summary  # human-readable table
  bun discover-ats.ts --in companies.yml --vendors gh,ashby,lever  # restrict probes
  bun discover-ats.ts --in companies.yml --vendors workday         # Workday only
  bun discover-ats.ts --in companies.yml --small-threshold 10  # what counts as a small board (default ${DEFAULT_SMALL_THRESHOLD}, 0 = off)
  bun discover-ats.ts --self-test                   # inline test suite
  bun discover-ats.ts --help                        # print this usage block

portals.yml is a user-layer file: this command NEVER writes it unless you pass
--write. The default previews the entries it would add (see pendingEntries).

Vendors: gh, ashby, lever, workable, smartrecruiters, recruitee, bamboohr,
breezy, pinpoint, rippling, join (all resolve from a name/slug) and workday
(resolves from a coordinate hint — a name alone can't locate a Workday site).
Default: all of them, probed in that order, first match wins.

Input YAML shape:
  companies:
    - name: Adyen
    - name: Monzo
      slug: monzo-bank      # optional explicit slug (needed for camelCase Ashby boards)
    - name: Mollie
      website: mollie.com   # optional; surfaced for unresolved companies
    # Workday — give a full careers URL ...
    - name: Nvidia
      workday: https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite
    # ... or the coordinates (instance auto-probed if omitted):
    - name: Salesforce
      workday: { tenant: salesforce, site: External_Career_Site }`;

// ── Pure functions (exported for tests) ──────────────────────────────

/**
 * Derive a URL-safe slug from a company name. Mirrors seeds/vc-portfolios.ts.
 * Lowercases — so camelCase Ashby boards (AlephAlpha, DeepL) need an explicit
 * `slug` in the input; a derived slug will miss them.
 * @param {string} name
 * @returns {string}
 */
export function deriveSlug(name: string | null | undefined): string {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Parse the company list from an input YAML string and/or bare CLI names.
 * Never throws on malformed YAML — returns a warning instead. Drops entries
 * with no usable name; dedupes by lowercased name (input file wins over CLI).
 */
export function parseCompanyInput(rawYaml: string, cliNames: readonly string[] = []): { companies: Company[]; warnings: string[] } {
  const warnings: string[] = [];
  const byName = new Map<string, Company>();

  const add = (raw: unknown, origin: string): void => {
    if (!isRecord(raw)) {
      if (raw !== undefined && raw !== null) warnings.push(`${origin}: dropped non-object entry`);
      return;
    }
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) {
      warnings.push(`${origin}: dropped entry with missing/empty name`);
      return;
    }
    const key = name.toLowerCase();
    if (byName.has(key)) return; // first occurrence wins
    const entry: Company = { name };
    if (typeof raw.slug === 'string' && raw.slug.trim()) entry.slug = raw.slug.trim();
    if (typeof raw.website === 'string' && raw.website.trim()) entry.website = raw.website.trim();
    // Workday hint: a full careers URL (string) or a {tenant, site, instance?}
    // object. parseWorkdayHint validates the contents downstream. Warn on a
    // present-but-wrong-typed value (e.g. a number) so it isn't dropped silently.
    if (typeof raw.workday === 'string' && raw.workday.trim()) entry.workday = raw.workday.trim();
    else if (isRecord(raw.workday)) entry.workday = raw.workday;
    else if (raw.workday !== undefined && raw.workday !== null && raw.workday !== '') {
      warnings.push(`${origin}: ignored "workday" hint for "${name}" — expected a URL string or {tenant, site} object`);
    }
    byName.set(key, entry);
  };

  if (rawYaml && rawYaml.trim()) {
    let doc: unknown = null;
    try {
      doc = loadYaml(rawYaml);
    } catch (err) {
      warnings.push(`input: malformed YAML — ${errorMessage(err)}`);
      doc = null;
    }
    const list: unknown[] | null = Array.isArray(doc)
      ? doc
      : (isRecord(doc) && Array.isArray(doc.companies) ? doc.companies : null);
    if (doc && !list) {
      warnings.push('input: expected a top-level `companies:` list (or a bare YAML list)');
    }
    for (const item of list || []) {
      // Allow bare strings in the list too: `- Adyen`.
      add(typeof item === 'string' ? { name: item } : item, 'input');
    }
  }

  for (const raw of cliNames) {
    if (typeof raw === 'string' && raw.trim()) add({ name: raw.trim() }, 'args');
  }

  return { companies: [...byName.values()], warnings };
}

/**
 * Build the candidate {vendor, slug, careers_url} probes for one company.
 * SLUG_RE is enforced before every interpolation — the SSRF choke point.
 * A vendor whose slug fails the guard is skipped (recorded in `skipped`).
 * A vendor that CAN'T represent this slug at all — the URL is well-formed and
 * on the right host, but the provider's own contract rejects its shape — is
 * recorded in `unsupported` and never becomes a candidate (see below).
 *
 * @param {{name:string, slug?:string}} company
 * @param {string[]} [vendors]  Subset of VENDOR_ORDER.
 * @returns {{candidates: {vendor:string, slug:string, careers_url:string}[], skipped: string[], unsupported: string[]}}
 */
export function buildCandidateUrls(company: { name: string; slug?: string }, vendors: readonly string[] = VENDOR_ORDER): { candidates: Candidate[]; skipped: string[]; unsupported: string[] } {
  const slug = company.slug || deriveSlug(company.name);
  const candidates: Candidate[] = [];
  const skipped: string[] = [];
  const unsupported: string[] = [];
  for (const vendor of vendors) {
    const cfg = VENDORS[vendor];
    if (!cfg) continue;
    if (!SLUG_RE.test(slug)) {
      skipped.push(vendor);
      continue;
    }
    const careers_url = cfg.buildUrl(slug);
    // Defense-in-depth: re-parse the URL we just built and confirm its hostname
    // is EXACTLY the intended ATS host before it's ever probed — never trust the
    // string by shape alone. SLUG_RE already forbids '/', '@', etc., so a slug
    // can't smuggle in a host; this assertion makes that guarantee explicit and
    // survives any future change to buildUrl. (Mirrors each provider's own
    // new URL(...).hostname allowlist check.)
    let host: string | null;
    try { host = new URL(careers_url).hostname; } catch { host = null; }

    // Subdomain vendors derive their host from the slug, so the expected value is
    // computed the same way rather than being a constant. The assertion itself is
    // unchanged: whatever we are about to probe must be EXACTLY the host we meant.
    const expected = cfg.hostFor ? cfg.hostFor(slug) : cfg.host;
    if (host !== expected) {
      skipped.push(vendor);
      continue;
    }
    // Last gate, and the only one that knows each vendor's REAL slug contract:
    // ask the provider itself whether it can derive an API URL from this URL.
    // detect() is pure and local (a URL parse, no network, no side effects).
    //
    // The host assertion above can't catch this: `expected` is built by the same
    // concatenation as the URL, so for a subdomain vendor a dotted slug like
    // `foo.bar` yields host === expected === `foo.bar.bamboohr.com` and sails
    // through — the suffix is always appended, so nothing escapes the vendor
    // domain (no SSRF), but that host cannot exist. Every subdomain provider
    // pins a SINGLE tenant label (`^[a-z0-9][a-z0-9-]*\.bamboohr\.com$`), and
    // several path vendors have their own slug shape too, so their detect()
    // returns null. Left in, such a candidate is recorded as a probe ERROR
    // ("no API URL derivable") indistinguishable from a transient network
    // failure, which drags resolveCompany's reason to "board status unknown —
    // re-run" and invites a retry that can never succeed. Deriving the rule from
    // the provider rather than re-declaring a slug regex here means the
    // discovery guard and the provider contract cannot drift apart.
    if (!cfg.provider.detect({ name: company.name, careers_url })) {
      unsupported.push(vendor);
      continue;
    }
    candidates.push({ vendor, slug, careers_url });
  }
  return { candidates, skipped, unsupported };
}

// Coordinate token guard — tenant/instance/site segments interpolated into a
// Workday host/path. Workday site names contain letters, digits, `_` and `-`
// (e.g. NVIDIAExternalCareerSite, External_Career_Site); instances are wdNN.
const WORKDAY_SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Extract Workday coordinates {tenant, instance?, site} from a company's hints.
 * Accepts, in priority order:
 *   1. A full Workday URL in `workday`, `careers_url`, or `website`, either as a
 *      careers page or as the CXS endpoint it resolves to:
 *      https://<tenant>.<instance>.myworkdayjobs.com[/<locale>]/<site>[/...]
 *      https://<tenant>.<instance>.myworkdayjobs.com/wday/cxs/<tenant>/<site>[/jobs]
 *   2. An explicit object `workday: { tenant, site, instance? }`.
 * Returns null when no Workday coordinates are present. `instance` may be null
 * (caller then auto-probes WORKDAY_INSTANCES). Every returned segment is
 * guaranteed to pass WORKDAY_SEGMENT_RE.
 *
 * @param company - Any object carrying Workday-ish fields.
 * @returns Coordinates, or null when no usable hint is present.
 */
export function parseWorkdayHint(company: WorkdaySource): WorkdayCoords | null {
  const clean = (v: unknown): string | null => (typeof v === 'string' && WORKDAY_SEGMENT_RE.test(v) ? v : null);

  // 1. Explicit object form.
  if (company.workday && typeof company.workday === 'object') {
    const tenant = clean(company.workday.tenant);
    const site = clean(company.workday.site);
    const instance = clean(company.workday.instance);
    if (tenant && site) return { tenant, instance: instance || null, site };
  }

  // 2. URL form — check every field that might carry a Workday link. No
  // substring pre-filter here (CodeQL js/incomplete-url-substring-sanitization):
  // the anchored regexes below are the actual gate and already reject anything
  // that isn't a well-formed *.myworkdayjobs.com URL.
  const urlCandidates: string[] = [company.workday, company.careers_url, company.website]
    .filter((v): v is string => typeof v === 'string');
  for (const raw of urlCandidates) {
    // A CXS endpoint carries the site one level deeper, behind /wday/cxs/{tenant}/.
    // It also matches the careers-page pattern below, which captures the literal
    // `wday` as the site — here that lands in a generated portals.yml entry as
    // `careers_url: https://{tenant}.{instance}.myworkdayjobs.com/wday`, a
    // plausible-looking line for a board that doesn't exist (#3498). Checked
    // first, same as providers/workday.ts resolveEndpoint().
    // Both patterns are anchored: unanchored, they match a Workday URL embedded
    // anywhere in the candidate (e.g. `https://evil.example/r?next=https://acme
    // .wd5.myworkdayjobs.com/Careers`), so a redirect wrapper silently yields
    // coordinates for whatever tenant it carries. Anchoring is also what the
    // comment above has always claimed this gate does.
    const cxs = raw.match(/^https?:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/wday\/cxs\/[\w-]+\/([^/?#]+)(?:\/jobs)?(?:[/?#]|$)/);
    // The tenant comes from the host, not from the /wday/cxs/{tenant}/ segment:
    // these coordinates rebuild a careers URL host-first (buildWorkdayCandidates),
    // and the host is what has to stay reachable.
    const m = cxs
      || raw.match(/^https?:\/\/([\w-]+)\.(wd[\w-]*)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/?#]+)/);
    if (!m) continue;
    const [, tenant, instance, site] = m;
    if (clean(tenant) && clean(instance) && clean(site)) {
      return { tenant, instance, site };
    }
  }
  return null;
}

/**
 * Build the candidate Workday careers_url list for a hint. When the instance is
 * known, that's the single candidate; when it's null, expand across
 * WORKDAY_INSTANCES so the caller can probe for the live one.
 *
 * @param {{tenant:string, instance:string|null, site:string}} coords
 * @returns {{careers_url:string, instance:string}[]}
 */
export function buildWorkdayCandidates(coords: WorkdayCoords): { careers_url: string; instance: string }[] {
  const instances = coords.instance ? [coords.instance] : WORKDAY_INSTANCES;
  return instances.map((instance) => ({
    instance,
    careers_url: `https://${coords.tenant}.${instance}.myworkdayjobs.com/${coords.site}`,
  }));
}

/**
 * Quote a YAML scalar only when it needs it. Bare values stay bare (matching the
 * existing hand-written portals.yml style); values with YAML-special characters
 * are double-quoted and escaped.
 * @param {string} value
 * @returns {string}
 */
export function yamlScalar(value: string): string {
  const s = String(value ?? '');
  const needsQuote = s === '' || /^[\s]|[\s]$/.test(s) || /[:#"'{}\[\],&*!|>%@`]/.test(s);
  if (!needsQuote) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render one resolved match as a portals.yml tracked_companies entry snippet.
 * Leads with a newline so it slots cleanly against surrounding entries. Only
 * Greenhouse gets an `api:` line (matching every GH entry in the shipped file).
 * Workday gets an explicit `provider: workday` line — its detect() keys off the
 * myworkdayjobs.com host, but pinning it is unambiguous and matches how
 * provider-specific entries are written elsewhere in portals.yml.
 *
 * @param match - A resolved board.
 * @returns The YAML snippet.
 */
export function renderPortalEntry(match: ResolvedMatch): string {
  const lines = [`  - name: ${yamlScalar(match.name)}`];
  lines.push(`    careers_url: ${match.careers_url}`);
  if (match.api) lines.push(`    api: ${match.api}`);
  if (match.provider) lines.push(`    provider: ${match.provider}`);
  lines.push(`    enabled: true`);
  if (match.notes) lines.push(`    notes: ${yamlScalar(match.notes)}`);
  // A comment, not a key: portals.yml still parses to the same fields, but the
  // user sees the prompt next to the entry when they open the file (#4772).
  if (match.smallBoard) lines.push(`    # verify: ${smallBoardDetail(match.jobCount ?? 0)}`);
  return '\n' + lines.join('\n') + '\n';
}

/**
 * Flag resolved boards that list few postings. Purely advisory: it adds a
 * `smallBoard: true` field and never changes what resolves (#4772).
 *
 * @param resolved - Resolved matches; entries are mutated in place.
 * @param threshold - Boards at or under this count are flagged; 0 disables.
 * @returns the same array
 */
export function flagSmallBoards(resolved: ResolvedMatch[], threshold: number = DEFAULT_SMALL_THRESHOLD): ResolvedMatch[] {
  for (const r of resolved) {
    // A match without a posting count is not classified (isSmallBoard(undefined)
    // was false before these types existed, and stays false).
    if (typeof r.jobCount === 'number' && isSmallBoard(r.jobCount, threshold)) r.smallBoard = true;
  }
  return resolved;
}

/** Normalize a careers_url/api for dedupe comparison: lowercase, strip trailing slash. */
function normalizeUrl(u: unknown): string {
  return String(u || '').trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Split resolved matches into {fresh, duplicates} against the tracker's existing
 * entries. A match is a duplicate if its lowercased name OR its normalized
 * careers_url/api already appears. Also self-dedupes within `fresh` (two input
 * companies resolving to the same board).
 *
 * @param matches - Candidate matches to classify.
 * @param existingEntries - Parsed portals.yml tracked_companies (or []).
 * @returns the fresh matches and the ones already present
 */
export function dedupeAgainstPortals(matches: readonly ResolvedMatch[], existingEntries: readonly unknown[] | null): { fresh: ResolvedMatch[]; duplicates: ResolvedMatch[] } {
  const names = new Set<string>();
  const urls = new Set<string>();
  const entries: readonly unknown[] = Array.isArray(existingEntries) ? existingEntries : [];
  for (const e of entries) {
    if (!isRecord(e)) continue;
    if (typeof e.name === 'string') names.add(e.name.trim().toLowerCase());
    if (e.careers_url) urls.add(normalizeUrl(e.careers_url));
    if (e.api) urls.add(normalizeUrl(e.api));
  }
  const fresh: ResolvedMatch[] = [];
  const duplicates: ResolvedMatch[] = [];
  for (const m of matches) {
    const nameKey = String(m.name || '').trim().toLowerCase();
    const urlKey = normalizeUrl(m.careers_url);
    const apiKey = m.api ? normalizeUrl(m.api) : null;
    const dup = names.has(nameKey) || urls.has(urlKey) || (apiKey && urls.has(apiKey));
    if (dup) {
      duplicates.push(m);
    } else {
      fresh.push(m);
      names.add(nameKey);
      urls.add(urlKey);
      if (apiKey) urls.add(apiKey);
    }
  }
  return { fresh, duplicates };
}

/**
 * Splice rendered entry snippets into the tracked_companies block of a
 * portals.yml text, preserving every other byte (comments, other blocks,
 * ordering). Never re-serializes the document.
 *
 * @param {string} fileText   Current portals.yml contents.
 * @param {string[]} snippets  Output of renderPortalEntry(), one per entry.
 * @returns {string}
 */
export function insertIntoTrackedCompanies(fileText: string, snippets: readonly string[]): string {
  if (!snippets.length) return fileText;
  let block = snippets.join('');

  // The header line as a user can legitimately write it: bare, with a trailing
  // comment, or as an empty flow list (`tracked_companies: []`). The last two
  // used to miss this match, so a SECOND `tracked_companies:` key was appended
  // to the file, which no YAML parser accepts.
  const header = fileText.match(/^tracked_companies:[ \t]*(?:\[[ \t]*\][ \t]*)?(?:#[^\n]*)?$/m);
  if (!header) {
    // No block at all — append a fresh one at EOF.
    const sep = fileText.endsWith('\n') ? '\n' : '\n\n';
    return `${fileText}${sep}tracked_companies:${block}`;
  }

  // An empty flow list becomes the block form; its trailing comment stays.
  const headerText = header[0].replace(/^(tracked_companies:)[ \t]*\[[ \t]*\]/, '$1');
  const headerEnd = header.index + header[0].length; // index of the newline after the header
  const rest = fileText.slice(headerEnd);
  // Find the block's end: the next top-level key (a line starting with a
  // non-space, non-# char and containing a colon). Comments and indented lines
  // stay in-block. `m` anchors ^ to line starts; the leading \n keeps us from
  // matching the header line itself. A list item written at column 0 (`- name:`,
  // valid YAML and what some YAML emitters produce) is part of the block, not a
  // key, so a line that starts a sequence entry is never the boundary.
  const boundary = rest.match(/\n(?!-(?:[ \t]|\r?\n|$))[^\s#][^\n]*:/);
  const blockEnd = boundary ? headerEnd + boundary.index : fileText.length;

  // Match the indentation of the entries already there: our snippets are
  // indented for the template's two-space style, and a sequence whose entries
  // sit at two different indents is not valid YAML.
  const firstItem = fileText.slice(headerEnd, blockEnd).match(/\n([ ]*)-[ \t]/);
  if (firstItem && firstItem[1].length !== 2) {
    const shift = firstItem[1].length - 2;
    block = block.replace(/^( *)(\S)/gm, (_m: string, spaces: string, ch: string) => (
      shift > 0 ? `${' '.repeat(shift)}${spaces}${ch}` : `${spaces.slice(Math.min(-shift, spaces.length))}${ch}`
    ));
  }

  let before = fileText.slice(0, header.index) + headerText + fileText.slice(headerEnd, blockEnd);
  const after = fileText.slice(blockEnd);
  // Trim trailing blank lines that belong to the block so our leading-newline
  // snippets don't stack extra blank lines before the next key.
  const bodyStart = header.index + headerText.length;
  before = before.replace(/\n[ \t]*(?=\n*$)/g, (m2: string, off: number) => (off >= bodyStart ? '\n' : m2));

  return before + block + after;
}

/**
 * Whether a spliced portals.yml text still parses and carries exactly the
 * expected number of tracked_companies entries. The text splice above works on
 * lines, not on the YAML, so --write checks its own output before replacing the
 * user's file.
 *
 * @param {string} text
 * @param {number} expectedCount
 * @returns {boolean}
 */
export function splicedCorrectly(text: string, expectedCount: number): boolean {
  try {
    const doc = loadYaml(text);
    return isRecord(doc) && Array.isArray(doc.tracked_companies) && doc.tracked_companies.length === expectedCount;
  } catch {
    return false;
  }
}

// ── Network functions (separated from pure logic, like vc-portfolios.ts) ──

/**
 * Probe a single vendor candidate for one company.
 */
export async function probeVendor(company: Company, candidate: Candidate, ctx: Context): Promise<ProbeResult> {
  const cfg = VENDORS[candidate.vendor];
  const entry: PortalEntry = { name: company.name, careers_url: candidate.careers_url };
  if (!cfg || !cfg.provider.detect(entry)) {
    return { status: 'error', jobCount: 0, error: 'no API URL derivable' };
  }
  try {
    const jobs = await cfg.provider.fetch(entry, ctx);
    const jobCount = Array.isArray(jobs) ? jobs.length : 0;
    return { status: jobCount > 0 ? 'match' : 'empty', jobCount };
  } catch (err) {
    const out: ProbeResult = { status: 'error', jobCount: 0, error: errorMessage(err) };
    // _http.ts attaches the numeric status to the thrown error; keeping it is
    // what lets the caller tell a definitive 404 from a transient 5xx instead of
    // re-parsing the message text (#2883).
    const httpStatus = isRecord(err) ? err.status : undefined;
    if (typeof httpStatus === 'number' && Number.isInteger(httpStatus)) out.httpStatus = httpStatus;
    // A refused redirect has no status at all: it is a bare `TypeError: fetch
    // failed`, and the vendor's actual answer lives one level down in
    // err.cause. Recording only err.message discarded that answer, so a
    // BambooHR tenant that does not exist — answered with `302 →
    // www.bamboohr.com`, not a 404 — reached the user as the single word
    // "fetch failed" under advice to re-run it. Same reasoning as the
    // httpStatus line above: keep the discriminator on the object rather than
    // re-parsing prose downstream (#3788).
    if (isRefusedRedirectError(err)) {
      out.refusedRedirect = true;
      out.error = `${out.error} (${causeMessage(err)})`;
    }
    return out;
  }
}

/**
 * Whether a probe failure ESTABLISHES that no board exists.
 *
 * 404 and 410 are answers: the vendor was reached and said the board is not
 * there. Everything else — 5xx, a timeout, DNS, a rejected redirect, or a
 * candidate whose API URL could not even be derived — leaves the question open,
 * because nothing ever answered it.
 */
export function isDefinitiveAbsence(probeError: { readonly httpStatus?: number }): boolean {
  return probeError?.httpStatus === 404 || probeError?.httpStatus === 410;
}

/**
 * Resolve a Workday board from parsed coordinates. Probes each candidate host
 * (one, when the instance is known; a bounded list otherwise) via the real
 * providers/workday.ts fetch, capped to a single CXS page (ctx.maxPages: 1 —
 * the provider honors this as a live-probe). First host that returns ≥1 job
 * wins.
 */
export async function resolveWorkday(company: Company, coords: WorkdayCoords, ctx: Context): Promise<WorkdayResult> {
  const candidates = buildWorkdayCandidates(coords);
  const probeCtx: Context = { ...ctx, maxPages: 1 };
  const tried: string[] = [];
  let emptyUrl: string | null = null;
  let lastError: string | undefined;
  let lastRefusedRedirect = false;

  for (const candidate of candidates) {
    tried.push(candidate.careers_url);
    const entry: PortalEntry = { name: company.name, careers_url: candidate.careers_url };
    if (!workday.detect(entry)) { lastError = 'no CXS endpoint derivable'; continue; }
    try {
      const jobs = await workday.fetch(entry, probeCtx);
      const jobCount = Array.isArray(jobs) ? jobs.length : 0;
      if (jobCount > 0) {
        return {
          resolved: {
            name: company.name,
            vendor: 'workday',
            provider: 'workday',
            slug: coords.tenant,
            careers_url: candidate.careers_url,
            jobCount,
          },
        };
      }
      // Remember the FIRST host that was confirmed live-but-empty, so the
      // reported emptyBoards URL is one we actually probed (not always wd1).
      if (!emptyUrl) emptyUrl = candidate.careers_url;
    } catch (err) {
      lastError = errorMessage(err);
      // The file's second `.fetch(` site, and workday.ts passes
      // redirect:'error' too — so a Workday host that redirects arrives here as
      // the same bare "fetch failed" probeVendor used to report. Keeping the
      // cause costs nothing and stops the two error paths from describing the
      // same failure differently (#3788).
      if (isRefusedRedirectError(err)) {
        lastError = `${lastError} (${causeMessage(err)})`;
        lastRefusedRedirect = true;
      } else {
        lastRefusedRedirect = false;
      }
    }
  }
  return emptyUrl
    ? { status: 'empty', tried, careers_url: emptyUrl }
    : { status: 'error', tried, detail: lastError, refusedRedirect: lastRefusedRedirect };
}

/**
 * Resolve one company: probe slug vendors in VENDOR_ORDER (first with ≥1 job
 * wins), then — if unresolved and Workday coordinates are present/requested —
 * probe Workday. Returns either a resolved record or an unresolved record.
 */
export async function resolveCompany(company: Company, { vendors = VENDOR_ORDER, ctx, includeWorkday = true }: ResolveOptions = {}): Promise<ResolveResult> {
  const { candidates, skipped, unsupported } = buildCandidateUrls(company, vendors);
  const triedVendors: string[] = [];
  const emptyBoards: EmptyBoard[] = [];
  const errors: ProbeError[] = [];
  // Every real caller hands a ctx down from runDiscovery(); the fallback keeps
  // the probe path total for direct calls that resolve no candidates at all.
  const probeCtx: Context = ctx ?? makeHttpCtx();

  for (const candidate of candidates) {
    triedVendors.push(candidate.vendor);
    const result = await probeVendor(company, candidate, probeCtx);
    if (result.status === 'match') {
      const cfg = VENDORS[candidate.vendor];
      const resolved: ResolvedMatch = {
        name: company.name,
        vendor: cfg.id,
        slug: candidate.slug,
        careers_url: candidate.careers_url,
        jobCount: result.jobCount,
      };
      if (cfg.api) resolved.api = cfg.api(candidate.slug);
      return { resolved };
    }
    if (result.status === 'empty' && candidate.vendor === 'smartrecruiters') {
      // SmartRecruiters' public postings API answers 200 with totalFound:0
      // for ANY slug, including one that does not exist — unlike every other
      // probed vendor, "empty" here establishes nothing. Counting it in
      // emptyBoards let a single phantom hit outrank a real "not found"
      // verdict from every other vendor, since emptyBoards is checked first
      // in the reason ladder below: an unmatched company name would read as
      // "board(s) found but currently list 0 jobs — re-run later", advising
      // a retry that can never produce a different answer (#4179). Silently
      // excluded from both emptyBoards and errors[] — the vendor still shows
      // up in triedVendors, it just contributes no verdict either way. The
      // accepted cost: a genuinely existing SmartRecruiters board with zero
      // OPEN postings right now also reads as "not found" instead of "found,
      // empty" — cheaper than every unmatched name reading as "found".
    } else if (result.status === 'empty') {
      emptyBoards.push({ vendor: candidate.vendor, careers_url: candidate.careers_url });
    } else {
      const entry: ProbeError = { vendor: candidate.vendor, error: result.error };
      if (typeof result.httpStatus === 'number' && Number.isInteger(result.httpStatus)) entry.httpStatus = result.httpStatus;
      if (result.refusedRedirect) entry.refusedRedirect = true;
      if (isDefinitiveAbsence(result)) entry.definitive = true;
      errors.push(entry);
    }
  }

  // Workday: only when a coordinate hint is present (a name alone can't resolve
  // a Workday site). Confirmed live via the real workday provider.
  const coords = includeWorkday ? parseWorkdayHint(company) : null;
  if (coords) {
    triedVendors.push('workday');
    const wd = await resolveWorkday(company, coords, probeCtx);
    if ('resolved' in wd) return { resolved: wd.resolved };
    if (wd.status === 'empty') {
      // Use the host resolveWorkday actually confirmed empty, not always wd1.
      emptyBoards.push({ vendor: 'workday', careers_url: wd.careers_url });
    } else if (wd.detail) {
      const wdEntry: ProbeError = { vendor: 'workday', error: wd.detail };
      // Carried so errors[] describes a Workday refusal the same way it
      // describes a BambooHR one. It cannot reach the reason ladder — the
      // refused-redirect branch is guarded by !coords and a Workday probe only
      // runs WITH coords — but a machine reading errors[] should not have to
      // know that (#3788).
      if (wd.refusedRedirect) wdEntry.refusedRedirect = true;
      errors.push(wdEntry);
    }
  }

  // A Workday hint was supplied (via any field parseWorkdayHint reads) but
  // produced no usable coords — i.e. it was malformed/rejected. Distinct from
  // "no hint at all", so the message can tell the user to fix their input
  // rather than suggesting they add one. `includeWorkday` gates this the same
  // way the probe above is gated.
  const workdayHintProvided = includeWorkday
    && (typeof company.workday === 'string'
      ? company.workday.trim() !== ''
      : typeof company.workday === 'object' && company.workday !== null);
  // A failure is SETTLED when the vendor answered and re-running the identical
  // probe cannot produce a different answer. Two ways that happens, and they
  // mean different things:
  //
  //   - a definitive 404/410 — the board is not there (#2883);
  //   - a refused redirect — the vendor pointed us off-tenant, which says "not
  //     this slug", NOT "no board". BambooHR does not 404 an unknown tenant; it
  //     answers `302 → www.bamboohr.com`. MaRS Discovery District redirects on
  //     the derived `mars-discovery-district` and returns three jobs on
  //     `marsdd`, so calling that absence would be as wrong as calling it
  //     transient (#3788).
  //
  // Both are settled, so neither should advise re-running the same probe; only
  // the first establishes absence, which is why refusedRedirect gets its own
  // verdict below instead of joining isDefinitiveAbsence().
  const isSettled = (e: ProbeError): boolean => isDefinitiveAbsence(e) || e.refusedRedirect === true;
  const reason = emptyBoards.length
    ? 'board(s) found but currently list 0 jobs — re-run later or force-add manually'
    // Every probe errored and nothing was confirmed absent or empty — don't
    // claim "no board found", the status is unknown.
    //
    // Unless every failure was SETTLED. A 404 from Greenhouse/Ashby/Lever is
    // an answer, not a hiccup: the board is not there and re-running will say so
    // again. Advising a retry in that case erased the difference between "this
    // company has no board" and "the network hiccuped", which is exactly the
    // pair a user pruning portals.yml has to tell apart (#2883). One transient
    // failure among them is enough to leave the question open — that vendor
    // never answered, so absence is not established.
    : (errors.length && !coords && !errors.every(isSettled))
      ? 'probe error(s) occurred — board status unknown, see errors[] and re-run'
      // Settled, but by a redirect rather than a 404: the actionable fix is the
      // slug, not a retry and not a Workday hint.
      : (errors.length && !coords && errors.some((e) => e.refusedRedirect))
        ? 'vendor(s) redirected off-tenant ('
          + errors.filter((e) => e.refusedRedirect).map((e) => e.vendor).join(', ')
          + ') — the slug is wrong, or no board exists under it. The same probe '
          + 'will redirect again, so set an explicit `slug` and re-run.'
        // A hint was given but rejected by parseWorkdayHint (bad chars, missing
        // tenant/site): tell the user to fix it, not to add one.
        : (workdayHintProvided && !coords)
          ? 'Workday hint given but rejected (invalid/missing tenant or site) — check the `workday` field and re-run'
          : coords
            ? 'Workday coordinates given but no live board with open jobs found at the probed host(s).'
            // Nothing was probeable: every vendor's own contract rejected this
            // slug's shape, so no board was ruled out — say that, rather than
            // implying we looked and found nothing.
            : (!candidates.length && unsupported.length)
              ? `slug "${company.slug || deriveSlug(company.name)}" is not a valid board slug for any probed vendor `
                + `(${unsupported.join(', ')}) — nothing was probed; fix the \`slug\` field and re-run.`
              // VENDOR_ORDER covers eleven vendors now, so name none of them here.
              : 'no supported ATS board found. If this company uses Workday, add a hint — '
                + 'a full careers URL (workday: https://<tenant>.wd<N>.myworkdayjobs.com/<site>) or '
                + 'workday: {tenant, site} — and re-run; discover-ats will confirm and add it.';

  const unresolved: UnresolvedCompany = { name: company.name, triedVendors, reason };
  if (skipped.length) unresolved.skippedUnsafeSlug = skipped;
  // Well-formed URL on the right host, but the vendor's own slug contract
  // rejects its shape — reported separately so it isn't read as a probe failure.
  if (unsupported.length) unresolved.unsupportedSlugShape = unsupported;
  if (emptyBoards.length) unresolved.emptyBoards = emptyBoards;
  if (errors.length) unresolved.errors = errors;
  if (company.website) unresolved.website = company.website;
  return { unresolved };
}

/**
 * Split companies on the user's do-not-apply list (data/blacklist.md) away from
 * the rest, using scan.ts's own findBlacklistEntry so discovery and scanning
 * agree on what is blacklisted. Before probing, a company is checked by name and
 * by every URL it carries (a Workday URL hint AND `website`: either one can be
 * the host a domain-scope entry names); after probing, `urlsOf` lets the caller
 * re-check a resolved board's careers_url. A blacklisted company is never
 * written to portals.yml: scan.ts would drop every posting from it anyway.
 *
 * @returns {{allowed:any[], blacklisted:{name:string, entry:string, reason:string}[]}}
 */
export function partitionBlacklisted(
  companies: readonly Company[],
  blacklist: Blacklist,
  urlsOf: (company: Company) => readonly (string | null | undefined)[] = (c) => [typeof c.workday === 'string' ? c.workday : null, c.website],
): { allowed: Company[]; blacklisted: BlacklistedCompany[] } {
  const allowed: Company[] = [];
  const blacklisted: BlacklistedCompany[] = [];
  for (const c of companies) {
    const urls = urlsOf(c).filter(Boolean).map(asBlacklistUrl);
    let hit: BlacklistEntry | null = null;
    for (const url of urls.length ? urls : ['']) {
      hit = findBlacklistEntry(blacklist, c.name, url);
      if (hit) break;
    }
    if (hit) blacklisted.push({ name: c.name, entry: hit.company, reason: hit.reason });
    else allowed.push(c);
  }
  return { allowed, blacklisted };
}

/**
 * The input format documents a bare `website: mollie.com`, which `new URL()`
 * inside findBlacklistEntry rejects, so a scheme-less value would never reach a
 * domain-scope entry. Give it one; a value that already has a scheme is kept.
 */
function asBlacklistUrl(value: unknown): string {
  const v = String(value).trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

/** Bounded-concurrency map (mirrors scan-ats-full.ts parallelEach; not exported there). */
async function parallelEach<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let i = 0;
  async function worker(): Promise<void> {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

/**
 * Probe every company (bounded concurrency) and split into resolved/unresolved.
 */
export async function runDiscovery(companies: readonly Company[], { vendors = VENDOR_ORDER, ctx, concurrency = DEFAULT_CONCURRENCY, includeWorkday = true }: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const results: (ResolveResult | undefined)[] = new Array(companies.length);
  const httpCtx = ctx || makeHttpCtx();
  await parallelEach(companies, concurrency, async (company, idx) => {
    results[idx] = await resolveCompany(company, { vendors, ctx: httpCtx, includeWorkday });
  });
  const resolved: ResolvedMatch[] = [];
  const unresolved: UnresolvedCompany[] = [];
  for (const r of results) {
    if (r && 'resolved' in r) resolved.push(r.resolved);
    else if (r && 'unresolved' in r) unresolved.push(r.unresolved);
  }
  return { resolved, unresolved };
}

// ── Summary output ────────────────────────────────────────────────────

interface SummaryInput {
  resolved: readonly ResolvedMatch[];
  unresolved: readonly UnresolvedCompany[];
  duplicates: readonly ResolvedMatch[];
  blacklisted?: readonly BlacklistedCompany[];
}

function printSummary({ resolved, unresolved, duplicates, blacklisted = [] }: SummaryInput): void {
  console.log(`\n${'='.repeat(78)}`);
  console.log('  ATS Discovery — career-ops');
  console.log(`  resolved: ${resolved.length} | unresolved: ${unresolved.length} | duplicates skipped: ${duplicates.length} | blacklisted skipped: ${blacklisted.length}`);
  console.log(`${'='.repeat(78)}\n`);

  if (resolved.length) {
    console.log('  ' + 'Company'.padEnd(24) + 'Vendor'.padEnd(12) + 'Jobs'.padEnd(7) + 'Board');
    console.log('  ' + '-'.repeat(90));
    for (const r of resolved) {
      console.log('  ' + String(r.name).substring(0, 22).padEnd(24)
        + String(r.vendor).padEnd(12) + String(r.jobCount).padEnd(7) + r.careers_url
        + (r.smallBoard ? `  [small board — verify ownership]` : ''));
    }
    console.log('');
  }

  if (unresolved.length) {
    console.log('  Unresolved (manual follow-up):');
    for (const u of unresolved) {
      const site = u.website ? ` [${u.website}]` : '';
      console.log(`    - ${u.name}${site}: ${u.reason}`);
    }
    console.log('');
  }

  if (blacklisted.length) {
    console.log('  Skipped — on data/blacklist.md (never added):');
    for (const b of blacklisted) {
      console.log(`    - ${b.name} (matched "${b.entry}")${b.reason ? `: ${b.reason}` : ''}`);
    }
    console.log('');
  }
}

// ── Self-test (pure, no network) ────────────────────────────────────────

function runSelfTest(): void {
  let pass = 0;
  let fail = 0;
  const check = (cond: unknown, label: string): void => {
    if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL: ${label}`); }
  };

  // deriveSlug
  check(deriveSlug('Trade Republic') === 'trade-republic', 'deriveSlug spaces → dashes');
  check(deriveSlug('  N8N!  ') === 'n8n', 'deriveSlug trims + strips punctuation');
  check(deriveSlug('Adyen') === 'adyen', 'deriveSlug simple lowercases');

  // parseCompanyInput
  const p1 = parseCompanyInput('companies:\n  - name: Adyen\n  - name: Monzo\n    slug: monzo-bank\n', ['Ramp']);
  check(p1.companies.length === 3, 'parseCompanyInput merges file + CLI names');
  check(p1.companies[1].slug === 'monzo-bank', 'parseCompanyInput keeps explicit slug');
  const p2 = parseCompanyInput('companies:\n  - name: Adyen\n', ['adyen']);
  check(p2.companies.length === 1, 'parseCompanyInput dedupes by lowercased name');
  const p3 = parseCompanyInput(': : not valid yaml : :\n[', []);
  check(p3.companies.length === 0 && p3.warnings.length > 0, 'parseCompanyInput warns on malformed YAML, never throws');
  const p4 = parseCompanyInput('companies:\n  - name: ""\n  - slug: x\n', []);
  check(p4.companies.length === 0, 'parseCompanyInput drops nameless entries');

  // buildCandidateUrls
  const b1 = buildCandidateUrls({ name: 'Adyen' });
  // Counted off VENDOR_ORDER rather than a literal, so adding a vendor does not
  // require editing an unrelated assertion.
  check(b1.candidates.length === VENDOR_ORDER.length, 'buildCandidateUrls emits one candidate per vendor');
  check(b1.candidates[0].vendor === 'gh' && b1.candidates[0].careers_url === 'https://job-boards.greenhouse.io/adyen', 'buildCandidateUrls GH url');
  // The three highest-hit-rate vendors stay first: resolveCompany returns on the
  // first match, so this ordering is what caps a company they can resolve at
  // three probes (one on gh, two on ashby, three on lever) rather than eleven.
  check(b1.candidates.slice(0, 3).map((c) => c.vendor).join(',') === 'gh,ashby,lever', 'buildCandidateUrls probes the common vendors first');
  const b2 = buildCandidateUrls({ name: 'X', slug: 'bad/slug' });
  check(b2.candidates.length === 0 && b2.skipped.length === VENDOR_ORDER.length, 'buildCandidateUrls SLUG_RE rejects unsafe slug (no URL built)');

  // Long-tail vendors: path-style hosts are constant, subdomain-style hosts are
  // derived from the slug, and every built URL must survive its own host assertion.
  const byVendor = Object.fromEntries(b1.candidates.map((c) => [c.vendor, c.careers_url]));
  check(byVendor.workable === 'https://apply.workable.com/adyen', 'buildCandidateUrls workable url');
  check(byVendor.smartrecruiters === 'https://careers.smartrecruiters.com/adyen', 'buildCandidateUrls smartrecruiters url');
  check(byVendor.rippling === 'https://ats.rippling.com/adyen/jobs', 'buildCandidateUrls rippling url');
  check(byVendor.join === 'https://join.com/companies/adyen', 'buildCandidateUrls join url');
  check(byVendor.recruitee === 'https://adyen.recruitee.com', 'buildCandidateUrls recruitee subdomain url');
  check(byVendor.breezy === 'https://adyen.breezy.hr', 'buildCandidateUrls breezy subdomain url');
  check(byVendor.bamboohr === 'https://adyen.bamboohr.com', 'buildCandidateUrls bamboohr subdomain url');
  check(byVendor.pinpoint === 'https://adyen.pinpointhq.com', 'buildCandidateUrls pinpoint subdomain url');
  // Every candidate must be accepted by its own provider's detect(), or the probe
  // would report "no API URL derivable" instead of actually checking the board.
  check(
    b1.candidates.every((c) => !!VENDORS[c.vendor].provider.detect({ name: 'Adyen', careers_url: c.careers_url })),
    'every built candidate URL is recognized by its provider detect()',
  );
  // Ashby boards are case-sensitive so slugs are not lowercased globally, but the
  // subdomain vendors only match lowercase hosts. A mixed-case slug must still
  // produce a probeable URL for them rather than being silently skipped.
  const bMixed = buildCandidateUrls({ name: 'DeepL', slug: 'DeepL' });
  const mixed = Object.fromEntries(bMixed.candidates.map((c) => [c.vendor, c.careers_url]));
  check(mixed.ashby === 'https://jobs.ashbyhq.com/DeepL', 'buildCandidateUrls preserves slug case for Ashby');
  check(mixed.recruitee === 'https://deepl.recruitee.com', 'buildCandidateUrls lowercases a subdomain host');
  check(bMixed.skipped.length === 0, 'a mixed-case slug is not skipped by the host assertion');

  // Dotted slug. SLUG_RE allows dots (path vendors accept them), but a subdomain
  // vendor turns `foo.bar` into `foo.bar.bamboohr.com` — two tenant labels, which
  // every subdomain provider's `<tenant>.<vendor>` regex rejects. The host
  // assertion can't catch it (expected is built by the same concatenation), so
  // the provider-contract gate is what keeps it out of the probe loop.
  const SUBDOMAIN_VENDORS = ['recruitee', 'breezy', 'bamboohr', 'pinpoint'];
  const bDot = buildCandidateUrls({ name: 'X', slug: 'foo.bar' });
  const dotCandidates = new Set(bDot.candidates.map((c) => c.vendor));
  check(
    SUBDOMAIN_VENDORS.every((v) => !dotCandidates.has(v) && bDot.unsupported.includes(v)),
    'a dotted slug is unsupported for every subdomain vendor, never a candidate',
  );
  check(bDot.skipped.length === 0, 'a dotted slug is an unsupported shape, not an unsafe-slug skip');
  check(
    bDot.candidates.length > 0
      && bDot.candidates.every((c) => !!VENDORS[c.vendor].provider.detect({ name: 'X', careers_url: c.careers_url })),
    'a dotted slug still probes the vendors whose contract accepts it',
  );
  // The security property, asserted rather than argued: buildUrl always appends
  // the vendor suffix, so no slug can move the host off the vendor's own domain.
  // A dotted slug is a wasted-probe/reporting problem, not an SSRF one.
  const SUBDOMAIN_SUFFIX = {
    recruitee: '.recruitee.com', breezy: '.breezy.hr', bamboohr: '.bamboohr.com', pinpoint: '.pinpointhq.com',
  };
  let offDomain = 0;
  for (const s of ['foo.bar', 'evil.com', 'a.b.c.d', '..evil.com', 'x.bamboohr.com', '169.254.169.254']) {
    for (const c of buildCandidateUrls({ name: 'X', slug: s }, SUBDOMAIN_VENDORS).candidates) {
      if (!new URL(c.careers_url).hostname.endsWith(SUBDOMAIN_SUFFIX[c.vendor])) offDomain += 1;
    }
  }
  check(offDomain === 0, 'no slug can move a subdomain-vendor host off the vendor domain');

  const b3 = buildCandidateUrls({ name: 'Adyen' }, ['ashby']);
  check(b3.candidates.length === 1 && b3.candidates[0].vendor === 'ashby', 'buildCandidateUrls honors vendor subset');

  // renderPortalEntry
  const gh = renderPortalEntry({ name: 'Adyen', careers_url: 'https://job-boards.greenhouse.io/adyen', api: 'https://boards-api.greenhouse.io/v1/boards/adyen/jobs' });
  check(gh.includes('  - name: Adyen') && gh.includes('    api: https://boards-api.greenhouse.io/v1/boards/adyen/jobs'), 'renderPortalEntry GH includes api line');
  const lv = renderPortalEntry({ name: 'Mistral AI', careers_url: 'https://jobs.lever.co/mistral' });
  check(!lv.includes('api:'), 'renderPortalEntry non-GH omits api line');
  const q = renderPortalEntry({ name: 'Foo: Bar', careers_url: 'https://jobs.ashbyhq.com/foo' });
  check(q.includes('name: "Foo: Bar"'), 'renderPortalEntry quotes name with colon');

  // small-board flag (#4772): advisory field + `# verify:` comment, only when flagged
  const sb = flagSmallBoards([{ name: 'A', jobCount: 1 }, { name: 'B', jobCount: 6 }]);
  check(sb[0].smallBoard === true && sb[1].smallBoard === undefined, 'flagSmallBoards flags only boards at or under the threshold');
  check(renderPortalEntry({ name: 'A', careers_url: 'https://x', smallBoard: true, jobCount: 1 }).includes('# verify:'), 'renderPortalEntry adds # verify: for a small board');
  check(!renderPortalEntry({ name: 'B', careers_url: 'https://x', jobCount: 6 }).includes('# verify:'), 'renderPortalEntry omits # verify: for a larger board');

  // dedupeAgainstPortals
  const existing = [{ name: 'Adyen', careers_url: 'https://job-boards.greenhouse.io/adyen/' }];
  const d1 = dedupeAgainstPortals([{ name: 'Adyen', careers_url: 'x' }], existing);
  check(d1.duplicates.length === 1 && d1.fresh.length === 0, 'dedupe by name hit');
  const d2 = dedupeAgainstPortals([{ name: 'Other', careers_url: 'https://job-boards.greenhouse.io/adyen' }], existing);
  check(d2.duplicates.length === 1, 'dedupe by careers_url hit (trailing slash normalized)');
  const d3 = dedupeAgainstPortals([{ name: 'A', careers_url: 'u1' }, { name: 'A', careers_url: 'u2' }], []);
  check(d3.fresh.length === 1, 'dedupe self-dedupes within fresh');

  // insertIntoTrackedCompanies — normal block with trailing top-level key
  const doc = 'title_filter:\n  positive: [a]\n\ntracked_companies:\n  - name: Existing\n    careers_url: https://jobs.lever.co/existing\n\njob_boards:\n  - name: Foo\n';
  const snippet = renderPortalEntry({ name: 'New', careers_url: 'https://jobs.lever.co/new' });
  const inserted = insertIntoTrackedCompanies(doc, [snippet]);
  check(inserted.indexOf('- name: New') < inserted.indexOf('job_boards:'), 'insert lands before job_boards:');
  check(inserted.indexOf('- name: New') > inserted.indexOf('tracked_companies:'), 'insert lands after tracked_companies:');
  check(inserted.startsWith('title_filter:\n  positive: [a]\n'), 'insert preserves leading bytes');
  check(inserted.includes('job_boards:\n  - name: Foo\n'), 'insert preserves trailing block');
  // idempotency via dedupe: the same board already present → nothing fresh → no insert
  const parsed = loadYaml(inserted);
  const again = dedupeAgainstPortals([{ name: 'New', careers_url: 'https://jobs.lever.co/new' }], parsed.tracked_companies);
  check(again.fresh.length === 0, 'insert is idempotent through dedupe');

  // missing header → appended
  const noHeader = insertIntoTrackedCompanies('title_filter:\n  positive: [a]\n', [snippet]);
  check(/tracked_companies:/.test(noHeader) && noHeader.includes('- name: New'), 'insert appends fresh block when header missing');

  // empty block
  const emptyBlock = insertIntoTrackedCompanies('tracked_companies:\njob_boards:\n  - name: Foo\n', [snippet]);
  check(emptyBlock.indexOf('- name: New') < emptyBlock.indexOf('job_boards:'), 'insert handles empty block');

  // parseWorkdayHint — URL form
  const wh1 = parseWorkdayHint({ name: 'Nvidia', workday: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite' });
  check(wh1 && wh1.tenant === 'nvidia' && wh1.instance === 'wd5' && wh1.site === 'NVIDIAExternalCareerSite', 'parseWorkdayHint parses full URL');
  const wh1b = parseWorkdayHint({ name: 'X', careers_url: 'https://acme.wd3.myworkdayjobs.com/en-US/Careers/job/foo' });
  check(wh1b && wh1b.tenant === 'acme' && wh1b.instance === 'wd3' && wh1b.site === 'Careers', 'parseWorkdayHint strips locale + trailing path');
  // object form, instance optional
  const wh2 = parseWorkdayHint({ name: 'Salesforce', workday: { tenant: 'salesforce', site: 'External_Career_Site' } });
  check(wh2 && wh2.tenant === 'salesforce' && wh2.instance === null && wh2.site === 'External_Career_Site', 'parseWorkdayHint object form, null instance');
  // no hint → null
  check(parseWorkdayHint({ name: 'Adyen' }) === null, 'parseWorkdayHint returns null without hint');
  // unsafe segment rejected
  check(parseWorkdayHint({ name: 'X', workday: { tenant: 'bad/tenant', site: 'S' } }) === null, 'parseWorkdayHint rejects unsafe segment');

  // buildWorkdayCandidates
  const wc1 = buildWorkdayCandidates({ tenant: 'nvidia', instance: 'wd5', site: 'NVIDIAExternalCareerSite' });
  check(wc1.length === 1 && wc1[0].careers_url === 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', 'buildWorkdayCandidates known instance → single URL');
  const wc2 = buildWorkdayCandidates({ tenant: 'salesforce', instance: null, site: 'External_Career_Site' });
  check(wc2.length === WORKDAY_INSTANCES.length && wc2[0].careers_url.includes('salesforce.wd1.'), 'buildWorkdayCandidates null instance → expands across instances');

  // renderPortalEntry — workday provider line
  const wdEntry = renderPortalEntry({ name: 'Nvidia', careers_url: 'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite', provider: 'workday' });
  check(wdEntry.includes('    provider: workday') && !wdEntry.includes('api:'), 'renderPortalEntry emits provider: workday, no api line');

  console.log(`\n  discover-ats self-test: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

// ── CLI arg parsing ──────────────────────────────────────────────────

// --write is the explicit opt-in to modify portals.yml (a user-layer file);
// without it the run is preview-only. --dry-run is accepted as a harmless alias
// for "don't write" (the default) so an older invocation never surprises anyone.
const KNOWN_FLAGS = ['--in', '--vendors', '--small-threshold', '--write', '--dry-run', '--summary', '--self-test', '--help', '-h'];
const VALUE_FLAGS = ['--in', '--vendors', '--small-threshold'];

function parseArgs(argv: readonly string[]): CliOptions {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }

  const consumedValueIndices = new Set<number>();
  args.forEach((a, idx) => {
    if (VALUE_FLAGS.includes(a) && args[idx + 1] !== undefined && !args[idx + 1].startsWith('--')) {
      consumedValueIndices.add(idx + 1);
    }
  });

  const unknownFlags = args.filter((a, idx) =>
    a.startsWith('-') && !consumedValueIndices.has(idx) && !KNOWN_FLAGS.includes(a.split('=')[0]));
  if (unknownFlags.length) {
    console.error(`Error: unrecognized flag(s): ${unknownFlags.join(', ')}. Valid flags: ${KNOWN_FLAGS.join(', ')}`);
    process.exit(1);
  }

  const valueOf = (flag: string): string | null => {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
    const kv = args.find((a) => a.startsWith(flag + '='));
    return kv ? kv.split('=').slice(1).join('=') : null;
  };

  // --vendors accepts the slug vendors (gh/ashby/lever) plus `workday` as a
  // toggle. Workday only fires when a company carries a coordinate hint; listing
  // it here alongside slug vendors lets a user scope a run to Workday alone
  // (--vendors workday) or drop it (--vendors gh,ashby,lever).
  const vendorsArg = valueOf('--vendors');
  const requested = vendorsArg
    ? vendorsArg.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [...VENDOR_ORDER, 'workday'];
  const validVendors = new Set([...VENDOR_ORDER, 'workday']);
  const unknownVendors = requested.filter((v) => !validVendors.has(v));
  if (unknownVendors.length) {
    console.error(`Error: unknown vendor(s): ${unknownVendors.join(', ')}. Valid: ${[...validVendors].join(', ')}`);
    process.exit(1);
  }
  const vendors = requested.filter((v) => VENDORS[v]);
  const includeWorkday = requested.includes('workday');

  // Positional args (not flags, not a consumed flag value) are company names.
  const names = args.filter((a, idx) => !a.startsWith('-') && !consumedValueIndices.has(idx));

  // Same shape check as audit-portals.ts: a non-negative number, 0 = off.
  const rawThreshold = valueOf('--small-threshold');
  const smallThreshold = rawThreshold === null ? DEFAULT_SMALL_THRESHOLD : Number(rawThreshold);
  if (!Number.isFinite(smallThreshold) || smallThreshold < 0 || String(rawThreshold).trim() === '') {
    console.error(`Error: --small-threshold expects a non-negative number, got "${rawThreshold}"`);
    process.exit(1);
  }

  return {
    smallThreshold,
    inPath: valueOf('--in'),
    vendors,
    includeWorkday,
    // Preview by default; only --write may touch portals.yml. --dry-run is an
    // accepted no-op alias (it just reaffirms the default).
    write: args.includes('--write'),
    summary: args.includes('--summary'),
    selfTest: args.includes('--self-test'),
    names,
  };
}

// ── Main ──────────────────────────────────────────────────────────────

interface DiscoveryMetadata {
  resolved: number;
  unresolved: number;
  duplicatesSkipped: number;
  blacklistedSkipped: number;
  fresh: number;
  freshWritten: number;
  written: boolean;
  previewOnly: boolean;
  portalsPath: string;
  warnings: string[];
}

interface DiscoveryEnvelope {
  metadata: DiscoveryMetadata;
  resolved: ResolvedMatch[];
  unresolved: UnresolvedCompany[];
  blacklisted: BlacklistedCompany[];
  /** Rendered YAML for the entries that were not written (preview / no file). */
  pendingEntries?: string;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  if (opts.selfTest) runSelfTest();

  let rawYaml = '';
  if (opts.inPath) {
    const path = resolve(process.cwd(), opts.inPath);
    if (!existsSync(path)) {
      console.error(`Error: input file not found: ${opts.inPath}`);
      process.exit(1);
    }
    rawYaml = readFileSync(path, 'utf-8');
  }

  const { companies, warnings } = parseCompanyInput(rawYaml, opts.names);

  if (companies.length === 0) {
    // Emit the same metadata shape as the normal path (documented in
    // modes/discover.md) so a consumer reading previewOnly/portalsPath on a
    // zero-company run gets the documented envelope, not undefined fields.
    const out: DiscoveryEnvelope = {
      metadata: {
        resolved: 0, unresolved: 0, duplicatesSkipped: 0, blacklistedSkipped: 0, fresh: 0, freshWritten: 0,
        written: false, previewOnly: true, portalsPath: PORTALS_PATH, warnings,
      },
      resolved: [], unresolved: [], blacklisted: [],
    };
    if (opts.summary) printSummary({ resolved: [], unresolved: [], duplicates: [] });
    else console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  const blacklist = loadBlacklist(BLACKLIST_PATH);
  const pre = partitionBlacklisted(companies, blacklist);
  const discovered = await runDiscovery(pre.allowed, { vendors: opts.vendors, includeWorkday: opts.includeWorkday });
  const unresolved = discovered.unresolved;
  // A resolved board's host can hit a domain-scope entry the name did not
  // (e.g. a company listed under a different name on a blacklisted host).
  const post = partitionBlacklisted(discovered.resolved, blacklist, (r) => [r.careers_url]);
  const resolved = post.allowed;
  const blacklisted = [...pre.blacklisted, ...post.blacklisted];
  // Advisory only: resolution and exit codes are unchanged (#4772).
  flagSmallBoards(resolved, opts.smallThreshold);

  // Dedupe resolved matches against the existing tracker.
  let existingEntries: readonly unknown[] = [];
  if (existsSync(PORTALS_PATH)) {
    try {
      const parsed = loadYaml(readFileSync(PORTALS_PATH, 'utf-8'));
      existingEntries = isRecord(parsed) && Array.isArray(parsed.tracked_companies) ? parsed.tracked_companies : [];
    } catch (err) {
      warnings.push(`portals.yml: could not parse for dedupe — ${errorMessage(err)}`);
    }
  }
  const { fresh, duplicates } = dedupeAgainstPortals(resolved, existingEntries);
  const snippets = fresh.map(renderPortalEntry);

  // Data-contract rule: portals.yml is a USER-LAYER file and is NEVER written
  // unless the user explicitly opts in with --write. The default is preview —
  // we print the entries we WOULD add and touch nothing. This mirrors how the
  // rest of career-ops treats user files (see DATA_CONTRACT.md).
  let written = false;
  if (opts.write && fresh.length && existsSync(PORTALS_PATH)) {
    const current = readFileSync(PORTALS_PATH, 'utf-8');
    const next = insertIntoTrackedCompanies(current, snippets);
    if (splicedCorrectly(next, existingEntries.length + fresh.length)) {
      // Write-to-temp-then-rename: atomic on the same filesystem, so a crash
      // mid-write can't leave the user's portals.yml truncated.
      const tmpPath = `${PORTALS_PATH}.tmp-${process.pid}`;
      writeFileSync(tmpPath, next, 'utf-8');
      renameSyncWithRetry(tmpPath, PORTALS_PATH);
      written = true;
    } else {
      // A text splice cannot cover every way tracked_companies can be written.
      // Rather than leave a portals.yml the scanner cannot parse, keep the file
      // as it is and print the entries for the user to paste.
      warnings.push(`--write skipped — splicing into ${PORTALS_PATH} would not leave it as valid YAML with ${existingEntries.length + fresh.length} tracked_companies entries; the file is unchanged and the entries are shown in pendingEntries to add by hand`);
    }
  } else if (opts.write && fresh.length && !existsSync(PORTALS_PATH)) {
    warnings.push(`--write given but portals.yml not found at ${PORTALS_PATH} — printing entries instead`);
  } else if (!opts.write && fresh.length) {
    warnings.push(`preview only — ${fresh.length} new entr${fresh.length === 1 ? 'y' : 'ies'} shown in pendingEntries; re-run with --write to append them to portals.yml`);
  }

  const metadata: DiscoveryMetadata = {
    resolved: resolved.length,
    unresolved: unresolved.length,
    duplicatesSkipped: duplicates.length,
    blacklistedSkipped: blacklisted.length,
    fresh: fresh.length,
    freshWritten: written ? fresh.length : 0,
    written,
    previewOnly: !written,
    portalsPath: PORTALS_PATH,
    warnings,
  };

  if (opts.summary) {
    printSummary({ resolved, unresolved, duplicates, blacklisted });
  } else {
    const out: DiscoveryEnvelope = { metadata, resolved, unresolved, blacklisted };
    // Show the would-be YAML whenever we didn't write it (preview, or --write
    // that couldn't find the file), so the user can paste it manually.
    if (!written) out.pendingEntries = snippets.join('');
    console.log(JSON.stringify(out, null, 2));
  }
  process.exit(0);
}

// --- Run (CLI only; guarded so the module is safely importable for tests) ---
if (isMainModule(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`discover-ats: ${errorText(err)}`);
    process.exit(1);
  });
}
