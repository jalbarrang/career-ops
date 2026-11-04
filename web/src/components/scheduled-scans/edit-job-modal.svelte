<script lang="ts">
  import { Edit3, Loader2, X } from "@lucide/svelte";
  import type { ScheduledJob, ScanEngine } from "@/lib/scheduled-jobs";
  import { DEFAULT_FILTERS, type ExploreFilters } from "@/lib/explore";
  import FilterBuilder from "@/components/explore/filter-builder.svelte";
  import ScheduledOverlay from "./scheduled-overlay.svelte";
  import { cadenceMinimum, cadenceValueForUnit, updateScheduledJobRequest } from "@/lib/scheduled-job-client.ts";

  let {
    job,
    isopen,
    onclose,
    onupdated,
  }: { job: ScheduledJob | null; isopen: boolean; onclose: () => void; onupdated: () => void } = $props();

  let name = $state("");
  let engine = $state<ScanEngine>("full");
  let every = $state(6);
  let unit = $state<"minutes" | "hours" | "days">("hours");
  let filters = $state<ExploreFilters>({ ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats] });
  let submitting = $state(false);
  let error = $state("");
  let nameRef = $state<HTMLInputElement | null>(null);

  $effect(() => {
    if (job) {
      name = job.name || "";
      engine = job.engine || "full";
      every = job.every || 6;
      unit = job.unit || "hours";
      // Merge job's persisted filters on top of defaults so all fields are defined
      filters = {
        ...DEFAULT_FILTERS,
        ...job.filters,
        // Ensure arrays are never undefined
        positive: job.filters?.positive || [],
        negative: job.filters?.negative || [],
        allow: job.filters?.allow || [],
        block: job.filters?.block || [],
        alwaysAllow: job.filters?.alwaysAllow || [],
        ats: job.filters?.ats?.length ? [...job.filters.ats] : [...DEFAULT_FILTERS.ats],
      };
    }
  });

  async function handleSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!job) return;
    submitting = true;
    error = "";

    try {
      await updateScheduledJobRequest(job.id, {
        name,
        engine,
        every,
        unit,
        filters,
      });

      onupdated();
      onclose();
    } catch (err) {
      error = err instanceof Error ? err.message : "Error updating job";
    } finally {
      submitting = false;
    }
  }
</script>

<ScheduledOverlay {isopen} {onclose} titleid="edit-scheduled-scan-title" initialfocus={nameRef} panelclass="max-w-2xl">
  {#if job}
    <div class="flex items-center justify-between border-b border-border pb-4">
      <div class="flex items-center gap-2.5">
        <div class="grid size-9 place-items-center rounded-xl bg-brand-soft text-brand">
          <Edit3 class="size-5" />
        </div>
        <div>
          <h2 id="edit-scheduled-scan-title" class="text-lg font-semibold text-foreground">Edit Scheduled Scan</h2>
          <p class="text-xs text-muted">Update name, filters, schedule, and location scope.</p>
        </div>
      </div>
      <button
        type="button"
        onclick={onclose}
        class="rounded-lg p-1.5 text-faint transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <X class="size-5" />
      </button>
    </div>

    <form onsubmit={handleSubmit} class="mt-5 space-y-5">
      {#if error}<div class="rounded-xl border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-500">{error}</div>{/if}

      <!-- ─── Name + Engine + Cadence ─── -->
      <div>
        <label for="edit-scan-name" class="mb-1 block text-[13px] font-medium text-foreground">Scan Name</label>
        <input
          id="edit-scan-name"
          bind:this={nameRef}
          type="text"
          value={name}
          oninput={(e) => (name = e.currentTarget.value)}
          required
          class="w-full rounded-xl border border-border bg-surface-hover/60 px-3.5 py-2 text-sm text-foreground outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/20"
          placeholder="e.g. Roles matching my profile"
        />
      </div>

      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label for="edit-scan-engine" class="mb-1 block text-[13px] font-medium text-foreground">Scan Engine</label>
          <select
            id="edit-scan-engine"
            value={engine}
            onchange={(e) => (engine = e.currentTarget.value as ScanEngine)}
            class="w-full rounded-xl border border-border bg-surface-hover/60 px-3.5 py-2 text-sm text-foreground outline-none focus:border-brand/60"
          >
            <option value="full">Full ATS Dataset Sweep</option>
            <option value="portals">Zero-Token Portals.yml</option>
          </select>
        </div>

        <div>
          <label for="edit-scan-every" class="mb-1 block text-[13px] font-medium text-foreground">Repeat Cadence</label>
          <div class="flex gap-2">
            <input
              id="edit-scan-every"
              type="number"
              min={cadenceMinimum(unit)}
              value={every}
              oninput={(e) => (every = Math.max(cadenceMinimum(unit), Number(e.currentTarget.value)))}
              class="w-20 rounded-xl border border-border bg-surface-hover/60 px-3.5 py-2 text-sm text-foreground outline-none focus:border-brand/60"
            />
            <select
              value={unit}
              onchange={(e) => {
                const nextUnit = e.currentTarget.value as "minutes" | "hours" | "days";
                unit = nextUnit;
                every = cadenceValueForUnit(every, nextUnit);
              }}
              class="flex-1 rounded-xl border border-border bg-surface-hover/60 px-3.5 py-2 text-sm text-foreground outline-none focus:border-brand/60"
            >
              <option value="hours">Hours</option>
              <option value="days">Days</option>
              <option value="minutes">Minutes</option>
            </select>
          </div>
        </div>
      </div>

      <!-- ─── Reuse FilterBuilder from Explore ─── -->
      <div class="rounded-xl border border-border bg-surface/30 p-4">
        <FilterBuilder {filters} onchange={(f) => (filters = f)} />
      </div>

      <!-- ─── Actions ─── -->
      <div class="flex items-center justify-end gap-3 border-t border-border pt-4">
        <button
          type="button"
          onclick={onclose}
          class="rounded-xl border border-border px-4 py-2 text-xs font-medium text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          class="inline-flex items-center gap-2 rounded-xl bg-brand px-4 py-2 text-xs font-medium text-brand-foreground shadow transition-colors hover:bg-brand-200 disabled:opacity-50"
        >
          {#if submitting}<Loader2 class="size-4 animate-spin" />{:else}<Edit3 class="size-4" />{/if}
          {submitting ? "Saving…" : "Save Changes"}
        </button>
      </div>
    </form>
  {/if}
</ScheduledOverlay>
