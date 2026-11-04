#!/usr/bin/env node
/**
 * packages/cli/src/commands/outreach/contact-lookup.ts — Saved-Contact Company Lookup for career-ops (#4691)
 *
 * `contacto` finds ONE fresh outreach target per application via WebSearch —
 * but if the candidate already has a saved contact at the SAME company in
 * `data/contacts.tsv` (written by a prior `contacto` run, or by `add` from an
 * earlier, different-role application), that warm lead is a far stronger
 * starting point than a cold search, and should be surfaced FIRST. This
 * script answers that one question: "do I already have a saved contact at
 * {company}?"
 *
 * MATCHING. Deliberately exact-key, not fuzzy: `data/contacts.tsv`'s company
 * column is normally written by `contacto`/`add` from the SAME company string
 * already in the tracker, so it reuses normalizeCompany() from
 * packages/core/src/tracker/tracker-utils.ts — the identical key packages/cli/src/commands/tracker/merge-tracker.ts, packages/cli/src/commands/tracker/set-status.ts and
 * packages/cli/src/commands/insights/company-history.ts already use for same-company lookups — rather than a
 * second, drifting definition of "same company" (see AGENTS.md's Data
 * Contract on reusing shared helpers instead of inventing new ones). This is
 * NOT packages/cli/src/commands/outreach/linkedin-join.ts's fuzzy token matching: that script joins against
 * free-text LinkedIn export data, which genuinely needs tolerance for
 * "Siemens" vs "Siemens Digital Industries Software"; this one joins against
 * a phonebook the candidate's own prior session wrote, where a fuzzy match
 * would risk surfacing a contact at an unrelated, similarly-named company as
 * a false "warm lead".
 *
 * packages/cli/src/commands/outreach/contacts.ts itself stays zero-dep on purpose (its CLI tests copy just that
 * script + lib/ + packages/core/src/kernel/path-resolver.ts into an isolated temp dir), so this
 * lookup lives in its own file rather than growing packages/cli/src/commands/outreach/contacts.ts's dependency
 * footprint with packages/core/src/tracker/tracker-utils.ts's js-yaml / packages/core/src/tracker/tracker-aliases.json chain.
 *
 * Run: career-ops contact-lookup --company "Acme"            (JSON to stdout)
 *      career-ops contact-lookup --company "Acme" --summary  (human-readable)
 *      career-ops contact-lookup --self-test
 *
 * Issue #4691 — github.com/career-ops-hq/career-ops
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parseContacts } from './contacts.ts';
import { normalizeCompany } from '../../../../core/src/tracker/tracker-utils.ts';
import { validateFlags, flagValue } from '../../../../core/src/kernel/cli-flags.ts';
import { isMainModule } from '../../../../core/src/kernel/is-main-module.ts';
import { getCareerOpsRoot } from '../../../../core/src/kernel/path-resolver.ts';

const DATA_ROOT = getCareerOpsRoot();
const CONTACTS_PATH = join(DATA_ROOT, 'data/contacts.tsv');

// --- CLI args ---
const KNOWN_FLAGS = ['--company', '--summary', '--self-test', '--help', '-h'];

const USAGE = `Usage:
  career-ops contact-lookup --company <name>            # JSON: saved contacts at <name>
  career-ops contact-lookup --company <name> --summary  # human-readable
  career-ops contact-lookup --self-test                  # run the in-memory test suite
  career-ops contact-lookup --help                       # print this usage block and exit`;

const args = isMainModule(import.meta.url) ? process.argv.slice(2) : [];
validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: ['--company'], requireOperand: true });
const selfTestMode = args.includes('--self-test');
const summaryMode = args.includes('--summary');
const companyQuery = flagValue(args, '--company') ?? null;

/**
 * Find saved contacts at the same company (#4691), for contacto's "do I
 * already know someone here?" check before it runs a cold WebSearch.
 *
 * @param {Array} contacts - Parsed contacts (parseContacts().contacts).
 * @param {string} company - Target company name (e.g. the new application's).
 * @returns {Array} Matching contacts, most-recently-listed first, so a later
 *   update-in-place row (e.g. a promotion) outranks an older line for the
 *   same person — contacts.tsv is itself an update-in-place store.
 */
/** One saved contact, as parseContacts() emits it. */
export interface SavedContact {
  name: string;
  company: string;
  type: string;
  title: string;
  phone: string;
  email: string;
  linkedin: string;
  tracker: string | null;
  notes: string;
}

export function findContactsByCompany(contacts: readonly SavedContact[], company: string): SavedContact[] {
  const key = normalizeCompany(company);
  if (!key) return [];
  return contacts.filter((c) => normalizeCompany(c.company) === key).reverse();
}

function renderSummary(company: string, matches: readonly SavedContact[]): string {
  const lines = [`\nSAVED CONTACTS @ ${company}\n`];
  if (!matches.length) {
    lines.push('  No saved contact at this company yet — nothing to surface before the cold search.\n');
    return lines.join('\n');
  }
  for (const c of matches) {
    const bits: string[] = [];
    if (c.title) bits.push(c.title);
    bits.push(c.type ? `type: ${c.type}` : 'type: —');
    bits.push(c.tracker ? `tracker #${c.tracker}` : 'tracker: —');
    lines.push(`  ${c.name} (${bits.join(', ')})`);
    if (c.notes) lines.push(`    notes: ${c.notes}`);
  }
  lines.push('');
  return lines.join('\n');
}

// --- Self-test ---
const CONTACTS_FIXTURE = [
  '# name\tcompany\ttype\ttitle\tphone\temail\tlinkedin\ttracker\tnotes',
  'Jane Doe\tAcme Inc.\tinterviewer\tEng Manager\t\tjane@acme.io\t\t012\tinterviewed me for the SWE role, March 2026',
  'Jörg Müller\tInitech\tpeer\t\t\tjoerg@initech.de\t\t-\tintro via meetup',
  'Old Jane\tAcme Inc.\trecruiter\tOld Title\t\t\t\t007\tolder saved line, same company',
].join('\n');

function selfTest(): void {
  const assert = (cond: boolean, msg: string): void => {
    if (!cond) { console.error(`SELF-TEST FAIL: ${msg}`); process.exit(1); }
  };

  const { contacts } = parseContacts(CONTACTS_FIXTURE);

  // Exact-string company name.
  const exact = findContactsByCompany(contacts, 'Acme Inc.');
  assert(exact.length === 2, `exact company name finds both Acme contacts, got ${exact.length}`);

  // Punctuation/case-insensitive, via normalizeCompany (packages/core/src/tracker/tracker-utils.ts):
  // "ACME, Inc" must still match "Acme Inc." — same normalization the tracker
  // itself uses for same-company dedup.
  const folded = findContactsByCompany(contacts, 'ACME, Inc');
  assert(folded.length === 2, `normalized company name still matches, got ${folded.length}`);

  // Most-recently-listed first.
  assert(folded[0].name === 'Old Jane', 'most-recently-listed row comes first (reversed order)');

  // A company with no saved contact returns an empty array, not throwing.
  assert(findContactsByCompany(contacts, 'Globex').length === 0, 'no match -> empty array');

  // A different company's contact never leaks in.
  const initech = findContactsByCompany(contacts, 'Initech');
  assert(initech.length === 1 && initech[0].name === 'Jörg Müller', 'distinct company matches only its own contact');

  // Empty/placeholder company name never matches every row (normalizeCompany
  // folds '?' etc. to '' — see packages/core/src/tracker/tracker-utils.ts's own `?` -> '' convention).
  assert(findContactsByCompany(contacts, '').length === 0, 'empty query -> empty array, never "matches everything"');
  assert(findContactsByCompany(contacts, '?').length === 0, '"?" placeholder query -> empty array');

  console.log('contact-lookup self-test OK (exact + normalized company matching, empty/placeholder guards)');
}

function main(): void {
  if (selfTestMode) { selfTest(); return; }

  if (!companyQuery) {
    console.error('--company is required, e.g. --company "Acme"');
    process.exit(1);
  }

  const content = existsSync(CONTACTS_PATH) ? readFileSync(CONTACTS_PATH, 'utf-8') : '';
  const { contacts } = parseContacts(content);
  const matches = findContactsByCompany(contacts, companyQuery);

  if (summaryMode) {
    console.log(renderSummary(companyQuery, matches));
  } else {
    console.log(JSON.stringify({ company: companyQuery, matches, total: matches.length }, null, 2));
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
