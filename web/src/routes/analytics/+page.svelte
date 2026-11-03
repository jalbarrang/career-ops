<script lang="ts">
  import type { PageData } from "./$types";
  import { canonStatus, scoreNum } from "@/lib/format";
  import PipelineSankey from "@/components/analytics/pipeline-sankey.svelte";
  import FunnelRates from "@/components/analytics/funnel-rates.svelte";
  import SearchInsights from "@/components/analytics/search-insights.svelte";

  let { data }: { data: PageData } = $props();

  const STAGES: { key: string; label: string }[] = [
    { key: "EVALUATED", label: "Evaluated" },
    { key: "APPLIED", label: "Applied" },
    { key: "RESPONDED", label: "Responded" },
    { key: "INTERVIEW", label: "Interview" },
    { key: "OFFER", label: "Offer" },
    { key: "HIRED", label: "Hired" },
    { key: "REJECTED", label: "Rejected" },
    { key: "DISCARDED", label: "Discarded" },
  ];

  const total = $derived(data.total);
  const applications = $derived(data.applications);

  const VIEW_TABS = [
    { id: "progress", label: "Progress" },
    { id: "insights", label: "Insights" },
  ] as const;

  const stageCounts = $derived(
    STAGES.map((s) => ({
      ...s,
      n: applications.filter((a) => canonStatus(a.status).includes(s.key)).length,
    })),
  );
  const maxStage = $derived(Math.max(1, ...stageCounts.map((s) => s.n)));

  const scores = $derived(applications.map((a) => scoreNum(a.score)).filter((n) => !Number.isNaN(n)));
  const avg = $derived(scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0);
  const buckets = $derived(
    [
      { label: "4.5 – 5.0", test: (n: number) => n >= 4.5 },
      { label: "4.0 – 4.4", test: (n: number) => n >= 4 && n < 4.5 },
      { label: "3.0 – 3.9", test: (n: number) => n >= 3 && n < 4 },
      { label: "< 3.0", test: (n: number) => n < 3 },
    ].map((b) => ({ label: b.label, n: scores.filter(b.test).length })),
  );
  const maxBucket = $derived(Math.max(1, ...buckets.map((b) => b.n)));

  const topCompanies = $derived.by(() => {
    const companyCounts = new Map<string, number>();
    for (const a of applications) if (a.company) companyCounts.set(a.company, (companyCounts.get(a.company) ?? 0) + 1);
    return [...companyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  });
  const maxCompany = $derived(Math.max(1, ...topCompanies.map((c) => c[1])));
</script>

{#snippet stat(value: number | string, label: string, hint: string | undefined)}
  <div class="rounded-2xl border border-border bg-surface/50 p-4">
    <div class="text-3xl font-semibold tabular-nums">{value}</div>
    <div class="mt-1 text-xs text-faint">{label}</div>
    {#if hint}
      <a href="/" class="mt-2 block text-xs text-muted transition-colors hover:text-brand">
        {hint}
      </a>
    {/if}
  </div>
{/snippet}

{#snippet bar(label: string, value: number, pct: number, totalOf: number | undefined, tone: "neutral" | "positive")}
  {@const share = totalOf !== undefined && totalOf > 0 ? Math.round((value / totalOf) * 100) : null}
  {@const fill =
    tone === "positive"
      ? "bg-gradient-to-r from-emerald-500/60 to-emerald-500/30"
      : "bg-gradient-to-r from-foreground/25 to-foreground/10"}
  <div class="flex items-center gap-3">
    <div class="w-32 shrink-0 truncate text-sm text-muted">{label}</div>
    <div class="relative h-7 flex-1 overflow-hidden rounded-md bg-surface">
      <div class="h-full rounded-md {fill}" style="width: {Math.max(pct, value > 0 ? 4 : 0)}%"></div>
    </div>
    <div class="w-20 shrink-0 text-right text-sm tabular-nums">
      {value}
      {#if share !== null}<span class="ml-1 text-xs text-faint">{share}%</span>{/if}
    </div>
  </div>
{/snippet}

<div class="mx-auto max-w-5xl px-6 py-10">
  <h1 class="font-display text-2xl tracking-tight text-landing">Analytics</h1>
  <p class="mt-1 text-sm text-muted">Across {total} tracked evaluation{total === 1 ? "" : "s"}.</p>

  <div class="mt-5 flex flex-wrap gap-1 border-b border-border">
    {#each VIEW_TABS as t (t.id)}
      <a
        href={t.id === "progress" ? "/analytics" : `/analytics?view=${t.id}`}
        aria-current={data.view === t.id ? "page" : undefined}
        class={data.view === t.id
          ? "-mb-px border-b-2 border-brand px-3 py-2 text-sm text-brand-text"
          : "-mb-px border-b-2 border-transparent px-3 py-2 text-sm text-muted transition-colors hover:text-foreground"}
      >
        {t.label}
      </a>
    {/each}
  </div>

  {#if data.view === "insights"}
    <SearchInsights />
  {:else}
    <!-- headline stats -->
    <div class="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
      {@render stat(total, "evaluated", undefined)}
      {@render stat(avg ? avg.toFixed(2) : "—", "avg score", undefined)}
      {@render stat(
        data.interviews,
        "interviews",
        data.interviews === 0 ? "Interviews follow replies — keep follow-ups warm →" : undefined,
      )}
      {@render stat(
        data.offers,
        "offers",
        data.offers === 0 ? "Offers follow interviews — keep the conversations going →" : undefined,
      )}
    </div>

    <PipelineSankey applications={applications} statusLog={data.statusLog} />

    <section class="mt-10 scroll-mt-8">
      <h2 class="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Pipeline by stage</h2>
      <div class="mt-4 space-y-2.5">
        {#each stageCounts as s (s.key)}
          {@render bar(s.label, s.n, (s.n / maxStage) * 100, total, s.key === "OFFER" ? "positive" : "neutral")}
        {/each}
      </div>
    </section>

    <section class="mt-10 scroll-mt-8">
      <h2 class="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Score distribution</h2>
      <div class="mt-4 space-y-2.5">
        {#each buckets as b (b.label)}
          {@render bar(b.label, b.n, (b.n / maxBucket) * 100, scores.length, "neutral")}
        {/each}
      </div>
    </section>

    <section id="companies" class="mt-10 scroll-mt-8">
      <h2 class="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Top companies</h2>
      <div class="mt-4 space-y-2.5">
        {#each topCompanies as [name, n] (name)}
          {@render bar(name, n, (n / maxCompany) * 100, undefined, "neutral")}
        {/each}
      </div>
    </section>

    <!-- The core's cumulative funnel and conversion rates. Last, because it is
         the one block that waits on a spawned script. -->
    <FunnelRates />
  {/if}
</div>
