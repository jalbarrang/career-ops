<script lang="ts">
  import { Search, X } from "@lucide/svelte";
  import type { AtsSource } from "@/lib/explore";
  import { ATS_LABEL } from "@/lib/explore";
  import { FRESHNESS_WINDOWS, SENIORITY_LABEL, type Seniority } from "@/lib/inbox";
  import CostBadge from "@/components/cost/cost-badge.svelte";
  import { cn } from "@/lib/cn";

  // Free, client-side facets over the raw firehose — 0 tokens, instant. Mirrors the
  // Explore chip language so the two surfaces read as one system. On mobile the chip
  // row scrolls INSIDE its own container (never the page).
  let {
    within,
    setWithin,
    sources,
    toggleSource,
    seniorities,
    toggleSeniority,
    locQ,
    setLocQ,
    kw,
    setKw,
    availSources,
    availSeniorities,
    resultCount,
    totalCount,
    anyActive,
    onClear,
  }: {
    within: number | null;
    setWithin: (d: number | null) => void;
    sources: Set<AtsSource>;
    toggleSource: (s: AtsSource) => void;
    seniorities: Set<Seniority>;
    toggleSeniority: (s: Seniority) => void;
    locQ: string;
    setLocQ: (v: string) => void;
    kw: string;
    setKw: (v: string) => void;
    availSources: AtsSource[];
    availSeniorities: Seniority[];
    resultCount: number;
    totalCount: number;
    anyActive: boolean;
    onClear: () => void;
  } = $props();
</script>

{#snippet pill(on: boolean, onclick: () => void, label: string)}
  <button
    type="button"
    {onclick}
    class={cn(
      "shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]",
      on ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:text-foreground",
    )}
  >
    {label}
  </button>
{/snippet}

<div class="space-y-2.5">
  <!-- keyword search + live count -->
  <div class="flex items-center gap-3">
    <div class="relative flex-1">
      <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
      <input
        value={kw}
        oninput={(e) => setKw(e.currentTarget.value)}
        placeholder="Filter by company or role…"
        class="w-full rounded-lg border border-border bg-surface/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40 max-sm:min-h-[44px]"
      />
    </div>
    <span class="shrink-0 text-xs text-muted">
      <span class="tabular-nums text-foreground">{resultCount}</span>
      <span class="text-faint">/{totalCount}</span>
    </span>
  </div>

  <!-- chip row — desktop wraps, mobile scrolls inside the container -->
  <div class="flex items-center gap-2 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible sm:pb-0">
    <!-- freshness (single-select segmented; click active to clear) -->
    <div class="inline-flex shrink-0 rounded-lg border border-border bg-surface/40 p-0.5">
      {#each FRESHNESS_WINDOWS as w (w.days)}
        <button
          type="button"
          onclick={() => setWithin(within === w.days ? null : w.days)}
          class={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]",
            within === w.days ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
          )}
        >
          {w.label}
        </button>
      {/each}
    </div>

    {#each availSources as s (s)}
      {@render pill(sources.has(s), () => toggleSource(s), ATS_LABEL[s])}
    {/each}

    {#each availSeniorities as s (s)}
      {@render pill(seniorities.has(s), () => toggleSeniority(s), SENIORITY_LABEL[s])}
    {/each}

    <!-- location contains -->
    <input
      value={locQ}
      oninput={(e) => setLocQ(e.currentTarget.value)}
      placeholder="location…"
      class="w-28 shrink-0 rounded-full border border-border bg-surface/40 px-3 text-xs outline-none transition-colors placeholder:text-faint focus:border-brand/40 max-sm:min-h-[44px] py-1"
    />

    {#if anyActive}
      <button
        type="button"
        onclick={onClear}
        class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
      >
        <X class="size-3" /> Clear
      </button>
    {/if}
  </div>

  <!-- Token-honesty is bidirectional: the "free" reassurance is as always-visible
       as the tray's "spend" cue (mobile + desktop) — never desktop-only. -->
  <div class="flex items-center gap-1.5">
    <CostBadge kind="free" size="xs" />
    <span class="text-[11px] text-faint">Filtering is free — only scoring uses tokens.</span>
  </div>
</div>
