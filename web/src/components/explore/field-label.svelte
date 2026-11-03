<script lang="ts">
  import type { Snippet } from "svelte";

  // The small heading above every filter control: the label on the left, an
  // optional behavioural hint right-aligned beside it.
  let { children, hint }: { children?: Snippet; hint?: string } = $props();
</script>

<div class="mb-1.5 flex items-baseline justify-between gap-4">
  <span class="text-[13px] font-medium text-foreground">{@render children?.()}</span>
  {#if hint}<span class="ml-4 text-right text-[11px] text-faint">{hint}</span>{/if}
</div>
