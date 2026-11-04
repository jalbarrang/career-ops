<script lang="ts">
  import { Loader2, Send } from "@lucide/svelte";

  // The composer: a textarea that grows with its content (a pasted CV, a long
  // answer) up to a cap that scales with the panel, instead of staying a one-line
  // box that scrolls. The height is set in an effect so it runs AFTER the render
  // that wrote the value — an imperative height set inside the input handler is
  // wiped by the very next render.
  let {
    input = $bindable(),
    cap,
    cliId,
    busy,
    chatPending,
    chatReady,
    onsend,
  }: {
    input: string;
    cap: number;
    cliId: string | null;
    busy: boolean;
    chatPending: boolean;
    chatReady: boolean;
    onsend: () => void;
  } = $props();

  let inputEl = $state<HTMLTextAreaElement | null>(null);

  // Clearing the input (after send) shrinks it back to one line.
  $effect(() => {
    const el = inputEl;
    const max = cap;
    const value = input;
    if (!el) return;
    el.style.height = "auto";
    if (value) el.style.height = `${Math.min(el.scrollHeight, max)}px`;
  });
</script>

<div class="border-t border-border p-3">
  <div class="flex items-end gap-2">
    <textarea
      bind:this={inputEl}
      bind:value={input}
      onkeydown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onsend();
        }
      }}
      placeholder={cliId ? "Ask anything…" : "Configure a CLI first"}
      rows={1}
      disabled={!cliId}
      style:max-height={`${cap}px`}
      class="flex-1 resize-none rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 disabled:opacity-50"
    ></textarea>
    <button
      type="button"
      onclick={onsend}
      disabled={busy || chatPending || !chatReady || !input.trim() || !cliId}
      class="rounded-xl bg-brand p-2 text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-40"
      aria-label="Send"
    >
      {#if busy}
        <Loader2 class="size-4 animate-spin" />
      {:else}
        <Send class="size-4" />
      {/if}
    </button>
  </div>
</div>
