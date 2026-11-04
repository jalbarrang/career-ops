<script lang="ts">
  import { onMount } from "svelte";
  import type { Snippet } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { ArrowRight, Bell, CircleQuestionMark, Sparkles } from "@lucide/svelte";
  import { instrumentSerif } from "@/lib/fonts";
  import type { Application, InboxJob } from "@/lib/career-ops";
  import type { DiscoveredOffer } from "@/lib/explore";
  import { scoreNum } from "@/lib/format";
  import { pickAwaitingDecision } from "@/lib/home/awaiting.ts";
  import HeroGlow from "@/components/hero-glow.svelte";
  import DiscoveryCard from "@/components/explore/discovery-card.svelte";
  import FollowUpCard, { type FollowUp } from "@/components/home/follow-up-card.svelte";
  import DecisionCard from "@/components/home/decision-card.svelte";
  import QuickEvaluate from "@/components/quick-evaluate.svelte";
  import FollowupsDueSectionSkeleton from "@/components/page-loading-skeletons/followups-due-section.svelte";

  // Response shapes of the two client loops. Both routes answer with `available`
  // and `metadata` even when the underlying engine fails, so every field is
  // optional and every absence is handled below.
  type FollowupsResponse = {
    available?: boolean;
    metadata?: { overdue?: number; urgent?: number } | null;
    entries?: FollowUp[];
    nextUpcoming?: FollowUp | null;
  };
  type WhatsNewResponse = { offers?: DiscoveredOffer[]; count?: number };

  // The retention "Today": a dual-loop action queue (the maintainer's
  // "N new matches this week · M follow-ups due"). SUPPLY loop = fresh free-scan
  // matches (zero tokens, /api/whats-new); DEMAND loop = follow-ups due
  // (/api/followups). Each item one-tap actionable. Home stays a VIEW over the
  // canonical files — every action dispatches a real registry action / route.
  let {
    applications,
    inbox,
    inBetween,
  }: { applications: Application[]; inbox: Pick<InboxJob, "url" | "done">[]; inBetween: boolean } = $props();

  let followups = $state<FollowUp[]>([]);
  let overdue = $state(0);
  let followupsLoading = $state(true);
  let followupsError = $state(false);
  let nextUpcoming = $state<FollowUp | null>(null);
  let fresh = $state<DiscoveredOffer[]>([]);
  let freshCount = $state(0);
  let freshLoading = $state(true);
  let freshError = $state(false);
  // Bumped per refetch so a slow earlier response can never overwrite a newer one.
  let requestGeneration = 0;
  // Computed once, like the React useMemo([]) it replaces.
  const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });

  function refetch(): void {
    const generation = ++requestGeneration;
    const isLatest = (): boolean => generation === requestGeneration;

    followupsLoading = true;
    followupsError = false;
    void fetch("/api/followups")
      .then((r) => {
        if (!r.ok) throw new Error("Follow-ups request failed");
        return r.json();
      })
      .then((raw: unknown) => {
        if (!isLatest()) return;
        const d = raw as FollowupsResponse;
        // The cadence route reports engine failures as HTTP 200 with
        // available:false; that is unavailable, not an empty action queue.
        if (d.available === false) throw new Error("Follow-ups unavailable");
        // /api/followups already filters to urgency 'urgent'/'overdue' — due
        // now, never 'waiting'/'cold' (#86). Both count toward "due"; a
        // missing metadata.overdue must read as 0 due, never as "every entry
        // is overdue" (the old `?? d.entries?.length` fallback).
        followups = Array.isArray(d.entries) ? d.entries : [];
        overdue = (d.metadata?.overdue ?? 0) + (d.metadata?.urgent ?? 0);
        nextUpcoming = d.nextUpcoming ?? null;
      })
      .catch(() => {
        if (isLatest()) followupsError = true;
      })
      .finally(() => {
        if (isLatest()) followupsLoading = false;
      });

    freshLoading = true;
    freshError = false;
    void fetch("/api/whats-new")
      .then((r) => {
        if (!r.ok) throw new Error("Fresh matches request failed");
        return r.json();
      })
      .then((raw: unknown) => {
        if (!isLatest()) return;
        const d = raw as WhatsNewResponse;
        const offers = Array.isArray(d.offers) ? d.offers : [];
        const count = Number(d.count);
        fresh = offers;
        freshCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : offers.length;
      })
      .catch(() => {
        if (isLatest()) freshError = true;
      })
      .finally(() => {
        if (isLatest()) freshLoading = false;
      });
  }

  onMount(() => {
    refetch();
    // A worker (evaluate/pdf) just wrote a real tracker row — refresh the server
    // snapshot (applications/inbox props) + the client loops so the freshly-scored
    // role appears in "Awaiting your decision" without a manual reload.
    const onDone = () => {
      void invalidateAll();
      refetch();
    };
    window.addEventListener("co-job-done", onDone);
    return () => {
      window.removeEventListener("co-job-done", onDone);
      requestGeneration += 1;
    };
  });

  // Awaiting decision: scored (Evaluated) but no terminal status yet. The
  // ordering lives in lib/home/awaiting.ts so it can be tested — see the file
  // for why "first six in the array" was a bug waiting for #3529.
  const awaiting = $derived(pickAwaitingDecision(applications, scoreNum));

  const newThisWeek = $derived(freshCount);
  const dataLoading = $derived(followupsLoading || freshLoading);
  const dataError = $derived(followupsError || freshError);
  const allClear = $derived(!dataLoading && !dataError && newThisWeek === 0 && overdue === 0 && awaiting.length === 0);
  const inboxUrls = $derived(new Set(inbox.map((j) => j.url)));
</script>

{#snippet section(Icon: typeof Bell, title: string, hint: string, content: Snippet)}
  <section class="mt-10">
    <div class="mb-3 flex items-center gap-2">
      <Icon class="size-4 text-brand" />
      <h2 class="text-sm font-semibold uppercase tracking-[0.16em] text-muted">{title}</h2>
      <span class="text-xs text-faint">· {hint}</span>
    </div>
    {@render content()}
  </section>
{/snippet}

{#snippet followupsContent()}
  <div class="grid gap-2.5">
    {#each followups as f (`${f.num}-${f.company}`)}
      <!-- Refetch (not a local decrement) so the parent's followups/nextUpcoming
           stay in sync with the server — logging the LAST due item must flip this
           section over to "Next follow-up" instead of leaving it empty. -->
      <FollowUpCard followup={f} onLogged={refetch} />
    {/each}
  </div>
{/snippet}

{#snippet nextFollowupContent()}
  {#if nextUpcoming}
    <!-- Nothing is due — say so honestly instead of an empty "due" block,
         but still surface what's next so the queue isn't silent (#86). -->
    <p class="text-sm text-muted">
      <span class="font-medium text-foreground">{nextUpcoming.company}</span>
      {#if nextUpcoming.role}<span> · {nextUpcoming.role}</span>{/if}
      {#if nextUpcoming.nextFollowupDate}<span class="text-faint"> — upcoming {nextUpcoming.nextFollowupDate}</span>{/if}
    </p>
  {/if}
{/snippet}

{#snippet awaitingContent()}
  <div class="grid gap-2.5 sm:grid-cols-2">
    {#each awaiting as a (a.n)}
      <DecisionCard app={a} />
    {/each}
  </div>
{/snippet}

{#snippet freshContent()}
  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {#each fresh.slice(0, 6) as o (o.url)}
      <DiscoveryCard offer={o} inPipeline={inboxUrls.has(o.url)} />
    {/each}
  </div>
  {#if fresh.length > 6}
    <a
      href="/explore?view=fresh"
      class="mt-3 inline-flex items-center text-sm text-muted transition hover:text-brand max-sm:min-h-[44px]"
    >
      See all {freshCount} →
    </a>
  {/if}
{/snippet}

<div class="mx-auto max-w-5xl px-6 py-10 max-sm:pb-24">
  <section class="dot-bg relative overflow-hidden rounded-2xl border border-border bg-surface/40 px-7 py-10 md:px-10 md:py-12">
    <HeroGlow />
    <!-- Readability scrim between the animated glow (z-0) and the copy (z-10). -->
    <div aria-hidden="true" class="pointer-events-none absolute inset-0 z-[1] bg-surface/55 backdrop-blur-[2px] dark:bg-background/45"></div>
    <div class="relative z-10">
      <p class="font-mono text-xs uppercase tracking-[0.2em] text-muted">
        <span class="text-faint">//</span> today · <span class="tabular-nums">{dateLabel}</span>
      </p>
      <h1 class="{instrumentSerif.className} mt-3 text-4xl leading-[1.05] text-landing md:text-5xl">
        {#if dataLoading}
          Your career queue is loading.
        {:else if dataError}
          Some updates are unavailable.
        {:else if allClear}
          You're all caught up.
        {:else}
          {#if newThisWeek > 0}
            <span class="text-brand tabular-nums">{newThisWeek}</span> new match{newThisWeek === 1 ? "" : "es"} this week
          {/if}
          {#if newThisWeek > 0 && overdue > 0}<span class="text-faint"> · </span>{/if}
          {#if overdue > 0}
            <span class="text-brand tabular-nums">{overdue}</span> follow-up{overdue === 1 ? "" : "s"} due
          {/if}
        {/if}
      </h1>
      <p class="mt-4 max-w-xl text-sm text-muted">
        {dataError
          ? "We couldn't load all of today's updates. Try again."
          : allClear
            ? "I'll keep scanning the market in the background and surface anything that fits."
            : "Your action queue for today — discovery and follow-ups, in one place."}
      </p>
      <div class="mt-6 flex flex-wrap gap-2.5">
        <a
          href="/explore"
          class="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground transition hover:bg-brand-200 max-sm:min-h-[44px]"
        >
          Find new roles <ArrowRight class="size-4" />
        </a>
        <a
          href="/pipeline"
          class="inline-flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
        >
          Open pipeline
        </a>
      </div>
      {#if inBetween}<QuickEvaluate />{/if}
    </div>
  </section>

  {#if dataError && !dataLoading}
    <div
      role="alert"
      class="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 px-5 py-4 text-sm text-muted"
    >
      <p>
        {followupsError && freshError ? "Follow-ups and fresh matches" : followupsError ? "Follow-ups" : "Fresh matches"} could not be loaded.
      </p>
      <button type="button" onclick={refetch} class="font-medium text-brand hover:underline">Retry updates</button>
    </div>
  {/if}

  <!-- A. Follow-ups due (demand loop) -->
  {#if followupsLoading}
    <FollowupsDueSectionSkeleton />
  {:else if !followupsError && followups.length > 0}
    {@render section(Bell, "Follow-ups due", "Keep your applications alive — a nudge beats silence", followupsContent)}
  {:else if !followupsError && nextUpcoming}
    {@render section(Bell, "Next follow-up", "Nothing due yet", nextFollowupContent)}
  {/if}

  <!-- B. Awaiting your decision -->
  {#if awaiting.length > 0}
    {@render section(CircleQuestionMark, "Awaiting your decision", "Scored — apply or skip", awaitingContent)}
  {/if}

  <!-- C. Fresh matches this week (supply loop) -->
  {#if !freshError && fresh.length > 0}
    {@render section(Sparkles, "Fresh matches this week", "Found by your free scans · 0 tokens", freshContent)}
  {/if}

  {#if allClear}
    <div class="mt-8 rounded-2xl border border-border bg-surface/30 px-6 py-10 text-center">
      <Sparkles class="mx-auto size-6 text-brand" />
      <p class="mx-auto mt-3 max-w-md text-sm text-muted">
        Nothing needs you right now. Run a <a href="/explore" class="text-brand hover:underline">free scan</a> to surface
        this week's roles, or check your <a href="/pipeline" class="text-brand hover:underline">pipeline</a>.
      </p>
    </div>
  {/if}
</div>
