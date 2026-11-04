<script lang="ts">
  import { Compass, Sparkles } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import CostBadge from "@/components/cost/cost-badge.svelte";
  import type { ExploreMode } from "@/lib/explore";

  // Cost honesty rendered at the POINT OF CHOICE: free deterministic Scan (default)
  // vs token-spending AI search. The AI segment stays selectable even with no CLI —
  // selecting it reveals the blocked state (more discoverable than a dead tab).
  let {
    mode,
    onchange,
    cliConfigured,
  }: { mode: ExploreMode; onchange: (m: ExploreMode) => void; cliConfigured: boolean } = $props();
</script>

<div class="flex w-full rounded-xl border border-border bg-surface/40 p-1 sm:inline-flex sm:w-auto">
  <button
    type="button"
    onclick={() => onchange("scan")}
    aria-pressed={mode === "scan"}
    class={cn(
      "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm transition-colors sm:flex-none sm:gap-2 sm:px-3 max-sm:min-h-[44px]",
      mode === "scan" ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
    )}
  >
    <Compass class="size-4" />
    <span class="font-medium">Scan</span>
    <span class="hidden sm:inline-flex">
      <CostBadge kind="free-network" size="xs" />
    </span>
  </button>
  <button
    type="button"
    onclick={() => onchange("ai")}
    aria-pressed={mode === "ai"}
    class={cn(
      "flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm transition-colors sm:flex-none sm:gap-2 sm:px-3 max-sm:min-h-[44px]",
      mode === "ai" ? "bg-brand-soft text-brand" : "text-muted hover:text-foreground",
    )}
  >
    <Sparkles class="size-4" />
    <span class="font-medium">AI search</span>
    <span class="hidden sm:inline-flex">
      <CostBadge kind="spend" size="xs" />
    </span>
    {#if !cliConfigured}<span class="text-[10px] text-faint">needs a CLI</span>{/if}
  </button>
</div>
