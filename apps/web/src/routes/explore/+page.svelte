<script lang="ts">
  import { onMount } from "svelte";
  import type { PageData } from "./$types";
  import { provideExplore } from "@/lib/explore.svelte";
  import ExplorerView from "@/components/explore/explorer-view.svelte";

  let { data }: { data: PageData } = $props();

  // One explore store for the page, created per render and handed down through
  // context (the SvelteKit equivalent of the old ExploreProvider).
  const explore = provideExplore();

  // Restore the last settled result set (per-tab sessionStorage). On mount, not in
  // an initializer: the server has no sessionStorage and the markup must match.
  onMount(() => {
    explore.hydrate();
  });

  // Persist only SETTLED states (never mid-stream) so a reload restores a complete
  // set. Reading each field here is what makes the write follow a change;
  // persist() itself skips every phase that has no complete result behind it.
  $effect(() => {
    explore.phase;
    explore.mode;
    explore.offers;
    explore.matchCount;
    explore.companiesScanned;
    explore.companiesAvailable;
    explore.capHit;
    explore.droppedNoDate;
    explore.sources;
    explore.partial;
    explore.status;
    explore.error;
    explore.scannerMissing;
    explore.added;
    explore.aiTrace;
    explore.aiCost;
    explore.aiIntent;
    explore.persist();
  });
</script>

<ExplorerView seed={data.seed} inboxSnapshot={data.inboxSnapshot} appsSnapshot={data.appsSnapshot} rootExists={data.rootExists} />
