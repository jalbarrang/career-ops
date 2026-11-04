<script lang="ts">
  import { onMount } from "svelte";
  import "../app.css";
  import { page } from "$app/state";
  import { instrumentSerif } from "@/lib/fonts";
  import { NAV_ITEMS, isActivePath } from "@/lib/nav-items";
  import { provideJobs } from "@/lib/jobs.svelte";
  import { providePipeline } from "@/lib/pipeline.svelte";
  import { provideApply } from "@/lib/apply.svelte";
  import { provideExplore } from "@/lib/explore.svelte";
  import { m } from "@/lib/paraglide/messages";
  import { themeStore } from "@/lib/theme.svelte";
  import { cn } from "@/lib/cn";
  import CoMark from "@/components/co-mark.svelte";
  import MobileNav from "@/components/mobile-nav.svelte";
  import ThemeToggle from "@/components/theme-toggle.svelte";
  import BackToTop from "@/components/back-to-top.svelte";
  import UsageMeter from "@/components/usage-meter.svelte";
  import WorkerPills from "@/components/jobs/worker-pills.svelte";
  import LocaleSwitcher from "@/components/locale-switcher.svelte";
  import RouteProgress from "@/components/route-progress.svelte";
  import AssistantConsole from "@/components/assistant-console.svelte";
  import FirstScoreView from "@/components/explore/first-score-view.svelte";

  let { children } = $props();

  // One store per feature for the whole app, created per render and handed down
  // through context — the SvelteKit equivalent of the four providers the Next
  // shell nested. Each provide*() reuses an instance a parent already set, so a
  // page calling it again (as /apply and /explore do) stays on this one.
  const jobs = provideJobs();
  providePipeline();
  provideApply();
  provideExplore();

  onMount(() => {
    themeStore.start();
    jobs.hydrate();
  });

  // Mirror the live worker list into localStorage on every change.
  $effect(() => {
    jobs.jobs;
    jobs.persist();
  });
</script>

<RouteProgress />
<MobileNav />
<div class="flex min-h-screen">
  <aside class="sticky top-0 hidden h-screen w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface/30 p-4 md:flex">
    <a href="/" class="mb-8 flex items-center gap-2.5 px-1">
      <CoMark size={32} />
      <span class="{instrumentSerif.className} relative -top-px text-2xl font-normal tracking-tight text-landing">career-ops</span>
    </a>
    <nav class="flex flex-col gap-1">
      {#each NAV_ITEMS as { href, label, icon: Icon, chip } (href)}
        {@const active = isActivePath(href, page.url.pathname)}
        <a
          {href}
          class={cn(
            "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
            active ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-surface-hover hover:text-foreground",
          )}
        >
          <Icon class="size-4" />
          {label()}
          {#if chip}
            <span class="ml-auto rounded-full border border-brand/30 bg-brand-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-text">
              {chip()}
            </span>
          {/if}
        </a>
      {/each}
    </nav>

    <WorkerPills />

    <div class="mt-auto space-y-3 pt-4 pb-16">
      <UsageMeter />
      <div class="space-y-1.5">
        <div class="flex items-center justify-between px-1">
          <span class="text-[10px] font-semibold uppercase tracking-[0.18em] text-faint">{m.shell_appearance()}</span>
          <LocaleSwitcher />
        </div>
        <ThemeToggle showLabel />
        <div class="px-1">
          <span class="{instrumentSerif.className} text-sm text-faint">{m.shell_local_first()}</span>
        </div>
      </div>
    </div>
  </aside>
  <main class="flex-1 overflow-x-hidden">{@render children()}</main>
  <AssistantConsole />
  <BackToTop />
  <FirstScoreView />
</div>
