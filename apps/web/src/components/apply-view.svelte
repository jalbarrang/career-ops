<script lang="ts">
  import {
    AlertTriangle,
    ArrowUpRight,
    Check,
    CheckCircle2,
    ExternalLink,
    Info,
    Loader2,
    MousePointerClick,
    PenLine,
    RotateCcw,
    ScanLine,
    ShieldCheck,
    Sparkles,
    Terminal,
    Wand2,
  } from "@lucide/svelte";
  import type { ApplyIssue, DriveStep } from "@/lib/apply/issue";
  import { useApply } from "@/lib/apply.svelte";
  import { cn } from "@/lib/cn";
  import ApplyExitBar from "@/components/apply/apply-exit-bar.svelte";
  import FieldRow from "@/components/apply/field-row.svelte";
  import RotatingStatus from "@/components/apply/rotating-status.svelte";

  // The form-proxy UI: the real employer form is opened headlessly on the user's
  // machine and re-rendered here in plain language, pre-filled from their CV. The
  // user verifies every answer, then we fill the real form behind the scenes and
  // bring it to the front for them to submit. We never submit.
  const a = useApply();
  let input = $state("");

  const opening = $derived(a.status === "opening");
  const driving = $derived(a.status === "driving");
  const prefilling = $derived(a.status === "prefilling");
  const filling = $derived(a.status === "filling");
  const done = $derived(a.status === "done");
  const busy = $derived(opening || driving);
  const phase = $derived(busy ? 0 : prefilling ? 1 : 2);

  // journey: Read → Draft → Review
  const PHASES: { label: string; icon: typeof ScanLine }[] = [
    { label: "Reading form", icon: ScanLine },
    { label: "Drafting answers", icon: PenLine },
    { label: "Review & submit", icon: CheckCircle2 },
  ];

  const DRIVE_VERB: Record<string, string> = {
    click: "Clicked",
    type: "Typed into",
    select: "Selected",
    scroll: "Scrolled",
    "parse-error": "Thinking…",
    stuck: "Stuck",
    reached_form: "Reached the form",
  };
</script>

{#if a.status === "idle" || a.status === "error"}
  <div>
    <div class="flex max-w-2xl items-center gap-2 rounded-full border border-border bg-surface/70 py-1.5 pl-4 pr-1.5 shadow-sm transition focus-within:border-brand/50 focus-within:shadow-md">
      <input
        value={input}
        oninput={(e) => (input = e.currentTarget.value)}
        onkeydown={(e) => e.key === "Enter" && a.open(input.trim())}
        placeholder="Paste an application form URL (Ashby, Lever, Greenhouse…)"
        class="min-w-0 flex-1 bg-transparent py-1.5 text-sm outline-none placeholder:text-faint"
      />
      <button
        type="button"
        onclick={() => a.open(input.trim())}
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-brand px-4 py-1.5 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
      >
        <Wand2 class="size-4" /> Read form
      </button>
    </div>
    {#if a.error}
      <div class="mt-4 max-w-2xl rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3.5">
        <div class="flex items-start gap-2.5">
          <AlertTriangle class="mt-0.5 size-4 shrink-0 text-amber-500" />
          <div class="min-w-0">
            <p class="text-sm text-amber-800 dark:text-amber-300">{a.error}</p>
            {#if a.url && /^https?:\/\//.test(a.url)}
              <a href={a.url} target="_blank" rel="noreferrer" class="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline">
                Open the form directly <ExternalLink class="size-3" />
              </a>
            {/if}
          </div>
        </div>
      </div>
    {/if}
    <!-- A session that failed still has a row and an origin behind it, so the
         way back and the way to record it must survive the failure. -->
    {#if a.status === "error"}<ApplyExitBar />{/if}
  </div>
{:else}
  <div class="mx-auto max-w-2xl">
    {@render phaseRail(phase)}

    {#if !busy}
      <div class="co-rise mb-4 flex items-baseline justify-between gap-3">
        <h2 class="font-display text-xl text-landing drop-shadow-sm">{a.title || "Application"}</h2>
        <button type="button" onclick={() => a.reset()} class="inline-flex items-center gap-1 text-xs text-faint transition-colors hover:text-foreground">
          <RotateCcw class="size-3" /> new
        </button>
      </div>
    {/if}

    <!-- opening: big magic hero + skeleton fields (no layout jump when real ones arrive) -->
    {#if opening}
      {@render processingHero("Reading your form…", "Opening the real application on your machine and reading every field.")}
      {@render fieldSkeleton()}
    {/if}

    <!-- driving: watch the agent reach the form live (it navigates, never submits) -->
    {#if driving}
      {@render drivePanel(a.driveSteps, false)}
    {/if}

    {#if a.error}
      <p class="co-rise mb-3 flex items-start gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 backdrop-blur-sm dark:text-amber-400">
        <AlertTriangle class="mt-0.5 size-4 shrink-0" /> {a.error}
      </p>
    {/if}

    {#if !busy}
      <div class="co-rise">
        {@render applyIssues(a.issues)}
        <!-- drafting banner while the planner writes the answers -->
        {#if prefilling}
          <div class="mb-4 flex items-center gap-3 rounded-xl border border-brand/30 bg-brand-soft/60 px-4 py-3 backdrop-blur-sm">
            <span class="relative grid size-8 shrink-0 place-items-center">
              <span class="co-orb absolute inset-0 rounded-full bg-brand/40 blur-[6px]"></span>
              <Sparkles class="size-4 text-brand" />
            </span>
            <div class="min-w-0">
              <div class="text-sm font-medium text-foreground">Drafting your answers…</div>
              <RotatingStatus />
            </div>
            <Loader2 class="ml-auto size-4 shrink-0 animate-spin text-brand" />
          </div>
        {/if}

        <div class="mb-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onclick={() => a.prefill()}
            disabled={prefilling || filling}
            class="inline-flex items-center gap-1.5 rounded-full border border-brand/40 bg-brand-soft px-3.5 py-1.5 text-sm font-medium text-brand transition-colors hover:bg-brand/15 disabled:opacity-50"
          >
            {#if prefilling}<Loader2 class="size-4 animate-spin" />{:else}<Sparkles class="size-4" />{/if}
            {prefilling ? "Drafting from your CV…" : "Pre-fill from my CV"}
          </button>
          <span class="text-xs text-muted">…or ask the corner assistant to write/revise any answer.</span>
        </div>

        {#if prefilling || a.prefillLog.length > 0}
          <details class="mb-4 rounded-lg border border-border bg-surface/60 backdrop-blur-sm">
            <summary class="flex cursor-pointer select-none items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted">
              <Terminal class="size-3.5" /> Pre-fill diagnostics
              {#if prefilling}<Loader2 class="size-3 animate-spin text-brand" />{/if}
              <span class="ml-auto text-faint">{a.prefillLog.length} steps</span>
            </summary>
            <div class="max-h-52 overflow-y-auto border-t border-border px-3 py-2">
              <ol class="space-y-0.5 font-mono text-[11px] leading-relaxed text-muted">
                {#each a.prefillLog as l, i (i)}
                  <li class={l.startsWith("✗") ? "text-amber-600 dark:text-amber-400" : ""}>{l}</li>
                {/each}
                {#if prefilling}<li class="text-faint">…</li>{/if}
              </ol>
            </div>
          </details>
        {/if}

        <!-- the questions — float on the blurred form image, cascade in, each
             flashes brand-orange the instant its drafted answer lands -->
        <div class="space-y-1 rounded-2xl border border-border/70 bg-surface/80 p-2 shadow-2xl shadow-black/10 backdrop-blur-md sm:p-3">
          {#each a.fields as f, i (f.id)}
            <div class="co-rise rounded-xl px-3 py-2.5" style:animation-delay={`${Math.min(i * 45, 700)}ms`}>
              <FieldRow
                field={f}
                value={a.answers[f.id] ?? ""}
                needs={!!a.meta[f.id]?.needsConfirmation}
                index={i}
                drafting={prefilling}
                onChange={(v) => a.setAnswer(f.id, v)}
              />
            </div>
          {/each}
        </div>

        <div class="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onclick={() => a.fill()}
            disabled={filling || prefilling}
            class="inline-flex items-center gap-2 rounded-full bg-brand px-5 py-2.5 text-sm font-medium text-brand-foreground shadow-lg shadow-brand/25 transition-all hover:bg-brand-200 hover:shadow-brand/40 disabled:opacity-50"
          >
            {#if filling}<Loader2 class="size-4 animate-spin" />{:else}<ArrowUpRight class="size-4" />{/if}
            {filling ? "Filling the real form…" : "Fill the real form & review"}
          </button>
          <button
            type="button"
            onclick={() => a.agentFill()}
            disabled={filling || prefilling}
            title="Let the AI drive the real form and fill it field-by-field (for tricky / multi-step forms). It never submits."
            class="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2.5 text-sm font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand disabled:opacity-50"
          >
            <MousePointerClick class="size-4" /> Let the AI fill it
          </button>
          <p class="inline-flex items-center gap-1.5 text-xs text-muted">
            <ShieldCheck class="size-3.5 text-emerald-500" /> Never submits — you click Submit yourself.
          </p>
        </div>

        <!-- agent filling the form live (full-agent escalation) -->
        {#if filling && a.driveSteps.length > 0}
          <div class="mt-6">{@render drivePanel(a.driveSteps, true)}</div>
        {/if}

        {#if (filling || done) && a.steps.length > 0}
          <div class="co-rise mt-6">
            <div class="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-faint">Behind the scenes</div>
            <div class="flex gap-2 overflow-x-auto pb-2">
              {#each a.steps as s, i (i)}
                <figure class="shrink-0">
                  {#if s.thumb}
                    <img src={s.thumb} alt="" class="h-24 w-36 rounded-md border border-border object-cover" />
                  {:else}
                    <div class="flex h-24 w-36 items-center justify-center rounded-md border border-dashed border-border text-faint">…</div>
                  {/if}
                  <figcaption class={cn("mt-1 w-36 truncate text-[10px]", s.ok ? "text-faint" : "text-amber-500")}>{s.label || "field"}</figcaption>
                </figure>
              {/each}
            </div>
          </div>
        {/if}
        {#if done}
          <div class="co-rise mt-4 flex items-start gap-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm backdrop-blur-sm">
            <CheckCircle2 class="mt-0.5 size-5 shrink-0 text-emerald-500" />
            <div>
              <span class="font-medium text-emerald-700 dark:text-emerald-400">The real form is now in front, pre-filled.</span>{" "}
              <span class="text-muted">Review it and click Submit yourself — career-ops never submits for you.</span>
            </div>
          </div>
        {/if}
      </div>
    {/if}

    <!-- the way out: back out of the form, or record that you sent it -->
    <ApplyExitBar />
  </div>
{/if}

{#snippet phaseRail(phaseIndex: number)}
  <div class="mb-6 flex items-center gap-2.5">
    {#each PHASES as s, i (s.label)}
      {@const Icon = s.icon}
      {@const state = i < phaseIndex ? "done" : i === phaseIndex ? "active" : "todo"}
      <div class="flex items-center gap-2">
        <span
          class={cn(
            "relative grid size-6 place-items-center rounded-full border transition-colors",
            state === "done" && "border-brand bg-brand text-brand-foreground",
            state === "active" && "border-brand text-brand",
            state === "todo" && "border-border text-faint",
          )}
        >
          {#if state === "done"}<Check class="size-3.5" />{:else}<Icon class="size-3.5" />{/if}
          {#if state === "active"}<span class="absolute inset-0 -z-10 animate-ping rounded-full bg-brand/30"></span>{/if}
        </span>
        <span class={cn("hidden text-xs font-medium sm:inline", i <= phaseIndex ? "text-foreground" : "text-faint")}>{s.label}</span>
      </div>
      {#if i < PHASES.length - 1}
        <span class="relative h-px flex-1 overflow-hidden rounded bg-border">
          <span class={cn("absolute inset-y-0 left-0 bg-brand transition-all duration-700", i < phaseIndex ? "w-full" : "w-0")}></span>
        </span>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet applyIssues(issues: ApplyIssue[])}
  {@const warns = issues.filter((i) => i.level === "warn" || i.level === "block")}
  {@const infos = issues.filter((i) => i.level === "info")}
  {#if issues.length > 0}
    <div class="mb-4 space-y-2">
      {#if warns.length > 0}
        <div class="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 backdrop-blur-sm">
          <div class="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle class="size-4" /> A few things to check
          </div>
          <ul class="space-y-1 text-xs text-amber-800/90 dark:text-amber-300/90">
            {#each warns as i, k (k)}
              <li class="flex gap-1.5"><span class="mt-px text-amber-500">•</span> {i.message}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#each infos as i, k (k)}
        <div class="flex items-center gap-1.5 text-xs text-muted">
          <Info class="size-3.5 shrink-0 text-faint" /> {i.message}
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet drivePanel(steps: DriveStep[], isFilling: boolean)}
  {@const last = steps[steps.length - 1]}
  <div class="co-rise">
    <div class="flex flex-col items-center gap-3 py-7 text-center">
      <span class="relative grid size-14 place-items-center">
        <span class="co-orb absolute inset-0 rounded-full bg-brand/30 blur-lg"></span>
        <span class="co-ring absolute inset-0 rounded-full border-2 border-brand/30 border-t-brand"></span>
        <MousePointerClick class="size-6 text-brand" />
      </span>
      <div class="font-display text-2xl text-landing">{isFilling ? "AI is filling the form…" : "Reaching your form…"}</div>
      <p class="max-w-sm text-sm text-muted">
        {isFilling
          ? "The AI is driving the real form field-by-field on your machine — it never submits; you review and submit."
          : "The AI is navigating the real application on your machine to reach the form — it never submits."}
      </p>
    </div>
    {#if last?.thumb}
      <img src={last.thumb} alt="" class="w-full rounded-xl border border-border shadow-xl shadow-black/10" />
    {:else}
      <div class="co-skel h-56 w-full rounded-xl"></div>
    {/if}
    {#if steps.length > 0}
      <ol class="mt-3 space-y-1.5 rounded-xl border border-border/70 bg-surface/70 p-3 backdrop-blur-sm">
        {#each steps as s, i (i)}
          <li class={cn("flex items-center gap-2 text-xs", i === steps.length - 1 ? "text-foreground" : "text-muted")}>
            <span class="grid size-5 shrink-0 place-items-center rounded-full bg-brand-soft text-[10px] font-semibold text-brand">{s.turn}</span>
            <span class="shrink-0 font-medium">{DRIVE_VERB[s.action] ?? s.action}</span>
            <span class="truncate text-faint">{s.detail}</span>
            <!-- `submit-control` is the guard doing its job (good news, distinct
                 color); `not-offered`/`gone` are the page moving under us
                 (a caution, not a protection) — same amber as before this
                 field had a consumer at all. -->
            {#if s.note}
              {#if s.refusal === "submit-control"}
                <span class="inline-flex shrink-0 items-center gap-1 text-emerald-700 dark:text-emerald-400">
                  <ShieldCheck class="size-3" /> {s.note}
                </span>
              {:else}
                <span class="shrink-0 text-amber-500">· {s.note}</span>
              {/if}
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </div>
{/snippet}

{#snippet processingHero(title: string, subtitle: string)}
  <div class="co-rise flex flex-col items-center gap-3 py-14 text-center">
    <span class="relative grid size-16 place-items-center">
      <span class="co-orb absolute inset-0 rounded-full bg-brand/30 blur-lg"></span>
      <span class="co-ring absolute inset-0 rounded-full border-2 border-brand/30 border-t-brand"></span>
      <Sparkles class="size-7 text-brand" />
    </span>
    <div class="font-display text-3xl text-landing">{title}</div>
    <p class="max-w-sm text-sm text-muted">{subtitle}</p>
  </div>
{/snippet}

{#snippet fieldSkeleton()}
  <div class="co-rise space-y-3 rounded-2xl border border-border/70 bg-surface/70 p-5 backdrop-blur-md" style:animation-delay="120ms">
    {#each [64, 80, 48, 72, 56] as w, i (i)}
      <div class="space-y-2">
        <div class="co-skel h-3" style:width={`${w}px`}></div>
        <div class="co-skel h-9 w-full"></div>
      </div>
    {/each}
  </div>
{/snippet}

<style>
  /* Co-located UI animations: field cascade-in, per-field "just drafted" flash,
     skeleton shimmer, hero orb. Every rule is `:global` because the field rows,
     the rotating status line and the exit bar are their own components — a
     scoped selector would compile to `.co-rise.svelte-…` and never match them. */
  @keyframes co-rise {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  :global(.co-rise) {
    animation: co-rise 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
  }
  @keyframes co-flash {
    0% {
      box-shadow: 0 0 0 0 hsl(26 82% 55% / 0);
    }
    22% {
      box-shadow: 0 0 0 3px hsl(26 82% 55% / 0.38);
    }
    100% {
      box-shadow: 0 0 0 0 hsl(26 82% 55% / 0);
    }
  }
  :global(.co-flash) {
    animation: co-flash 1.15s ease both;
    border-radius: 0.6rem;
  }
  @keyframes co-shim {
    0% {
      background-position: -200% 0;
    }
    100% {
      background-position: 200% 0;
    }
  }
  :global(.co-skel) {
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--fg) 5%, transparent) 25%,
      color-mix(in srgb, var(--fg) 12%, transparent) 37%,
      color-mix(in srgb, var(--fg) 5%, transparent) 63%
    );
    background-size: 200% 100%;
    animation: co-shim 1.6s linear infinite;
    border-radius: 0.5rem;
  }
  @keyframes co-orb {
    0%,
    100% {
      transform: scale(1);
      opacity: 0.55;
    }
    50% {
      transform: scale(1.35);
      opacity: 0.9;
    }
  }
  :global(.co-orb) {
    animation: co-orb 2.4s ease-in-out infinite;
  }
  @keyframes co-spin {
    to {
      transform: rotate(360deg);
    }
  }
  :global(.co-ring) {
    animation: co-spin 3s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.co-rise),
    :global(.co-flash),
    :global(.co-skel),
    :global(.co-orb),
    :global(.co-ring) {
      animation: none;
    }
  }
</style>
