<script lang="ts">
  import { onMount } from "svelte";

  // Honest, calming rotation of what the planner is actually doing, so the (~1-2min)
  // draft doesn't feel stalled. Crossfades every ~2.8s.
  const DRAFT_MSGS = [
    "Reading your CV…",
    "Reading the role and company…",
    "Matching your experience to each question…",
    "Writing every answer in your own voice…",
    "Flagging anything that needs your call…",
  ];

  let i = $state(0);
  onMount(() => {
    const t = setInterval(() => {
      i = (i + 1) % DRAFT_MSGS.length;
    }, 2800);
    return () => clearInterval(t);
  });
</script>

{#key i}
  <div class="co-rise truncate text-xs text-muted">{DRAFT_MSGS[i]}</div>
{/key}
