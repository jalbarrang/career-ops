<script lang="ts">
  import { onMount } from "svelte";
  import {
    CalendarClock,
    CalendarPlus,
    CheckCircle2,
    Clock,
    History,
    Layers,
    Loader2,
    RefreshCw,
    Search,
    Sparkles,
    Zap,
  } from "@lucide/svelte";
  import CreateJobModal from "./scheduled-scans/create-job-modal.svelte";
  import EditJobModal from "./scheduled-scans/edit-job-modal.svelte";
  import JobCard from "./scheduled-scans/job-card.svelte";
  import RunHistoryDrawer from "./scheduled-scans/run-history-drawer.svelte";
  import type { ScheduledJob, JobRun } from "@/lib/scheduled-jobs";
  import { instrumentSerif } from "@/lib/fonts";
  import { updateScheduledJobRequest } from "@/lib/scheduled-job-client.ts";
  import { isSchedulerStatusPayload } from "@/lib/scheduled-scheduler-status.ts";

  type Store = { jobs: ScheduledJob[]; runs: JobRun[] };
  type SchedulerStatus = {
    platform: "win32" | "darwin" | "linux" | string;
    available: boolean;
    running: boolean;
    task: { exists: boolean; enabled: boolean; nextRun: string | null; lastRun: string | null };
  };

  function formatTaskTime(value: string | null) {
    if (!value) return "Not reported";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  }

  let store = $state<Store>({ jobs: [], runs: [] });
  let scheduler = $state<SchedulerStatus | null>(null);
  let loading = $state(false);
  let filterTab = $state<"all" | "active" | "paused">("all");
  let searchQuery = $state("");
  let createModalOpen = $state(false);
  let historyDrawerOpen = $state(false);
  let editingJob = $state<ScheduledJob | null>(null);
  let osRunning = $state(false);
  let error = $state<string | null>(null);

  async function loadData(): Promise<void> {
    loading = true;
    error = null;
    try {
      const [jobsResponse, schedulerResponse] = await Promise.all([
        fetch("/api/scheduled-jobs", { cache: "no-store" }),
        fetch("/api/scheduler", { cache: "no-store" }),
      ]);
      const resJobs = (await jobsResponse.json().catch(() => ({}))) as {
        jobs?: ScheduledJob[];
        runs?: JobRun[];
        error?: string;
      };
      const resScheduler = (await schedulerResponse.json().catch(() => null)) as
        | (SchedulerStatus & { error?: string })
        | null;
      if (!jobsResponse.ok) throw new Error(resJobs.error || "Could not load scheduled scans.");
      if (!schedulerResponse.ok && resScheduler?.error) error = resScheduler.error;
      store = {
        jobs: Array.isArray(resJobs.jobs) ? resJobs.jobs : [],
        runs: Array.isArray(resJobs.runs) ? resJobs.runs : [],
      };
      if (schedulerResponse.ok && isSchedulerStatusPayload(resScheduler)) scheduler = resScheduler;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not load scheduled scans.";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void loadData();
  });

  async function handleToggleStatus(id: string, currentStatus: string): Promise<void> {
    const nextStatus = currentStatus === "active" ? "paused" : "active";
    try {
      await updateScheduledJobRequest(id, { status: nextStatus });
      await loadData();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not update scheduled scan.";
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (!confirm("Are you sure you want to delete this scheduled scan?")) return;
    try {
      const response = await fetch(`/api/scheduled-jobs/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        error = body.error || "Could not delete scheduled scan.";
        return;
      }
      await loadData();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not delete scheduled scan.";
    }
  }

  async function handleTriggerOsScheduler(): Promise<void> {
    osRunning = true;
    try {
      const response = await fetch("/api/scheduler", { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(body.error || "Could not start scheduler.");
      await loadData();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not start scheduler.";
    } finally {
      osRunning = false;
    }
  }

  const jobsList = $derived(store.jobs.filter((j) => j.status !== "deleted"));
  const activeJobs = $derived(jobsList.filter((j) => j.status === "active"));
  const pausedJobs = $derived(jobsList.filter((j) => j.status === "paused"));

  const filteredJobs = $derived(
    jobsList
      .filter((j) => {
        if (filterTab === "active") return j.status === "active";
        if (filterTab === "paused") return j.status === "paused";
        return true;
      })
      .filter((j) => {
        if (!searchQuery.trim()) return true;
        const q = searchQuery.toLowerCase();
        return (
          j.name.toLowerCase().includes(q) || (j.filters?.positive || []).some((kw) => kw.toLowerCase().includes(q))
        );
      }),
  );

  const totalRuns = $derived(store.runs.length);
  const successRuns = $derived(store.runs.filter((r) => r.state === "success").length);
  const failedRuns = $derived(store.runs.filter((r) => r.state === "failed").length);
  const totalRolesFound = $derived(store.runs.reduce((acc, r) => acc + (r.rolesFound || 0), 0));
  const successRate = $derived(totalRuns > 0 ? Math.round((successRuns / totalRuns) * 100) : 100);
</script>

{#snippet statCard(label: string, value: string | number, subtitle: string, Icon: typeof Zap, iconClass: string)}
  <div
    class="co-rise flex items-center justify-between rounded-xl border border-border bg-surface/40 p-4 shadow-sm transition-all hover:border-brand/30 hover:shadow-md"
  >
    <div>
      <span class="text-xs font-medium text-muted">{label}</span>
      <div class="mt-1 text-2xl font-bold tracking-tight text-foreground">{value}</div>
      <div class="mt-0.5 text-[11px] text-faint">{subtitle}</div>
    </div>
    <div class="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
      <Icon class={iconClass} />
    </div>
  </div>
{/snippet}

<div class="mx-auto max-w-5xl px-5 py-8 md:px-8 space-y-8">
  <!-- Header matching Explore & Portals format -->
  <div class="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
    <div>
      <div class="flex items-center gap-2.5">
        <CalendarClock class="size-6 text-brand" />
        <h1 class="{instrumentSerif.className} text-3xl text-foreground">Scheduled Scans</h1>
      </div>
      <p class="mt-1.5 max-w-2xl text-sm text-muted">
        Persistent, automated crawler jobs supporting Zero-Token and Full ATS Dataset sweeps.
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        onclick={() => (createModalOpen = true)}
        class="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground shadow-lg transition-all hover:bg-brand-200"
      >
        <CalendarPlus class="size-4" />
        New Scheduled Scan
      </button>
      <button
        type="button"
        onclick={() => (historyDrawerOpen = true)}
        class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface/60 px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
      >
        <History class="size-4 text-brand" />
        Run Logs ({store.runs.length})
      </button>
      <button
        type="button"
        onclick={() => void loadData()}
        disabled={loading}
        class="inline-flex size-9 items-center justify-center rounded-full border border-border bg-surface/60 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        title="Refresh list"
      >
        <RefreshCw class="size-4 {loading ? 'animate-spin text-brand' : ''}" />
      </button>
    </div>
  </div>
  {#if error}
    <div role="alert" class="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-600 dark:text-rose-400">
      {error}
    </div>
  {/if}

  <!-- Stats Cards -->
  <div class="grid gap-3.5 sm:grid-cols-4">
    {@render statCard("Active Scans", activeJobs.length, `${jobsList.length} total jobs`, Zap, "size-4 text-emerald-500")}
    {@render statCard("Executed Runs", totalRuns, `${successRuns} successful`, Layers, "size-4 text-brand")}
    {@render statCard("Roles Discovered", totalRolesFound, "Pushed to pipeline", Sparkles, "size-4 text-amber-500")}
    {@render statCard("Success Rate", `${successRate}%`, `${failedRuns} failed runs`, CheckCircle2, "size-4 text-emerald-500")}
  </div>

  <!-- OS Task Scheduler Banner -->
  {#if scheduler}
    <div class="co-rise rounded-2xl border border-border bg-surface/40 p-4 shadow-sm backdrop-blur-sm">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-3">
          <div class="grid size-9 place-items-center rounded-xl bg-surface-hover text-brand">
            <Clock class="size-5" />
          </div>
          <div>
            <div class="flex items-center gap-2 text-sm font-semibold text-foreground">
              {scheduler.platform === "win32" ? "Windows Task Scheduler Integration" : "Manual scans"}
              <span
                class={scheduler.task.exists && scheduler.task.enabled
                  ? "rounded bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400"
                  : "rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:text-amber-300"}
              >
                {scheduler.platform !== "win32"
                  ? "No automatic schedule"
                  : scheduler.task.exists
                    ? scheduler.task.enabled
                      ? "Task enabled"
                      : "Task disabled"
                    : "Task not installed"}
              </span>
            </div>
            <div class="mt-0.5 text-xs text-muted">
              {scheduler.platform !== "win32"
                ? "On macOS and Linux, saved scans only run when you choose Run now."
                : scheduler.task.exists
                  ? "Next OS check: " +
                    formatTaskTime(scheduler.task.nextRun) +
                    " · Last OS check: " +
                    formatTaskTime(scheduler.task.lastRun)
                  : "Install the Windows task with web/scripts/install-scan-schedule.ps1 to run due jobs automatically."}
            </div>
          </div>
        </div>
        {#if scheduler.platform === "win32"}
          <button
            type="button"
            onclick={() => void handleTriggerOsScheduler()}
            disabled={osRunning || scheduler.running || !scheduler.available}
            class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            {#if osRunning}
              <Loader2 class="size-3.5 animate-spin text-brand" />
            {:else}
              <Zap class="size-3.5 text-brand" />
            {/if}
            {osRunning ? "Checking..." : "Check due jobs now"}
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <!-- Filter Tabs & Search -->
  <div class="flex flex-wrap items-center justify-between gap-3">
    <div class="flex items-center gap-1 rounded-full border border-border bg-surface/60 p-1">
      <button
        type="button"
        onclick={() => (filterTab = "all")}
        class="rounded-full px-3.5 py-1 text-xs font-medium transition-colors {filterTab === 'all'
          ? 'bg-brand text-brand-foreground shadow'
          : 'text-muted hover:text-foreground'}"
      >
        All Scans ({jobsList.length})
      </button>
      <button
        type="button"
        onclick={() => (filterTab = "active")}
        class="rounded-full px-3.5 py-1 text-xs font-medium transition-colors {filterTab === 'active'
          ? 'bg-brand text-brand-foreground shadow'
          : 'text-muted hover:text-foreground'}"
      >
        Active ({activeJobs.length})
      </button>
      <button
        type="button"
        onclick={() => (filterTab = "paused")}
        class="rounded-full px-3.5 py-1 text-xs font-medium transition-colors {filterTab === 'paused'
          ? 'bg-brand text-brand-foreground shadow'
          : 'text-muted hover:text-foreground'}"
      >
        Paused ({pausedJobs.length})
      </button>
    </div>

    <div class="relative min-w-[200px]">
      <Search class="absolute left-3 top-2.5 size-3.5 text-faint" />
      <input
        type="text"
        value={searchQuery}
        oninput={(e) => (searchQuery = e.currentTarget.value)}
        placeholder="Search scans or keywords…"
        class="w-full rounded-full border border-border bg-surface/60 pl-8 pr-3 py-1.5 text-xs text-foreground outline-none focus:border-brand/60"
      />
    </div>
  </div>

  <!-- Jobs Grid -->
  {#if filteredJobs.length === 0}
    <div class="rounded-2xl border border-dashed border-border p-12 text-center">
      <CalendarClock class="mx-auto size-8 text-faint" />
      <h3 class="mt-3 text-sm font-semibold text-foreground">No scheduled scans found</h3>
      <p class="mt-1 text-xs text-muted">Create a new scan to start automatically discovering matching jobs.</p>
      <button
        type="button"
        onclick={() => (createModalOpen = true)}
        class="mt-4 inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-xs font-medium text-brand-foreground shadow"
      >
        <CalendarPlus class="size-3.5" /> New Scheduled Scan
      </button>
    </div>
  {:else}
    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {#each filteredJobs as job (job.id)}
        <JobCard
          {job}
          ontogglestatus={(id, currentStatus) => void handleToggleStatus(id, currentStatus)}
          onedit={(j) => (editingJob = j)}
          ondelete={(id) => void handleDelete(id)}
          onrunfinished={() => void loadData()}
        />
      {/each}
    </div>
  {/if}

  <!-- Create Modal, Edit Modal & History Drawer -->
  <CreateJobModal isopen={createModalOpen} onclose={() => (createModalOpen = false)} oncreated={() => void loadData()} />

  <EditJobModal
    job={editingJob}
    isopen={!!editingJob}
    onclose={() => (editingJob = null)}
    onupdated={() => void loadData()}
  />

  <RunHistoryDrawer isopen={historyDrawerOpen} onclose={() => (historyDrawerOpen = false)} runs={store.runs} />
</div>
