<script lang="ts">
  import { ArrowUpRight, Sparkles } from "@lucide/svelte";
  import WorkerCard from "@/components/jobs/worker-card.svelte";
  import { renderMarkdown } from "@/lib/markdown";
  import type { Job } from "@/lib/jobs.svelte";
  import type { Part } from "@/components/assistant/envelope";

  // ── part renderers ──
  // Split out of the console (it was a plain `PartView` function there) so the
  // 700-line component stays about streaming and conversation state.
  let {
    part,
    jobs,
    onConfirm,
  }: {
    part: Part;
    jobs: Job[];
    onConfirm: (cid: string, accept: boolean) => void;
  } = $props();

  const cardJob = $derived(part.type === "card" ? jobs.find((j) => j.id === part.jobId) : undefined);

  // Batch children resolve through the live store, so a card that finishes while
  // the message sits on screen re-renders as done without touching the message.
  const batchJobs = $derived(
    part.type === "batch" ? part.jobIds.map((id) => jobs.find((j) => j.id === id)).filter((j): j is Job => !!j) : [],
  );
  const batchDone = $derived(batchJobs.filter((j) => j.status === "done").length);
</script>

{#if part.type === "text"}
  {#if part.text.trim()}
    <div class="report-prose text-sm [&_*]:my-1 [&>:first-child]:mt-0 [&>:last-child]:mb-0">
      {@html renderMarkdown(part.text)}
    </div>
  {/if}
{:else if part.type === "note"}
  <div class="text-xs italic text-faint">{part.text}</div>
{:else if part.type === "card"}
  {#if cardJob}
    <WorkerCard job={cardJob} variant="inline">
      {#snippet trailing()}
        <a href={`/jobs/${cardJob.id}`} class="text-faint transition-colors hover:text-brand" aria-label="Open worker">
          <ArrowUpRight class="size-3.5" />
        </a>
      {/snippet}
    </WorkerCard>
  {:else}
    <a href={`/jobs/${part.jobId}`} class="block rounded-xl border border-border bg-surface/40 p-2.5 text-xs text-faint hover:text-foreground">
      Worker finished earlier — open log →
    </a>
  {/if}
{:else if part.type === "batch"}
  <div class="rounded-xl border border-border bg-surface/40 p-2.5">
    <div class="mb-1.5 flex items-center gap-1.5 text-xs font-medium">
      <Sparkles class="size-3.5 text-brand" />
      {part.jobIds.length} evaluations
      <span class="ml-auto tabular-nums text-faint">{batchDone}/{part.jobIds.length} done</span>
    </div>
    <div class="space-y-1.5">
      {#each batchJobs as job (job.id)}
        <WorkerCard {job} variant="inline">
          {#snippet trailing()}
            <a href={`/jobs/${job.id}`} class="text-faint transition-colors hover:text-brand" aria-label="Open worker">
              <ArrowUpRight class="size-3.5" />
            </a>
          {/snippet}
        </WorkerCard>
      {/each}
    </div>
  </div>
{:else if part.type === "confirm"}
  <div class="rounded-xl border border-brand/40 bg-brand-soft p-2.5">
    <div class="text-xs font-medium text-foreground">{part.summary}</div>
    {#if part.state === "pending"}
      <div class="mt-2 flex gap-2">
        <button
          type="button"
          onclick={() => onConfirm(part.cid, true)}
          class="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200"
        >
          Confirm
        </button>
        <button
          type="button"
          onclick={() => onConfirm(part.cid, false)}
          class="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    {:else}
      <div class="mt-1 text-xs text-faint">{part.state === "done" ? "✓ started" : "cancelled"}</div>
    {/if}
  </div>
{/if}
