<script lang="ts">
  import { onMount } from "svelte";
  import { AlertTriangle, Check, Loader2 } from "@lucide/svelte";
  import type { Job } from "@/lib/jobs.svelte";
  import { TONE, pillTone } from "@/lib/jobs-tone";
  import { jobErrorHint } from "@/lib/job-error-hint.ts";
  import { cn } from "@/lib/cn";
  import { isFencingNotice } from "@/lib/cli-fencing.ts";
  import type { Snippet } from "svelte";

  // Humanize raw agent tool names into what the user actually cares about, so a
  // multi-minute evaluation reads as progress instead of a cryptic tool dump (#8).
  const STEP_LABELS: Record<string, string> = {
    WebFetch: "Reading the posting",
    WebSearch: "Searching the web",
    Read: "Reading your CV & profile",
    Glob: "Looking through your files",
    Grep: "Looking through your files",
    Write: "Writing the report",
    Edit: "Updating the report",
    NotebookEdit: "Updating the report",
    Bash: "Saving to your tracker",
    TodoWrite: "Planning the steps",
    Task: "Working",
  };
  const humanizeStep = (label: string): string => STEP_LABELS[label] ?? label;

  // The unfenced-runtime notice is emitted as the run's FIRST step, before the
  // CLI produces any output — and this card renders only the newest step, so it
  // would be displaced within a second of the run starting. Scan the whole list
  // instead and render it in the sticky slot below, the same shape jobErrorHint
  // already uses. Returns the notice ITSELF, not a boolean: a card that matched
  // either shape and then printed one hardcoded sentence told a sandboxed Codex
  // run it "ran with its default access", which is false (#2507).
  function fencingNotice(job: Job): string | undefined {
    return job.steps.find((s) => isFencingNotice(s.label))?.label;
  }

  const fmtElapsed = (ms: number): string => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const fmtTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

  // The ONE worker card — a pure function of a Job. Rendered in three surfaces:
  // the sidebar tray (variant="tray", inside WorkerPills' link), inline in the
  // assistant chat (variant="inline"), and conceptually the /jobs/[id] timeline.
  let {
    job,
    variant = "tray",
    trailing,
  }: { job: Job; variant?: "tray" | "inline"; trailing?: Snippet } = $props();

  const tone = $derived(TONE[pillTone(job)]);
  const running = $derived(job.status === "running");
  const inline = $derived(variant === "inline");
  const hasScore = $derived(job.result?.score != null);
  const errorHint = $derived(jobErrorHint(job));
  const fencing = $derived(fencingNotice(job));
  const tokens = $derived(job.status === "done" ? (job.cost?.tokens ?? 0) : 0);

  // Tick once a second WHILE running so a long evaluation visibly counts up
  // (never looks frozen). Stops re-rendering as soon as the job settles.
  let now = $state<number | null>(null);
  onMount(() => {
    if (!running) return;
    now = Date.now();
    const t = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(t);
  });
  const elapsed = $derived(Math.max(0, (now ?? job.startedAt) - job.startedAt));

  const rawLast = $derived(job.steps[job.steps.length - 1]?.label);
  const last = $derived(rawLast ? humanizeStep(rawLast) : undefined);
  const bottom = $derived(job.status === "done" && job.result?.summary ? job.result.summary : last);
</script>

<div class={cn(inline && "rounded-xl border border-border bg-surface/60 p-2.5")}>
  <div class="flex items-center gap-2">
    {#if job.status === "running"}
      <Loader2 class="size-3 shrink-0 animate-spin text-brand" />
    {:else if job.status === "error"}
      <AlertTriangle class={cn("size-3 shrink-0", tone.icon)} />
    {:else}
      <Check class={cn("size-3 shrink-0", tone.icon)} />
    {/if}
    <span class={cn("truncate font-medium", inline ? "text-sm" : "text-xs")}>{job.title}</span>
    {#if hasScore}
      <span class={cn("ml-auto shrink-0 rounded px-1 py-0.5 font-semibold tabular-nums", inline ? "text-xs" : "text-[10px]", tone.chip)}>
        {job.result?.score}
      </span>
    {/if}
    {#if trailing}
      <span class={cn("shrink-0", hasScore ? "ml-1" : "ml-auto")}>{@render trailing()}</span>
    {/if}
  </div>
  <div class={cn("mt-1.5 w-full overflow-hidden rounded-full bg-surface-hover", inline ? "h-1.5" : "h-1")}>
    {#if running}
      <div class="job-indeterminate h-full w-full"></div>
    {:else}
      <div class={cn("h-full w-full rounded-full", tone.bar)}></div>
    {/if}
  </div>
  {#if bottom || running}
    <div class={cn("mt-1 truncate text-faint", inline ? "text-xs" : "text-[10px]")}>
      {running ? `${last ?? "Working"} · ${fmtElapsed(elapsed)}` : bottom}
    </div>
  {/if}
  {#if errorHint}
    <div class={cn("mt-1 text-amber-700 dark:text-amber-400", inline ? "text-xs" : "text-[10px]")}>
      {errorHint.text}
    </div>
  {/if}
  {#if fencing}
    <div class={cn("mt-1 text-amber-700 dark:text-amber-400", inline ? "text-xs" : "text-[10px]")}>
      {fencing}
    </div>
  {/if}
  {#if tokens > 0}
    <div class={cn("mt-1 text-faint tabular-nums", inline ? "text-xs" : "text-[10px]")}>
      {fmtTokens(tokens)} tokens{#if job.cost?.usd != null} · ${job.cost.usd.toFixed(2)}{/if}
    </div>
  {/if}
</div>
