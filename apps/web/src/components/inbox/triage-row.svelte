<script module lang="ts">
  export type RowScore = { score: number | null; tone: "good" | "warn" | "bad" | "muted"; jobId: string; running: boolean };
</script>

<script lang="ts">
  import { Bookmark, BookmarkCheck, Loader2, X } from "@lucide/svelte";
  import type { InboxJob } from "@/lib/career-ops";
  import type { AtsSource } from "@/lib/explore";
  import { ATS_LABEL } from "@/lib/explore";
  import { Badge } from "@/components/ui/badge";
  import CompanyLogo from "@/components/company-logo.svelte";
  import { cn } from "@/lib/cn";

  function agoLabel(age: number | null): string | null {
    if (age == null) return null;
    if (age <= 0) return "today";
    if (age === 1) return "yesterday";
    if (age < 7) return `${age}d ago`;
    if (age < 30) return `${Math.floor(age / 7)}w ago`;
    return `${Math.floor(age / 30)}mo ago`;
  }

  // One raw posting in the triage list. Shows ONLY cheap, free signals + an honest
  // "not scored" (CRUDA) — never a fake match%. Once its shortlist eval finishes it
  // flips to EVALUADA (a real A–F badge). Save→shortlist / Skip→hidden are free + undoable.
  let {
    job,
    source,
    age,
    scored,
    selected,
    shortlisted,
    onToggleSelect,
    onSave,
    onSkip,
  }: {
    job: InboxJob;
    source: AtsSource | null;
    age: number | null;
    scored?: RowScore;
    selected: boolean;
    shortlisted: boolean;
    onToggleSelect: () => void;
    onSave: () => void;
    onSkip: () => void;
  } = $props();

  const ago = $derived(agoLabel(age));
  const evaluated = $derived(!!scored && (scored.running || scored.score != null));
</script>

<li
  class={cn(
    "flex items-center gap-2.5 px-3 py-2.5 transition-colors sm:gap-3 sm:px-4",
    selected ? "bg-brand-soft/50" : "hover:bg-surface-hover",
    evaluated && "opacity-95",
  )}
>
  <!-- multi-select — power-user batch to shortlist -->
  <input
    type="checkbox"
    checked={selected}
    onchange={onToggleSelect}
    aria-label={`Select ${job.company} ${job.role}`}
    class="size-4 shrink-0 accent-brand max-sm:min-h-[44px] max-sm:min-w-[24px]"
  />

  <CompanyLogo name={job.company} size={20} />

  <div class="min-w-0 flex-1">
    <p class="truncate text-sm">
      <span class="font-medium text-foreground">{job.company}</span>
      <span class="text-muted"> · {job.role}</span>
    </p>
    <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
      {#if job.location}<span class="truncate">{job.location}</span>{/if}
      {#if source}<span class="rounded bg-surface-hover px-1 py-px font-medium text-muted">{ATS_LABEL[source]}</span>{/if}
      {#if ago}<span>{ago}</span>{/if}
      <!-- 🔴 CRUDA: honest "not scored" — no fabricated match%. -->
      {#if !evaluated}<span class="italic text-muted">not scored</span>{/if}
    </p>
  </div>

  <!-- EVALUADA state (right-aligned, visually distinct from raw rows) -->
  {#if scored && evaluated}
    <a href={`/jobs/${scored.jobId}`} class="flex shrink-0 items-center gap-1.5 text-xs">
      {#if scored.running}
        <Loader2 class="size-3.5 animate-spin text-brand" />
        <span class="text-brand max-sm:hidden">Scoring…</span>
      {:else}
        <Badge tone={scored.tone}>{scored.score}/5</Badge>
      {/if}
    </a>
  {:else}
    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        onclick={onSave}
        title={shortlisted ? "In your shortlist" : "Save to shortlist"}
        aria-pressed={shortlisted}
        class={cn(
          "inline-flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors max-sm:min-h-[44px] max-sm:min-w-[44px]",
          shortlisted ? "text-brand" : "text-muted hover:bg-surface-hover hover:text-brand",
        )}
      >
        {#if shortlisted}<BookmarkCheck class="size-4" />{:else}<Bookmark class="size-4" />{/if}
        <span class="max-sm:hidden">{shortlisted ? "Saved" : "Save"}</span>
      </button>
      <button
        type="button"
        onclick={onSkip}
        title="Skip — hide from the inbox"
        class="inline-flex items-center justify-center rounded-md p-1 text-faint transition-colors hover:bg-surface-hover hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
      >
        <X class="size-4" />
      </button>
    </div>
  {/if}
</li>
