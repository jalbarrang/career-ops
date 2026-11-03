<script module lang="ts">
  export type ShortItem = { url: string; company: string; role: string };
</script>

<script lang="ts">
  import { ChevronDown, Coins, Settings, Sparkles, X } from "@lucide/svelte";
  import CompanyLogo from "@/components/company-logo.svelte";
  import CostBadge from "@/components/cost/cost-badge.svelte";
  import { cn } from "@/lib/cn";
  import { formatRunCostEstimate } from "@/lib/run-cost-estimate.mjs";

  // The persistent shortlist tray — bottom-sheet on mobile (thumb-zone), floating card
  // on desktop. "Score shortlist" is the ONLY token spend in the whole inbox: cost is
  // shown BEFORE the click and gated behind an explicit confirm (never spend by surprise).
  let {
    items,
    estimate,
    hasCli,
    onRemove,
    onClear,
    onScore,
  }: {
    items: ShortItem[];
    estimate: { tokens?: number; usd?: number };
    hasCli: boolean;
    onRemove: (url: string) => void;
    onClear: () => void;
    onScore: () => void;
  } = $props();

  let open = $state(false);
  let confirming = $state(false);

  const n = $derived(items.length);
  const costText = $derived(formatRunCostEstimate(estimate));
</script>

{#if n > 0}
  <div class="fixed inset-x-0 bottom-0 z-30 sm:bottom-4">
    <div class="mx-auto max-w-3xl sm:px-6">
      <div class="border-t border-border bg-surface shadow-lg shadow-black/10 sm:rounded-2xl sm:border">
        <!-- expandable saved-items list -->
        {#if open}
          <ul class="max-h-64 divide-y divide-border overflow-y-auto px-3 py-1">
            {#each items as it (it.url)}
              <li class="flex items-center gap-2.5 py-2">
                <CompanyLogo name={it.company} size={18} />
                <span class="min-w-0 flex-1 truncate text-sm">
                  <span class="font-medium">{it.company}</span> <span class="text-muted">· {it.role}</span>
                </span>
                <button
                  type="button"
                  onclick={() => onRemove(it.url)}
                  aria-label={`Remove ${it.company}`}
                  class="inline-flex items-center justify-center rounded-md p-1 text-faint transition-colors hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
                >
                  <X class="size-4" />
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        <!-- the persistent bar -->
        <div class="flex items-center gap-3 px-3 py-2.5 sm:px-4">
          <button
            type="button"
            onclick={() => (open = !open)}
            class="inline-flex items-center gap-1.5 text-sm font-medium max-sm:min-h-[44px]"
          >
            <ChevronDown class={cn("size-4 text-muted transition-transform", open && "rotate-180")} />
            Shortlist <span class="tabular-nums text-brand-text">({n})</span>
          </button>

          {#if open}
            <button
              type="button"
              onclick={onClear}
              class="text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
            >
              Clear
            </button>
          {/if}

          <div class="ml-auto flex items-center gap-2">
            {#if !confirming}
              <button
                type="button"
                onclick={() => (confirming = true)}
                class="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
              >
                <Sparkles class="size-4" />
                <span>Score {n}</span>
                <span class="hidden text-xs font-normal text-brand-foreground/80 sm:inline">· {costText}</span>
              </button>
            {:else if !hasCli}
              <div class="flex items-center gap-2 text-xs">
                <span class="text-muted">No AI configured.</span>
                <a
                  href="/config"
                  class="inline-flex items-center gap-1 rounded-full border border-brand/40 bg-brand-soft px-3 py-1.5 font-medium text-brand max-sm:min-h-[44px]"
                >
                  <Settings class="size-3.5" /> Set up
                </a>
                <button type="button" onclick={() => (confirming = false)} class="text-faint hover:text-foreground max-sm:min-h-[44px]">
                  Cancel
                </button>
              </div>
            {:else}
              <div class="flex items-center gap-2">
                <span class="hidden items-center gap-1 text-[11px] text-muted sm:inline-flex">
                  <Coins class="size-3.5 text-brand" /> {costText}
                </span>
                <button
                  type="button"
                  onclick={() => {
                    confirming = false;
                    onScore();
                  }}
                  class="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 max-sm:min-h-[44px]"
                >
                  Score {n} now
                </button>
                <button
                  type="button"
                  onclick={() => (confirming = false)}
                  class="rounded-full px-2 py-2 text-xs text-faint transition-colors hover:text-foreground max-sm:min-h-[44px]"
                >
                  Cancel
                </button>
              </div>
            {/if}
          </div>
        </div>

        <!-- cost line — always visible on mobile (where it doesn't fit in the button) -->
        <div class="flex items-center gap-2 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted sm:hidden">
          <CostBadge kind="spend" size="xs" />
          <span>{costText} — the only step that spends</span>
        </div>
      </div>
    </div>
  </div>
{/if}
