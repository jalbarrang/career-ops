<script lang="ts">
  import { useApply } from "@/lib/apply.svelte";
  import ApplyBackdrop from "@/components/apply/apply-backdrop.svelte";

  // Mounts the full-viewport apply wallpaper at the PAGE level (a sibling before
  // the content) so it sits behind everything — header + questions scroll over the
  // blurred form. Active only once a session is opening/processing/ready.
  const a = useApply();
</script>

{#if a.status !== "idle" && a.status !== "error"}
  <ApplyBackdrop image={a.shots[0]} intense={a.status === "opening" || a.status === "prefilling" || a.status === "filling"} />
{/if}
