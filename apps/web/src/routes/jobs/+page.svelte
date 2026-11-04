<script lang="ts">
  import { Check, AlertTriangle, Loader2, Trash2 } from "@lucide/svelte";
  import { useJobs } from "@/lib/jobs.svelte";
  import { pillTone } from "@/lib/jobs-tone";
  import { cn } from "@/lib/cn";

  const TONE_CHIP = {
    good: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
    warn: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
    bad: "bg-red-500/15 text-red-700 dark:text-red-400",
    muted: "bg-surface-hover text-muted",
  } as const;

  // Worker history is client-only state (the jobs store), so this page has no
  // server load — it renders whatever the tab's store holds.
  const store = useJobs();
  const jobs = $derived(store.jobs);
  const hasFinished = $derived(jobs.some((j) => j.status !== "running"));
</script>

<div class="mx-auto max-w-4xl px-6 py-10">
  <div class="flex items-end justify-between">
    <div>
      <h1 class="font-display text-2xl tracking-tight text-landing">Workers</h1>
      <p class="mt-1 text-sm text-muted">
        Every evaluation you ran — a persistent log. <span class="tabular-nums">{jobs.length}</span> total.
      </p>
    </div>
    {#if hasFinished}
      <button
        onclick={() => store.clearFinished()}
        class="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <Trash2 class="size-3.5" /> Clear finished
      </button>
    {/if}
  </div>

  {#if jobs.length === 0}
    <div class="mt-8 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center text-sm text-muted">
      No workers yet. Hit <span class="text-foreground">Evaluate</span> on an inbox posting to spin one up.
    </div>
  {:else}
    <ul class="mt-6 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
      {#each jobs as j (j.id)}
        {@const tone = pillTone(j)}
        <li>
          <a href={`/jobs/${j.id}`} class="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover">
            {#if j.status === "running"}
              <Loader2 class="size-4 shrink-0 animate-spin text-brand" />
            {:else if j.status === "error"}
              <AlertTriangle class="size-4 shrink-0 text-red-400" />
            {:else}
              <Check class="size-4 shrink-0 text-emerald-500" />
            {/if}
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{j.title}</div>
              {#if j.subtitle || j.result?.summary}
                <div class="truncate text-xs text-muted">{j.result?.summary || j.subtitle}</div>
              {/if}
            </div>
            {#if j.result?.score != null}
              <span class={cn("shrink-0 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums", TONE_CHIP[tone])}>
                {j.result.score}/5
              </span>
            {/if}
            <span class="hidden shrink-0 text-xs capitalize text-faint sm:block">{j.status}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>
