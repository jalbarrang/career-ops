<script lang="ts">
  import { ArrowLeft, ChevronDown, ExternalLink, FileText } from "@lucide/svelte";
  import type { Application } from "@/lib/career-ops";
  import { Badge } from "@/components/ui/badge";
  import CompanyLogo from "@/components/company-logo.svelte";
  import ScoreMethodology from "@/components/score-methodology.svelte";
  import GeneratePdfButton from "@/components/generate-pdf-button.svelte";
  import ApplyButton from "@/components/apply-button.svelte";
  import ReportMarkdown from "@/components/report-markdown.svelte";
  // Tracker controls shared with the pipeline table; owned by the pipeline port.
  import StatusSelect from "@/components/status-select.svelte";
  import DeleteFromTracker from "@/components/delete-from-tracker.svelte";
  import { legitimacyTone, parseReport, scoreTone } from "@/lib/format";
  import {
    APPLY_LINE,
    applyCtaQuiet,
    applyLineLabel,
    cleanHeading,
    isLeadSection,
    isVerdictHeading,
    splitSections,
    verdictReason,
  } from "@/lib/report-sections.mjs";
  import { isStarTableHeader, parsePipeTable } from "@/lib/report-tables.mjs";
  import { companyPresentation } from "@/lib/company-presentation.mjs";

  // Progressive disclosure of the report. Current oferta.md writes letter F as
  // Interview Plan (STAR+R), not a verdict — never promote by letter (#3416).
  // The score + 4.0 apply line + legitimacy live in one Peak-End callout (#4203).
  // Block B (CV Match) stays open; everything else, including Role Summary and
  // STAR+R, is collapsed (#4205). Machine artifacts stay in the Technical tier.

  function isMachine(heading: string): boolean {
    return /machine summary|submitted|submit[-\s]?log/i.test(heading);
  }

  function httpUrl(url?: string | null): string | undefined {
    if (!url) return undefined;
    return /^https?:\/\//i.test(url) ? url : undefined;
  }

  function preview(md: string): string {
    const table = parsePipeTable(md);
    if (table && isStarTableHeader(table.header)) {
      const n = table.rows.length;
      return `${n} interview stor${n === 1 ? "y" : "ies"}`;
    }
    const text = md
      .replace(/^#+\s.*$/gm, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/[*_`>#|]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const sentence = text.split(/(?<=[.!?])\s/)[0] ?? text;
    return sentence.length > 96 ? sentence.slice(0, 96).trimEnd() + "…" : sentence;
  }

  let {
    id,
    app,
    report,
    canDelete = false,
    pdfReadyFromIndex = false,
    coverReady = false,
  }: {
    id: string;
    app: Application | null;
    report: string | null;
    /** kept in the props contract (the page passes it) but no longer surfaced —
     *  the raw .md filename is a dev artifact, not header content. */
    file?: string | null;
    canDelete?: boolean;
    pdfReadyFromIndex?: boolean;
    /** A tailored cover letter for THIS application exists in output/ (resolved by
     *  the page, see resolveTailoredCover). View only — covers are never generated
     *  from here. */
    coverReady?: boolean;
  } = $props();

  const meta = $derived(report ? parseReport(report) : null);
  const fieldValue = (label: string): string | undefined => meta?.fields.find((f) => f.label === label)?.value;
  const score = $derived(app?.score || fieldValue("Score"));
  const date = $derived(app?.date || fieldValue("Date"));
  const archetype = $derived(fieldValue("Archetype"));
  const url = $derived(fieldValue("URL"));
  const decision = $derived(fieldValue("Decision"));
  const line = $derived(applyLineLabel(score ?? ""));
  const recommended = $derived(line === "Recommended");
  const quietApply = $derived(applyCtaQuiet({ score, legitimacy: meta?.legitimacy }));
  const applyUrl = $derived(httpUrl(url));
  const pdfReady = $derived((app?.pdf ?? "").includes("✅") || pdfReadyFromIndex);
  const company = $derived(app ? companyPresentation(app) : null);
  const companyName = $derived(company?.label ?? app?.company ?? meta?.title ?? id);

  const split = $derived(splitSections(meta?.body ?? report ?? ""));
  const verdictSection = $derived(split.sections.find((s) => isVerdictHeading(s.heading)));
  const rest = $derived(split.sections.filter((s) => s !== verdictSection));
  const machine = $derived(rest.filter((s) => isMachine(s.heading)));
  const mainSections = $derived(rest.filter((s) => !isMachine(s.heading)));
  const reason = $derived(
    verdictReason({
      report: report ?? "",
      intro: split.intro,
      verdictContent: verdictSection?.content,
    }),
  );
  const verdictClass = $derived(recommended ? "border-brand/25 bg-brand-soft/50" : "border-border bg-surface/50");
</script>

<div class="mx-auto max-w-3xl px-6 py-8 xl:max-w-5xl 2xl:max-w-[1600px]">
  <a href="/pipeline" class="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
    <ArrowLeft class="size-4" /> Pipeline
  </a>

  <header class="mt-5">
    <p class="font-mono text-xs uppercase tracking-[0.18em] text-faint">#{id}</p>
    <div class="mt-2 flex items-center gap-3">
      <CompanyLogo name={company?.logoName ?? meta?.title ?? `Report #${id}`} size={40} />
      <h1 class="font-display text-3xl tracking-tight text-landing">
        {company?.label ?? meta?.title ?? `Report #${id}`}
      </h1>
    </div>
    {#if app?.role}
      <p class="mt-1 text-muted">{app.role}</p>
    {/if}

    <div class="mt-4 flex flex-wrap items-center gap-2.5">
      {#if app}
        <!-- Keyed on the row: the status editor keeps its own copy of `current`, so a
             reused component across report navigations must be rebuilt (the React
             version did the same with `key={props.n}` inside the component). -->
        {#key id}
          <StatusSelect n={id} current={app.status} />
        {/key}
      {/if}
      <GeneratePdfButton n={id} company={app?.company ?? meta?.title ?? id} {pdfReady} />
      {#if coverReady}
        <a
          href={`/api/cover-pdf?application=${encodeURIComponent(id)}`}
          target="_blank"
          rel="noreferrer"
          class="inline-flex items-center justify-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-400 max-sm:min-h-[44px]"
        >
          <FileText class="size-3.5" /> View cover
        </a>
      {/if}
    </div>

    {#if app && canDelete}
      <div class="mt-3">
        <DeleteFromTracker n={id} />
      </div>
    {/if}

    {#if archetype || date || applyUrl}
      <div class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        {#if archetype}
          <span class="max-w-full truncate">{archetype}</span>
        {/if}
        {#if date}
          <span class="tabular-nums text-faint">{date}</span>
        {/if}
        {#if applyUrl}
          <a
            href={applyUrl}
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center justify-center gap-1 text-brand hover:underline max-sm:min-h-[44px]"
          >
            posting <ExternalLink class="size-3" />
          </a>
        {/if}
      </div>
    {/if}
  </header>

  {#if report}
    <div class="mt-8">
      <div class={`rounded-2xl border px-5 py-5 ${verdictClass}`}>
        <p class="font-mono text-[11px] uppercase tracking-[0.16em] text-faint">Verdict</p>
        <div class="mt-2 flex flex-wrap items-end gap-x-3 gap-y-1">
          {#if score}
            <p class="font-display text-4xl tabular-nums tracking-tight text-landing">{score}</p>
          {:else}
            <p class="text-sm text-muted">No score on this report.</p>
          {/if}
          <p class="pb-1 text-xs text-muted">Apply line is {APPLY_LINE.toFixed(1)}</p>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          {#if score}
            <Badge tone={scoreTone(score)}>{score}</Badge>
          {/if}
          {#if line}
            <Badge tone={recommended ? "good" : "muted"}>{line}</Badge>
          {/if}
          {#if decision}
            <Badge tone="info">{decision}</Badge>
          {/if}
          {#if meta?.legitimacy}
            <Badge tone={legitimacyTone(meta.legitimacy)}>{meta.legitimacy}</Badge>
          {/if}
        </div>
        {#if reason}
          <p class="mt-4 text-[15px] font-medium leading-relaxed text-foreground">{reason}</p>
        {/if}
        <div class="mt-4">
          <ApplyButton n={id} url={applyUrl} company={companyName} {pdfReady} quiet={quietApply} />
        </div>
      </div>

      {#if split.sections.length === 0}
        <article class="report-prose mt-6">
          <ReportMarkdown children={meta?.body ?? report} />
        </article>
      {:else}
        {#each mainSections as s, i (i)}
          {#if isLeadSection(s)}
            <article class="report-prose mt-6">
              <h2>{cleanHeading(s.heading)}</h2>
              <ReportMarkdown children={s.content} />
            </article>
          {:else}
            <details class="group mt-3 overflow-hidden rounded-xl border border-border bg-surface/30">
              <summary class="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 py-3 transition-colors hover:bg-surface-hover">
                <span class="text-sm font-medium">{cleanHeading(s.heading)}</span>
                <span class="hidden truncate text-xs text-faint sm:inline">{preview(s.content)}</span>
                <ChevronDown class="ml-auto size-4 shrink-0 text-faint transition-transform group-open:rotate-180" />
              </summary>
              <div class="report-prose border-t border-border px-4 py-3">
                <ReportMarkdown children={s.content} />
              </div>
            </details>
          {/if}
        {/each}

        {#if machine.length > 0}
          <div class="mt-6 flex items-center gap-3 text-[11px] uppercase tracking-[0.14em] text-faint">
            <span class="h-px flex-1 bg-border"></span>
            Technical details · for developers
            <span class="h-px flex-1 bg-border"></span>
          </div>
          {#each machine as s, i (i)}
            <details class="group mt-2 overflow-hidden rounded-xl border border-border/60 bg-surface/20">
              <summary class="flex min-h-[44px] cursor-pointer list-none items-center gap-2 px-4 py-3 font-mono text-xs text-muted transition-colors hover:bg-surface-hover">
                {cleanHeading(s.heading)}
                <ChevronDown class="ml-auto size-4 shrink-0 text-faint transition-transform group-open:rotate-180" />
              </summary>
              <div class="report-prose border-t border-border/60 px-4 py-3">
                <ReportMarkdown children={s.content} />
              </div>
            </details>
          {/each}
        {/if}
      {/if}
    </div>
    <ScoreMethodology />
  {:else}
    <div class="mt-8 flex items-center gap-3 rounded-2xl border border-dashed border-border bg-surface/30 p-5 text-sm text-muted">
      <FileText class="size-5 shrink-0 text-faint" />
      No report file found for #{id} in <code class="text-foreground">reports/</code>.
    </div>
  {/if}
</div>
