// Client-side Explore state: the discovery surface's whole pipeline — filters,
// the free ATS scan stream, the AI-search stream, and the result set.
//
// This replaces the Next app's ExploreProvider. The shape is deliberately the
// same as the React context value (one store carrying filters + phases + results),
// so a completed search survives a mode toggle exactly as it did before, and
// nothing leaks across requests on the server (see provideExplore below).
import { getContext, setContext } from "svelte";
import { browser } from "$app/env";
import { invalidateAll } from "$app/navigation";
import {
  ATS_LABEL,
  DEFAULT_FILTERS,
  aiToParams,
  filtersToParams,
  isBroadSearch,
  parseExplorePatch,
  type AtsSource,
  type DiscoveredOffer,
  type ExploreFilters,
  type ExploreMode,
  type ScanEvent,
} from "@/lib/explore";
import { makeAiStreamParser, type AiTraceChunk } from "@/lib/explore-ai";
import { MAX_OFFER_LIMIT } from "@/lib/whats-new.ts";
import { isScannerMissing } from "@/lib/explore-error.ts";
import { SvelteSet } from "svelte/reactivity";

export type Phase =
  | "idle"
  | "casting"
  | "scanning"
  | "revealing"
  | "results"
  | "empty-current"
  | "empty-loose"
  | "failed"
  | "degraded" // scan completed but searched nothing (transient fetch/rate-limit) — not "all caught up"
  | "hunting" // AI search streaming
  | "blocked"; // AI search needs a CLI
export type AiCost = { searches: number; candidates: number; fetches: number };
export type SourceState = {
  state: "queued" | "active" | "swept" | "noisy";
  companies?: number;
  done?: number;
  total?: number;
  matches?: number;
  unreachable?: number;
};

const CONTEXT_KEY = "career-ops:explore-store";

// Explore results are expensive (a scan walks the ATS network; an AI search spends
// tokens). Persist the SETTLED result set per-tab so a reload or a mode toggle never
// throws the work away (disc#5 — "came back to explore, work is lost").
const RESULTS_KEY = "career-ops:explore-results";
type ResultSnapshot = {
  v: number;
  mode: ExploreMode;
  phase: Phase;
  offers: DiscoveredOffer[];
  matchCount: number;
  companiesScanned: number;
  companiesAvailable: number;
  capHit: boolean;
  droppedNoDate: number;
  sources: Partial<Record<AtsSource, SourceState>>;
  partial: boolean;
  status: string;
  error: string;
  scannerMissing: boolean;
  added: string[];
  aiTrace: AiTraceChunk[];
  aiCost: AiCost;
  aiIntent: string;
};

/** Phases backed by a live stream — never rehydrated INTO, since no stream backs them. */
const RUNNING_PHASES = new Set<Phase>(["casting", "scanning", "revealing", "hunting"]);
/** Phases worth persisting — anything mid-stream would restore as a half-result. */
const SETTLED_PHASES = new Set<Phase>(["results", "empty-current", "empty-loose", "failed", "degraded", "blocked"]);

const EMPTY_COST: AiCost = { searches: 0, candidates: 0, fetches: 0 };

/** The `error` string of a parsed JSON body, or "" when the body carries none.
 *  Reads a declared shape instead of trusting whatever the route sent. */
function errorMessage(body: unknown): string {
  if (typeof body !== "object" || body === null || !("error" in body)) return "";
  const { error } = body as { error?: unknown };
  return typeof error === "string" ? error : "";
}

export class ExploreStore {
  filters = $state<ExploreFilters>({ ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats] });
  phase = $state<Phase>("idle");
  offers = $state<DiscoveredOffer[]>([]);
  sources = $state<Partial<Record<AtsSource, SourceState>>>({});
  matchCount = $state(0);
  companiesScanned = $state(0);
  // Authoritative scan-health signals (scanner --json mode, #1199): tell a capped /
  // degraded scan from a genuinely empty one, and power a "scanned X of Y" banner.
  companiesAvailable = $state(0);
  capHit = $state(false);
  droppedNoDate = $state(0);
  status = $state("");
  partial = $state(false);
  error = $state("");
  /** The failure was the structured "scanner absent from this checkout" 400,
   *  not a runtime scan error, so it drives the "full toolkit" panel over a retry. */
  scannerMissing = $state(false);
  added = new SvelteSet<string>();
  adding = new SvelteSet<string>();
  mode = $state<ExploreMode>("scan");
  aiIntent = $state("");
  aiTrace = $state<AiTraceChunk[]>([]);
  aiCost = $state<AiCost>({ ...EMPTY_COST });

  /** Any of the four streamed phases is "running" for the UI. */
  running = $derived(RUNNING_PHASES.has(this.phase));

  // Reentrancy latch: a second discover() while one is streaming is a no-op, and
  // setMode() drops it (switching surface stops a half-run without losing results).
  #running = false;
  // Whether the user (or the assistant) has set filters — a fresh mount seeded
  // from the URL must not clobber them.
  #touched = false;

  setFilters(f: ExploreFilters): void {
    this.#touched = true;
    this.filters = f;
  }

  /** Set filters from a seed/URL only if the user/assistant hasn't touched them
   *  yet — so a fresh page mount can't clobber assistant-set filters. */
  initFilters(f: ExploreFilters): void {
    if (this.#touched) return;
    this.filters = f;
  }

  // Switch surface but PRESERVE the current results + filters — toggling scan↔AI must
  // not throw away a completed search (disc#5). A new search (discover/discoverAI)
  // clears + repopulates; an explicit reset() clears. Just stop any half-run.
  setMode(m: ExploreMode): void {
    this.#running = false;
    this.mode = m;
  }

  setAiIntent(s: string): void {
    this.aiIntent = s;
  }

  /** Write a single source's state without spreading a computed key into a
   *  Partial<Record<…>> — keeps the index write honest under strict TS. */
  #setSource(ats: AtsSource, next: SourceState): void {
    const sources: Partial<Record<AtsSource, SourceState>> = { ...this.sources };
    sources[ats] = next;
    this.sources = sources;
  }

  async discover(): Promise<void> {
    if (this.#running) return;
    const f = this.filters;
    this.#running = true;
    this.phase = "casting";
    this.offers = [];
    this.matchCount = 0;
    this.companiesScanned = 0;
    this.companiesAvailable = 0;
    this.capHit = false;
    this.droppedNoDate = 0;
    this.partial = false;
    this.error = "";
    this.scannerMissing = false;
    this.status = "Casting the net across the ATS network…";
    const init: Partial<Record<AtsSource, SourceState>> = {};
    for (const a of f.ats) init[a] = { state: "queued" };
    this.sources = init;
    if (browser) {
      const qs = filtersToParams(f);
      window.history.replaceState(null, "", `/explore${qs ? `?${qs}` : ""}`);
    }

    const acc: DiscoveredOffer[] = [];
    let sawError = "";
    let sawScannerMissing = false; // the structured 400 (data-only checkout), not a runtime scan error
    let companiesScannedAcc = 0; // 0 at the end = the directories never downloaded → degraded, not empty
    let capHitAcc = false; // scan was capped (only a slice of the universe searched)
    let datasetIssueAcc = false; // some ATS dataset was stale/empty/unreachable
    let droppedNoDateAcc = 0; // postings dropped for lacking a publish date
    try {
      const r = await fetch("/api/explore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
      });
      // Every non-OK response is decided from the parsed body, not the status.
      // A failed response never carries a scan stream, so reading one would
      // parse a JSON error object as scan events and report "no readable
      // output" instead of the server's actual message.
      if (!r.ok) {
        const d: unknown = await r.json().catch(() => ({}));
        sawScannerMissing = isScannerMissing(d);
        sawError = errorMessage(d) || (sawScannerMissing ? "The scanner isn't available." : `Discovery failed (${r.status}).`);
      } else if (!r.body) {
        sawError = "No response stream.";
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let ev: ScanEvent;
            try {
              ev = JSON.parse(line) as ScanEvent;
            } catch {
              continue;
            }
            switch (ev.kind) {
              case "atsStart":
                this.phase = "scanning";
                this.status = `Walking ${ATS_LABEL[ev.ats as AtsSource] ?? ev.ats} — ${ev.companies.toLocaleString()} companies`;
                this.#setSource(ev.ats as AtsSource, { ...this.sources[ev.ats as AtsSource], state: "active", companies: ev.companies });
                break;
              case "progress":
                // `matches` is the engine's running total. Live `offer` events
                // (stderr JSON in --json mode) populate the card list; this
                // number still drives the hero counter.
                this.matchCount = Math.max(this.matchCount, ev.matches);
                this.#setSource(ev.ats as AtsSource, {
                  ...this.sources[ev.ats as AtsSource],
                  state: "active",
                  done: ev.scanned,
                  total: ev.total,
                });
                break;
              case "atsDone":
                this.#setSource(ev.ats as AtsSource, {
                  ...this.sources[ev.ats as AtsSource],
                  state: ev.unreachable > 0 ? "noisy" : "swept",
                  unreachable: ev.unreachable,
                });
                break;
              case "offer":
                acc.push(ev.offer);
                this.offers = [...this.offers, ev.offer];
                this.matchCount = Math.max(this.matchCount, acc.length);
                break;
              case "summary": {
                companiesScannedAcc = ev.companiesScanned;
                this.companiesScanned = ev.companiesScanned;
                if (typeof ev.companiesAvailable === "number") this.companiesAvailable = ev.companiesAvailable;
                if (ev.capHit) {
                  capHitAcc = true;
                  this.capHit = true;
                }
                const datasetIssue =
                  (ev.datasetStatus ? Object.values(ev.datasetStatus).some((s) => s !== "ok") : false) ||
                  (ev.incomplete?.length ?? 0) > 0;
                if (datasetIssue) datasetIssueAcc = true;
                if (typeof ev.postingsDroppedNoDate === "number" && ev.postingsDroppedNoDate > 0) {
                  droppedNoDateAcc = ev.postingsDroppedNoDate;
                  this.droppedNoDate = ev.postingsDroppedNoDate;
                }
                if (ev.unreachable > 0 || datasetIssue) this.partial = true;
                break;
              }
              case "error":
                sawError = ev.message;
                break;
              default:
                break;
            }
          }
        }
      }
    } catch (e) {
      sawError = e instanceof Error ? e.message : "stream error";
    }

    // Mark any still-active sources as swept (stream ended).
    const after: Partial<Record<AtsSource, SourceState>> = { ...this.sources };
    for (const k of Object.keys(after) as AtsSource[]) {
      const s = after[k];
      if (s?.state === "active" || s?.state === "queued") after[k] = { ...s, state: "swept" };
    }
    this.sources = after;

    this.#running = false;
    if (acc.length > 0) {
      // A scan that ended in an error still keeps what it found (a legacy scan
      // stopped at the deadline, or every --json source stopped): mark it partial
      // and keep the reason, which ResultsList shows beside the results.
      if (sawError) {
        this.partial = true;
        this.error = sawError;
      }
      this.matchCount = acc.length;
      this.phase = "revealing";
      this.status = `${acc.length} fresh role${acc.length === 1 ? "" : "s"} found — free.`;
      window.setTimeout(() => (this.phase = "results"), 850);
    } else if (sawError) {
      this.error = sawError;
      this.scannerMissing = sawScannerMissing;
      this.phase = "failed";
    } else if (capHitAcc || datasetIssueAcc || droppedNoDateAcc > 0 || companiesScannedAcc === 0) {
      // Maintainer's RULE (#1199): it is NOT "all caught up" if the scan was capped,
      // a dataset was stale/unreachable, postings were dropped for missing a date, OR
      // nothing was searched at all (legacy 0-companies fallback when --json is absent).
      // Truly-empty is only when live datasets were fully searched and found nothing.
      this.phase = "degraded";
    } else {
      this.phase = isBroadSearch(f) ? "empty-current" : "empty-loose";
    }
  }

  // Today's "See all N" link (#84) routes here with ?view=fresh instead of leaving
  // the user on a bare config form. Re-fetch the same free, zero-token /api/whats-new
  // history the dashboard already reads and drop it straight into the results phase
  // — no scan, so it never touches sources/companiesScanned like discover() does.
  async loadFresh(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    this.phase = "casting";
    this.status = "Loading fresh matches…";
    this.offers = [];
    this.matchCount = 0;
    this.companiesScanned = 0;
    this.companiesAvailable = 0;
    this.capHit = false;
    this.droppedNoDate = 0;
    this.partial = false;
    this.sources = {};
    this.error = "";
    try {
      // A finite ceiling, not `all`: explorer-view renders every offer it gets,
      // so an unbounded list would be an unbounded DOM. `count` below stays the
      // complete total, which is what the header actually reports.
      const r = await fetch(`/api/whats-new?limit=${MAX_OFFER_LIMIT}`);
      if (!r.ok) {
        this.error = `Couldn't load fresh matches (${r.status}).`;
        this.phase = "failed";
        return;
      }
      const d = (await r.json().catch(() => null)) as { offers?: DiscoveredOffer[]; count?: number } | null;
      if (!d || !Array.isArray(d.offers)) {
        this.error = "Couldn't load fresh matches — unexpected response.";
        this.phase = "failed";
        return;
      }
      const list: DiscoveredOffer[] = d.offers;
      this.offers = list;
      const count = Number(d.count);
      this.matchCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : list.length;
      this.phase = list.length > 0 ? "results" : "empty-current";
    } catch (e) {
      this.error = e instanceof Error ? e.message : "Couldn't load fresh matches.";
      this.phase = "failed";
    } finally {
      this.#running = false;
    }
  }

  async addToPipeline(list: DiscoveredOffer[]): Promise<number> {
    const fresh = list.filter((o) => !this.added.has(o.url));
    if (fresh.length === 0) return 0;
    for (const o of fresh) this.adding.add(o.url);
    try {
      const r = await fetch("/api/explore/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offers: fresh }),
      });
      const d = (await r.json()) as { added?: number };
      if (d.added && d.added > 0) {
        for (const o of fresh) this.added.add(o.url);
        // The new inbox rows were written server-side. Invalidate the router's
        // loaded data so the (server-rendered) Pipeline view shows them instead of a
        // stale snapshot, and ping live listeners (today's dashboard, pipeline
        // provider) — otherwise the user adds a job, opens Pipeline, and sees it
        // empty (disc#5).
        await invalidateAll();
        if (browser) {
          window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: "explore-add" } }));
        }
      }
      return d.added ?? 0;
    } catch {
      return 0;
    } finally {
      for (const o of fresh) this.adding.delete(o.url);
    }
  }

  applyPatch(raw: Record<string, unknown>, opts?: { merge?: boolean; run?: boolean }): void {
    const next = parseExplorePatch(raw, this.filters, opts?.merge ?? false);
    this.setFilters(next);
    if (opts?.run) void this.discover();
  }

  reset(): void {
    this.#running = false;
    this.phase = "idle";
    this.offers = [];
    this.sources = {};
    this.matchCount = 0;
    this.companiesScanned = 0;
    this.status = "";
    this.partial = false;
    this.error = "";
    this.scannerMissing = false;
    this.aiTrace = [];
    this.aiCost = { ...EMPTY_COST };
    try {
      sessionStorage.removeItem(RESULTS_KEY);
    } catch {
      /* ignore */
    }
  }

  // AI search — orchestrate modes/discover.md via the user's CLI, streamed.
  async discoverAI(): Promise<void> {
    if (this.#running) return;
    const intent = this.aiIntent.trim();
    if (!intent) return;
    let cliId: string | null = null;
    try {
      const cfg = JSON.parse(localStorage.getItem("career-ops:config") || "{}") as { cliId?: string };
      cliId = cfg.cliId || null;
    } catch {
      cliId = null;
    }
    if (!cliId) {
      this.phase = "blocked";
      return;
    }
    this.#running = true;
    this.phase = "casting";
    this.offers = [];
    this.matchCount = 0;
    this.aiTrace = [];
    this.aiCost = { ...EMPTY_COST };
    this.error = "";
    this.scannerMissing = false;
    this.status = "Casting across the open web…";
    if (browser) window.history.replaceState(null, "", `/explore?${aiToParams(intent)}`);

    let knownUrls = new Set<string>();
    try {
      const k = (await fetch("/api/explore/ai/known").then((r) => r.json())) as { urls?: unknown };
      knownUrls = new Set<string>(Array.isArray(k.urls) ? (k.urls as string[]) : []);
    } catch {
      /* best-effort dedup */
    }
    const parser = makeAiStreamParser({ knownUrls });

    const acc: DiscoveredOffer[] = [];
    let sawError = "";
    let sawScannerMissing = false; // the structured 400 (capability absent from this checkout), not a runtime error
    const handle = (chunks: AiTraceChunk[]) => {
      for (const ch of chunks) {
        if (ch.kind === "offer") {
          acc.push(ch.offer);
          this.offers = [...this.offers, ch.offer];
          this.matchCount = acc.length;
          this.aiCost = { ...this.aiCost, candidates: acc.length };
          this.phase = "hunting";
        } else {
          this.aiTrace = [...this.aiTrace, ch];
          if (ch.kind === "narration") {
            const s = (ch.text.match(/\bsearch(ing|ed)?\b/gi) || []).length;
            const f = (ch.text.match(/\bfetch(ing|ed)?\b/gi) || []).length;
            if (s || f) this.aiCost = { searches: this.aiCost.searches + s, candidates: this.aiCost.candidates, fetches: this.aiCost.fetches + f };
            if (this.phase === "casting") this.phase = "hunting";
          }
        }
      }
    };

    try {
      const r = await fetch("/api/explore/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: intent, cliId }),
      });
      if (r.status === 404) {
        this.#running = false;
        this.phase = "blocked";
        return;
      }
      // Same rule as the scan path, and this is the call site the status-based
      // check actually broke: /api/explore/ai returns three different 400s
      // (malformed JSON, missing parameters, MODE_MISSING), and all three were
      // reported as "this checkout has no scanner". MODE_MISSING carries its own
      // copy about AI search, which the scanner panel overwrote.
      if (!r.ok) {
        const d: unknown = await r.json().catch(() => ({}));
        sawScannerMissing = isScannerMissing(d);
        sawError = errorMessage(d) || (sawScannerMissing ? "AI search isn't available." : `AI search failed (${r.status}).`);
      } else if (!r.body) {
        sawError = "No response stream.";
      } else {
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          handle(parser.feed(dec.decode(value, { stream: true })));
        }
        handle(parser.flush());
      }
    } catch (e) {
      sawError = e instanceof Error ? e.message : "stream error";
    }

    this.#running = false;
    if (acc.length > 0) {
      this.matchCount = acc.length;
      this.phase = "revealing";
      this.status = `${acc.length} candidate${acc.length === 1 ? "" : "s"} found.`;
      window.setTimeout(() => (this.phase = "results"), 850);
    } else if (sawError) {
      this.error = sawError;
      this.scannerMissing = sawScannerMissing;
      this.phase = "failed";
    } else {
      this.phase = "empty-loose";
    }
  }

  /** Rehydrate the last settled result set (per-tab sessionStorage), unless a
   *  search is already running. Call once on mount — never during SSR, where
   *  sessionStorage does not exist and the markup must match the server's. */
  hydrate(): void {
    if (this.#running) return;
    let snap: ResultSnapshot | null = null;
    try {
      snap = JSON.parse(sessionStorage.getItem(RESULTS_KEY) || "null") as ResultSnapshot | null;
    } catch {
      snap = null;
    }
    if (!snap || snap.v !== 1 || !Array.isArray(snap.offers)) return;
    this.mode = snap.mode === "ai" ? "ai" : "scan";
    this.offers = snap.offers;
    this.matchCount = typeof snap.matchCount === "number" ? snap.matchCount : snap.offers.length;
    this.companiesScanned = snap.companiesScanned ?? 0;
    this.companiesAvailable = snap.companiesAvailable ?? 0;
    this.capHit = !!snap.capHit;
    this.droppedNoDate = snap.droppedNoDate ?? 0;
    this.sources = snap.sources ?? {};
    this.partial = !!snap.partial;
    this.status = typeof snap.status === "string" ? snap.status : "";
    this.error = typeof snap.error === "string" ? snap.error : "";
    this.scannerMissing = !!snap.scannerMissing;
    this.added.clear();
    for (const u of Array.isArray(snap.added) ? snap.added : []) this.added.add(u);
    this.aiTrace = Array.isArray(snap.aiTrace) ? snap.aiTrace : [];
    this.aiCost = snap.aiCost ?? { ...EMPTY_COST };
    if (typeof snap.aiIntent === "string") this.aiIntent = snap.aiIntent;
    // Never rehydrate INTO a running phase — no live stream backs it.
    this.phase = RUNNING_PHASES.has(snap.phase) ? (snap.offers.length ? "results" : "idle") : snap.phase;
  }

  /** Persist only SETTLED states (never mid-stream) so a reload restores a complete
   *  set. Safe to call before hydrate(); a non-settled phase writes nothing. */
  persist(): void {
    if (!SETTLED_PHASES.has(this.phase)) return;
    try {
      const snap: ResultSnapshot = {
        v: 1,
        mode: this.mode,
        phase: this.phase,
        offers: this.offers,
        matchCount: this.matchCount,
        companiesScanned: this.companiesScanned,
        companiesAvailable: this.companiesAvailable,
        capHit: this.capHit,
        droppedNoDate: this.droppedNoDate,
        sources: this.sources,
        partial: this.partial,
        status: this.status,
        error: this.error,
        scannerMissing: this.scannerMissing,
        added: [...this.added],
        aiTrace: this.aiTrace,
        aiCost: this.aiCost,
        aiIntent: this.aiIntent,
      };
      sessionStorage.setItem(RESULTS_KEY, JSON.stringify(snap));
    } catch {
      /* sessionStorage full/unavailable — non-fatal */
    }
  }
}

// In the browser the Explorer keeps ONE store for the life of the tab. The Next
// app mounted ExploreProvider above the routes (app-shell), so the assistant
// console could apply a filter patch from any page and the Explorer picked it up
// on arrival; two instances would break that hand-off. Every mutation originates
// in the browser, so the shared instance is never written during SSR.
// On the server each render gets its own store: there is no browser, no writer,
// and no reader outside the current render, so nothing leaks across requests.
let clientStore: ExploreStore | null = null;

function sharedStore(): ExploreStore {
  clientStore ??= new ExploreStore();
  return clientStore;
}

/** Create the Explore store and make it available to every descendant. */
export function provideExplore(): ExploreStore {
  // Reuse what a parent already provided (a page can call this too) so the
  // Explorer isn't split across two stores. On the server, a fresh instance per
  // render: nothing can leak across requests.
  const inherited = getContext<ExploreStore | undefined>(CONTEXT_KEY);
  if (inherited) return inherited;
  const store = browser ? sharedStore() : new ExploreStore();
  setContext(CONTEXT_KEY, store);
  return store;
}

export function useExplore(): ExploreStore {
  const store = getContext<ExploreStore | undefined>(CONTEXT_KEY);
  if (store) return store;
  // A component rendered outside the explore route (the assistant console, which
  // patches filters for a "search for X" turn) still needs a store. In the browser
  // that is the same shared instance the route provides, so its patch is exactly
  // what /explore renders on arrival.
  return browser ? sharedStore() : new ExploreStore();
}
