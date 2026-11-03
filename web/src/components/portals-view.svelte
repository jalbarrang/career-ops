<script lang="ts">
  import { Loader2, Radar, Wrench } from "@lucide/svelte";
  import CompanyLogo from "@/components/company-logo.svelte";
  import { useJobs, type Job } from "@/lib/jobs.svelte";
  import { cn } from "@/lib/cn";

  type Company = { name: string; status: string; detail: string };
  type Result = { available: boolean; configured: boolean; companies: Company[] };

  const TONE: Record<string, { dot: string; label: string; chip: string }> = {
    live: { dot: "bg-emerald-500", label: "live", chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" },
    empty: { dot: "bg-amber-500", label: "live · empty", chip: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
    broken: { dot: "bg-red-500", label: "broken", chip: "bg-red-500/15 text-red-700 dark:text-red-400" },
    skipped: { dot: "bg-zinc-400", label: "no ATS", chip: "bg-surface-hover text-muted" },
  };
  const ORDER: Record<string, number> = { broken: 0, empty: 1, live: 2, skipped: 3 };

  let res = $state<Result | null>(null);
  let loading = $state(false);
  const store = useJobs();

  // map the agentic "fix-portal" workers to the company they're repairing
  const fixByCompany = $derived.by(() => {
    const m = new Map<string, Job>();
    for (const j of store.jobs) {
      if (j.kind !== "fix-portal" || !j.input) continue;
      const ex = m.get(j.input);
      if (!ex || j.startedAt > ex.startedAt) m.set(j.input, j);
    }
    return m;
  });

  function check(): void {
    loading = true;
    fetch("/api/portals/verify")
      .then((r) => r.json())
      .then((d: Result) => (res = d))
      .catch(() => (res = { available: false, configured: false, companies: [] }))
      .finally(() => (loading = false));
  }

  const companies = $derived(res?.companies ?? []);
  const broken = $derived(companies.filter((c) => c.status === "broken"));
  const liveN = $derived(companies.filter((c) => c.status === "live" || c.status === "empty").length);
  const sorted = $derived([...companies].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9)));
</script>

{#snippet fixAffordance(company: string, job: Job | undefined)}
  {#if job?.status === "running"}
    <a href={`/jobs/${job.id}`} class="inline-flex items-center gap-1 text-xs font-medium text-brand">
      <Loader2 class="size-3 animate-spin" /> Fixing…
    </a>
  {:else if job?.status === "done"}
    <a href={`/jobs/${job.id}`} class="text-xs font-medium text-emerald-600 dark:text-emerald-400">repaired · re-check</a>
  {:else}
    <button
      onclick={() =>
        store.startJob({ title: `Fix · ${company}`, subtitle: "repair portal slug", kind: "fix-portal", input: company, page: "/portals" })}
      title={`Have the agent repair ${company}'s portal slug`}
      class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:border-brand/40 hover:text-brand"
    >
      <Wrench class="size-3" /> Fix
    </button>
  {/if}
{/snippet}

<div>
  <div class="flex items-center gap-3">
    <button
      onclick={check}
      disabled={loading}
      class="inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]"
    >
      {#if loading}<Loader2 class="size-4 animate-spin" />{:else}<Radar class="size-4" />{/if}
      Check portal health
    </button>
    {#if loading}<span class="text-xs text-faint">Probing each company's ATS… (~30–60s)</span>{/if}
  </div>

  {#if res && !res.available}
    <p class="mt-4 rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
      <code class="text-foreground">verify-portals.mjs</code> not found — this needs a complete career-ops
      checkout (the web orchestrates the core's validator).
    </p>
  {/if}
  {#if res && res.available && !res.configured}
    <p class="mt-4 rounded-xl border border-dashed border-border bg-surface/30 p-4 text-sm text-muted">
      No <code class="text-foreground">portals.yml</code> yet — ask the assistant to set up the companies to scan.
    </p>
  {/if}

  {#if res && res.configured}
    <div class="mt-5">
      <p class="text-sm text-muted">
        <span class="tabular-nums text-emerald-600 dark:text-emerald-400">{liveN}</span> live ·{" "}
        <span class="tabular-nums text-red-600 dark:text-red-400">{broken.length}</span> broken ·{" "}
        <span class="tabular-nums">{companies.length}</span> tracked
      </p>
      {#if broken.length > 0}
        <div class="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm">
          <span class="font-medium text-red-700 dark:text-red-400">
            {broken.length}
            {broken.length === 1 ? "company silently drops" : "companies silently drop"} from every
            scan
          </span>{" "}
          <span class="text-muted">
            — their careers link is broken. Fix the <code>careers_url</code> in <code>portals.yml</code> (or ask the
            assistant to repair them).
          </span>
        </div>
      {/if}
      <ul class="mt-4 divide-y divide-border overflow-hidden rounded-2xl border border-border bg-surface/40">
        {#each sorted as c (c.name)}
          {@const t = TONE[c.status] ?? TONE.skipped}
          <li class="flex items-center gap-3 px-4 py-2.5">
            <CompanyLogo name={c.name} size={20} />
            <span class={cn("size-1.5 shrink-0 rounded-full", t.dot)}></span>
            <span class="shrink-0 text-sm font-medium">{c.name}</span>
            <span class="truncate font-mono text-xs text-faint">{c.detail}</span>
            <div class="ml-auto flex shrink-0 items-center gap-2">
              {#if c.status === "broken"}{@render fixAffordance(c.name, fixByCompany.get(c.name))}{/if}
              <span class={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", t.chip)}>{t.label}</span>
            </div>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
</div>
