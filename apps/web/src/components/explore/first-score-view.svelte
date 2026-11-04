<script lang="ts">
  import { onMount } from "svelte";
  import { goto } from "$app/navigation";
  import { Compass, Coins, FileText, ShieldCheck, Sparkles, X } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import { instrumentSerif } from "@/lib/fonts";
  import { legitimacyTone, parseReport, scoreTone } from "@/lib/format";
  import { useJobs, type Job } from "@/lib/jobs.svelte";

  const SEEN_KEY = "career-ops:first-score-seen";

  // THE AHA — fires once, the first time an evaluation completes. The maintainer's
  // north star: the WHY is the hero (a sentence that clearly read THIS CV and reasoned
  // about THIS job), the grade is large-but-secondary. A celebration, not a report.

  /** Pull the strongest "why this person" line out of the worker output. Prefer the
   *  VERDICT summary; else the first substantive sentence of the report body. */
  function extractWhy(job: Job): string {
    const s = (job.result?.summary || "").trim();
    if (s.length > 30) return s.replace(/\.$/, "") + ".";
    const body = parseReport(job.text || "").body;
    const para = body
      .split(/\n{2,}/)
      .map((p) => p.replace(/[#*>`-]/g, "").replace(/\s+/g, " ").trim())
      .find((p) => p.length > 60 && /\b(you|your|fit|match|strong|experience|background)\b/i.test(p));
    return para ? para.slice(0, 240) : "You're a strong match for this role — open the full report for the breakdown.";
  }

  const jobStore = useJobs();

  let dismissed = $state(false);
  let seen = $state(true); // assume seen until we read localStorage (avoid flash)
  let panelEl = $state<HTMLDivElement | null>(null);

  onMount(() => {
    try {
      seen = localStorage.getItem(SEEN_KEY) === "1";
    } catch {
      seen = false;
    }
  });

  const firstDone = $derived(
    jobStore.jobs
      .filter((j) => j.kind === "evaluate" && j.status === "done")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))[0],
  );

  const open = $derived(!seen && !dismissed && !!firstDone);

  // A11y for the emotional-peak modal: focus into it on open, trap Tab, Escape to
  // close, restore focus on close (mirrors the MobileNav pattern).
  $effect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const t = window.setTimeout(() => panelEl?.querySelector<HTMLElement>("a, button")?.focus(), 40);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        try {
          localStorage.setItem(SEEN_KEY, "1"); // dismiss = seen (don't re-pop on reload)
        } catch {
          /* ignore */
        }
        dismissed = true;
        return;
      }
      if (e.key === "Tab" && panelEl) {
        const f = panelEl.querySelectorAll<HTMLElement>("a[href], button:not([disabled])");
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
      prev?.focus?.();
    };
  });

  function close(): void {
    try {
      localStorage.setItem(SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
    dismissed = true;
  }
</script>

{#if open && firstDone}
  {@const why = extractWhy(firstDone)}
  {@const score = firstDone.result?.score ?? null}
  {@const meta = parseReport(firstDone.text || "")}
  {@const legit = meta.legitimacy}
  {@const company = firstDone.title.replace(/^Evaluate\s*·\s*/, "")}
  {@const role = firstDone.subtitle || ""}
  {@const tone = score != null ? scoreTone(`${score}`) : "muted"}
  <div class="co-aha" role="dialog" tabindex="-1" aria-modal="true" aria-label="Your first score">
    <!-- Backdrop dismiss, as a real button: a click handler on the dialog div is
         invisible to assistive tech and unreachable by Tab. -->
    <button type="button" class="absolute inset-0 cursor-default" aria-label="Close" onclick={close}></button>
    <div bind:this={panelEl} class="co-aha__card">
      <div class="co-aha__glow"></div>
      <button type="button" onclick={close} aria-label="Close" class="absolute right-3 top-3 z-10 rounded-md p-1.5 text-faint transition hover:text-foreground">
        <X class="size-4" />
      </button>

      <div class="relative px-7 pb-7 pt-8">
        <p class="font-mono text-[11px] uppercase tracking-[0.18em] text-brand">
          <span class="text-faint">//</span> the job we found you — scored
        </p>

        <div class="mt-4 flex items-start gap-4">
          <div class="min-w-0 flex-1">
            <h2 class="{instrumentSerif.className} truncate text-2xl leading-tight text-foreground">{role || company}</h2>
            {#if role}<p class="truncate text-sm text-muted">{company}</p>{/if}
          </div>
          {#if score != null}
            <div class="shrink-0 text-right">
              <div
                class={cn(
                  "co-aha__grade text-5xl font-semibold",
                  tone === "good" ? "text-emerald-500" : tone === "warn" ? "text-amber-500" : tone === "bad" ? "text-red-400" : "text-muted",
                )}
              >
                {score}
              </div>
              <div class="text-[11px] uppercase tracking-wide text-faint">/ 5 fit</div>
            </div>
          {/if}
        </div>

        <!-- THE WHY — the hero. A sentence that read THIS CV against THIS job. -->
        <blockquote class="{instrumentSerif.className} mt-5 border-l-2 border-brand/40 pl-4 text-[19px] leading-snug text-foreground">
          <Sparkles class="mb-1 inline size-4 text-brand" /> {why}
        </blockquote>

        {#if legit}
          <div
            class={cn(
              "mt-4 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium",
              legitimacyTone(legit) === "good"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
            )}
          >
            <ShieldCheck class="size-3" /> Legitimacy: {legit}
          </div>
        {/if}

        <p class="mt-5 flex items-center gap-1.5 text-[12px] text-faint">
          <Coins class="size-3.5" /> That ran on your own AI. Everything before it — finding this job — was free.
        </p>

        <div class="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onclick={() => {
              close();
              void goto("/pipeline?tab=EVALUATED");
            }}
            class="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-brand-foreground shadow-sm transition hover:brightness-110"
          >
            <FileText class="size-4" /> See the full report
          </button>
          <button
            type="button"
            onclick={() => {
              close();
              void goto("/explore");
            }}
            class="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/50 px-4 py-2.5 text-sm font-medium text-foreground transition hover:border-brand/40 hover:text-brand"
          >
            <Compass class="size-4" /> Find more like this
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .co-aha {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.2rem;
    background: color-mix(in srgb, var(--bg) 70%, rgba(0, 0, 0, 0.5));
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
    animation: co-aha-in 0.35s ease both;
  }
  .co-aha__card {
    position: relative;
    width: min(34rem, 100%);
    border-radius: 1.3rem;
    border: 1px solid var(--border, hsl(0 0% 50% / 0.2));
    background: var(--bg);
    box-shadow: 0 24px 70px -20px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }
  .co-aha__glow {
    position: absolute;
    inset: 0;
    background: radial-gradient(80% 60% at 50% -10%, hsl(26 82% 55% / 0.22), transparent 70%);
    pointer-events: none;
  }
  .co-aha__grade {
    font-variant-numeric: tabular-nums;
    line-height: 1;
  }
  @keyframes co-aha-in {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.985);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .co-aha {
      animation: none;
    }
  }
</style>
