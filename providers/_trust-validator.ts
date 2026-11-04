// _trust-validator.ts — Lightweight trust validation for scanned job postings.
//
// Enriches each job with trustScore (0-100), trustFlags (string[]), and
// trustLevel ('high' | 'medium' | 'low'). Never drops jobs — flag only.
//
// Underscore prefix keeps scan.ts's provider loader from importing this
// as a job-board provider.
//
// V1 heuristics:
//   1. URL structure validation
//   2. Missing application URL
//   3. Suspicious domain detection
//   4. Company ↔ domain mismatch (with ATS allowlist)

import { asciiFold } from '../lib/ascii-fold.ts';
import type { TrustLevel, TrustResult } from './_types.ts';

/** The `trust_filter:` block from portals.yml. */
export interface TrustFilterConfig {
  /** Default: enabled unless explicitly `false`. */
  enabled?: boolean;
  /** Replaces the built-in shortener list when present. */
  suspicious_domains?: string[];
  /** Replaces the built-in ATS allowlist when present. */
  ats_allowlist?: string[];
}

/** The job fields trust validation reads. */
export interface TrustSubject {
  url?: string | null;
  company?: string | null;
}

/** A validator built from config, applied to one posting at a time. */
export type TrustValidator = (job: TrustSubject) => TrustResult;

const DEFAULT_SUSPICIOUS_DOMAINS: string[] = [
  'bit.ly',
  'tinyurl.com',
  't.co',
  'forms.gle',
  'goo.gl',
  'shorturl.at',
  'rebrand.ly',
  'cutt.ly',
];

const DEFAULT_ATS_ALLOWLIST: string[] = [
  'greenhouse.io',
  'ashbyhq.com',
  'lever.co',
  'workday.com',
  'smartrecruiters.com',
  'jobvite.com',
  'myworkdayjobs.com',
  'recruitee.com',
  'workable.com',
  'icims.com',
  'taleo.net',
  'applytojob.com',
  'breezy.hr',
  'jazz.co',
  'bamboohr.com',
  'teamtailor.com',
];

/** Points deducted per trust flag. */
const PENALTIES = {
  invalid_url: 50,
  missing_apply_url: 40,
  suspicious_domain: 25,
  company_domain_mismatch: 15,
};

/**
 * Classify a numeric trust score into a human-readable level.
 *
 * @param score - 0-100 trust score.
 */
export function classifyTrustLevel(score: number): TrustLevel {
  if (score >= 90) return 'high';
  if (score >= 60) return 'medium';
  return 'low';
}

/**
 * Check whether a URL string is well-formed and uses http(s).
 *
 * @param url - Candidate posting URL.
 */
export function validateUrl(url: string): { valid: boolean; flag?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { valid: false, flag: 'invalid_url' };
    }
    return { valid: true };
  } catch {
    return { valid: false, flag: 'invalid_url' };
  }
}

/**
 * Check whether a hostname matches or is a subdomain of any entry in a
 * domain list.  E.g. hostname "abc.bit.ly" matches blocklist entry "bit.ly".
 *
 * @param hostname - lowercased hostname from URL
 * @param domainList - domains to test against
 */
export function matchesDomainList(hostname: string, domainList: readonly string[]): boolean {
  for (const domain of domainList) {
    if (hostname === domain || hostname.endsWith('.' + domain)) {
      return true;
    }
  }
  return false;
}


/**
 * ASCII-fold a company name for comparison against a hostname.
 *
 * NFD is the right tool HERE and the wrong one in foldStatusInput()
 * (tracker-utils.ts, #2705). There the fold must not collapse distinct
 * identities — Żubr must never become Zubr. Here we are deliberately comparing
 * against an ASCII hostname, so folding to the ASCII base letter is the whole
 * point: "societegenerale.com" IS the ASCII folding of "Société Générale".
 *
 * The previous `[^a-z0-9 ]` strip DELETED accented letters instead of folding
 * them, so "Société Générale" became "socit gnrale" and matched neither the
 * slug nor any word of its own domain (#2924).
 *
 * @param company - Company name as the source spells it.
 * @returns Lowercased, space-separated ASCII, or '' when nothing Latin remains.
 */
export function asciiFoldForHostname(company: string): string {
  // punctuation: 'delete', not the shared default of 'space'. Deliberate, and
  // the reason this migration was not a straight swap (#3040): the word-level
  // check below matches any word of 3+ chars, so turning punctuation into a
  // separator would CREATE words that were never there —
  // "Smith&Jones" -> [smith, jones], and `smith` substring-matches
  // smithfield.com, so a mismatch that should be flagged silently is not.
  // Fewer false penalties is the safe direction in general; on a legitimacy
  // validator, the flag NOT firing is the failure that costs something.
  return asciiFold(company, { punctuation: 'delete' });
}

/**
 * Heuristic: does the company name plausibly match the URL hostname?
 *
 * Strips non-alphanumeric chars from the company name, lowercases, and checks
 * whether the result (or any word ≥3 chars) appears as a substring of the
 * hostname.  Returns true when a match is found (= no mismatch flag needed).
 *
 * @param company - Company name (nullish values can't be evaluated → true).
 * @param hostname - Hostname the posting's URL resolves to.
 * @returns true if company matches hostname
 */
export function companyMatchesHostname(
  company: string | null | undefined,
  hostname: string | null | undefined,
): boolean {
  if (!company || !hostname) return true; // can't evaluate → no flag

  const normalized = asciiFoldForHostname(company);
  // Nothing Latin survived (a CJK, Cyrillic, Greek, … name). Deliberate, not
  // an oversight: hostnames are effectively ASCII, so such a name can never
  // appear in one and the absence of a match proves nothing. "Working" here
  // would flag every non-Latin company posting on its own legitimate domain —
  // trading a silent skip for a systematic false positive (#2924).
  if (!normalized) return true;

  // Full slug check (all spaces removed)
  const slug = normalized.replace(/\s+/g, '');
  if (hostname.includes(slug)) return true;

  // Word-level check — any word ≥3 chars present in hostname
  const words = normalized.split(/\s+/).filter(w => w.length >= 3);
  for (const word of words) {
    if (hostname.includes(word)) return true;
  }

  return false;
}

/**
 * Build a trust validator function from portals.yml config.
 *
 * Usage mirrors buildLocationFilter / buildSalaryFilter in scan.ts.
 *
 * @param config - The `trust_filter:` block, or nullish for "no filter".
 */
export function buildTrustValidator(config?: TrustFilterConfig | null): TrustValidator {
  // Disabled or absent config → return a no-op that gives every job 100/high
  if (!config || config.enabled === false) {
    return () => ({ score: 100, flags: [], level: 'high' });
  }

  const suspiciousDomains: string[] = (Array.isArray(config.suspicious_domains)
    ? config.suspicious_domains
    : DEFAULT_SUSPICIOUS_DOMAINS)
    .map((d: string) => String(d).toLowerCase().trim())
    .filter(Boolean);

  const atsAllowlist: string[] = (Array.isArray(config.ats_allowlist)
    ? config.ats_allowlist
    : DEFAULT_ATS_ALLOWLIST)
    .map((d: string) => String(d).toLowerCase().trim())
    .filter(Boolean);

  return (job: TrustSubject): TrustResult => {
    const flags: string[] = [];
    let score = 100;

    const url = typeof job.url === 'string' ? job.url.trim() : '';

    // Rule 1 — Missing URL
    if (!url) {
      flags.push('missing_apply_url');
      score -= PENALTIES.missing_apply_url;
      // Can't run further URL-based checks
      const clamped = Math.max(0, score);
      return { score: clamped, flags, level: classifyTrustLevel(clamped) };
    }

    // Rule 2 — URL structure validation
    const urlCheck = validateUrl(url);
    if (!urlCheck.valid) {
      flags.push('invalid_url');
      score -= PENALTIES.invalid_url;
      // Can't parse hostname → skip domain checks
      const clamped = Math.max(0, score);
      return { score: clamped, flags, level: classifyTrustLevel(clamped) };
    }

    // Parse hostname for domain checks
    let hostname = '';
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      // Already validated above, but guard defensively
      const clamped = Math.max(0, score);
      return { score: clamped, flags, level: classifyTrustLevel(clamped) };
    }

    // Rule 3 — Suspicious domain detection
    if (matchesDomainList(hostname, suspiciousDomains)) {
      flags.push('suspicious_domain');
      score -= PENALTIES.suspicious_domain;
    }

    // Rule 4 — Company ↔ domain mismatch (skip for ATS-hosted URLs)
    const company = typeof job.company === 'string' ? job.company.trim() : '';
    if (company && !matchesDomainList(hostname, atsAllowlist)) {
      if (!companyMatchesHostname(company, hostname)) {
        flags.push('company_domain_mismatch');
        score -= PENALTIES.company_domain_mismatch;
      }
    }

    score = Math.max(0, Math.min(100, score));
    return { score, flags, level: classifyTrustLevel(score) };
  };
}
