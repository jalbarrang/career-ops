<script lang="ts">
  import { invalidateAll, goto } from "$app/navigation";
  import { navigating, page } from "$app/state";
  import { Search, ChevronsUpDown, X, Compass, ArrowRight } from "@lucide/svelte";
  import type { Application, InboxJob } from "@/lib/career-ops";
  import { Badge } from "@/components/ui/badge";
  import CompanyLogo from "@/components/company-logo.svelte";
  import { canonStatus, scoreNum, scoreTone } from "@/lib/format";
  import StatusSelect from "@/components/status-select.svelte";
  import { applicationKey, applySavedStatus } from "@/lib/pipeline-status.ts";
  import InboxTriage from "@/components/inbox/inbox-triage.svelte";
  import { cn } from "@/lib/cn";
  import { companyPresentation, companySearchText } from "@/lib/company-presentation.ts";
  import PipelineTableRows from "@/components/page-loading-skeletons/pipeline-table-rows.svelte";
  import { startRouteProgress } from "@/components/route-progress.svelte";
  import { sortRows } from "@/lib/core/pipeline-sort.ts";

  // INBOX (the triage queue) is the default tab; the rest filter the tracker.
  const TABS = [
    "INBOX",
    "ALL",
    "EVALUATED",
    "APPLIED",
    "RESPONDED",
    "INTERVIEW",
    "OFFER",
    "HIRED",
    "REJECTED",
    "DISCARDED",
    "SKIP",
  ] as const;
  type Tab = (typeof TABS)[number];

  const SORT_KEYS = ["tracker", "company", "role", "score", "status", "date"] as const;
  type SortKey = (typeof SORT_KEYS)[number];

  let { applications, inbox }: { applications: Application[]; inbox: InboxJob[] } = $props();

  // SvelteKit's `navigating` is the pending flag the React version got from
  // useTransition: every tab/min/sort change is a query navigation through the
  // server load, which is exactly the transition Next's router.replace ran.
  const isPending = $derived(navigating.to !== null);
  let pendingTab = $state<Tab | null>(null);

  // The confirmed save, replayed over the refreshed snapshot until it settles
  // (the job useOptimistic did in the React version). Starts AFTER the POST
  // succeeds, and is dropped once the invalidated load has landed.
  let saved = $state<{ key: string; status: string } | null>(null);
  // Bumped per save so a slow earlier invalidateAll cannot clear a newer save's
  // optimism. (Comparing the objects would not work: reading a $state object
  // hands back its proxy, never the literal we assigned.)
  let saveToken = 0;
  const visibleApplications = $derived(saved ? (applySavedStatus(applications, saved) as Application[]) : applications);

  let announcement = $state("");
  let tabsEl = $state<HTMLDivElement | null>(null);

  // The URL is the SINGLE source of truth for tab/min/sort/dir, so the home stat
  // tiles' deep links AND the assistant's filterPipeline/navigate actions drive
  // the table identically (no local mirror → no desync).
  const pTab = $derived((page.url.searchParams.get("tab") ?? "").toUpperCase());
  const tab = $derived<Tab>((TABS as readonly string[]).includes(pTab) ? (pTab as Tab) : "INBOX");
  const visibleTab = $derived(isPending && pendingTab ? pendingTab : tab);
  const minFilter = $derived.by(() => {
    const pMin = parseFloat(page.url.searchParams.get("min") ?? "");
    return Number.isFinite(pMin) ? pMin : null;
  });
  const pSort = $derived(page.url.searchParams.get("sort") ?? "");
  const sortKey = $derived<SortKey>((SORT_KEYS as readonly string[]).includes(pSort) ? (pSort as SortKey) : "score");
  const sortDir = $derived<1 | -1>(page.url.searchParams.get("dir") === "1" ? 1 : -1);

  // Search stays LOCAL for snappy typing; seeded from the URL and re-synced only
  // when the URL's q changes (i.e. the assistant set it) — never per keystroke.
  let q = $state(page.url.searchParams.get("q") ?? "");
  let lastUrlQ = $state(page.url.searchParams.get("q") ?? "");
  $effect(() => {
    const urlQ = page.url.searchParams.get("q") ?? "";
    if (urlQ !== lastUrlQ) {
      lastUrlQ = urlQ;
      q = urlQ;
    }
  });

  $effect(() => {
    if (!isPending) pendingTab = null;
  });

  function setParams(updates: Record<string, string | number | null>) {
    const current = page.url.searchParams.toString();
    const sp = new URLSearchParams(current);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") sp.delete(k);
      else sp.set(k, String(v));
    }
    const qs = sp.toString();
    if (qs === current) return;
    if (Object.prototype.hasOwnProperty.call(updates, "tab")) {
      const nextTab = String(updates.tab ?? "INBOX").toUpperCase();
      if ((TABS as readonly string[]).includes(nextTab)) pendingTab = nextTab as Tab;
    }
    startRouteProgress();
    // `replace: true` is router.replace (no history entry); `reset: false` is
    // `{ scroll: false }` — leave the scroll position and focus alone.
    void goto(`${page.url.pathname}${qs ? `?${qs}` : ""}`, { replace: true, reset: false });
  }

  // Pending + deduped by URL (pipeline.md can list the same posting twice) so the
  // header count, the tab count and the triage list all agree on one number.
  const pendingInbox = $derived.by(() => {
    const seen = new Set<string>();
    const out: InboxJob[] = [];
    for (const j of inbox) {
      if (j.done || seen.has(j.url)) continue;
      seen.add(j.url);
      out.push(j);
    }
    return out;
  });

  const filtered = $derived.by(() => {
    if (tab === "INBOX") return [];
    let rows = visibleApplications;
    if (tab !== "ALL") rows = rows.filter((r) => canonStatus(r.status).includes(tab));
    const min = minFilter;
    if (min != null) {
      rows = rows.filter((r) => {
        const n = scoreNum(r.score);
        return !Number.isNaN(n) && n >= min;
      });
    }
    const needle = q.trim().toLowerCase();
    if (needle) {
      rows = rows.filter((r) => companySearchText(r).toLowerCase().includes(needle));
    }
    // scoreNum is the real score parser (it handles the tracker's "4.2/5"
    // cells); sortRows takes it rather than keeping a second copy (#4333).
    return sortRows(
      rows,
      { key: sortKey, dir: sortDir },
      scoreNum,
      (row: Application) => companyPresentation(row).label,
    ) as Application[];
  });

  /** Focus the tab button the URL currently selects — the focus target a row
   *  that leaves its tab hands back to (the React version kept a ref on it). */
  function focusActiveTab() {
    tabsEl?.querySelector<HTMLButtonElement>('button[data-active="true"]')?.focus();
  }

  function tabCount(t: Tab): number {
    if (t === "INBOX") return pendingInbox.length;
    if (t === "ALL") return visibleApplications.length;
    return visibleApplications.filter((r) => canonStatus(r.status).includes(t)).length;
  }
</script>

<div class="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 max-sm:pb-24">
  <div class="flex items-end justify-between gap-4">
    <div>
      <h1 class="font-display text-2xl tracking-tight text-landing">Pipeline</h1>
      <p class="mt-1 text-sm text-muted">
        <span class="tabular-nums">{pendingInbox.length}</span> in inbox ·{" "}
        <span class="tabular-nums">{visibleApplications.length}</span> tracked
      </p>
    </div>
    <!-- the tracker has its own search; the inbox brings its own facet filters -->
    {#if visibleTab !== "INBOX"}
      <div class="relative w-64 max-w-[40vw]">
        <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        <input
          value={q}
          oninput={(e) => (q = e.currentTarget.value)}
          placeholder="Search company or role…"
          class="w-full rounded-md border border-border bg-surface/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
        />
      </div>
    {/if}
  </div>

  <!-- tabs -->
  <div class="mt-6 flex flex-wrap gap-1 border-b border-border" bind:this={tabsEl}>
    {#each TABS as t (t)}
      <button
        data-active={tab === t ? "true" : undefined}
        onclick={() => setParams({ tab: t === "INBOX" ? null : t })}
        class={cn(
          // gap-1, not a whitespace text node: flex containers drop
          // whitespace-only anonymous items, which rendered "INBOX0".
          "-mb-px inline-flex items-center justify-center gap-1 border-b-2 px-3 py-2 text-xs font-medium transition-colors max-sm:min-h-[44px]",
          visibleTab === t ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
        )}
      >
        {t} <span class="text-faint tabular-nums">{tabCount(t)}</span>
      </button>
    {/each}
  </div>

  <p role="status" class="sr-only">{announcement}</p>

  {#if visibleTab !== "INBOX" && minFilter != null}
    <div class="mt-3 flex items-center gap-2">
      <span class="text-xs text-faint">Filtered:</span>
      <button
        type="button"
        onclick={() => setParams({ min: null })}
        class="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-2.5 py-1 text-xs font-medium text-brand transition-colors hover:bg-brand/15"
        title="Clear score filter"
      >
        score ≥ {minFilter.toFixed(1)}
        <X class="size-3" />
      </button>
    </div>
  {/if}

  {#if visibleTab === "INBOX"}
    <!-- ── Inbox: the triage surface (Abundance → Triage → Shortlist → Score) ── -->
    {#if pendingInbox.length > 0}
      <InboxTriage inbox={pendingInbox} />
    {:else}
      <!-- Empty inbox. Self-sufficient for the mainstream user (a primary in-web
           action), honest for devs (the CLI/file path stays, demoted to
           progressive transparency). The React component's `filtered`/`count > 0`
           branches were never reachable from here — it was only ever called with
           (count=0, filtered=false) — so this is the branch that rendered. -->
      <div
        class="dot-bg mt-4 overflow-hidden rounded-2xl border border-border bg-surface/50 bg-origin-border bg-gradient-to-tr from-brand/10 via-transparent to-transparent shadow-lg"
      >
        <div class="flex items-center gap-2 border-b border-foreground/10 px-5 py-3">
          <span class="size-2.5 rounded-full bg-foreground/15" aria-hidden="true"></span>
          <span class="size-2.5 rounded-full bg-foreground/15" aria-hidden="true"></span>
          <span class="size-2.5 rounded-full bg-foreground/15" aria-hidden="true"></span>
          <span class="ml-3 font-mono text-xs tracking-wide text-muted">career-ops · inbox</span>
        </div>
        <div class="px-6 py-10 text-center">
          <p class="font-display text-lg">
            Your <span class="text-brand">inbox</span> is empty.
          </p>
          <p class="mx-auto mt-2 max-w-sm text-sm text-muted">Find roles that match your CV — free, no tokens spent.</p>
          <a
            href="/explore?run=1"
            class="mt-5 inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground shadow-sm transition-all duration-200 hover:bg-brand-200 hover:-translate-y-0.5 hover:shadow-md"
          >
            <Compass class="size-4" /> Run your first free scan <ArrowRight class="size-4" />
          </a>
          <p class="mx-auto mt-4 max-w-sm text-xs text-muted">
            Prefer the terminal? Run <code class="rounded bg-surface-hover px-1 py-0.5 font-mono">career-ops scan</code>, or add job URLs to{" "}
            <code class="rounded bg-surface-hover px-1 py-0.5 font-mono">data/pipeline.md</code>.
          </p>
        </div>
      </div>
    {/if}
  {:else if isPending || filtered.length > 0}
    <!-- ── Tracker table ──
         overflow-x-auto, not overflow-hidden: the rounded corners still clip,
         but a table too wide for the viewport can now be scrolled to instead
         of being silently cut off. min-w keeps the columns readable rather
         than letting w-full crush them on a phone. -->
    <div class="mt-4 overflow-x-auto rounded-2xl border border-border">
      <table class="w-full min-w-[44rem] text-sm">
        <thead class="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
          <tr>
            {#each SORT_KEYS as k (k)}
              <th
                aria-sort={sortKey === k ? (sortDir === 1 ? "ascending" : "descending") : "none"}
                class={cn("whitespace-nowrap px-4 py-2.5 font-medium", k === "date" && "hidden lg:table-cell")}
              >
                <button
                  type="button"
                  class="inline-flex cursor-pointer select-none items-center gap-1 uppercase tracking-wide hover:text-foreground"
                  onclick={() => setParams({ sort: k, dir: sortKey === k ? sortDir * -1 : -1 })}
                >
                  {k}
                  <ChevronsUpDown aria-hidden="true" class="size-3" />
                </button>
              </th>
            {/each}
          </tr>
        </thead>
        <!-- Keep editors mounted while query navigation is pending: sorting
             must not discard an open editor or an in-flight status save. -->
        <tbody class="divide-y divide-border" hidden={isPending} aria-busy={false}>
          {#each filtered as r (applicationKey(r))}
            {@const company = companyPresentation(r)}
            {@const key = applicationKey(r)}
            <tr data-application-key={key} class="group transition-colors hover:bg-surface/40">
              <td class="whitespace-nowrap px-4 py-3 font-medium tabular-nums">
                <a href={`/pipeline/${r.n}`} class="transition-colors group-hover:text-brand">#{r.n}</a>
              </td>
              <td class="px-4 py-3 font-medium">
                <a href={`/pipeline/${r.n}`} class="flex items-center gap-2.5 transition-colors group-hover:text-brand">
                  <CompanyLogo name={company.logoName} size={20} />
                  {company.label}
                </a>
              </td>
              <td class="px-4 py-3 text-muted">
                <a href={`/pipeline/${r.n}`}>{r.role}</a>
              </td>
              <td class="px-4 py-3">
                <Badge tone={scoreTone(r.score)}>{r.score || "—"}</Badge>
              </td>
              <td class="whitespace-nowrap px-4 py-3 text-muted">
                {#key r.n}
                  <StatusSelect
                    n={r.n}
                    current={r.status}
                    inline
                    applicationLabel={`${company.label} — ${r.role} (#${r.n})`}
                    onSaved={(status, restoreFocus) => {
                      // If this focused row leaves its tab, preserve a useful
                      // focus target. Do not interrupt someone using search.
                      const focusedRow = (document.activeElement as HTMLElement | null)?.closest("tr");
                      if (
                        tab !== "ALL" &&
                        !canonStatus(status).includes(tab) &&
                        (restoreFocus || focusedRow?.dataset.applicationKey === key)
                      ) {
                        focusActiveTab();
                      }
                      announcement = `Application #${r.n} status saved as ${status}.`;
                      const token = ++saveToken;
                      saved = { key, status };
                      void invalidateAll().finally(() => {
                        if (saveToken === token) saved = null;
                      });
                    }}
                  />
                {/key}
              </td>
              <td class="hidden whitespace-nowrap px-4 py-3 text-faint tabular-nums lg:table-cell">{r.date}</td>
            </tr>
          {/each}
        </tbody>
        {#if isPending}
          <tbody class="divide-y divide-border" aria-busy="true">
            <PipelineTableRows trackerColumn />
          </tbody>
        {/if}
      </table>
    </div>
  {:else}
    <div class="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
      <p class="font-display text-lg">No matches</p>
      <p class="mx-auto mt-1 max-w-sm text-sm text-muted">Try a different tab or clear the search.</p>
    </div>
  {/if}
</div>
