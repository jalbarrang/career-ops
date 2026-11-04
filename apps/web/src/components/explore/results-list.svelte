<script lang="ts">
  import { Plus, Search } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import CostBadge from "@/components/cost/cost-badge.svelte";
  import { useExplore } from "@/lib/explore.svelte";
  import DiscoveryCard from "./discovery-card.svelte";
  import type { EnrichedOffer } from "./enriched-offer";

  let { offers }: { offers: EnrichedOffer[] } = $props();

  const explore = useExplore();
  const SORTS = ["fresh", "company"] as const;
  let sort = $state<(typeof SORTS)[number]>("fresh");
  let q = $state("");

  const isAi = $derived(explore.mode === "ai");

  const view = $derived.by(() => {
    const needle = q.trim().toLowerCase();
    let list = offers;
    if (needle) list = list.filter((o) => o.title.toLowerCase().includes(needle) || o.company.toLowerCase().includes(needle));
    return [...list].sort((a, b) =>
      sort === "fresh" ? (b.postedAt || "").localeCompare(a.postedAt || "") : a.company.localeCompare(b.company),
    );
  });

  const addable = $derived(offers.filter((o) => !o.inPipeline && !o.evaluatedN && !explore.added.has(o.url)));
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-3">
    <div>
      <p class="text-sm text-foreground">
        <span class="font-semibold">{offers.length}</span>
        {isAi ? `candidate${offers.length === 1 ? "" : "s"}` : `fresh role${offers.length === 1 ? "" : "s"}`}
        <CostBadge kind={isAi ? "spend" : "free-network"} size="xs" class="ml-2 align-middle" />
      </p>
      <p class="text-[12px] text-faint">
        {isAi
          ? "found by AI on the open web · unverified until you evaluate"
          : `${explore.companiesScanned > 0 ? `${explore.companiesScanned.toLocaleString()} companies scanned · ` : ""}0 tokens spent${explore.partial ? " · some boards were unreachable (normal for public directories)" : ""}`}
      </p>
      {#if !isAi && explore.error}
        <p class="text-[12px] text-amber-700 dark:text-amber-300">{explore.error}</p>
      {/if}
    </div>

    <div class="ml-auto flex items-center gap-2">
      <div class="flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5">
        <Search class="size-3.5 text-faint" />
        <input
          value={q}
          oninput={(e) => (q = e.currentTarget.value)}
          placeholder="Filter results…"
          class="w-32 bg-transparent text-[13px] outline-none placeholder:text-faint"
        />
      </div>
      <div class="inline-flex rounded-lg border border-border bg-surface/40 p-0.5 text-xs">
        {#each SORTS as s (s)}
          <button
            type="button"
            onclick={() => (sort = s)}
            class={cn("rounded-md px-2.5 py-1 font-medium capitalize transition-colors", sort === s ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground")}
          >
            {s}
          </button>
        {/each}
      </div>
      {#if addable.length > 1}
        <button
          type="button"
          onclick={() => void explore.addToPipeline(addable)}
          class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/40 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand"
        >
          <Plus class="size-3.5" /> Add all {addable.length}
        </button>
      {/if}
    </div>
  </div>

  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {#each view as o (o.url)}
      <DiscoveryCard offer={o} inPipeline={o.inPipeline} evaluatedN={o.evaluatedN} />
    {/each}
  </div>

  {#if view.length === 0 && (q.trim() || !explore.running)}
    <p class="py-10 text-center text-sm text-faint">No results match “{q}”.</p>
  {/if}
</div>
