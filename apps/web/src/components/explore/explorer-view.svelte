<script lang="ts">
  import { onMount } from "svelte";
  import { AlertTriangle, ChevronDown, Compass, RotateCcw, Settings, Sparkles } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import { instrumentSerif } from "@/lib/fonts";
  import type { Application, InboxJob } from "@/lib/career-ops";
  import { normalizeTextKey } from "@/lib/core/normalize-text-key.ts";
  import { paramsToFilters, paramsToAi, type ExploreFilters } from "@/lib/explore";
  import { useExplore } from "@/lib/explore.svelte";
  import FilterBuilder from "./filter-builder.svelte";
  import DiscoveringState from "./discovering-state.svelte";
  import AiHuntView from "./ai-hunt-view.svelte";
  import ExploreModeToggle from "./explore-mode-toggle.svelte";
  import AiSearchBox from "./ai-search-box.svelte";
  import ResultsList from "./results-list.svelte";
  import type { EnrichedOffer } from "./enriched-offer";
  import ScheduleJobAction from "./schedule-job-action.svelte";

  let {
    seed,
    inboxSnapshot,
    appsSnapshot,
    rootExists,
  }: {
    seed: { filters: ExploreFilters; seededFrom: string[] };
    inboxSnapshot: InboxJob[];
    appsSnapshot: Application[];
    rootExists: boolean;
  } = $props();

  // Same shape as core normalizeTextKey(s, " ") — never [^a-z0-9] (#2666).
  const norm = (s: string) => normalizeTextKey(s, " ");
  const CLI_NAMES: Record<string, string> = {
    claude: "Claude Code",
    codex: "Codex",
    gemini: "Gemini CLI",
    opencode: "OpenCode",
    copilot: "Copilot CLI",
    qwen: "Qwen CLI",
    antigravity: "Antigravity CLI",
  };

  const explore = useExplore();

  const scanNote = $derived(
    explore.companiesScanned > 0
      ? `Scanned ${explore.companiesScanned.toLocaleString()}${explore.companiesAvailable > explore.companiesScanned ? ` of ${explore.companiesAvailable.toLocaleString()}` : ""} compan${explore.companiesScanned === 1 ? "y" : "ies"}${explore.partial ? " · some sources were unreachable" : ""}.`
      : undefined,
  );
  let inited = false;
  let refineOpen = $state(false);
  let cli = $state<{ id: string | null; name?: string }>({ id: null });
  let firstRun = $state(false);

  onMount(() => {
    try {
      const cfg = JSON.parse(localStorage.getItem("career-ops:config") || "{}") as { cliId?: string };
      const id = cfg.cliId || null;
      cli = { id, name: id ? CLI_NAMES[id] || id : undefined };
    } catch {
      cli = { id: null };
    }
  });

  // Initialize once from the URL (shareable search) or the server seed — without
  // clobbering anything the assistant set before this mount.
  onMount(() => {
    if (inited) return;
    inited = true;
    const sp = new URLSearchParams(window.location.search);
    const ai = paramsToAi(sp);
    if (ai !== null) {
      explore.setMode("ai");
      explore.setAiIntent(ai);
    } else if (sp.get("view") === "fresh") {
      // Today's "See all N" (#84) hands off here instead of a bare config form —
      // load the SAME /api/whats-new offers it already showed, through the normal
      // results-phase UI. The config form (Refine search / Re-cast) stays reachable.
      // Force scan mode: a session restored in "ai" mode (sessionStorage rehydrate)
      // must not show the AI-search UI for this scan-only hand-off.
      explore.setMode("scan");
      explore.initFilters(seed.filters);
      void explore.loadFresh();
    } else {
      explore.initFilters(sp.toString() ? paramsToFilters(sp) : seed.filters);
      // Onboarding hand-off: ?run=1 auto-fires the free scan + flags the first-run
      // banner (the "matches found from your CV, free" reveal).
      if (sp.get("run") === "1") {
        firstRun = true;
        void explore.discover();
      }
    }
  });

  const inboxUrls = $derived(new Set(inboxSnapshot.map((j) => j.url)));
  const enriched = $derived.by<EnrichedOffer[]>(() =>
    explore.offers.map((o) => {
      const inPipeline = inboxUrls.has(o.url);
      const c = norm(o.company);
      const t = norm(o.title);
      const ev = appsSnapshot.find((a) => {
        if (norm(a.company) !== c) return false;
        const ar = norm(a.role);
        return ar.length > 3 && (t.includes(ar) || ar.includes(t.split(" ").slice(0, 3).join(" ")));
      });
      return { ...o, inPipeline, evaluatedN: ev?.n };
    }),
  );

  const isAi = $derived(explore.mode === "ai");
  const isResults = $derived(explore.phase === "results");
  const canDiscover = $derived(explore.filters.ats.length > 0);
  const scanRunning = $derived(explore.running && !isAi);
  // Keep one ResultsList mounted across scanning → revealing → results so
  // filter/sort/scroll and co-rise survive the 850ms reveal handoff.
  const showScanList = $derived(!isAi && explore.offers.length > 0 && (scanRunning || isResults));

  // 0 results, but the scan was NOT a clean full search → never "all caught up".
  // Pick the most informative reason (authoritative when the scanner's --json mode
  // is available; otherwise the 0-companies fallback).
  function degradedCopy(a: {
    companiesScanned: number;
    companiesAvailable: number;
    capHit: boolean;
    droppedNoDate: number;
    partial: boolean;
  }): { title: string; body: string } {
    let title = "The scan ran, but couldn’t reach any sources.";
    let body =
      "The public ATS directories didn’t respond — usually a transient network hiccup or rate-limit, so nothing could be searched. This isn’t “all caught up”; a retry in a moment usually clears it.";
    if (a.companiesScanned > 0 && a.capHit) {
      title = "No matches in the slice we searched.";
      body = `The scan is capped, so it only searched ${a.companiesScanned.toLocaleString()}${a.companiesAvailable > a.companiesScanned ? ` of ${a.companiesAvailable.toLocaleString()}` : ""} companies — not the whole network. Raise scan depth (Refine search) or narrow your roles, then re-cast to look deeper.`;
    } else if (a.companiesScanned > 0 && a.droppedNoDate > 0) {
      title = "Fresh-looking roles were skipped for missing dates.";
      body = `${a.droppedNoDate.toLocaleString()} posting${a.droppedNoDate === 1 ? "" : "s"} matched but had no clear publish date, so the freshness filter dropped them. Widening the time window often brings dated equivalents back.`;
    } else if (a.companiesScanned > 0 && a.partial) {
      title = "Some job boards were unreachable.";
      body = `The scan searched ${a.companiesScanned.toLocaleString()} companies, but one or more sources didn’t respond — so this is a partial result, not “all caught up”. A retry usually clears it.`;
    }
    return { title, body };
  }
</script>

{#snippet discoverBar(canDiscoverNow: boolean, ondiscover: () => void, label: string, currentFilters: ExploreFilters)}
  <div class="flex flex-wrap items-center gap-3">
    <button
      type="button"
      disabled={!canDiscoverNow}
      onclick={ondiscover}
      class="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground shadow-sm transition-all hover:brightness-110 disabled:opacity-50 max-sm:min-h-[44px]"
    >
      <Compass class="size-4" /> {label}
    </button>
    <ScheduleJobAction filters={currentFilters} />
    <span class="inline-flex items-center gap-1.5 text-[12px] text-muted">
      <span class="size-1.5 rounded-full bg-emerald-500"></span>
      Evaluating a role later costs tokens. Discovering never does.
    </span>
  </div>
{/snippet}

{#snippet emptyState(tone: "good" | "loose", title: string, body: string, note: string | undefined, onrerun: () => void, rerunLabel: string)}
  <div class="rounded-2xl border border-border bg-surface/30 px-6 py-12 text-center">
    <div class={cn("mx-auto grid size-12 place-items-center rounded-full", tone === "good" ? "bg-emerald-500/12 text-emerald-500" : "bg-brand-soft text-brand")}>
      <Sparkles class="size-6" />
    </div>
    <h2 class="{instrumentSerif.className} mt-4 text-2xl text-foreground">{title}</h2>
    <p class="mx-auto mt-1.5 max-w-md text-sm text-muted">{body}</p>
    {#if note}<p class="mx-auto mt-1 max-w-md text-[12px] text-faint">{note}</p>{/if}
    <button
      type="button"
      onclick={onrerun}
      class="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/50 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:border-brand/40 hover:text-brand"
    >
      <RotateCcw class="size-4" /> {rerunLabel}
    </button>
  </div>
{/snippet}

{#snippet degradedCard(args: { companiesScanned: number; companiesAvailable: number; capHit: boolean; droppedNoDate: number; partial: boolean; onretry: () => void })}
  {@const copy = degradedCopy(args)}
  <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 text-center">
    <AlertTriangle class="mx-auto size-6 text-amber-500" />
    <p class="mt-2 text-sm font-medium text-foreground">{copy.title}</p>
    <p class="mx-auto mt-1 max-w-md text-[13px] text-muted">{copy.body}</p>
    <button type="button" onclick={args.onretry} class="mt-3 inline-flex items-center gap-1.5 rounded-md bg-brand-soft px-3 py-1.5 text-sm font-medium text-brand">
      <RotateCcw class="size-4" /> Retry the scan
    </button>
  </div>
{/snippet}

{#snippet cappedBanner(companiesScanned: number, companiesAvailable: number, onrefine: () => void)}
  <!-- Results ARE present, but the scan was capped — tell the user there's more, so a
       partial list never reads as "everything there is". -->
  <div class="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-amber-500/25 bg-amber-500/[0.07] px-4 py-2.5 text-[13px]">
    <span class="text-foreground">
      Showing a capped slice — searched {companiesScanned.toLocaleString()}
      {companiesAvailable > companiesScanned ? ` of ${companiesAvailable.toLocaleString()}` : ""} companies.
    </span>
    <button type="button" onclick={onrefine} class="font-medium text-brand hover:underline">Raise scan depth to search deeper</button>
  </div>
{/snippet}

{#snippet failedCard(msg: string, scannerMissing: boolean, onretry: () => void)}
  <!-- The scanner-missing case (data-only / pre-scan-ats-full checkout) must NOT
       offer a "Try again" that re-fails forever — give a real next step instead.
       The caller decides this from the response body's SCANNER_MISSING code, never
       from the error text and never from the bare 400: a runtime scan error ("The
       scanner returned no readable output.") mentions the scanner too, and 400 is
       a shared channel that also carries malformed-request and MODE_MISSING
       failures. Neither may be misreported as a broken checkout. -->
  {#if scannerMissing}
    <div class="rounded-2xl border border-border bg-surface/30 px-6 py-10 text-center">
      <div class="mx-auto grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
        <Compass class="size-6" />
      </div>
      <h2 class="{instrumentSerif.className} mt-4 text-2xl text-foreground">Discovery needs the full toolkit</h2>
      <p class="mx-auto mt-1.5 max-w-md text-sm text-muted">
        Your career-ops home looks data-only or is on an older version. The free scanner ships with a complete checkout —
        update career-ops, or paste a job URL on the pipeline to evaluate it directly.
      </p>
      <div class="mt-4 flex flex-wrap justify-center gap-2">
        <a href="/pipeline" class="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-brand-foreground transition hover:brightness-110">
          Open pipeline
        </a>
        <a href="/config" class="inline-flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand">
          Open Config
        </a>
      </div>
    </div>
  {:else}
    <div class="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5 text-center">
      <AlertTriangle class="mx-auto size-6 text-amber-500" />
      <p class="mt-2 text-sm font-medium text-foreground">Couldn’t finish the search.</p>
      <p class="mt-1 text-[13px] text-muted">{msg}</p>
      <button type="button" onclick={onretry} class="mt-3 inline-flex items-center gap-1.5 rounded-md bg-brand-soft px-3 py-1.5 text-sm font-medium text-brand">
        <RotateCcw class="size-4" /> Try again
      </button>
    </div>
  {/if}
{/snippet}

{#snippet blockedCard()}
  <div class="rounded-2xl border border-border bg-surface/30 px-6 py-12 text-center">
    <div class="mx-auto grid size-12 place-items-center rounded-full bg-brand-soft text-brand">
      <Sparkles class="size-6" />
    </div>
    <h2 class="{instrumentSerif.className} mt-4 text-2xl text-foreground">AI search needs a CLI</h2>
    <p class="mx-auto mt-1.5 max-w-md text-sm text-muted">
      Connect Claude Code, Gemini, or any agent CLI — your key, your tokens, your machine. The free Scan stays available without one.
    </p>
    <a href="/config" class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-sm font-semibold text-brand-foreground transition hover:brightness-110">
      <Settings class="size-4" /> Open Config
    </a>
  </div>
{/snippet}

{#if explore.running && isAi}
  <AiHuntView cliName={cli.name} />
{:else}
  <div class={scanRunning ? undefined : "mx-auto max-w-5xl px-5 py-8 md:px-8"}>
    {#if scanRunning}
      <DiscoveringState />
    {/if}
    {#if !scanRunning}
      <header class="mb-6">
        <div class="flex flex-wrap items-center gap-3">
          <div class="flex items-center gap-2.5">
            <Compass class="size-6 text-brand" />
            <h1 class="{instrumentSerif.className} text-3xl text-foreground">Explore</h1>
            <span class="rounded-full border border-brand/30 bg-brand-soft px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-brand-text">New</span>
          </div>
          <div class="w-full sm:ml-auto sm:w-auto">
            <ExploreModeToggle mode={explore.mode} onchange={(m) => explore.setMode(m)} cliConfigured={!!cli.id} />
          </div>
        </div>
        {#if !isResults}
          <p class="mt-3 max-w-2xl text-[15px] leading-relaxed text-muted">
            {isAi
              ? "Describe the role in plain language — an AI hunts the open web for it, on your own AI. Candidates are unverified until you evaluate."
              : "Scan the public ATS network — Greenhouse, Lever, Ashby, Workday. Fresh postings matched to you, zero tokens. You only spend when you choose to evaluate one."}
          </p>
        {/if}
      </header>

      {#if !rootExists}
        <div class="mb-5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
          Your career-ops home isn’t set up yet — discovery needs a checkout with a profile to seed from.
        </div>
      {/if}

      {#if isAi}
        {#if explore.phase === "blocked"}
          {@render blockedCard()}
        {:else}
          <div class="space-y-6">
            <AiSearchBox
              intent={explore.aiIntent}
              onintent={(s) => explore.setAiIntent(s)}
              onsubmit={() => void explore.discoverAI()}
              cliConfigured={!!cli.id}
              cliName={cli.name}
              onrunscan={() => explore.setMode("scan")}
            />
            {#if explore.phase === "results"}<ResultsList offers={enriched} />{/if}
            {#if explore.phase === "empty-loose"}
              {@render emptyState(
                "loose",
                "No public matches — yet.",
                "AI search reads what's public. Try broader intent, or run the free Scan over the ATS network.",
                undefined,
                () => explore.setMode("scan"),
                "Run the free Scan",
              )}
            {/if}
            {#if explore.phase === "failed"}
              {@render failedCard(explore.error || explore.status, explore.scannerMissing, () => void explore.discoverAI())}
            {/if}
          </div>
        {/if}
      {:else}
        {#if isResults}
          <div class="mb-6 rounded-xl border border-border bg-surface/30">
            <button
              type="button"
              onclick={() => (refineOpen = !refineOpen)}
              class="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium text-foreground"
            >
              <Compass class="size-4 text-brand" /> Refine search
              <ChevronDown class={cn("ml-auto size-4 text-muted transition-transform", refineOpen && "rotate-180")} />
            </button>
            {#if refineOpen}
              <div class="space-y-4 border-t border-border p-4">
                <FilterBuilder filters={explore.filters} onchange={(f) => explore.setFilters(f)} seededFrom={seed.seededFrom} />
                {@render discoverBar(canDiscover, () => void explore.discover(), "Re-cast (free)", explore.filters)}
              </div>
            {/if}
          </div>
        {:else}
          <div class="mb-6 rounded-2xl border border-border bg-surface/30 p-5">
            <FilterBuilder filters={explore.filters} onchange={(f) => explore.setFilters(f)} seededFrom={seed.seededFrom} />
            <div class="mt-5">
              {@render discoverBar(canDiscover, () => void explore.discover(), "Discover (free)", explore.filters)}
            </div>
          </div>
        {/if}

        {#if isResults && firstRun}
          <div class="mb-4 flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3">
            <Sparkles class="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <p class="text-[13px] leading-relaxed text-foreground">
              These are live roles that match your CV. <span class="text-emerald-600 dark:text-emerald-400">Nothing here cost you a token.</span> Pick the one you're
              most curious about — Evaluate it and I'll tell you exactly how you score, and why.
            </p>
          </div>
        {/if}

        {#if isResults && explore.capHit}
          {@render cappedBanner(explore.companiesScanned, explore.companiesAvailable, () => (refineOpen = true))}
        {/if}
      {/if}
    {/if}

    {#if showScanList}
      <div class={scanRunning ? "relative z-[1] mx-auto max-w-5xl px-5 pb-10 md:px-8" : undefined}>
        <ResultsList offers={enriched} />
      </div>
    {/if}

    {#if !scanRunning && !isAi}
      {#if explore.phase === "empty-current"}
        {@render emptyState(
          "good",
          "You're all caught up.",
          "Nothing new since your last scan. Your pipeline is current — that's the goal.",
          scanNote,
          () => {
            explore.setFilters({ ...explore.filters, sinceDays: Math.max(explore.filters.sinceDays, 30) });
            void explore.discover();
          },
          "Look back 30 days",
        )}
      {/if}
      {#if explore.phase === "empty-loose"}
        {@render emptyState(
          "loose",
          "No fresh matches — yet.",
          "Discovery is free — loosen and re-cast as often as you want.",
          scanNote,
          () => {
            explore.setFilters({ ...explore.filters, sinceDays: 30, block: [], allow: [] });
            void explore.discover();
          },
          "Widen to 30 days · clear location",
        )}
      {/if}
      {#if explore.phase === "degraded"}
        {@render degradedCard({
          onretry: () => void explore.discover(),
          companiesScanned: explore.companiesScanned,
          companiesAvailable: explore.companiesAvailable,
          capHit: explore.capHit,
          droppedNoDate: explore.droppedNoDate,
          partial: explore.partial,
        })}
      {/if}
      {#if explore.phase === "failed"}
        {@render failedCard(explore.error || explore.status, explore.scannerMissing, () => void explore.discover())}
      {/if}
    {/if}
  </div>
{/if}
