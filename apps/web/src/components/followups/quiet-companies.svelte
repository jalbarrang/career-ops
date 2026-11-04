<script lang="ts">
  import { onMount } from "svelte";
  import { Clock3, Copy, Check } from "@lucide/svelte";
  import { quietModel, checkRan } from "@/lib/quiet-companies.ts";

  type QuietModel = ReturnType<typeof quietModel>;
  type QuietCompany = QuietModel["companies"][number];

  // Companies still in Interview whose silence has passed the courtesy threshold,
  // from the core's packages/cli/src/commands/outreach/rejection-latency.ts via /api/quiet-companies.
  //
  // On Follow-ups because that is the page about chasing, and this is the far end
  // of it: the point where chasing stops being worth it. It sits BELOW the due
  // list, since a follow-up you can still send outranks a company that has
  // already stopped replying.
  //
  // The copy stays on the observation. The core measures elapsed time and ships
  // the sentence bounding the claim; a heading like "companies that ghosted you"
  // would turn a day count into an accusation about a named third party, in a tool
  // whose output people paste into messages.

  let model = $state<QuietModel | null>(null);

  onMount(() => {
    let alive = true;
    fetch("/api/quiet-companies")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => alive && (model = quietModel(d)))
      .catch(() => alive && (model = quietModel(null)));
    return () => {
      alive = false;
    };
  });

  // Per-row copy feedback. React kept this in the row component; a Svelte snippet
  // shares the page's scope, so both transient flags are keyed by the row instead.
  const rowKey = (c: QuietCompany) => `${c.company}-${c.lastDate ?? ""}`;
  let copiedKeys = $state<string[]>([]);
  let fallback = $state<{ key: string; text: string } | null>(null);

  async function copyRow(c: QuietCompany): Promise<void> {
    if (!c.blacklistRow) return;
    const key = rowKey(c);
    try {
      await navigator.clipboard.writeText(c.blacklistRow);
      copiedKeys = [...copiedKeys.filter((k) => k !== key), key];
      if (fallback?.key === key) fallback = null;
      setTimeout(() => {
        copiedKeys = copiedKeys.filter((k) => k !== key);
      }, 1600);
    } catch {
      // Shown when the clipboard is unavailable — a denied permission, a
      // non-secure origin, an older browser. The row is the whole point of the
      // button, so failing silently leaves the user with no way to get it; this
      // puts it on screen as selectable text instead.
      fallback = { key, text: c.blacklistRow };
    }
  }
</script>

{#snippet header(courtesyDays: number | null)}
  <div class="flex flex-wrap items-center gap-2">
    <Clock3 class="size-4 text-brand" />
    <h2 class="font-display text-base text-landing">No reply since your last round</h2>
    {#if courtesyDays !== null}<span class="text-xs text-faint">past {courtesyDays} days</span>{/if}
  </div>
{/snippet}

<!--  The core's warnings and its disclaimer, shared by the populated and empty
      panels so neither can quietly drop them. -->
{#snippet caveats(warnings: string[], disclaimer: string | null)}
  {#each warnings as w, i (i)}
    <p class="mt-3 text-xs text-muted">{w}</p>
  {/each}
  {#if disclaimer}
    <!-- Straight from the payload. Not styled as fine print: it is the
         sentence that keeps a day count from reading as a verdict. -->
    <p class="mt-4 border-t border-border pt-3 text-xs text-faint">{disclaimer}</p>
  {/if}
{/snippet}

{#snippet row(c: QuietCompany)}
  <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-surface/40 px-3.5 py-2.5">
    <div class="min-w-0 flex-[1_1_60%]">
      <p class="truncate text-sm">
        <span class="font-medium text-foreground">{c.company}</span>
        {#if c.role}<span class="text-muted"> · {c.role}</span>{/if}
      </p>
      <p class="text-xs text-faint">
        {c.days} day{c.days === 1 ? "" : "s"} since {c.lastDate ?? "the last round"}
        {#if c.trackerNums.length > 0}<span> · #{c.trackerNums.join(", #")}</span>{/if}
      </p>
    </div>
    {#if c.blacklistRow}
      <!-- Copy, never apply. data/blacklist.md is opt-in and never
           auto-populated (AGENTS.md); putting a company on it stays a decision
           the user makes in their own file. -->
      <button
        type="button"
        onclick={() => void copyRow(c)}
        title={c.blacklistRow}
        class="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted transition hover:border-brand/40 hover:text-foreground"
      >
        {#if copiedKeys.includes(rowKey(c))}
          <Check class="size-3.5" />
        {:else}
          <Copy class="size-3.5" />
        {/if}
        {copiedKeys.includes(rowKey(c)) ? "Copied" : "Copy blacklist row"}
      </button>
    {/if}
    {#if fallback?.key === rowKey(c)}
      <div class="w-full">
        <p class="text-xs text-muted">Couldn't reach the clipboard — select and copy:</p>
        <code
          class="mt-1 block w-full select-all overflow-x-auto rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[11px] text-foreground"
        >
          {fallback.text}
        </code>
      </div>
    {/if}
  </div>
{/snippet}

{#if !model}
  <div class="mt-8 h-24 w-full animate-pulse rounded-2xl bg-muted/25" aria-hidden="true"></div>
{:else if !checkRan(model)}
  <!-- A failed check is SHOWN, not hidden. Returning null here made the panel
       disappear after the loading state, which on a page about chasing reads as
       "nobody has gone quiet" — the reassuring answer, given for the one reason
       that cannot support it. The whole point of this panel is that silence and
       not-knowing look different. -->
  <section class="mt-8 rounded-2xl border border-dashed border-border bg-surface/30 px-5 py-4">
    {@render header(null)}
    <p class="mt-2 text-sm text-muted">This check didn't run, so nothing here says whether anyone has gone quiet.</p>
  </section>
{:else if model.companies.length === 0}
  <section class="mt-8 rounded-2xl border border-border bg-surface/30 px-5 py-4">
    {@render header(model.courtesyDays)}
    <p class="mt-2 text-sm text-muted">
      Nothing has gone quiet past the threshold{model.checked > 0
        ? ` across ${model.checked} compan${model.checked === 1 ? "y" : "ies"}`
        : ""}.
    </p>
    <!-- The caveats belong here MORE than on the populated panel, not less: an
         "all clear" drawn from a partial check is the reading most likely to
         be believed, and the core's warnings are what say the check was
         partial. -->
    {@render caveats(model.warnings, model.disclaimer)}
  </section>
{:else}
  <section class="mt-8 rounded-2xl border border-border bg-surface/40 px-5 py-4">
    {@render header(model.courtesyDays)}

    <div class="mt-3 grid gap-2.5">
      {#each model.companies as c (`${c.company}-${c.lastDate ?? ""}`)}
        {@render row(c)}
      {/each}
    </div>

    {@render caveats(model.warnings, model.disclaimer)}
  </section>
{/if}
