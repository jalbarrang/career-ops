import type { Context, Job, PortalEntry, Provider } from './_types.ts';

import { safeEncodeURIComponent } from './_safe-url.ts';

// Arbeitsagentur (Bundesagentur für Arbeit) provider — hits the public Jobsuche
// REST API (the same endpoint arbeitsagentur.de uses), so it lives in-process
// alongside the other JSON-API providers (greenhouse/ashby shape). One or more
// keywords are queried; scan.ts applies title_filter + location_filter + dedup
// afterwards, so this provider over-fetches (recall-first).
//
// Configure via a `job_boards` (or `tracked_companies`) entry with
// `provider: arbeitsagentur` and an `arbeitsagentur:` block:
//
//   - name: Arbeitsagentur — ML/KI Deutschland
//     provider: arbeitsagentur
//     arbeitsagentur:
//       keywords: ["Machine Learning Engineer", "Data Scientist"]  # required
//       wo: Berlin              # optional anchor city; omit for nationwide
//       umkreis: 50             # km radius around `wo` (default 50)
//       days: 30                # recency window in days (default 30)
//       size: 100               # results per keyword (1–100, default 100)
//       remoteNationwide: true  # also run a nationwide pass keeping remote-eligible hits
//       remoteMatch: filter     # how that pass detects remote (default 'title'):
//                               #   'filter' — server-side `homeoffice=nv_true` query + pagination to narrow
//                               #              the set, then the same title check as 'title'. Recommended:
//                               #              same standard of proof, applied to a far better candidate set.
//                               #              (v4 confirmed `homeofficetyp: VOLLSTAENDIG` per hit via the
//                               #              detail endpoint; v6 no longer serves it to this key — #2494.)
//                               #   'title'  — regex on the job title only (cheap; misses body-level remote)
//                               #   'off'    — skip the remote pass entirely
//       remoteMaxPages: 10      # 'filter' mode: max pages to paginate (size each); default 1
//     enabled: true

// v6. The v4 search and detail endpoints both 404 as of 2026-08-04 (#2494);
// v5 does too. v6 keeps every query parameter this provider sends
// (was/wo/umkreis/veroeffentlichtseit/angebotsart/homeoffice/page/size) but
// renames the response fields — see normalizeJob().
const API_URL = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs';
const API_KEY = 'jobboerse-jobsuche'; // public client key the arbeitsagentur.de UI uses
const DETAIL_BASE = 'https://www.arbeitsagentur.de/jobsuche/jobdetail/';
const REMOTE_RE = /(remote|homeoffice|home[-\s]?office|ortsunabh|deutschlandweit|bundesweit|100\s*%|full[-\s]?remote|fully remote)/i;

/** Sanitized `arbeitsagentur:` config block. */
export interface ArbeitsagenturConfig {
  keywords: string[];
  wo: string;
  umkreis: number;
  days: number;
  size: number;
  remoteNationwide: boolean;
  remoteMatch: 'title' | 'filter' | 'off';
  remoteMaxPages: number;
}

/** One normalized posting, still carrying its `refnr` (the internal dedup key). */
export interface ArbeitsagenturJob {
  title: string;
  url: string;
  company: string;
  location: string;
  refnr: string;
}

/** Narrow an untrusted JSON value to an object with unknown fields. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Render a thrown value the way a template literal over `(err && err.message) || err` would. */
function errorText(err: unknown): string {
  const raw = asRecord(err).message || err;
  return typeof raw === 'string' ? raw : String(raw);
}

// Clamp a runtime integer into [min, max], falling back to `def` for NaN, so a
// stray portals.yml value can't produce empty (size=0) or pathological queries.
function intInRange(val: unknown, def: number, min: number, max: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Reads and sanitizes the entry's `arbeitsagentur:` config block.
 */
export function parseArbeitsagenturConfig(entry: { arbeitsagentur?: unknown; [key: string]: unknown }): ArbeitsagenturConfig {
  const cfg = asRecord(entry && entry.arbeitsagentur);
  const rawKeywords: unknown[] = Array.isArray(cfg.keywords) ? cfg.keywords : [];
  const keywords: string[] = rawKeywords
    .filter((k: unknown): k is string => typeof k === 'string' && Boolean(k.trim()))
    .map((k: string) => k.trim());
  // Remote-detection mode is config-driven (not hardcoded).
  const remoteMatchRaw = cfg.remoteMatch;
  const remoteMatch: 'title' | 'filter' | 'off' =
    remoteMatchRaw === 'title' || remoteMatchRaw === 'filter' || remoteMatchRaw === 'off' ? remoteMatchRaw : 'title';
  return {
    keywords,
    wo: typeof cfg.wo === 'string' ? cfg.wo.trim() : '',
    umkreis: intInRange(cfg.umkreis, 50, 0, 1000), // km; only used when `wo` is set
    days: intInRange(cfg.days, 30, 1, 1000),       // recency window
    size: intInRange(cfg.size, 100, 1, 100),       // results per keyword (API max 100)
    remoteNationwide: cfg.remoteNationwide === true,
    remoteMatch,
    remoteMaxPages: intInRange(cfg.remoteMaxPages, 1, 1, 20),
  };
}

/**
 * Assembles a human-readable location from v6's `stellenlokationen` array. Most
 * postings are in Germany; only a non-DE country is appended so the downstream
 * location_filter can act on it.
 *
 * v4 exposed a single `arbeitsort` object whose `region` was a display name, so
 * it was joined onto the city. v6 nests the address one level deeper and its
 * `region` is an uppercase federal-state enum (`BADEN_WUERTTEMBERG`), which
 * would only add noise to a string the commute filter has to match — so the
 * city stands alone. A posting may list several locations; the downstream shape
 * is one string, so the first is used, as v4's single field effectively was.
 */
export function buildLocation(lokationen: unknown): string {
  if (!Array.isArray(lokationen)) return '';
  const adresse = asRecord(lokationen[0]).adresse;
  if (!adresse || typeof adresse !== 'object') return '';
  const addr = asRecord(adresse);
  const loc = String(addr.ort || '').trim();
  const land = addr.land;
  if (land && !/deutschland|germany/i.test(String(land))) return loc ? `${loc}, ${String(land)}` : String(land);
  return loc;
}

/**
 * Normalizes one raw Arbeitsagentur posting into a Job plus its `refnr` (kept
 * for dedup, stripped before the provider returns). Returns null when the
 * posting lacks a usable reference number or title.
 *
 * v6 renamed every field this reads — `refnr` → `referenznummer`, `titel` →
 * `stellenangebotsTitel`, `arbeitgeber` → `firma`, `arbeitsort` →
 * `stellenlokationen[]` (#2494). The public job-detail page still resolves by
 * reference number, so the outgoing URL is unchanged.
 */
export function normalizeJob(job: unknown): ArbeitsagenturJob | null {
  const row = asRecord(job);
  const refnr = row.referenznummer;
  const title = String(row.stellenangebotsTitel || '').trim();
  if (!refnr || !title) return null;
  // A lone surrogate in refnr would throw URIError out of encodeURIComponent and
  // abort the per-job loop in fetch(); refnr is also the dedup key (byRef), so a
  // degraded-but-kept value would collide malformed postings. Drop this one.
  const encodedRefnr = safeEncodeURIComponent(refnr);
  if (encodedRefnr === null) return null;
  return {
    title,
    url: DETAIL_BASE + encodedRefnr,
    company: String(row.firma || '').trim(),
    location: buildLocation(row.stellenlokationen),
    refnr: String(refnr),
  };
}

// What `remoteMatch: 'filter'` lost in the v6 move, and why it still exists.
//
// v4 proved a role was fully remote by reading `homeofficetyp: VOLLSTAENDIG`
// from the detail endpoint, because the `homeoffice=nv_true` query alone also
// returns `NACH_VEREINBARUNG` ("nach Absprache") — an office-anchored hybrid.
// That proof is gone: v6's detail endpoint answers 403 to this public client
// key, and the only home-office field on a v6 search hit is the boolean
// `homeofficemoeglich`, which is exactly what nv_true already filtered on (a
// sampled nv_true page was 100% `true`). A boolean that cannot separate
// fully-remote from hybrid is not evidence.
//
// So 'filter' keeps the half that still works — the server-side query narrows
// the candidate set far better than a nationwide sweep — and falls back to the
// posting's own title for the proof, the same standard 'title' mode uses. A
// candidate whose title makes no remote claim keeps its real city, which is the
// fail-closed behaviour an unverifiable lookup had in v4: the `Deutschlandweit
// (Homeoffice)` marker exempts a job from the commute location_filter, so
// tagging on nv_true alone would smuggle every hybrid past it.

const provider: Provider = {
  id: 'arbeitsagentur',

  /**
   * Fetches and normalizes postings from the Arbeitsagentur Jobsuche API.
   */
  async fetch(entry: PortalEntry, ctx: Context): Promise<Job[]> {
    const { keywords, wo, umkreis, days, size, remoteNationwide, remoteMatch, remoteMaxPages } = parseArbeitsagenturConfig(entry);
    if (!keywords.length) {
      throw new Error(`arbeitsagentur: entry "${entry.name || '(unnamed)'}" has no arbeitsagentur.keywords[]`);
    }

    const fetchKeyword = async (was: string, extra: Record<string, string> = {}): Promise<unknown[]> => {
      const params = new URLSearchParams({
        was,
        size: String(size),
        page: '1',
        angebotsart: '1', // 1 = ARBEIT (employment; excludes Ausbildung/Selbständigkeit)
        veroeffentlichtseit: String(days),
        ...extra,
      });
      // redirect:'error' prevents SSRF via server-side redirects.
      const json = await ctx.fetchJson(`${API_URL}?${params.toString()}`, {
        headers: { 'X-API-Key': API_KEY, accept: 'application/json' },
        redirect: 'error',
        timeoutMs: 12_000,
      });
      const results = asRecord(json).ergebnisliste;
      return Array.isArray(results) ? results : [];
    };

    const byRef = new Map<string, ArbeitsagenturJob>();
    const errors: string[] = [];
    let succeeded = 0; // keywords whose primary pass completed (i.e. the source answered)
    for (const kw of keywords) {
      let primary: unknown[];
      try {
        // Pass A: commutable radius around `wo`, or a single nationwide pass.
        primary = wo
          ? await fetchKeyword(kw, { wo, umkreis: String(umkreis) })
          : await fetchKeyword(kw);
        succeeded++;
      } catch (err) {
        // Recall-first: tolerate a single failed keyword and keep going.
        errors.push(`"${kw}": ${errorText(err)}`);
        continue;
      }
      // Pass B (optional): a nationwide pass for remote roles hosted at a far HQ
      // (which the radius pass misses). Detection is config-driven via `remoteMatch`:
      //   'filter' — server-side `homeoffice=nv_true` query + pagination, narrowing
      //              the candidate set; the title still has to claim remote (see
      //              the note on what v6 took away, above)
      //   'title'  — keep only nationwide hits whose title matches the remote regex
      // Its failure must NOT discard the primary results already fetched above.
      let wide: unknown[] = [];
      if (wo && remoteNationwide && remoteMatch !== 'off') {
        try {
          if (remoteMatch === 'filter') {
            // Server-side home-office filter: collect the candidates. `nv_true` only
            // means "home office is possible", so these are not yet known to be
            // remote — the title check below is what decides.
            for (let page = 1; page <= remoteMaxPages; page++) {
              const res = await fetchKeyword(kw, { homeoffice: 'nv_true', page: String(page) });
              wide.push(...res);
              if (res.length < size) break; // short page → done
            }
          } else { // 'title'
            const nationwide = await fetchKeyword(kw);
            wide = nationwide.filter(j => REMOTE_RE.test(String(asRecord(j).stellenangebotsTitel || '')));
          }
        } catch (err) {
          errors.push(`"${kw}" (remote pass): ${errorText(err)}`);
        }
      }
      // Pass A (commutable) keeps its city as-is.
      for (const raw of primary) {
        const job = normalizeJob(raw);
        if (job && !byRef.has(job.refnr)) byRef.set(job.refnr, job);
      }
      // Pass B roles get a `Deutschlandweit (Homeoffice)` marker, which makes
      // scan.ts's commute-based location_filter rescue them via always_allow
      // instead of dropping them on a far office city. A wrong marker therefore
      // smuggles an office-anchored hybrid past the distance check, so it may
      // only be applied on evidence:
      //   'title'  — the posting's own title claims remote; take it at face value.
      //   'filter' — `homeoffice=nv_true` narrowed the set but only means "home
      //              office possible", so the title is what proves it. Hits that
      //              make no such claim keep their real city.
      // Dedup by refnr first: paginating a live index can return the same posting
      // on two pages.
      const wideJobs: ArbeitsagenturJob[] = [...new Map(
        wide
          .map(normalizeJob)
          .filter((job): job is ArbeitsagenturJob => job !== null)
          .filter(job => !byRef.has(job.refnr))
          .map((job): [string, ArbeitsagenturJob] => [job.refnr, job]),
      ).values()];
      for (const job of wideJobs) {
        if (remoteMatch !== 'filter' || REMOTE_RE.test(job.title)) {
          job.location = job.location ? `${job.location} · Deutschlandweit (Homeoffice)` : 'Deutschlandweit (Homeoffice)';
        }
        if (!byRef.has(job.refnr)) byRef.set(job.refnr, job);
      }
    }

    // Total outage = every primary request failed. A keyword that answered with
    // zero results is not an outage, so key off the success count, not the
    // deduped result size — otherwise a legitimately-empty search throws.
    if (succeeded === 0 && errors.length) {
      throw new Error(`arbeitsagentur: all ${keywords.length} keyword request(s) failed — ${errors[0]}`);
    }

    return [...byRef.values()].map(({ refnr, ...job }) => job);
  },
};

export default provider;
