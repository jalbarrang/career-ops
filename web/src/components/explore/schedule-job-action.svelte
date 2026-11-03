<script lang="ts">
  import { CalendarPlus } from "@lucide/svelte";
  import type { ExploreFilters } from "@/lib/explore";
  import { Button } from "@/components/ui/button";
  import { cadenceMinimum, createScheduledJobRequest } from "@/lib/scheduled-job-client.mjs";

  type ScheduleUnit = "minutes" | "hours" | "days";

  let { filters }: { filters: ExploreFilters } = $props();

  let open = $state(false);
  let name = $state("Scheduled scan");
  let every = $state(3);
  let unit = $state<ScheduleUnit>("hours");
  // Not `state`: a local named `state` would make `$state(...)` read as the store
  // subscription shorthand instead of the rune.
  let feedback = $state("");
  let saving = $state(false);
  const minimum = $derived(cadenceMinimum(unit));

  async function save(): Promise<void> {
    saving = true;
    feedback = "Saving...";
    try {
      await createScheduledJobRequest({
        name,
        every: Math.max(minimum, every),
        unit,
        filters,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        startAt: new Date().toISOString(),
      });
      feedback = "Scheduled scan created.";
      open = false;
    } catch (error) {
      feedback = error instanceof Error ? error.message : "Could not create the scheduled scan.";
    } finally {
      saving = false;
    }
  }
</script>

<div class="inline-flex flex-wrap items-center gap-2">
  <Button type="button" variant="outline" onclick={() => (open = !open)}>
    <CalendarPlus class="size-4" />
    Schedule
  </Button>
  {#if open}
    <div class="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-surface p-3 text-sm">
      <label class="grid gap-1 text-xs text-muted">
        Name
        <input
          class="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          value={name}
          maxlength={80}
          oninput={(event) => (name = event.currentTarget.value)}
        />
      </label>
      <label class="grid gap-1 text-xs text-muted">
        Repeat every
        <input
          class="w-16 rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          type="number"
          min={minimum}
          value={every}
          oninput={(event) => (every = Number(event.currentTarget.value))}
        />
      </label>
      <select
        aria-label="Schedule unit"
        class="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
        value={unit}
        onchange={(event) => (unit = event.currentTarget.value as ScheduleUnit)}
      >
        <option value="minutes">minutes</option>
        <option value="hours">hours</option>
        <option value="days">days</option>
      </select>
      <Button
        type="button"
        disabled={saving || !name.trim() || !Number.isFinite(every) || every < minimum}
        onclick={() => void save()}
      >
        {saving ? "Saving..." : "Add scheduled scan"}
      </Button>
      {#if feedback}<span class="text-xs text-muted">{feedback}</span>{/if}
    </div>
  {/if}
  {#if !open && feedback}<span role="status" class="text-xs text-muted">{feedback}</span>{/if}
</div>
