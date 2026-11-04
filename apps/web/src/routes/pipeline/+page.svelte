<script lang="ts">
  import type { PageData } from "./$types";
  import PipelineView from "@/components/pipeline-view.svelte";

  // The tracker + inbox snapshot comes from the server load; every view control
  // (tab, score floor, sort, search) is read from the URL inside PipelineView.
  // The Next page's <Suspense> wrapper had no fallback, so there is nothing to
  // port for it: the load is awaited before this renders.
  let { data }: { data: PageData } = $props();
</script>

<PipelineView applications={data.applications} inbox={data.inbox} />
