<script lang="ts">
  import { page } from "$app/state";
  import { marked } from "marked";
  import { ArrowLeft, Loader2, Wrench, CircleDot, Check, X } from "@lucide/svelte";
  import { useJobs } from "@/lib/jobs.svelte";
  import HeroGlow from "@/components/hero-glow.svelte";
  import { Badge } from "@/components/ui/badge";

  // A worker's timeline, read straight from the client store — `params.id` is
  // synchronous in SvelteKit, so no `use(params)` promise to unwrap.
  const store = useJobs();
  const job = $derived(store.jobs.find((j) => j.id === page.params.id));

  // react-markdown + remark-gfm → marked. GFM (tables, strikethrough,
  // autolinks) is on by default in marked, the same set remark-gfm added.
  const html = $derived(job ? marked(job.text, { async: false }) : "");
</script>

{#if !job}
  <div class="mx-auto max-w-3xl px-6 py-10">
    <a href="/pipeline" class="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
      <ArrowLeft class="size-4" /> Pipeline
    </a>
    <p class="mt-8 text-sm text-muted">
      This worker is no longer in memory (it finished earlier or the page was reloaded).
    </p>
  </div>
{:else}
  <div class="mx-auto max-w-3xl px-6 py-8">
    <a href="/pipeline" class="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-brand">
      <ArrowLeft class="size-4" /> Pipeline
    </a>

    <section class="dot-bg relative mt-5 overflow-hidden rounded-2xl border border-border bg-surface/40 px-6 py-7">
      {#if job.status === "running"}<HeroGlow />{/if}
      <div class="relative z-10">
        <p class="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.18em] text-faint">
          {#if job.status === "running"}
            <Loader2 class="size-3 animate-spin text-brand" /> working
          {:else if job.status === "done"}
            <Check class="size-3 text-emerald-500" /> done
          {:else}
            <X class="size-3 text-red-400" /> error
          {/if}
        </p>
        <h1 class="mt-2 font-display text-2xl tracking-tight text-landing">{job.title}</h1>
        {#if job.subtitle}<p class="mt-1 text-sm text-muted">{job.subtitle}</p>{/if}
        {#if job.result?.score != null}
          <div class="mt-3 flex flex-wrap items-center gap-2.5">
            <Badge tone={job.result.tone}>{job.result.score}/5</Badge>
            {#if job.result.summary}<span class="text-sm text-muted">{job.result.summary}</span>{/if}
          </div>
        {/if}
      </div>
    </section>

    <ol class="mt-6 space-y-2">
      {#each job.steps as s, i (i)}
        <li class="flex items-start gap-2.5 text-sm">
          {#if s.kind === "tool"}
            <Wrench class="mt-0.5 size-3.5 shrink-0 text-brand" />
          {:else}
            <CircleDot class="mt-0.5 size-3.5 shrink-0 text-faint" />
          {/if}
          <span class={s.kind === "tool" ? "font-medium" : "text-muted"}>
            {s.kind === "tool" ? `Using ${s.label}` : s.label}
          </span>
        </li>
      {/each}
      {#if job.status === "running"}
        <li class="flex items-center gap-2.5 text-sm text-muted">
          <Loader2 class="size-3.5 animate-spin text-brand" /> thinking…
        </li>
      {/if}
    </ol>

    {#if job.text}
      <div class="mt-8">
        <h2 class="text-xs font-semibold uppercase tracking-[0.2em] text-muted">Output</h2>
        <div class="report-prose mt-3 rounded-2xl border border-border bg-surface/40 p-5">
          {@html html}
        </div>
      </div>
    {/if}
  </div>
{/if}
