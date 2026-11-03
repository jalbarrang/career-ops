<script lang="ts">
  import { CheckCircle2, XCircle, Clock, X, TerminalSquare, Loader2, Ban } from "@lucide/svelte";
  import type { JobRun } from "@/lib/scheduled-jobs";
  import { cn } from "@/lib/cn";
  import ScheduledOverlay from "./scheduled-overlay.svelte";
  import { runStatusTone } from "@/lib/scheduled-run-status.mjs";

  let { isopen, onclose, runs }: { isopen: boolean; onclose: () => void; runs: JobRun[] } = $props();

  let closeRef = $state<HTMLButtonElement | null>(null);
</script>

<ScheduledOverlay
  {isopen}
  {onclose}
  titleid="run-history-title"
  initialfocus={closeRef}
  variant="drawer"
>
  <div class="flex items-center justify-between border-b border-border p-4">
    <div class="flex items-center gap-2">
      <TerminalSquare class="size-5 text-brand" />
      <h2 id="run-history-title" class="text-base font-semibold text-foreground">Execution Run History</h2>
    </div>
    <button
      bind:this={closeRef}
      type="button"
      onclick={onclose}
      class="rounded-lg p-1.5 text-faint hover:bg-surface-hover hover:text-foreground"
    >
      <X class="size-5" />
    </button>
  </div>

  <div class="flex-1 overflow-y-auto p-4 space-y-3">
    {#if runs.length === 0}
      <div class="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
        No scan executions recorded yet.
      </div>
    {:else}
      {#each runs as run, i (`${run.id || "run"}-${i}`)}
        {@const isSuccess = run.state === "success"}
        {@const isRunning = run.state === "running"}
        {@const isQueued = run.state === "queued"}
        {@const isCancelled = run.state === "cancelled"}
        {@const tone = runStatusTone(run.state)}
        <div
          class="rounded-xl border border-border bg-surface/50 p-3.5 text-xs shadow-sm transition-colors hover:border-brand/30"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1.5 font-medium">
              {#if isSuccess}
                <CheckCircle2 class="size-4 text-emerald-500" />
              {:else if isRunning}
                <Loader2 class="size-4 animate-spin text-brand" />
              {:else if isQueued}
                <Clock class="size-4 text-amber-500" />
              {:else if isCancelled}
                <Ban class="size-4 text-muted" />
              {:else}
                <XCircle class="size-4 text-rose-500" />
              {/if}
              <span
                class={cn(
                  tone === "success" ? "text-emerald-600 dark:text-emerald-400" : tone === "failed" ? "text-rose-500" : "text-muted",
                )}
              >
                {isSuccess ? "Success" : isRunning ? "Running" : isQueued ? "Queued" : isCancelled ? "Cancelled" : "Failed"}
              </span>
              {#if run.engine}
                <span class="rounded bg-surface-hover px-1.5 py-0.5 text-[10px] text-faint uppercase font-mono">
                  {run.engine}
                </span>
              {/if}
            </div>
            <span class="flex items-center gap-1 text-[11px] text-faint">
              <Clock class="size-3" />
              {new Date(run.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
          </div>

          <p class="mt-2 text-muted leading-relaxed">{run.message || "Execution completed"}</p>

          <div class="mt-2 flex items-center justify-between text-[11px] text-faint border-t border-border/40 pt-1.5">
            <span>Date: {new Date(run.at).toLocaleDateString()}</span>
            {#if typeof run.rolesFound === "number"}
              <span class="font-semibold text-foreground">{run.rolesFound} roles found</span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</ScheduledOverlay>
