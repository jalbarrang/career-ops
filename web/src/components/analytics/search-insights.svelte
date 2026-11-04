<script lang="ts">
  import { onMount } from "svelte";
  import { statsModel } from "@/lib/analytics/view-model.ts";
  import type { StatsModel, BreakdownSection, ThresholdSection, VendorSection } from "@/lib/analytics/view-model.ts";

  // The "Insights" view: analyze-patterns.ts, rendered.
  //
  // The core already refuses to claim things its sample cannot support, and every
  // one of those refusals is surfaced here rather than smoothed over — a panel
  // that quietly drops a caveat is how a hedged number becomes a rule someone
  // filters their search by. The gating lives in lib/analytics/view-model.ts and
  // is unit-tested; this file only renders the decision.
  let model = $state<StatsModel | null>(null);
  let loading = $state(true);

  onMount(() => {
    let alive = true;
    fetch("/api/patterns")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { patterns?: object | null } | null) => {
        if (alive) model = statsModel(d?.patterns ?? null);
      })
      .catch(() => {
        if (alive) model = statsModel(null);
      })
      .finally(() => {
        if (alive) loading = false;
      });
    return () => {
      alive = false;
    };
  });

  // Distance to the core's own threshold, as a percentage of the bar.
  const progressPct = $derived.by(() => {
    const p = model?.progress;
    return p && p.threshold ? Math.min(100, Math.round((p.current / p.threshold) * 100)) : 0;
  });
</script>

{#snippet empty(title: string, body: string)}
  <div class="mt-6 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-10 text-center">
    <p class="font-display text-lg text-landing">{title}</p>
    <p class="mx-auto mt-1.5 max-w-md text-sm text-muted">{body}</p>
  </div>
{/snippet}

{#if loading}
  <div class="mt-6 grid gap-3" aria-hidden="true">
    {#each Array.from({ length: 3 }) as _, i (i)}
      <div class="h-28 w-full animate-pulse rounded-2xl bg-muted/25" style="animation-delay: {i * 90}ms"></div>
    {/each}
  </div>
{:else if !model || model.state === "unavailable"}
  {@render empty(
    "Pattern analysis isn't available",
    "This needs analyze-patterns.ts in the career-ops checkout. Everything else on this page still works.",
  )}
{:else if model.state === "below-threshold" && model.progress}
  {@const progress = model.progress}
  <!-- The core's own words, plus the distance to the bar. Showing "4 of 5" is
       the difference between "come back later" and knowing exactly when. -->
  <div class="mt-6 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-8 text-center">
    <p class="font-display text-lg text-landing">Not enough applications yet</p>
    <p class="mx-auto mt-1.5 max-w-md text-sm text-muted">{progress.message}</p>
    {#if progress.threshold}
      <div class="mx-auto mt-5 max-w-xs">
        <div class="h-2 overflow-hidden rounded-full bg-surface">
          <div class="h-full rounded-full bg-brand/70" style="width: {progressPct}%"></div>
        </div>
        <p class="mt-2 text-xs tabular-nums text-faint">
          {progress.current} of {progress.threshold} applications
        </p>
      </div>
    {/if}
  </div>
{:else if model.sections.length === 0}
  {@render empty("No patterns to show yet", "Outcomes are what this reads — record a few and they'll appear here.")}
{:else}
  <div class="mt-6 grid gap-4">
    {#each model.sections as section (section.key)}
      {#if section.key === "threshold"}
        {@const s = section as ThresholdSection}
        <section class="rounded-2xl border border-border bg-surface/40 px-5 py-4">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 class="font-display text-base text-landing">{s.label}</h3>
            {#if s.sampleSize}<p class="text-xs text-faint">{s.sampleSize} decided outcomes</p>{/if}
          </div>
          <p class="mt-2 text-3xl tabular-nums text-foreground">
            <!-- Withheld when the core says the sample does not support it: a
                 "recommended 4.7" off three outcomes reads as a rule. -->
            {#if s.value === null}<span class="text-faint">—</span>{:else}{s.value.toFixed(1)}{/if}
          </p>
          {#if s.provisional}
            <p class="mt-1 text-xs text-muted">Too few decided outcomes to recommend a cutoff yet.</p>
          {/if}
          {#if s.note}<p class="mt-2 text-sm text-muted">{s.note}</p>{/if}
        </section>
      {:else if section.key === "vendor"}
        {@const v = section as VendorSection}
        {#if !v.claimable}
          <section class="rounded-2xl border border-border bg-surface/40 px-5 py-4">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 class="font-display text-base text-landing">{v.label}</h3>
            </div>
            <!-- No chart at all, and the reason stated. An advance rate over 0
                 identified applications is not a small number, it is no number. -->
            <p class="mt-2 text-sm text-muted">
              {v.identified} of the applications could be matched to an ATS vendor{#if v.minSampleForClaim}{`, and ${v.minSampleForClaim} are needed before a per-vendor rate means anything`}{/if}.
            </p>
          </section>
        {:else}
          {@const vtop = Math.max(1, ...v.rows.map((r) => Number(r.submitted ?? r.total) || 0))}
          <section class="rounded-2xl border border-border bg-surface/40 px-5 py-4">
            <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h3 class="font-display text-base text-landing">{v.label}</h3>
              <p class="text-xs text-faint">{v.coveragePct}% of applications identified</p>
            </div>
            <div class="mt-3 grid gap-2">
              {#each v.rows as row, i (`${String(row.vendor ?? "—")}-${i}`)}
                {@const label = String(row.vendor ?? "—")}
                {@const n = Number(row.submitted ?? row.total) || 0}
                {@const rate = Number(row.advanceRate)}
                <div class="flex items-center gap-3">
                  <span class="w-32 shrink-0 truncate text-sm text-muted">{label}</span>
                  <div class="h-3.5 flex-1 overflow-hidden rounded-full bg-surface">
                    <div class="h-full rounded-full bg-brand/60" style="width: {(n / vtop) * 100}%"></div>
                  </div>
                  <span class="w-10 shrink-0 text-right text-sm tabular-nums">{n}</span>
                  <span class="w-12 shrink-0 text-right text-xs tabular-nums text-faint">
                    {#if Number.isFinite(rate)}{rate}%{:else}—{/if}
                  </span>
                </div>
              {/each}
            </div>
            {#if v.citation}<p class="mt-3 text-xs text-faint">{v.citation}</p>{/if}
          </section>
        {/if}
      {:else}
        {@const b = section as BreakdownSection}
        {@const btop = Math.max(1, ...b.rows.map((r) => Number(r.total) || 0))}
        <section class="rounded-2xl border border-border bg-surface/40 px-5 py-4">
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 class="font-display text-base text-landing">{b.label}</h3>
            {#if b.partial}<p class="text-xs text-faint">some rows have no recorded value</p>{/if}
          </div>
          <div class="mt-3 grid gap-2">
            {#each b.rows as row, i (`${String(row[b.dimension] ?? "—")}-${i}`)}
              {@const label = String(row[b.dimension] ?? "—")}
              {@const total = Number(row.total) || 0}
              {@const conv = Number(row.conversionRate)}
              <div class="flex items-center gap-3">
                <span class="w-32 shrink-0 truncate text-sm text-muted" title={label}>
                  {label}
                </span>
                <div class="h-3.5 flex-1 overflow-hidden rounded-full bg-surface">
                  <div class="h-full rounded-full bg-brand/60" style="width: {(total / btop) * 100}%"></div>
                </div>
                <span class="w-10 shrink-0 text-right text-sm tabular-nums">{total}</span>
                <span class="w-12 shrink-0 text-right text-xs tabular-nums text-faint">
                  {#if Number.isFinite(conv)}{conv}%{:else}—{/if}
                </span>
              </div>
            {/each}
          </div>
        </section>
      {/if}
    {/each}
  </div>
{/if}
