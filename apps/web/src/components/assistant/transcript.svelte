<script lang="ts">
  import { Loader2 } from "@lucide/svelte";
  import PartView from "@/components/assistant/part-view.svelte";
  import type { Job } from "@/lib/jobs.svelte";
  import { cn } from "@/lib/cn";
  import { msgText, type Msg } from "@/components/assistant/envelope";

  // The scrollable transcript. It owns the follow-the-stream scroll because that
  // runs after every render of the list it measures.
  let {
    messages,
    jobs,
    busy,
    onConfirm,
  }: {
    messages: Msg[];
    jobs: Job[];
    busy: boolean;
    onConfirm: (cid: string, accept: boolean) => void;
  } = $props();

  let scrollEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    void messages;
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: "smooth" });
  });
</script>

<div bind:this={scrollEl} class="flex-1 space-y-4 overflow-y-auto px-4 py-4">
  {#each messages as m, i (i)}
    {@const hasVisible = m.parts.some((p) => (p.type === "text" && p.text.trim()) || p.type !== "text")}
    {@const isLast = i === messages.length - 1}
    <div class={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
      <div
        class={cn(
          "max-w-[88%] rounded-2xl px-3.5 py-2 text-sm",
          m.role === "user" ? "bg-brand text-brand-foreground" : "w-full bg-surface-hover text-foreground",
        )}
      >
        {#if m.role === "user"}
          {msgText(m)}
        {:else if !hasVisible && busy && isLast}
          <Loader2 class="size-4 animate-spin text-muted" />
        {:else}
          <div class="space-y-2">
            {#each m.parts as p, j (j)}
              <PartView part={p} {jobs} {onConfirm} />
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/each}
</div>
