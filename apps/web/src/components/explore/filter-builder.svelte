<script lang="ts">
  import { ChevronDown, Clock, MapPin, SlidersHorizontal } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import { ATS_LABEL, ATS_SOURCES, type AtsSource, type ExploreFilters } from "@/lib/explore";
  import FieldLabel from "./field-label.svelte";
  import KeywordField from "./keyword-field.svelte";

  const RECENCY = [
    { label: "24h", days: 1 },
    { label: "3d", days: 3 },
    { label: "7d", days: 7 },
    { label: "14d", days: 14 },
    { label: "30d", days: 30 },
  ];

  let {
    filters,
    onchange,
    seededFrom = [],
  }: { filters: ExploreFilters; onchange: (f: ExploreFilters) => void; seededFrom?: string[] } = $props();

  let advanced = $state(false);

  const set = (patch: Partial<ExploreFilters>) => onchange({ ...filters, ...patch });

  function toggleAts(a: AtsSource): void {
    const has = filters.ats.includes(a);
    const next = has ? filters.ats.filter((x) => x !== a) : [...filters.ats, a];
    // Never let the source list go empty — the scan needs at least one board.
    set({ ats: next.length ? next : filters.ats });
  }
</script>

<div class="space-y-4">
  <div>
    <FieldLabel hint={filters.positive.length === 0 ? "empty = every fresh posting" : undefined}>Roles to find</FieldLabel>
    <KeywordField
      values={filters.positive}
      tone="inc"
      placeholder="AI platform, ML infrastructure, staff engineer…"
      onchange={(v) => set({ positive: v })}
    />
    {#if seededFrom.length > 0 && filters.positive.length > 0}
      <p class="mt-1 text-[11px] text-faint">Seeded from your {seededFrom.join(" + ")} — edit freely.</p>
    {/if}
  </div>

  <div>
    <FieldLabel>Exclude</FieldLabel>
    <KeywordField values={filters.negative} tone="exc" placeholder="manager, sales, contract…" onchange={(v) => set({ negative: v })} />
  </div>

  <div>
    <FieldLabel hint="matches any city, region, country, or Remote">
      <span class="inline-flex items-center gap-1.5">
        <MapPin class="size-3.5 text-muted" /> City or location
      </span>
    </FieldLabel>
    <KeywordField
      values={filters.allow}
      tone="inc"
      placeholder="Toronto, New York, Remote…"
      ariaLabel="City or location"
      onchange={(v) => set({ allow: v })}
    />
  </div>

  <div class="flex flex-wrap items-end gap-x-8 gap-y-4">
    <div class="min-w-[18rem]">
      <FieldLabel hint="postings published in this window">
        <span class="inline-flex items-center gap-1.5">
          <Clock class="size-3.5 text-muted" /> Posted within
        </span>
      </FieldLabel>
      <div class="inline-flex rounded-lg border border-border bg-surface/40 p-0.5">
        {#each RECENCY as r (r.days)}
          <button
            type="button"
            onclick={() => set({ sinceDays: r.days })}
            class={cn(
              "rounded-md px-2.5 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]",
              filters.sinceDays === r.days ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
            )}
          >
            {r.label}
          </button>
        {/each}
      </div>
    </div>

    <div>
      <FieldLabel hint={filters.ats.length === 0 ? "pick at least one" : undefined}>Sources</FieldLabel>
      <div class="flex flex-wrap gap-1.5">
        {#each ATS_SOURCES as a (a)}
          {@const on = filters.ats.includes(a)}
          <button
            type="button"
            onclick={() => toggleAts(a)}
            class={cn(
              "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px]",
              on ? "border-brand/40 bg-brand-soft text-brand" : "border-border text-muted hover:text-foreground",
            )}
          >
            {ATS_LABEL[a]}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <button
    type="button"
    onclick={() => (advanced = !advanced)}
    class="inline-flex items-center gap-1.5 text-[12px] text-muted hover:text-foreground transition-colors max-sm:min-h-[44px]"
  >
    <SlidersHorizontal class="size-3.5" />
    More location controls &amp; scan depth
    <ChevronDown class={cn("size-3.5 transition-transform", advanced && "rotate-180")} />
  </button>

  {#if advanced}
    <div class="space-y-3 rounded-xl border border-border bg-surface/30 p-3">
      <div class="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel hint="rescues a multi-location posting">Always include</FieldLabel>
          <KeywordField values={filters.alwaysAllow} tone="inc" placeholder="Toronto…" onchange={(v) => set({ alwaysAllow: v })} />
        </div>
        <div>
          <FieldLabel hint="unless Always include also matches">Exclude locations</FieldLabel>
          <KeywordField values={filters.block} tone="exc" placeholder="India…" onchange={(v) => set({ block: v })} />
        </div>
      </div>
      <div>
        <FieldLabel hint="hard reject — overrides Always include">Never include</FieldLabel>
        <KeywordField values={filters.blockHard} tone="exc" placeholder="USA, Brazil…" onchange={(v) => set({ blockHard: v })} />
      </div>
      <div>
        <FieldLabel hint={`${filters.limitPerAts} companies / source`}>Scan depth</FieldLabel>
        <input
          type="range"
          min={50}
          max={500}
          step={50}
          value={filters.limitPerAts}
          oninput={(e) => set({ limitPerAts: Number(e.currentTarget.value) })}
          class="w-full accent-brand"
        />
      </div>
    </div>
  {/if}
</div>
