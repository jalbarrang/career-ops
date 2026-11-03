<script lang="ts">
  import type { PageData } from "./$types";
  import ReportView from "@/components/report-view.svelte";

  // `params.id` resolves synchronously in SvelteKit, so the id the load already
  // resolved is what the view renders — no `use(params)` promise to unwrap.
  let { data }: { data: PageData } = $props();
</script>

<ReportView
  id={data.id}
  app={data.app}
  report={data.report}
  file={data.file}
  canDelete={data.canDelete}
  pdfReadyFromIndex={data.pdfReadyFromIndex}
  coverReady={data.coverReady}
/>
