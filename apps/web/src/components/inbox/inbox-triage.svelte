<script lang="ts">
  import { onMount } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { Undo2 } from "@lucide/svelte";
  import { useJobs } from "@/lib/jobs.svelte";
  import type { Job } from "@/lib/jobs.svelte";
  import type { InboxJob } from "@/lib/career-ops";
  import type { AtsSource } from "@/lib/explore";
  import { ATS_SOURCES } from "@/lib/explore";
  import { daysSince, seniorityFromTitle, sourceFromUrl, SENIORITY_ORDER, type Seniority } from "@/lib/inbox";
  import FacetChips from "./facet-chips.svelte";
  import TriageRow, { type RowScore } from "./triage-row.svelte";
  import ShortlistTray, { type ShortItem } from "./shortlist-tray.svelte";
  import { cn } from "@/lib/cn";
  import { estimateRunCost } from "@/lib/run-cost-estimate.ts";

  const SHORTLIST_KEY = "career-ops:shortlist";
  const HIDDEN_KEY = "career-ops:hidden";
  const CONFIG_KEY = "career-ops:config";
  const BATCH = 20;

  /** One inbox posting plus the free signals derived from it. */
  type Enriched = { job: InboxJob; source: AtsSource | null; seniority: Seniority | null; age: number | null };

  /** A stored shortlist entry, narrowed from whatever localStorage held. */
  function isShortItem(value: unknown): value is ShortItem {
    if (typeof value !== "object" || value === null) return false;
    const it = value as Record<string, unknown>;
    return typeof it.url === "string" && typeof it.company === "string" && typeof it.role === "string";
  }

  // The inbox as a TRIAGE surface: Abundance → Triage → Shortlist → Opt-in Score.
  // Default is a small fresh batch (never the full wall); free facets + Save/Skip narrow
  // it; only "Score shortlist" spends tokens. 🔴 The shell is agnostic to what makes a
  // role relevant — order is freshness with a single documented plug point.
  let { inbox }: { inbox: InboxJob[] } = $props();

  const store = useJobs();
  const jobs = $derived(store.jobs);
  // Serialize skip/undo per URL so a fast Undo cannot lose the race to Skip.
  const skipChain = new Map<string, Promise<void>>();

  // facets
  let within = $state<number | null>(null);
  let sources = $state<Set<AtsSource>>(new Set());
  let seniorities = $state<Set<Seniority>>(new Set());
  let locQ = $state("");
  let kw = $state("");
  let showAll = $state(false);

  // persisted triage state + ephemeral selection/undo
  let shortlist = $state<ShortItem[]>([]);
  let hidden = $state<string[]>([]);
  let selected = $state<Set<string>>(new Set());
  let undo = $state<{ label: string; fn: () => void } | null>(null);
  let hasCli = $state(false);
  let loaded = $state(false);

  onMount(() => {
    try {
      const s = localStorage.getItem(SHORTLIST_KEY);
      const parsed: unknown = s ? JSON.parse(s) : null;
      if (Array.isArray(parsed)) shortlist = parsed.filter(isShortItem);
      const h = localStorage.getItem(HIDDEN_KEY);
      if (h) {
        const parsedHidden: unknown = JSON.parse(h);
        const urls = Array.isArray(parsedHidden) ? parsedHidden.filter((u): u is string => typeof u === "string") : [];
        const pending = new Set(inbox.map((j) => j.url));
        hidden = urls.filter((u) => pending.has(u));
      }
      const c = localStorage.getItem(CONFIG_KEY);
      hasCli = !!(c && (JSON.parse(c) as { cliId?: string }).cliId);
    } catch {
      /* ignore */
    }
    loaded = true;
    // First SSR inbox only — later refreshes prune via the inbox effect below.
  });

  $effect(() => {
    if (!loaded) return;
    const value = JSON.stringify(shortlist);
    try {
      localStorage.setItem(SHORTLIST_KEY, value);
    } catch {
      /* quota */
    }
  });

  $effect(() => {
    if (!loaded) return;
    const value = JSON.stringify(hidden);
    try {
      localStorage.setItem(HIDDEN_KEY, value);
    } catch {
      /* quota */
    }
  });

  // After SSR refresh, pipeline.md [x] rows are already gone from `inbox`.
  // Drop them from the localStorage cache so "N hidden" does not linger.
  $effect(() => {
    const pending = new Set(inbox.map((j) => j.url));
    const next = hidden.filter((u) => pending.has(u));
    if (next.length !== hidden.length) hidden = next;
  });

  // auto-dismiss the undo toast
  $effect(() => {
    if (!undo) return;
    const t = setTimeout(() => (undo = null), 5000);
    return () => clearTimeout(t);
  });

  // stable "now" for freshness (per mount)
  const now = Date.now();

  // Dedupe by URL — pipeline.md can list the same posting twice; it's one job, so it
  // triages once (and Save/Skip/score, all keyed by URL, act on it coherently).
  const enriched = $derived.by(() => {
    const seen = new Set<string>();
    const out: Enriched[] = [];
    for (const job of inbox) {
      if (seen.has(job.url)) continue;
      seen.add(job.url);
      out.push({ job, source: sourceFromUrl(job.url), seniority: seniorityFromTitle(job.role), age: daysSince(job.postedAt, now) });
    }
    return out;
  });

  // EVALUADA lookup: the latest evaluate worker per posting URL (running → badge).
  const scoreByUrl = $derived.by(() => {
    const best = new Map<string, Job>();
    for (const j of jobs) {
      if (!j.input || j.kind !== "evaluate") continue;
      const ex = best.get(j.input);
      if (!ex || j.startedAt > ex.startedAt) best.set(j.input, j);
    }
    const m = new Map<string, RowScore>();
    for (const [url, j] of best) {
      m.set(url, { score: j.result?.score ?? null, tone: j.result?.tone ?? "muted", jobId: j.id, running: j.status === "running" });
    }
    return m;
  });

  // facet options — only surface what's actually present in the (non-hidden) data
  const availSources = $derived.by(() => {
    const set = new Set<AtsSource>();
    for (const e of enriched) if (e.source && !hidden.includes(e.job.url)) set.add(e.source);
    return ATS_SOURCES.filter((s) => set.has(s));
  });
  const availSeniorities = $derived.by(() => {
    const set = new Set<Seniority>();
    for (const e of enriched) if (e.seniority && !hidden.includes(e.job.url)) set.add(e.seniority);
    return SENIORITY_ORDER.filter((s) => set.has(s));
  });

  const filtered = $derived.by(() =>
    enriched.filter((e) => {
      if (hidden.includes(e.job.url)) return false;
      if (within != null && (e.age == null || e.age > within)) return false;
      if (sources.size && (!e.source || !sources.has(e.source))) return false;
      if (seniorities.size && (!e.seniority || !seniorities.has(e.seniority))) return false;
      if (locQ.trim() && !(e.job.location || "").toLowerCase().includes(locQ.trim().toLowerCase())) return false;
      if (kw.trim() && !`${e.job.company} ${e.job.role}`.toLowerCase().includes(kw.trim().toLowerCase())) return false;
      return true;
    }),
  );

  // 🔴 SINGLE ORDER PLUG POINT — freshness only (newest first_seen first; unknown last).
  // A smarter ranker replaces ONLY this comparator; facets/triage/shortlist/score never
  // touch relevance. This is the whole firewall in one line.
  const ordered = $derived([...filtered].sort((a, b) => (a.age ?? Infinity) - (b.age ?? Infinity)));

  const anyFacet = $derived(within != null || sources.size > 0 || seniorities.size > 0 || locQ.trim() !== "" || kw.trim() !== "");
  const capped = $derived(!showAll && !anyFacet);
  const visible = $derived(capped ? ordered.slice(0, BATCH) : ordered);
  const hiddenCount = $derived(hidden.length);

  const isShortlisted = (url: string) => shortlist.some((s) => s.url === url);

  function persistSkip(url: string, done: boolean): Promise<void> {
    const prev = skipChain.get(url) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const res = await fetch("/api/inbox/skip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, done }),
        });
        if (!res.ok) throw new Error("skip write failed");
        await invalidateAll();
      })
      .catch(() => {
        if (done) hidden = hidden.filter((u) => u !== url);
      });
    skipChain.set(url, next);
    return next;
  }

  function save(job: InboxJob) {
    if (isShortlisted(job.url)) return;
    shortlist = [...shortlist, { url: job.url, company: job.company, role: job.role }];
  }

  function skip(job: InboxJob) {
    hidden = hidden.includes(job.url) ? hidden : [...hidden, job.url];
    undo = {
      label: `Skipped ${job.company}`,
      fn: () => {
        hidden = hidden.filter((u) => u !== job.url);
        void persistSkip(job.url, false);
      },
    };
    void persistSkip(job.url, true);
  }

  function restoreHidden() {
    const urls = hidden;
    hidden = [];
    for (const url of urls) void persistSkip(url, false);
  }

  function toggleSelect(url: string) {
    const n = new Set(selected);
    if (n.has(url)) n.delete(url);
    else n.add(url);
    selected = n;
  }

  function saveSelected() {
    const add = enriched
      .filter((e) => selected.has(e.job.url) && !isShortlisted(e.job.url))
      .map((e) => ({ url: e.job.url, company: e.job.company, role: e.job.role }));
    if (add.length) shortlist = [...shortlist, ...add];
    selected = new Set();
  }

  function toggleSource(s: AtsSource) {
    const n = new Set(sources);
    if (n.has(s)) n.delete(s);
    else n.add(s);
    sources = n;
  }

  function toggleSeniority(s: Seniority) {
    const n = new Set(seniorities);
    if (n.has(s)) n.delete(s);
    else n.add(s);
    seniorities = n;
  }

  const estimate = $derived(shortlist.length === 0 ? {} : estimateRunCost(jobs, "evaluate", shortlist.length));

  function scoreShortlist() {
    const batchId = `shortlist-${Date.now()}`;
    for (const it of shortlist) {
      store.startJob({ title: `Score · ${it.company}`, subtitle: it.role, kind: "evaluate", input: it.url, page: "/pipeline", batchId });
    }
    shortlist = []; // sent — the rows flip to Scoring… → badge via scoreByUrl
  }
</script>

<!-- The parent (PipelineView) renders the rich empty-inbox card; here we always
     have ≥1 raw posting. -->
{#if inbox.length > 0}
  <div class={cn("mx-auto mt-4 max-w-3xl", shortlist.length > 0 && "pb-28 sm:pb-24")}>
    <FacetChips
      {within}
      setWithin={(d) => (within = d)}
      {sources}
      toggleSource={toggleSource}
      {seniorities}
      toggleSeniority={toggleSeniority}
      {locQ}
      setLocQ={(v) => (locQ = v)}
      {kw}
      setKw={(v) => (kw = v)}
      {availSources}
      {availSeniorities}
      resultCount={filtered.length}
      totalCount={enriched.length - hiddenCount}
      anyActive={anyFacet}
      onClear={() => {
        within = null;
        sources = new Set();
        seniorities = new Set();
        locQ = "";
        kw = "";
      }}
    />

    <!-- batch header: fresh slice by default, or the full filtered set -->
    <div class="mt-4 flex items-baseline justify-between gap-3">
      <p class="text-sm font-medium text-foreground">
        {capped ? "Fresh — worth a look" : anyFacet ? `${filtered.length} match${filtered.length === 1 ? "" : "es"}` : "All roles"}
      </p>
      {#if hiddenCount > 0}
        <button type="button" onclick={restoreHidden} class="text-xs text-faint transition-colors hover:text-foreground">
          {hiddenCount} hidden · restore
        </button>
      {/if}
    </div>

    <!-- multi-select action bar -->
    {#if selected.size > 0}
      <div class="mt-2 flex items-center gap-3 rounded-lg border border-brand/30 bg-brand-soft px-3 py-2 text-sm">
        <span class="font-medium text-brand tabular-nums">{selected.size} selected</span>
        <button
          type="button"
          onclick={saveSelected}
          class="rounded-md bg-brand px-2.5 py-1 text-xs font-medium text-brand-foreground max-sm:min-h-[44px]"
        >
          Save to shortlist
        </button>
        <button
          type="button"
          onclick={() => (selected = new Set())}
          class="text-xs text-muted hover:text-foreground max-sm:min-h-[44px]"
        >
          Clear
        </button>
      </div>
    {/if}

    {#if visible.length > 0}
      <ul class="mt-3 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
        {#each visible as e (e.job.url)}
          <TriageRow
            job={e.job}
            source={e.source}
            age={e.age}
            scored={scoreByUrl.get(e.job.url)}
            selected={selected.has(e.job.url)}
            shortlisted={isShortlisted(e.job.url)}
            onToggleSelect={() => toggleSelect(e.job.url)}
            onSave={() => save(e.job)}
            onSkip={() => skip(e.job)}
          />
        {/each}
      </ul>
    {:else}
      <div class="mt-3 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-10 text-center">
        <p class="font-display text-lg">No matches</p>
        <p class="mx-auto mt-1 max-w-sm text-sm text-muted">Loosen the filters to see more of your inbox.</p>
      </div>
    {/if}

    <!-- "See all N" — only when the fresh batch is capping a larger list -->
    {#if capped && ordered.length > BATCH}
      <button
        type="button"
        onclick={() => (showAll = true)}
        class="mt-3 inline-flex w-full items-center justify-center gap-1 rounded-xl border border-border bg-surface/40 py-2.5 text-sm font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
      >
        See all {ordered.length} in inbox →
      </button>
    {/if}

    <!-- empty-shortlist guidance (only once there's nothing saved) -->
    {#if shortlist.length === 0}
      <p class="mt-4 text-center text-xs text-faint">Save roles worth a look, then score them together — one token spend.</p>
    {/if}

    <!-- undo toast (sits above the tray) -->
    {#if undo}
      <div class={cn("fixed inset-x-0 z-40 flex justify-center px-4", shortlist.length > 0 ? "bottom-24 sm:bottom-24" : "bottom-6")}>
        <div class="inline-flex items-center gap-3 rounded-full border border-border bg-surface px-4 py-2 text-sm shadow-lg">
          <span class="text-muted">{undo.label}</span>
          <button
            type="button"
            onclick={() => {
              undo?.fn();
              undo = null;
            }}
            class="inline-flex items-center gap-1 font-medium text-brand max-sm:min-h-[44px]"
          >
            <Undo2 class="size-3.5" /> Undo
          </button>
        </div>
      </div>
    {/if}

    <ShortlistTray
      items={shortlist}
      {estimate}
      {hasCli}
      onRemove={(url) => (shortlist = shortlist.filter((x) => x.url !== url))}
      onClear={() => (shortlist = [])}
      onScore={scoreShortlist}
    />
  </div>
{/if}
