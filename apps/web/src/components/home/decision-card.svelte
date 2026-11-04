<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { Check, FileText, Loader2, X } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import CompanyLogo from "@/components/company-logo.svelte";
  import type { Application } from "@/lib/career-ops";
  import { scoreNum, scoreTone } from "@/lib/format";
  import { companyPresentation } from "@/lib/company-presentation.ts";

  // Awaiting-decision row: a scored role with no terminal status. Primary action
  // opens the report (PDF + Apply live there). Skip / Applied still write status.
  let { app }: { app: Application } = $props();

  let busy = $state<"" | "Applied" | "Discarded">("");
  let done = $state<string | null>(null);

  // $derived, not a one-shot compute: the row is keyed by `n`, so a refreshed
  // snapshot can hand the same instance a re-scored/re-labelled application.
  const score = $derived(scoreNum(app.score));
  const tone = $derived(scoreTone(app.score));
  const company = $derived(companyPresentation(app));

  async function setStatus(status: "Applied" | "Discarded"): Promise<void> {
    busy = status;
    try {
      await fetch("/api/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: app.n, status }) });
      done = status;
      void invalidateAll();
    } catch {
      /* ignore */
    } finally {
      busy = "";
    }
  }
</script>

{#if !done}
  <div class="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-surface/40 p-3.5 transition hover:border-brand/30">
    <div class="flex items-start gap-2.5">
      <CompanyLogo name={company.logoName} size={24} />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm font-medium text-foreground">{company.label}</p>
        <p class="truncate text-[13px] text-muted">{app.role}</p>
      </div>
      {#if Number.isFinite(score) && score > 0}
        <span
          class={cn(
            "shrink-0 rounded-md px-2 py-0.5 text-xs font-semibold tabular-nums",
            tone === "good"
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : tone === "warn"
                ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                : "bg-surface-hover text-muted",
          )}
        >
          {app.score}
        </span>
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <!-- Primary is the report (PDF + Apply live there). Marking Applied from
           Today skipped that path and wrote a status with no application. -->
      <a
        href={`/pipeline/${app.n}`}
        class="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-brand-soft px-2.5 py-1.5 text-xs font-medium text-brand-text transition hover:bg-brand/15 max-sm:min-h-[44px]"
      >
        <FileText class="size-3.5" /> Review
      </a>
      <button
        type="button"
        disabled={!!busy}
        onclick={() => setStatus("Discarded")}
        class="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-muted transition hover:text-foreground disabled:opacity-60 max-sm:min-h-[44px] max-sm:px-4"
      >
        {#if busy === "Discarded"}
          <Loader2 class="size-3.5 animate-spin" />
        {:else}
          <X class="size-3.5" />
        {/if} Skip
      </button>
      <button
        type="button"
        disabled={!!busy}
        onclick={() => setStatus("Applied")}
        title="Record Applied without opening the apply flow"
        class="inline-flex shrink-0 items-center justify-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-faint transition hover:text-foreground disabled:opacity-60 max-sm:min-h-[44px]"
      >
        {#if busy === "Applied"}
          <Loader2 class="size-3.5 animate-spin" />
        {:else}
          <Check class="size-3.5" />
        {/if}
        Applied
      </button>
    </div>
  </div>
{/if}
