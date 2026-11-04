<script lang="ts">
  import { CalendarDays, Keyboard, Trash2 } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import { MONTH_LABELS, formatPeriod, parsePeriod } from "@/lib/cv-profile.ts";

  /**
   * Start / end date picker for a role's `period`, with a "currently working here"
   * toggle.
   *
   * The stored field stays a single string — the picker is a mode over it, not a
   * schema change — so everything downstream (the CV payload's `dates`, the PDF's
   * reverse-chronological guard, the importer's period classifier) is untouched.
   * What the picker writes follows the rules those consumers need: start date
   * first, a 4-digit year, English month abbreviations, an en dash, and no
   * trailing punctuation.
   *
   * An IMPORTED period is free text from someone's CV. When it does not parse
   * (a sentence, a stray list of clients) the picker stays out of the way and a
   * plain text box is shown instead, so a value it never understood is never
   * silently replaced by an empty one.
   */
  type Draft = {
    startMonth: string;
    startYear: string;
    endMonth: string;
    endYear: string;
    present: boolean;
  };

  let { value, onChange }: { value: string; onChange: (next: string) => void } = $props();

  function draftFrom(input: string): Draft {
    const parsed = parsePeriod(input);
    return {
      startMonth: parsed?.start?.month ? String(parsed.start.month) : "",
      startYear: parsed?.start?.year ? String(parsed.start.year) : "",
      endMonth: parsed?.end?.month ? String(parsed.end.month) : "",
      endYear: parsed?.end?.year ? String(parsed.end.year) : "",
      present: Boolean(parsed?.present),
    };
  }

  const number = (input: string) => (input === "" ? null : Number(input));

  // Empty is a valid state (a role with no dates), so it opens the picker.
  // The three declarations below are the React lazy useState initializers: each
  // reads the incoming value exactly once, so a later prop change never rewrites
  // what the user is in the middle of typing.
  // svelte-ignore state_referenced_locally
  let mode = $state<"picker" | "raw">(value.trim() !== "" && parsePeriod(value) === null ? "raw" : "picker");
  // svelte-ignore state_referenced_locally
  let draft = $state<Draft>(draftFrom(value));
  // svelte-ignore state_referenced_locally
  let typed = $state(value);

  function commit(next: Draft): void {
    draft = next;
    const formatted = formatPeriod({
      startMonth: number(next.startMonth),
      startYear: number(next.startYear),
      endMonth: next.present ? null : number(next.endMonth),
      endYear: next.present ? null : number(next.endYear),
      present: next.present,
    });
    // A half-typed year returns null; keep what is stored rather than blanking
    // it, so typing "2025" digit by digit never wipes the period on the way.
    if (formatted !== null) onChange(formatted);
  }

  const formatted = $derived(
    formatPeriod({
      startMonth: number(draft.startMonth),
      startYear: number(draft.startYear),
      endMonth: draft.present ? null : number(draft.endMonth),
      endYear: draft.present ? null : number(draft.endYear),
      present: draft.present,
    }),
  );
</script>

{#snippet monthSelect(key: "startMonth" | "endMonth", disabled: boolean)}
  <select
    aria-label={key === "startMonth" ? "Start month" : "End month"}
    value={draft[key]}
    {disabled}
    onchange={(event) => commit({ ...draft, [key]: event.currentTarget.value })}
    class={cn("rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none focus:border-brand/40", disabled && "opacity-50")}
  >
    <option value="">—</option>
    {#each MONTH_LABELS as label, index (label)}
      <option value={String(index + 1)}>{label}</option>
    {/each}
  </select>
{/snippet}

{#snippet yearInput(key: "startYear" | "endYear", disabled: boolean)}
  <input
    aria-label={key === "startYear" ? "Start year" : "End year"}
    value={draft[key]}
    {disabled}
    inputmode="numeric"
    maxlength="4"
    placeholder="2025"
    oninput={(event) => {
      const digits = event.currentTarget.value.replace(/\D/g, "").slice(0, 4);
      commit({ ...draft, [key]: digits });
    }}
    class={cn(
      "w-16 rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none placeholder:text-faint focus:border-brand/40",
      disabled && "opacity-50",
    )}
  />
{/snippet}

{#if mode === "raw"}
  <div class="text-xs text-faint">
    <div class="flex items-center justify-between gap-2">
      <span>Period</span>
      <button
        type="button"
        onclick={() => {
          draft = draftFrom(typed);
          mode = "picker";
        }}
        class="inline-flex items-center gap-1 text-faint transition-colors hover:text-foreground"
      >
        <CalendarDays class="size-3" /> Use dates
      </button>
    </div>
    <input
      value={typed}
      oninput={(event) => {
        typed = event.currentTarget.value;
        onChange(event.currentTarget.value);
      }}
      placeholder="Mar 2025 – Sep 2026"
      class="mt-0.5 w-full rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none placeholder:text-faint focus:border-brand/40"
    />
    <p class="mt-0.5">
      Kept as typed — this value is not a date range the picker could read. Start date first, with a year, if you want it to count for ordering.
    </p>
  </div>
{:else}
  <div class="text-xs text-faint">
    <div class="flex items-center justify-between gap-2">
      <span>Period</span>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={() => {
            typed = value;
            mode = "raw";
          }}
          class="inline-flex items-center gap-1 transition-colors hover:text-foreground"
        >
          <Keyboard class="size-3" /> Type it
        </button>
        {#if value.trim() !== ""}
          <button
            type="button"
            onclick={() => {
              draft = { startMonth: "", startYear: "", endMonth: "", endYear: "", present: false };
              onChange("");
            }}
            aria-label="Clear the dates"
            class="inline-flex items-center gap-1 transition-colors hover:text-foreground"
          >
            <Trash2 class="size-3" /> Clear
          </button>
        {/if}
      </div>
    </div>

    <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span class="inline-flex items-center gap-1">
        <span class="text-faint">Start</span>
        {@render monthSelect("startMonth", false)}
        {@render yearInput("startYear", false)}
      </span>
      <span class="inline-flex items-center gap-1">
        <span class="text-faint">End</span>
        {@render monthSelect("endMonth", draft.present)}
        {@render yearInput("endYear", draft.present)}
      </span>
      <label class="inline-flex cursor-pointer items-center gap-1.5 text-muted">
        <input
          type="checkbox"
          checked={draft.present}
          onchange={(event) => commit({ ...draft, present: event.currentTarget.checked })}
          class="accent-[var(--color-brand)]"
        />
        I currently work here
      </label>
    </div>

    <p class="mt-0.5 text-faint">
      {#if formatted}
        Saves as <span class="text-foreground">{formatted}</span>
        {#if formatted.length > 40}
          <span class="ml-1 text-amber-600 dark:text-amber-400">· over 40 characters, the importer may not read it as dates</span>
        {/if}
      {:else}
        Add a start year to save a period.
      {/if}
    </p>
  </div>
{/if}
