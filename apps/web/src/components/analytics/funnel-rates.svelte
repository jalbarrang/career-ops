<script lang="ts">
  import { onMount } from "svelte";
  import { progressModel } from "@/lib/analytics/view-model.ts";

  // The cumulative funnel and its conversion rates, straight from packages/core/src/insights/stats.ts via
  // /api/stats. A client island rather than server-read because packages/core/src/insights/stats.ts is
  // spawned per request and can take a second on a large tracker — the rest of
  // Analytics should not wait behind it.
  //
  // Every number here is the core's. What this component decides is only whether
  // a number may be shown at all, and that decision lives in
  // lib/analytics/view-model.ts where it is unit-tested.
  let phase = $state<"loading" | "ready" | "unavailable">("loading");
  let model = $state<ReturnType<typeof progressModel> | null>(null);

  onMount(() => {
    let alive = true;
    fetch("/api/stats")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: { stats?: object | null } | null) => {
        if (!alive) return;
        const m = progressModel(d?.stats ?? null);
        model = m;
        phase = m.available ? "ready" : "unavailable";
      })
      .catch(() => {
        if (alive) phase = "unavailable";
      });
    return () => {
      alive = false;
    };
  });

  // Quiet only for the one case that deserves it: packages/core/src/insights/stats.ts not being reachable
  // at all is an installation fact, and a red panel for it would be louder than
  // the fact deserves. An empty tracker is NOT that case — it is where every new
  // user starts, and rendering nothing there means the Conversion block simply
  // does not exist for them, with no way to learn that it will.
  const render = $derived(!!model && !(phase === "unavailable" && model.reason !== "no-data"));
</script>

{#if phase === "loading"}
  <section class="mt-10">
    <h2 class="font-display text-lg text-landing">Conversion</h2>
    <div class="mt-4 grid gap-3" aria-hidden="true">
      <!-- Inline rather than a shared Skeleton primitive: this branch is
           independent of the route-loading work, so it carries no dependency
           on components added there. -->
      {#each Array.from({ length: 4 }) as _, i (i)}
        <div class="h-9 w-full animate-pulse rounded-md bg-muted/25" style="animation-delay: {i * 80}ms"></div>
      {/each}
    </div>
  </section>
{:else if render && model}
  {#if phase === "unavailable"}
    <section class="mt-10">
      <h2 class="font-display text-lg text-landing">Conversion</h2>
      <p class="mt-3 rounded-2xl border border-dashed border-border bg-surface/30 px-5 py-6 text-sm text-muted">
        Nothing to convert yet — these rates come from applications you have
        sent. Apply to a role and the funnel fills in here.
      </p>
    </section>
  {:else}
    {@const stages = model.funnel.stages}
    {@const rates = model.funnel.rates}
    {@const top = Math.max(1, ...stages.map((s) => s.value))}
    <section class="mt-10">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 class="font-display text-lg text-landing">Conversion</h2>
        <p class="text-xs text-faint">
          Cumulative — reaching a stage counts every stage before it, matching{" "}
          <code class="text-muted">packages/core/src/insights/stats.ts</code>
        </p>
      </div>

      {#if model.provisional}
        <!-- packages/core/src/insights/stats.ts's own smallSample flag. Said plainly, because three
             percentages off a handful of applications look like a finding. -->
        <p class="mt-2 text-xs text-muted">
          Small sample so far — these rates will move a lot with each new outcome.
        </p>
      {/if}

      <div class="mt-4 grid gap-2.5">
        {#each stages as s (s.key)}
          <div class="flex items-center gap-3">
            <span class="w-24 shrink-0 text-sm text-muted">{s.label}</span>
            <div class="h-4 flex-1 overflow-hidden rounded-full bg-surface">
              <div class="h-full rounded-full bg-brand/70" style="width: {(s.value / top) * 100}%"></div>
            </div>
            <span class="w-8 shrink-0 text-right text-sm tabular-nums">{s.value}</span>
          </div>
        {/each}
      </div>

      <dl class="mt-5 grid grid-cols-3 gap-3">
        {#each rates as r (r.key)}
          <div class="rounded-xl border border-border bg-surface/40 px-3.5 py-3">
            <dt class="text-xs text-muted">{r.label}</dt>
            <dd class="mt-0.5 text-xl tabular-nums text-foreground">
              <!-- null, not 0: a rate with nothing to divide by is absent. An
                   em dash says "not yet" where "0%" would say "failing". -->
              {#if r.value === null}<span class="text-faint">—</span>{:else}{r.value}%{/if}
            </dd>
          </div>
        {/each}
      </dl>
    </section>
  {/if}
{/if}
