<script lang="ts">
  import { History, X } from "@lucide/svelte";
  import { page } from "$app/state";
  import { useJobs } from "@/lib/jobs.svelte";
  import WorkerCard from "@/components/jobs/worker-card.svelte";
  import { cn } from "@/lib/cn";
  import { m } from "@/lib/paraglide/messages";

  // Collapsed "worker" pills in the sidebar — each the shared <WorkerCard> wrapped
  // in a link to its detail. Same component the assistant chat renders inline.
  const store = useJobs();
  const jobs = $derived(store.jobs);
  const running = $derived(jobs.filter((j) => j.status === "running").length);
  const finished = $derived(jobs.length - running);
</script>

{#if jobs.length > 0}
  <div class="mt-4 border-t border-border pt-3">
    <div class="mb-2 flex items-center gap-2 px-1">
      <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">{m.shell_workers()}</span>
      {#if running > 0}<span class="text-[10px] tabular-nums text-brand">{m.shell_worker_running({ count: running })}</span>{/if}
      <a href="/jobs" class="ml-auto text-faint transition-colors hover:text-foreground" title={m.shell_worker_history()} aria-label={m.shell_worker_history()}>
        <History class="size-3.5" />
      </a>
      {#if finished > 0}
        <button
          onclick={() => store.clearFinished()}
          class="text-[10px] text-faint transition-colors hover:text-foreground"
          title={m.shell_worker_clear()}>{m.shell_worker_clear()}</button
        >
      {/if}
    </div>
    <ul class="space-y-1.5">
      {#each jobs.slice(0, 6) as j (j.id)}
        {@const active = page.url.pathname === `/jobs/${j.id}`}
        <li>
          <a
            href="/jobs/{j.id}"
            class={cn(
              "group block rounded-lg border px-2.5 py-2 transition-colors",
              active ? "border-brand/50 bg-brand-soft" : "border-border bg-surface/60 hover:bg-surface-hover",
            )}
          >
            <WorkerCard job={j} variant="tray">
              {#snippet trailing()}
                <button
                  onclick={(e) => {
                    e.preventDefault();
                    store.removeJob(j.id);
                  }}
                  class="text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground"
                  aria-label="Dismiss job"
                >
                  <X class="size-3" />
                </button>
              {/snippet}
            </WorkerCard>
          </a>
        </li>
      {/each}
    </ul>
  </div>
{/if}
