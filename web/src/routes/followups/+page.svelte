<script lang="ts">
  import FollowupsView from "@/components/followups/followups-view.svelte";

  // The cadence verdict is computed fresh per request by the core engine and
  // fetched client-side (the Next page's `dynamic = "force-dynamic"` only opted
  // out of caching; SvelteKit has no equivalent for a client-rendered view).
</script>

<FollowupsView />
