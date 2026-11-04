<script lang="ts">
  import { Check, Coins, ExternalLink, Loader2, Plus, ShieldQuestion, Sparkles } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import { instrumentSerif } from "@/lib/fonts";
  import { ATS_LABEL, type AtsSource, type DiscoveredOffer } from "@/lib/explore";
  import { useJobs } from "@/lib/jobs.svelte";
  import { useExplore } from "@/lib/explore.svelte";
  import CompanyLogo from "./company-logo.svelte";

  function freshness(postedAt: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(postedAt)) return "";
    const days = Math.max(0, Math.round((Date.now() - new Date(postedAt + "T00:00:00Z").getTime()) / 86_400_000));
    return days === 0 ? "today" : days === 1 ? "1d ago" : `${days}d ago`;
  }

  // What a running worker is doing on this exact posting → the live CTA label.
  const WORKER_LABEL: Record<string, string> = { evaluate: "Evaluating…", pdf: "Preparing CV…", research: "Researching…", apply: "Filling…" };

  let { offer, inPipeline, evaluatedN }: { offer: DiscoveredOffer; inPipeline: boolean; evaluatedN?: string } = $props();

  const explore = useExplore();
  const jobsStore = useJobs();

  // GLOBAL worker awareness: any worker acting on this URL drives the CTA, here
  // and on every other surface that renders this offer (the jobs store is global).
  const job = $derived(
    jobsStore.jobs.filter((j) => j.input === offer.url).sort((a, b) => b.startedAt - a.startedAt)[0],
  );
  const working = $derived(job?.status === "running");
  const doneEval = $derived(job?.status === "done" && job?.kind === "evaluate");
  const statusLabel = $derived(WORKER_LABEL[job?.kind ?? ""] ?? "Working…");

  const isAdded = $derived(explore.added.has(offer.url) || inPipeline || working || doneEval);
  const isAdding = $derived(explore.adding.has(offer.url));
  const unverified = $derived(offer.verification === "unconfirmed");
  const fresh = $derived(freshness(offer.postedAt) || offer.postedHint || "");

  function evaluate(): void {
    void explore.addToPipeline([offer]); // evaluating implies it's in the pipeline — record it
    jobsStore.startJob({ title: `Evaluate · ${offer.company}`, subtitle: offer.title, kind: "evaluate", input: offer.url, page: "/explore" });
  }
</script>

<div class="co-rise group flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-surface/40 p-3.5 text-left transition-all hover:-translate-y-0.5 hover:border-brand/30 hover:shadow-sm">
  <div class="flex items-start gap-3">
    <CompanyLogo company={offer.company} />
    <a href={offer.url} target="_blank" rel="noopener noreferrer" class="block min-w-0 flex-1 max-sm:min-h-[44px]">
      <h3 class="{instrumentSerif.className} truncate text-[17px] leading-tight text-foreground transition-colors group-hover:text-brand">{offer.title}</h3>
      <p class="mt-0.5 truncate text-[13px] text-muted">
        {offer.company}
        {#if offer.location}<span class="text-faint"> · {offer.location}</span>{/if}
      </p>
    </a>
    <a
      href={offer.url}
      target="_blank"
      rel="noopener noreferrer"
      title="Open the posting"
      aria-label="Open the posting"
      class="-m-1 inline-flex shrink-0 items-center justify-center rounded p-1 text-faint transition-colors hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
    >
      <ExternalLink class="size-4" />
    </a>
  </div>

  <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
    <span class="rounded border border-border px-1.5 py-0.5 font-medium text-muted">{ATS_LABEL[offer.ats as AtsSource] ?? offer.ats}</span>
    {#if fresh}<span class="text-faint">{fresh}</span>{/if}
    {#if unverified}
      <span
        class="inline-flex items-center gap-1 rounded border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 font-medium text-amber-600 dark:text-amber-300"
        title="Found by AI on the public web — we can't confirm it's still live without opening it. Evaluating runs a real browser check and sets the verdict."
      >
        <ShieldQuestion class="size-3" /> unverified
      </span>
    {/if}
    {#if offer.matchedKeyword}
      <span class="text-faint" title="Keyword match — not yet scored. Evaluate to get an A–F fit score.">
        · matched <span class="text-brand/80">{offer.matchedKeyword}</span>
      </span>
    {/if}
    {#if offer.fit}
      <span
        class={cn(
          "rounded border px-1 py-0.5 text-[11px] font-medium",
          offer.fit.band === "strong" ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "text-faint",
        )}
        title="Free keyword-level estimate: posting title vs your profile's target roles (config/profile.yml). Not an evaluation — Evaluate still gives the real A–F fit score."
      >
        · {offer.fit.band} fit
      </span>
    {/if}
  </div>

  {#if offer.why}
    <p class="flex items-start gap-1.5 text-[12px] leading-snug text-brand/80">
      <Sparkles class="mt-0.5 size-3 shrink-0" />
      {offer.why}
    </p>
  {/if}

  <div class="mt-0.5">
    {#if evaluatedN || doneEval}
      <a
        href={evaluatedN ? `/pipeline/${evaluatedN}` : job ? `/jobs/${job.id}` : "/pipeline"}
        class="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-brand-soft px-2.5 py-2 text-xs font-medium text-brand max-sm:min-h-[44px]"
      >
        <Check class="size-3.5" /> Evaluated · view report
      </a>
    {:else if working}
      <div class="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-brand/30 bg-brand-soft/60 px-2.5 py-2 text-xs font-medium text-brand">
        <Loader2 class="size-3.5 animate-spin" />
        {statusLabel}
        <span class="text-brand/60">· in pipeline</span>
      </div>
    {:else}
      <div class="flex items-center gap-2">
        <button
          type="button"
          disabled={isAdded || isAdding}
          onclick={() => void explore.addToPipeline([offer])}
          class={cn(
            "inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-2 text-xs font-medium transition-colors max-sm:min-h-[44px]",
            isAdded ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-surface-hover text-foreground hover:bg-brand-soft hover:text-brand",
          )}
        >
          {#if isAdding}<Loader2 class="size-3.5 animate-spin" />{:else if isAdded}<Check class="size-3.5" />{:else}<Plus class="size-3.5" />{/if}
          {isAdded ? "In pipeline" : "Add to pipeline"}
        </button>
        <button
          type="button"
          onclick={evaluate}
          title={unverified ? "Runs a real evaluation — and verifies the posting is live. Uses tokens." : "Runs a real A–F evaluation. Uses tokens."}
          class="inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-brand/30 px-2.5 py-2 text-xs font-medium text-brand transition-colors hover:bg-brand-soft max-sm:min-h-[44px]"
        >
          Evaluate <Coins class="size-3.5 opacity-80" />
        </button>
      </div>
    {/if}
  </div>
</div>
