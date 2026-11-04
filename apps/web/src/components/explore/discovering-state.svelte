<script lang="ts">
  import { Check, Loader2 } from "@lucide/svelte";
  import ApplyBackdrop from "@/components/apply/apply-backdrop.svelte";
  import { instrumentSerif } from "@/lib/fonts";
  import { ATS_LABEL, ATS_SOURCES, type AtsSource } from "@/lib/explore";
  import { useExplore, type SourceState } from "@/lib/explore.svelte";
  import { useCountUp } from "./use-count-up.svelte";

  const explore = useExplore();
  const shown = useCountUp(() => explore.matchCount);
  const companies = useCountUp(() => explore.companiesScanned);
</script>

{#snippet sourceChip(ats: AtsSource, s: SourceState | undefined)}
  {@const chipState = s?.state ?? "queued"}
  {@const pct = s?.total ? Math.min(100, Math.round(((s.done ?? 0) / s.total) * 100)) : chipState === "swept" || chipState === "noisy" ? 100 : 0}
  <div class="co-src__chip" data-state={chipState === "noisy" ? "active" : chipState}>
    {#if chipState === "active"}
      <span class="co-src__orb"></span>
    {:else if chipState === "swept" || chipState === "noisy"}
      <Check class="size-3.5 text-emerald-500" />
    {:else}
      <span class="size-2.5 rounded-full border border-current opacity-40"></span>
    {/if}
    <span class="text-[13px] font-medium text-foreground">{ATS_LABEL[ats]}</span>
    <div class="ml-auto flex flex-col items-end gap-1">
      {#if chipState === "noisy"}<span class="text-[10px] text-faint">~{s?.unreachable} skipped</span>{/if}
      <div class="co-src__track">
        <div class="co-src__bar" style="width: {pct}%"></div>
      </div>
    </div>
  </div>
{/snippet}

<ApplyBackdrop intense={explore.phase !== "revealing"} />
<div class="co-disc">
  <div class="co-ledger">
    <span class="size-1.5 rounded-full bg-emerald-500"></span>
    0 tokens · $0.00
    {#if companies.value > 0}<span class="opacity-70">· {companies.value.toLocaleString()} companies</span>{/if}
  </div>

  <div>
    <div class="{instrumentSerif.className} co-disc__counter text-foreground">{shown.value}</div>
    <p class="mt-1 text-sm text-muted">
      {explore.phase === "revealing"
        ? "fresh roles found — free"
        : explore.matchCount > 0
          ? "fresh roles and counting…"
          : "scanning the network…"}
    </p>
  </div>

  <div class="co-src">
    {#each ATS_SOURCES as a (a)}
      {@render sourceChip(a, explore.sources[a])}
    {/each}
  </div>

  <p class="flex items-center gap-2 text-[13px] text-faint">
    <Loader2 class="size-3.5 animate-spin" />
    {explore.status || "Casting the net across the ATS network…"}
  </p>
</div>

<style>
  :global(.co-disc) {
    position: relative;
    z-index: 1;
    display: flex;
    min-height: 0;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    text-align: center;
    gap: 1rem;
    padding: 1.5rem 1rem 0.5rem;
  }
  :global(.co-disc__counter) {
    font-variant-numeric: tabular-nums;
    line-height: 1;
    font-size: clamp(4rem, 13vw, 8rem);
  }
  :global(.co-src) {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 0.6rem;
  }
  :global(.co-src__chip) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-radius: 0.8rem;
    border: 1px solid var(--border, hsl(0 0% 50% / 0.2));
    padding: 0.5rem 0.8rem;
    min-width: 9.5rem;
    background: color-mix(in srgb, var(--bg) 70%, transparent);
    transition:
      opacity 0.3s,
      border-color 0.3s;
  }
  :global(.co-src__chip[data-state="queued"]) {
    opacity: 0.4;
    border-style: dashed;
  }
  :global(.co-src__chip[data-state="active"]) {
    border-color: hsl(26 73% 51% / 0.45);
  }
  :global(.co-src__orb) {
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: hsl(26 80% 55%);
    box-shadow: 0 0 0 0 hsl(26 80% 55% / 0.5);
    animation: co-orb 1.4s ease-out infinite;
  }
  :global(.co-src__bar) {
    height: 3px;
    border-radius: 2px;
    background: hsl(26 73% 51%);
    transition: width 0.4s ease;
  }
  :global(.co-src__track) {
    height: 3px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--fg) 14%, transparent);
    overflow: hidden;
    width: 3.5rem;
  }
  :global(.co-disc__skel) {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr));
    gap: 0.7rem;
    width: 100%;
    max-width: 46rem;
    margin-top: 0.5rem;
  }
  :global(.co-disc__skelcard) {
    height: 4.4rem;
    border-radius: 0.8rem;
    border: 1px solid var(--border, hsl(0 0% 50% / 0.15));
    background: color-mix(in srgb, var(--bg) 60%, transparent);
    overflow: hidden;
    position: relative;
  }
  :global(.co-disc__skelcard::after) {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--fg) 8%, transparent), transparent);
    transform: translateX(-100%);
    animation: co-shimmer 1.5s infinite;
  }
  :global(.co-ledger) {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    border-radius: 999px;
    border: 1px solid hsl(160 64% 46% / 0.3);
    background: hsl(160 64% 46% / 0.1);
    color: hsl(160 60% 40%);
    padding: 0.35rem 0.85rem;
    font-size: 12.5px;
    font-weight: 600;
  }
  :global(html.dark .co-ledger) {
    color: hsl(158 64% 62%);
  }
  @keyframes co-orb {
    0% {
      box-shadow: 0 0 0 0 hsl(26 80% 55% / 0.5);
    }
    70% {
      box-shadow: 0 0 0 0.5rem hsl(26 80% 55% / 0);
    }
    100% {
      box-shadow: 0 0 0 0 hsl(26 80% 55% / 0);
    }
  }
  @keyframes co-shimmer {
    100% {
      transform: translateX(100%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.co-src__orb),
    :global(.co-disc__skelcard::after) {
      animation: none;
    }
  }
</style>
