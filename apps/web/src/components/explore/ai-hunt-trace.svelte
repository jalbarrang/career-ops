<script lang="ts">
  import { Sparkles } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import type { AiTraceChunk } from "@/lib/explore-ai";

  // The live reasoning panel — a CONTAINED, polished card (apply-mode vocabulary)
  // rather than raw text on the backdrop. The narration arrives as arbitrary stream
  // deltas (split mid-word), so we COALESCE every narration chunk into one string,
  // strip markdown, and re-split into clean SENTENCES — healing the fragments. Newest
  // emphasized; auto-scrolls; co-located effect CSS (Tailwind v4 HMR gotcha).
  let { trace }: { trace: AiTraceChunk[] } = $props();

  let body = $state<HTMLDivElement | null>(null);

  const sentences = $derived.by(() => {
    const full = trace
      .filter((c) => c.kind === "narration")
      .map((c) => (c.kind === "narration" ? c.text : ""))
      .join("");
    const clean = full.replace(/`/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return [];
    // split into sentences (after . ! ? …), drop leading markdown bullets/quotes
    return clean
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.replace(/^[>\-*\s]+/, "").trim())
      .filter((s) => s.length > 2)
      .slice(-6);
  });

  // `**bold**` spans inside a sentence, split without a full markdown engine.
  const rows = $derived(
    sentences.map((s) =>
      s
        .split(/(\*\*[^*]+\*\*)/g)
        .filter((p) => p.length > 0)
        .map((p) => ({ bold: p.startsWith("**") && p.endsWith("**"), text: p.startsWith("**") && p.endsWith("**") ? p.slice(2, -2) : p })),
    ),
  );

  $effect(() => {
    rows.length;
    if (body) body.scrollTop = body.scrollHeight;
  });
</script>

{#if sentences.length > 0}
  <div class="w-full max-w-2xl rounded-2xl border border-border/70 bg-surface/80 text-left shadow-xl shadow-black/10 backdrop-blur-md">
    <div class="flex items-center gap-2 border-b border-border/60 px-4 py-2.5">
      <span class="co-reason__dot"></span>
      <span class="text-[12px] font-medium text-foreground">Reasoning live</span>
      <Sparkles class="ml-auto size-3.5 text-brand/70" />
    </div>
    <div bind:this={body} class="co-reason__body flex max-h-52 flex-col gap-2 overflow-y-auto px-4 py-3">
      {#each sentences as s, i (`${sentences.length}-${i}`)}
        <p class={cn("co-reason__line text-[13.5px] leading-relaxed", i === sentences.length - 1 ? "text-foreground" : "text-muted")}>
          {#each rows[i] as part}
            {#if part.bold}<strong class="font-semibold text-foreground">{part.text}</strong>{:else}<span>{part.text}</span>{/if}
          {/each}
        </p>
      {/each}
    </div>
  </div>
{/if}

<style>
  :global(.co-reason__dot) {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: hsl(26 80% 55%);
    box-shadow: 0 0 0 0 hsl(26 80% 55% / 0.5);
    animation: co-reason-pulse 1.5s ease-out infinite;
  }
  :global(.co-reason__body) {
    -webkit-mask-image: linear-gradient(180deg, transparent, #000 16%);
    mask-image: linear-gradient(180deg, transparent, #000 16%);
  }
  :global(.co-reason__line) {
    animation: co-reason-in 0.35s ease both;
  }
  @keyframes co-reason-pulse {
    70% {
      box-shadow: 0 0 0 0.4rem hsl(26 80% 55% / 0);
    }
    100% {
      box-shadow: 0 0 0 0 hsl(26 80% 55% / 0);
    }
  }
  @keyframes co-reason-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.co-reason__dot),
    :global(.co-reason__line) {
      animation: none;
    }
  }
</style>
