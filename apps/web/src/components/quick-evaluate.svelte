<script lang="ts">
  import { Sparkles } from "@lucide/svelte";
  import { useJobs } from "@/lib/jobs.svelte";
  import CostBadge from "@/components/cost/cost-badge.svelte";

  // Auto-pipeline, one click: paste a job URL → fire a real evaluation worker
  // (the same kind:"evaluate" that runs modes/oferta.md + writes the A–F report +
  // tracker row). The worker pills + assistant cards show progress.
  const store = useJobs();
  let url = $state("");
  let hint = $state("");

  function run(): void {
    const u = url.trim();
    if (!/^https?:\/\//i.test(u)) {
      hint = "Paste a full job-posting URL (https://…).";
      return;
    }
    store.startJob({ title: "Evaluate · pasted URL", subtitle: u, kind: "evaluate", input: u, page: "/" });
    url = "";
    hint = "Evaluating — watch it in the Workers tray.";
  }
</script>

<div class="mt-7">
  <div class="flex max-w-xl items-center gap-2 rounded-full border border-border bg-surface/70 py-1.5 pl-4 pr-1.5 shadow-sm focus-within:border-brand/50">
    <Sparkles class="size-4 shrink-0 text-brand/70" />
    <input
      value={url}
      oninput={(e) => {
        url = e.currentTarget.value;
        if (hint) hint = "";
      }}
      onkeydown={(e) => {
        if (e.key === "Enter") run();
      }}
      placeholder="Paste a job URL to evaluate…"
      class="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-faint"
    />
    <button
      onclick={run}
      class="shrink-0 rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
    >
      Evaluate
    </button>
  </div>
  <div class="mt-2 flex items-center gap-2">
    <CostBadge kind="spend" size="xs" />
    <span class="text-xs text-faint">Evaluation runs on your own AI — your key, your machine.</span>
  </div>
  {#if hint}<p class="mt-1 text-xs text-faint">{hint}</p>{/if}
</div>
