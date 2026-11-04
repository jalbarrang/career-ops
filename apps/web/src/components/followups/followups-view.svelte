<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { CalendarClock, ChevronDown, ChevronRight, Loader2, Pin, Search, Trash2 } from "@lucide/svelte";
  import { Badge } from "@/components/ui/badge";
  import CompanyLogo from "@/components/company-logo.svelte";
  import LogDialog from "@/components/followups/log-dialog.svelte";
  import QuietCompanies from "@/components/followups/quiet-companies.svelte";
  import NextDateDialog from "@/components/followups/next-date-dialog.svelte";
  import { scoreTone } from "@/lib/format";
  import {
    type CadenceEntry,
    type CadenceMetadata,
    daysHeatClass,
    followupStatusTone,
    oxfordJoin,
    relativeDays,
    urgencyRank,
    urgencyTone,
  } from "@/lib/followups";
  import { cn } from "@/lib/cn";
  import FollowupsTableRows from "@/components/page-loading-skeletons/followups-table-rows.svelte";
  import { startRouteProgress } from "@/components/route-progress.svelte";

  // The /followups tracker: WHO needs a nudge today, HOW urgent, WHEN the next
  // touch is due, and the permanent history of every follow-up sent. The verdict
  // is the core's packages/core/src/outreach/followup-cadence.ts (via /api/followups?full=1) — this view
  // only filters, sorts, and records.

  const URGENCY_TABS = ["ALL", "OVERDUE", "URGENT", "WAITING", "COLD"] as const;
  type UrgencyTab = (typeof URGENCY_TABS)[number];

  const COLUMNS = [
    { key: "company", label: "Company" },
    { key: "role", label: "Role" },
    { key: "score", label: "Score" },
    { key: "status", label: "Status" },
    { key: "urgency", label: "Urgency" },
    { key: "days", label: "Days since app" },
    { key: "next", label: "Next follow-up" },
    { key: "count", label: "Follow-ups done" },
    { key: "since", label: "Days since F/U" },
  ] as const;
  type SortKey = (typeof COLUMNS)[number]["key"];
  const SORT_KEYS: readonly string[] = COLUMNS.map((c) => c.key);

  /** Sortable value per column; null means "always last, either direction". */
  function sortVal(e: CadenceEntry, key: SortKey): string | number | null {
    switch (key) {
      case "company":
        return e.company.toLowerCase();
      case "role":
        return e.role.toLowerCase();
      case "score": {
        const m = e.score?.match(/(\d+(?:\.\d+)?)/);
        return m ? parseFloat(m[1]) : null;
      }
      case "status":
        return e.status;
      case "urgency":
        // Severity, not alphabetical: negate rank so DESCENDING (▼, the first
        // click) puts the most pressing first — matching how the ▼ glyph reads.
        return -urgencyRank(e.urgency);
      case "days":
        return e.daysSinceApplication;
      case "next":
        return e.daysUntilNext;
      case "count":
        return e.followupCount;
      case "since":
        return e.daysSinceLastFollowup;
    }
  }

  type CadenceResponse = {
    available: boolean;
    metadata: CadenceMetadata | null;
    entries: CadenceEntry[];
  };

  let data = $state<CadenceResponse | null>(null);
  let expanded = $state<Set<number>>(new Set());
  let dialogFor = $state<CadenceEntry | null>(null);
  let pinFor = $state<CadenceEntry | null>(null);
  let actionError = $state<string | null>(null);
  // The React view wrapped URL writes in useTransition and swapped the table body
  // for skeleton rows while the new params rendered.
  let pending = $state(false);

  async function refetch(): Promise<void> {
    try {
      const r = await fetch("/api/followups?full=1");
      data = (await r.json()) as CadenceResponse;
    } catch {
      data = { available: false, metadata: null, entries: [] };
    }
  }
  onMount(() => {
    void refetch();
  });

  // URL is the source of truth for tab/sort/dir (Pipeline convention); search
  // stays local for snappy typing, seeded from the URL. No sort param → the
  // engine's own order (most pressing first) and all headers show ⇅.
  const pTab = $derived((page.url.searchParams.get("urgency") ?? "").toUpperCase());
  const tab: UrgencyTab = $derived((URGENCY_TABS as readonly string[]).includes(pTab) ? (pTab as UrgencyTab) : "ALL");
  const pSort = $derived(page.url.searchParams.get("sort") ?? "");
  const sortKey: SortKey | null = $derived(SORT_KEYS.includes(pSort) ? (pSort as SortKey) : null);
  const dir: 1 | -1 = $derived(page.url.searchParams.get("dir") === "-1" ? -1 : 1);

  let q = $state(page.url.searchParams.get("q") ?? "");
  let lastUrlQ = page.url.searchParams.get("q") ?? "";
  $effect(() => {
    const urlQ = page.url.searchParams.get("q") ?? "";
    if (urlQ !== lastUrlQ) {
      lastUrlQ = urlQ;
      q = urlQ;
    }
  });

  async function setParams(updates: Record<string, string | number | null>): Promise<void> {
    const current = page.url.searchParams.toString();
    const sp = new URLSearchParams(current);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") sp.delete(k);
      else sp.set(k, String(v));
    }
    const qs = sp.toString();
    if (qs === current) return;
    startRouteProgress();
    pending = true;
    try {
      // router.replace(..., { scroll: false }) → replace + reset: false.
      await goto(`${page.url.pathname}${qs ? `?${qs}` : ""}`, { replace: true, reset: false });
    } finally {
      pending = false;
    }
  }

  const entries = $derived(data?.available ? data.entries : []);
  const meta = $derived(data && data.available ? data.metadata : null);

  const filtering = $derived(tab !== "ALL" || q.trim().length > 0);
  const filtered = $derived.by(() => {
    let rows = entries;
    if (tab !== "ALL") rows = rows.filter((e) => e.urgency.toUpperCase() === tab);
    if (q.trim()) {
      const needle = q.toLowerCase();
      rows = rows.filter((e) => `${e.company} ${e.role}`.toLowerCase().includes(needle));
    }
    const key = sortKey;
    if (!key) return rows; // engine order: most pressing first
    return [...rows].sort((a, b) => {
      const av = sortVal(a, key);
      const bv = sortVal(b, key);
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls last, either direction
      if (bv == null) return -1;
      if (typeof av === "string" && typeof bv === "string") return av.localeCompare(bv) * dir;
      return (Number(av) - Number(bv)) * dir;
    });
  });

  async function removeLogged(num: number): Promise<void> {
    actionError = null;
    try {
      const res = await fetch("/api/followups/log", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ num }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        actionError =
          typeof j.error === "string" ? `Couldn't remove the follow-up: ${j.error}` : "Couldn't remove the follow-up.";
      }
    } catch {
      actionError = "Couldn't remove the follow-up.";
    }
    await refetch();
  }

  function toggleExpand(num: number): void {
    const next = new Set(expanded);
    if (next.has(num)) next.delete(num);
    else next.add(num);
    expanded = next;
  }

  /** The one-sentence "what to do first" card payload — only when something is
   *  due and no filter narrows the view (spec: hidden while any filter/search is
   *  active). */
  const narrative = $derived.by(() => {
    if (!meta) return null;
    const due = meta.overdue + meta.urgent;
    if (due <= 0) return null;

    const pressing = [...entries]
      .filter((e) => e.urgency === "overdue" || e.urgency === "urgent")
      .sort((a, b) => urgencyRank(a.urgency) - urgencyRank(b.urgency) || b.daysSinceApplication - a.daysSinceApplication)
      .slice(0, 4);

    const parts: string[] = [];
    if (meta.overdue > 0) parts.push(`Overdue follow-ups: ${meta.overdue}`);
    if (meta.urgent > 0) parts.push(`Urgent: ${meta.urgent}`);
    if (pressing.length > 0) {
      parts.push(`most pressing today: ${oxfordJoin(pressing.map((e) => `${e.company} (#${e.num})`))}`);
      const days = pressing.map((e) => e.daysSinceApplication);
      const max = Math.max(...days);
      parts.push(days.every((d) => d === max) ? `all ${max} days since applied` : `up to ${max} days since applied`);
    }

    return { text: parts.join(" — "), overdue: meta.overdue > 0 };
  });
</script>

{#snippet narrativeCard()}
  {#if narrative}
    <div
      class={cn(
        "mt-5 rounded-xl border border-border border-l-4 bg-surface/40 px-4 py-3 text-sm text-muted",
        narrative.overdue ? "border-l-red-500" : "border-l-amber-500",
      )}
    >
      {narrative.text}
    </div>
  {/if}
{/snippet}

{#snippet emptyPanel(title: string, body: string)}
  <div class="mt-4 rounded-2xl border border-dashed border-border bg-surface/30 px-6 py-12 text-center">
    <p class="font-display text-lg">{title}</p>
    <p class="mx-auto mt-1 max-w-md text-sm text-muted">{body}</p>
  </div>
{/snippet}

{#snippet historyPanel(e: CadenceEntry)}
  {@const history = e.followups ?? []}
  <div class="space-y-2 pl-7 text-sm">
    {#if history.length === 0}
      <p class="text-faint">No follow-ups logged yet.</p>
    {:else}
      <ul class="space-y-1.5">
        {#each history as f, i (`${f.num ?? "b"}-${f.date}-${i}`)}
          <li class="group/item flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <!-- Fixed-width leading slot keeps every entry's text aligned,
                 whether or not it is deletable (legacy bullets carry no num). -->
            <span class="inline-flex w-5 shrink-0 justify-center self-center">
              {#if f.num != null}
                <button
                  type="button"
                  onclick={() => void removeLogged(f.num as number)}
                  title="Remove this logged follow-up (added by mistake?)"
                  aria-label={`Remove follow-up logged ${f.date}`}
                  class="rounded p-0.5 text-faint opacity-0 transition group-hover/item:opacity-100 hover:text-red-500 focus-visible:opacity-100"
                >
                  <Trash2 class="size-3.5" />
                </button>
              {/if}
            </span>
            <span class="tabular-nums text-muted">{f.date}</span>
            <Badge tone="muted">{f.channel}</Badge>
            {#if f.contact}<span class="text-muted">{f.contact}</span>{/if}
            {#if f.notes}<span class="text-faint">{f.notes}</span>{/if}
          </li>
        {/each}
      </ul>
    {/if}
    {#if e.contacts.length > 0}
      <p class="text-xs text-faint">
        Suggested contacts:{" "}
        {#each e.contacts as c, i (c.email)}{#if i > 0}<span>, </span>{/if}<a
            href={`mailto:${c.email}`}
            class="text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-brand"
          >{c.name ? `${c.name} <${c.email}>` : c.email}</a
          >{/each}
      </p>
    {/if}
  </div>
{/snippet}

{#snippet followupRow(e: CadenceEntry)}
  {@const statusLabel = e.status.charAt(0).toUpperCase() + e.status.slice(1)}
  {@const isExpanded = expanded.has(e.num)}
  <tr class="group transition-colors hover:bg-surface/40">
    <td class="px-2 py-3">
      <button
        type="button"
        onclick={() => toggleExpand(e.num)}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? "Hide" : "Show"} follow-up history for ${e.company}`}
        class="rounded p-1 text-faint transition hover:text-foreground"
      >
        {#if isExpanded}
          <ChevronDown class="size-4" />
        {:else}
          <ChevronRight class="size-4" />
        {/if}
      </button>
    </td>
    <td class="px-2.5 py-3 font-medium">
      {#if e.reportPath}
        <a href={`/pipeline/${e.num}`} class="flex items-center gap-2.5 transition-colors group-hover:text-brand">
          <CompanyLogo name={e.company} size={20} />
          {e.company}
        </a>
      {:else}
        <span class="flex items-center gap-2.5">
          <CompanyLogo name={e.company} size={20} />
          {e.company}
        </span>
      {/if}
    </td>
    <td class="max-w-56 truncate px-2.5 py-3 text-muted">{e.role}</td>
    <td class="px-2.5 py-3">
      <Badge tone={scoreTone(e.score)}>{e.score || "—"}</Badge>
    </td>
    <td class="px-2.5 py-3">
      <Badge tone={followupStatusTone(e.status)}>{statusLabel}</Badge>
    </td>
    <td class="px-2.5 py-3">
      <Badge tone={urgencyTone(e.urgency)}>{e.urgency}</Badge>
    </td>
    <td class={cn("px-2.5 py-3 tabular-nums", daysHeatClass(e.daysSinceApplication))}>{e.daysSinceApplication}</td>
    <td class="whitespace-nowrap px-2.5 py-3">
      {#if e.daysUntilNext == null}
        <span class="text-faint">—</span>
      {:else}
        <span
          class={cn(e.daysUntilNext < 0 && "font-medium text-red-600 dark:text-red-400")}
          title={e.nextFollowupDate ?? undefined}>{relativeDays(e.daysUntilNext)}</span
        >
      {/if}
      {#if e.nextOverride}
        <span
          class="ml-1.5 inline-flex align-[-1px]"
          title={`Pinned to ${e.nextOverride} — cleared when you log a follow-up`}
          aria-label="Pinned manually"
        >
          <Pin class="size-3 text-brand" />
        </span>
      {/if}
    </td>
    <td class="px-2.5 py-3 tabular-nums">{e.followupCount}</td>
    <td class={cn("px-2.5 py-3 tabular-nums", daysHeatClass(e.daysSinceLastFollowup))}>
      {#if e.daysSinceLastFollowup == null}
        <span class="text-faint">—</span>
      {:else}
        {e.daysSinceLastFollowup}
      {/if}
    </td>
    <td class="whitespace-nowrap px-2.5 py-3">
      <span class="inline-flex items-center gap-0.5">
        <button
          type="button"
          onclick={() => (dialogFor = e)}
          title="Log a follow-up (date, channel, contact, notes)"
          class="rounded-md px-2 py-1 text-xs font-medium text-muted transition-colors hover:bg-brand-soft hover:text-brand"
        >
          Log
        </button>
        <button
          type="button"
          onclick={() => (pinFor = e)}
          title={e.nextOverride ? `Next date pinned to ${e.nextOverride} — change or clear` : "Pin a custom next follow-up date"}
          class={cn(
            "rounded-md p-1 transition-colors hover:bg-brand-soft hover:text-brand",
            e.nextOverride ? "text-brand" : "text-faint",
          )}
        >
          <CalendarClock class="size-3.5" />
        </button>
      </span>
    </td>
  </tr>
  {#if isExpanded}
    <tr class="bg-surface/30">
      <td colSpan={COLUMNS.length + 2} class="px-4 py-3">
        {@render historyPanel(e)}
      </td>
    </tr>
  {/if}
{/snippet}

<div class="mx-auto max-w-none px-6 py-8">
  <div class="flex items-end justify-between gap-4">
    <div>
      <h1 class="font-display text-2xl tracking-tight text-landing">Follow-up Tracker</h1>
      <p class="mt-1 text-sm text-muted">
        {#if !data}
          <span class="inline-flex items-center gap-1.5">
            <Loader2 class="size-3.5 animate-spin" /> Computing cadence…
          </span>
        {:else if !data.available || !meta}
          Cadence unavailable
        {:else}
          <span class="tabular-nums">{meta.actionable}</span> active ·{" "}
          <span class="tabular-nums">{meta.urgent}</span> urgent ·{" "}
          <span class="tabular-nums">{meta.overdue}</span> overdue
        {/if}
      </p>
    </div>
    <div class="relative w-56 max-w-[35vw]">
      <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
      <input
        value={q}
        oninput={(e) => (q = e.currentTarget.value)}
        placeholder="Search company or role…"
        class="w-full rounded-md border border-border bg-surface/60 py-2 pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
      />
    </div>
  </div>

  {#if meta && !filtering}{@render narrativeCard()}{/if}

  <!-- urgency filter -->
  <div class="mt-6 flex flex-wrap gap-1 border-b border-border">
    {#each URGENCY_TABS as t (t)}
      {@const count = t === "ALL" ? entries.length : entries.filter((e) => e.urgency.toUpperCase() === t).length}
      <button
        onclick={() => void setParams({ urgency: t === "ALL" ? null : t })}
        class={cn(
          "-mb-px border-b-2 px-3 py-2 text-xs font-medium transition-colors",
          tab === t ? "border-brand text-foreground" : "border-transparent text-muted hover:text-foreground",
        )}
      >
        {t} <span class="text-faint tabular-nums">{count}</span>
      </button>
    {/each}
  </div>

  {#if actionError}<p class="mt-3 text-xs text-red-500">{actionError}</p>{/if}

  {#if data}
    {#if !data.available}
      {@render emptyPanel(
        "Cadence unavailable",
        "The cadence engine (packages/core/src/outreach/followup-cadence.ts) returned nothing — check that the core scripts are present.",
      )}
    {:else if !pending && filtered.length === 0}
      {#if filtering}
        {@render emptyPanel("No matches", "Try a different urgency filter or clear the search.")}
      {:else}
        {@render emptyPanel(
          "Nothing to chase",
          "No active applications need a follow-up. Apply to roles (or update statuses) and the cadence starts tracking them.",
        )}
      {/if}
    {:else}
      <div class="mt-4 overflow-x-auto rounded-2xl border border-border">
        <table class="w-full min-w-[880px] text-sm">
          <thead class="bg-surface/60 text-left text-xs uppercase tracking-wide text-faint">
            <tr>
              <th class="w-8 px-2 py-2.5" aria-label="Expand"></th>
              {#each COLUMNS as c (c.key)}
                {@const active = sortKey === c.key}
                <th aria-sort={active ? (dir === 1 ? "ascending" : "descending") : "none"} class="px-2.5 py-2.5 font-medium">
                  <button
                    type="button"
                    class="inline-flex cursor-pointer select-none items-center gap-1 uppercase tracking-wide hover:text-foreground"
                    onclick={() =>
                      void setParams({ sort: c.key, dir: active ? dir * -1 : c.key === "urgency" ? -1 : 1 })}
                  >
                    {c.label}
                    <span aria-hidden="true" class={cn(!active && "text-faint")}>
                      {active ? (dir === 1 ? "▲" : "▼") : "⇅"}
                    </span>
                  </button>
                </th>
              {/each}
              <th class="px-2.5 py-2.5 font-medium">Action</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border" aria-busy={pending}>
            {#if pending}
              <FollowupsTableRows />
            {:else}
              {#each filtered as e (e.num)}
                {@render followupRow(e)}
              {/each}
            {/if}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}

  <!-- Below the due list: a follow-up you can still send outranks a company
       that has already stopped replying. -->
  <QuietCompanies />

  {#if dialogFor}
    <LogDialog entry={dialogFor} onclose={() => (dialogFor = null)} onlogged={() => void refetch()} />
  {/if}
  {#if pinFor}
    <NextDateDialog entry={pinFor} onclose={() => (pinFor = null)} onchanged={() => void refetch()} />
  {/if}
</div>
