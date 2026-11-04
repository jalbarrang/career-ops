<script lang="ts">
  import {
    AlertCircle,
    CheckCircle2,
    Clock,
    Edit3,
    Globe,
    Loader2,
    MoreVertical,
    Pause,
    Play,
    Trash2,
    Zap,
  } from "@lucide/svelte";
  import type { ScheduledJob } from "@/lib/scheduled-jobs";
  import { cn } from "@/lib/cn";
  import { instrumentSerif } from "@/lib/fonts";

  let {
    job,
    ontogglestatus,
    onedit,
    ondelete,
    onrunfinished,
  }: {
    job: ScheduledJob;
    ontogglestatus: (id: string, currentStatus: string) => void;
    onedit: (job: ScheduledJob) => void;
    ondelete: (id: string) => void;
    onrunfinished: () => void;
  } = $props();

  let running = $state(false);
  let runMessage = $state<string | null>(null);
  let menuOpen = $state(false);
  let menuRef = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!menuOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef && !menuRef.contains(e.target as Node)) {
        menuOpen = false;
      }
    }
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") menuOpen = false;
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  });

  async function handleRunNow(): Promise<void> {
    running = true;
    runMessage = null;

    try {
      const res = await fetch(`/api/scheduled-jobs/${job.id}/run`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as { error?: string; rolesFound?: number };
      if (!res.ok) throw new Error(data.error || "Run failed");

      runMessage = ` Completed! Found ${data.rolesFound || 0} matching roles.`;
      onrunfinished();
    } catch (err) {
      runMessage = ` Error: ${err instanceof Error ? err.message : "Run failed"}`;
    } finally {
      running = false;
    }
  }

  const isFull = $derived(job.engine === "full");
  const isActive = $derived(job.status === "active");
  const positiveList = $derived(job.filters?.positive || []);
  const letter = $derived((job.name || "S").trim().charAt(0).toUpperCase());
</script>

<div
  class="co-rise group flex min-w-0 flex-col justify-between h-full gap-2.5 rounded-xl border border-border bg-surface/40 p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-sm"
>
  <div class="space-y-2.5">
    <!-- Top Header: Logo + Title + 3-Dots Menu -->
    <div class="flex items-start gap-3">
      <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-sm font-semibold text-brand">
        {letter}
      </div>
      <div class="min-w-0 flex-1">
        <h3
          class="{instrumentSerif.className} truncate text-[17px] leading-tight text-foreground transition-colors group-hover:text-brand"
        >
          {job.name}
        </h3>
        <p class="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted">
          <Clock class="size-3.5 text-faint" />
          Every {job.every}
          {job.unit} · {job.timezone}
        </p>
      </div>

      <!-- 3-Dots Dropdown Menu -->
      <div class="relative shrink-0" bind:this={menuRef}>
        <button
          type="button"
          onclick={() => (menuOpen = !menuOpen)}
          aria-label={`Options for ${job.name}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          class="rounded p-1 text-faint transition-colors hover:bg-surface-hover hover:text-foreground"
          title="Options"
        >
          <MoreVertical class="size-4" />
        </button>

        {#if menuOpen}
          <div
            role="menu"
            class="absolute right-0 top-full z-20 mt-1 w-36 overflow-hidden rounded-xl border border-border bg-surface shadow-xl backdrop-blur-md animate-in fade-in zoom-in-95"
          >
            <button
              type="button"
              role="menuitem"
              onclick={() => {
                menuOpen = false;
                onedit(job);
              }}
              class="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-brand-soft hover:text-brand"
            >
              <Edit3 class="size-3.5" /> Edit Scan
            </button>
            <button
              type="button"
              role="menuitem"
              onclick={() => {
                menuOpen = false;
                ondelete(job.id);
              }}
              class="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium text-rose-500 transition-colors hover:bg-rose-500/10"
            >
              <Trash2 class="size-3.5" /> Delete Scan
            </button>
          </div>
        {/if}
      </div>
    </div>

    <!-- Engine & Status Badges -->
    <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
      <span
        class={cn(
          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium",
          isFull
            ? "border-brand/30 bg-brand-soft/60 text-brand"
            : "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        )}
      >
        {#if isFull}<Globe class="size-3" />{:else}<Zap class="size-3" />{/if}
        {isFull ? "Full ATS Sweep" : "Zero-Token Portals"}
      </span>

      <span
        class={cn(
          "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-medium",
          isActive
            ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
            : "border-border bg-surface-hover text-muted",
        )}
      >
        <span class={cn("size-1.5 rounded-full", isActive ? "bg-emerald-500" : "bg-zinc-400")}></span>
        {job.status}
      </span>
    </div>

    <!-- Keywords clamped to max 2 lines -->
    {#if positiveList.length > 0}
      <div class="max-h-12 overflow-hidden flex flex-wrap items-center gap-1.5 text-[11px]">
        <span class="text-faint shrink-0">matched:</span>
        {#each positiveList as kw, i (i)}
          <span class="rounded border border-border px-1.5 py-0.5 font-medium text-muted truncate max-w-[140px]">{kw}</span>
        {/each}
      </div>
    {/if}

    <!-- Last Run & Status Message -->
    <div class="text-[12px]">
      {#if job.lastError}
        <p class="flex items-start gap-1.5 text-rose-500">
          <AlertCircle class="mt-0.5 size-3 shrink-0" />
          <span class="truncate">Last error: {job.lastError}</span>
        </p>
      {:else if job.lastRunAt}
        <p class="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 class="size-3.5 shrink-0" />
          Last run {new Date(job.lastRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ·{" "}
          {job.rolesFoundCount || 0} roles found
        </p>
      {:else}
        <p class="text-faint">No runs recorded yet</p>
      {/if}
      {#if runMessage}<p class="mt-1 font-medium text-brand">{runMessage}</p>{/if}
    </div>
  </div>

  <!-- Action Buttons Row pinned to bottom -->
  <div class="mt-auto pt-2 flex items-center gap-2 border-t border-border/40">
    <button
      type="button"
      onclick={() => void handleRunNow()}
      disabled={running}
      class="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-brand/30 px-2.5 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft disabled:opacity-50 max-sm:min-h-[44px]"
    >
      {#if running}<Loader2 class="size-3.5 animate-spin" />{:else}<Zap class="size-3.5" />{/if}
      {running ? "Scanning…" : "Run now"}
    </button>

    <button
      type="button"
      onclick={() => ontogglestatus(job.id, job.status)}
      class={cn(
        "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-2 text-xs font-medium transition-colors max-sm:min-h-[44px]",
        isActive
          ? "bg-surface-hover text-foreground hover:bg-brand-soft hover:text-brand"
          : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      )}
    >
      {#if isActive}<Pause class="size-3.5" />{:else}<Play class="size-3.5" />{/if}
      {isActive ? "Pause" : "Resume"}
    </button>
  </div>
</div>
