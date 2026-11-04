<script lang="ts">
  import { Sparkles } from "@lucide/svelte";
  import ApplyBackdrop from "@/components/apply/apply-backdrop.svelte";
  import { instrumentSerif } from "@/lib/fonts";
  import { useExplore } from "@/lib/explore.svelte";
  import { useCountUp } from "./use-count-up.svelte";
  import AiHuntTrace from "./ai-hunt-trace.svelte";
  import DiscoveryCard from "./discovery-card.svelte";

  // The AI hunt surface — apply-mode polish: an animated orb, a serif headline that
  // folds in the live count (no lonely giant "0"), a brand-orange effort ledger
  // (NEVER a fake $0), the CONTAINED reasoning panel, and cards materializing below.
  let { cliName }: { cliName?: string } = $props();

  const explore = useExplore();
  const shown = useCountUp(() => explore.matchCount);
  const revealing = $derived(explore.phase === "revealing");
</script>

<ApplyBackdrop intense={!revealing} />
<div class="co-aihunt">
  <span class="co-aiorb">
    <span class="co-aiorb__glow"></span>
    <span class="co-aiorb__ring"></span>
    <Sparkles class="size-6 text-brand" />
  </span>

  <div>
    <h2 class="{instrumentSerif.className} text-3xl leading-tight text-foreground">
      {explore.matchCount > 0 ? `${shown.value} candidate${shown.value === 1 ? "" : "s"}` : "Hunting the open web"}
    </h2>
    <p class="mt-1 text-sm text-muted">
      {revealing ? "found — review them below" : explore.matchCount > 0 ? "found so far · streaming in" : "casting across the public web…"}
    </p>
  </div>

  <div class="co-ailedger">
    <Sparkles class="size-3.5" />
    {cliName || "your CLI"} · searching the open web
    {#if explore.aiCost.searches > 0}<span class="opacity-75">· {explore.aiCost.searches} searches</span>{/if}
    {#if explore.matchCount > 0}<span class="opacity-75">· {explore.matchCount} found</span>{/if}
  </div>

  <AiHuntTrace trace={explore.aiTrace} />

  {#if explore.offers.length > 0}
    <div class="mt-2 grid w-full max-w-4xl gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {#each explore.offers as o (o.url)}
        <DiscoveryCard offer={o} inPipeline={false} />
      {/each}
    </div>
  {/if}
</div>

<style>
  :global(.co-aihunt) {
    position: relative;
    z-index: 1;
    display: flex;
    min-height: 72vh;
    flex-direction: column;
    align-items: center;
    gap: 1.2rem;
    padding: 2.5rem 1rem 2rem;
    text-align: center;
  }
  :global(.co-aiorb) {
    position: relative;
    display: grid;
    place-items: center;
    width: 4rem;
    height: 4rem;
  }
  :global(.co-aiorb__glow) {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: hsl(26 80% 55% / 0.28);
    filter: blur(18px);
    animation: co-aiorb-pulse 2.4s ease-in-out infinite;
  }
  :global(.co-aiorb__ring) {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 2px solid hsl(26 73% 51% / 0.25);
    border-top-color: hsl(26 73% 51%);
    animation: co-aiorb-spin 1.1s linear infinite;
  }
  :global(.co-ailedger) {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    border-radius: 999px;
    border: 1px solid hsl(26 73% 51% / 0.3);
    background: hsl(26 73% 51% / 0.1);
    color: hsl(26 78% 43%);
    padding: 0.4rem 0.9rem;
    font-size: 12.5px;
    font-weight: 600;
  }
  :global(html.dark .co-ailedger) {
    color: hsl(26 86% 67%);
  }
  @keyframes co-aiorb-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes co-aiorb-pulse {
    0%,
    100% {
      opacity: 0.6;
      transform: scale(0.92);
    }
    50% {
      opacity: 1;
      transform: scale(1.08);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.co-aiorb__ring),
    :global(.co-aiorb__glow) {
      animation: none;
    }
  }
</style>
