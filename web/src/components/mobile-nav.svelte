<script lang="ts">
  import { onMount } from "svelte";
  import { Menu, X } from "@lucide/svelte";
  import { page } from "$app/state";
  import { cn } from "@/lib/cn";
  import CoMark from "@/components/co-mark.svelte";
  import ThemeToggle from "@/components/theme-toggle.svelte";
  import WorkerPills from "@/components/jobs/worker-pills.svelte";
  import UsageMeter from "@/components/usage-meter.svelte";
  import LocaleSwitcher from "@/components/locale-switcher.svelte";
  import { instrumentSerif } from "@/lib/fonts";
  import { NAV_ITEMS, isActivePath } from "@/lib/nav-items";
  import { m } from "@/lib/paraglide/messages";
  import { useJobs } from "@/lib/jobs.svelte";

  // Mobile navigation (< md): a glass top bar + a right-side slide-over drawer that
  // mirrors the desktop sidebar (nav + workers + usage + theme). Premium details:
  // spring slide, scrim blur, swipe-to-close, body scroll-lock, Escape, focus move,
  // safe-area insets (notch / home bar), worker pulse, reduced-motion aware.
  const store = useJobs();
  const running = $derived(store.jobs.filter((j) => j.status === "running").length);

  let open = $state(false);
  let panel = $state<HTMLElement | null>(null);

  // Close on route change.
  $effect(() => {
    page.url.pathname;
    open = false;
  });

  // Scroll-lock + Escape + move focus into the drawer while open.
  $effect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        open = false;
        return;
      }
      // Trap Tab focus within the drawer while open.
      if (e.key === "Tab" && panel) {
        const f = panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
        if (f.length === 0) return;
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
    const t = window.setTimeout(() => panel?.querySelector<HTMLElement>("a, button")?.focus(), 60);

    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  });

  // Swipe-right-to-close.
  let drag = $state({ x0: 0, dx: 0, active: false });

  function onTouchStart(e: TouchEvent) {
    drag = { x0: e.touches[0].clientX, dx: 0, active: true };
  }
  function onTouchMove(e: TouchEvent) {
    if (!drag.active || !panel) return;
    const dx = Math.max(0, e.touches[0].clientX - drag.x0);
    drag.dx = dx;
    panel.style.transition = "none";
    panel.style.transform = `translateX(${dx}px)`;
  }
  function onTouchEnd() {
    if (!panel) return;
    panel.style.transition = "";
    panel.style.transform = "";
    if (drag.dx > 90) open = false;
    drag.active = false;
  }
</script>

<header class="co-mnav flex items-center gap-2 border-b border-border px-4 pb-3 md:hidden">
  <a href="/" class="flex min-h-[44px] items-center gap-2" aria-label={m.shell_home()}>
    <CoMark size={26} />
    <span class="{instrumentSerif.className} relative -top-px text-xl text-landing">career-ops</span>
  </a>
  <div class="ml-auto flex items-center gap-0.5">
    <ThemeToggle />
    <button
      type="button"
      onclick={() => (open = true)}
      aria-label={m.shell_open_menu()}
      aria-expanded={open}
      class="relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md p-2 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
    >
      <Menu class="size-5" />
      {#if running > 0}
        <span aria-hidden="true" class="co-pulse absolute right-1.5 top-1.5 size-2 rounded-full bg-brand ring-2 ring-surface"></span>
      {/if}
    </button>
  </div>
</header>

<div class={cn("co-mscrim md:hidden", open && "open")} onclick={() => (open = false)} aria-hidden="true"></div>

<div
  bind:this={panel}
  role="dialog"
  tabindex="-1"
  aria-modal="true"
  aria-label={m.shell_navigation()}
  inert={!open}
  class={cn("co-mdrawer border-l border-border bg-surface md:hidden", open && "open")}
  ontouchstart={onTouchStart}
  ontouchmove={onTouchMove}
  ontouchend={onTouchEnd}
>
  <div class="flex items-center justify-between px-4 py-3">
    <span class="{instrumentSerif.className} text-lg text-landing">{m.shell_menu()}</span>
    <button
      type="button"
      onclick={() => (open = false)}
      aria-label={m.shell_close_menu()}
      class="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md p-1.5 text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
    >
      <X class="size-5" />
    </button>
  </div>

  <nav class="flex flex-col gap-1 px-3">
    {#each NAV_ITEMS as { href, label, icon: Icon, chip } (href)}
      {@const active = isActivePath(href, page.url.pathname)}
      <a
        {href}
        onclick={() => (open = false)}
        aria-current={active ? "page" : undefined}
        class={cn(
          "flex items-center gap-3 rounded-lg px-3 py-3 text-[15px] transition-colors",
          active ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-surface-hover hover:text-foreground",
        )}
      >
        <Icon class="size-5" />
        {label()}
        {#if chip}
          <span class="ml-auto rounded-full border border-brand/30 bg-brand-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-text">
            {chip()}
          </span>
        {/if}
      </a>
    {/each}
  </nav>

  <div class="px-3">
    <WorkerPills />
  </div>

  <div class="co-msafe mt-auto space-y-3 border-t border-border px-4 pt-4">
    <UsageMeter />
    <div class="space-y-1.5">
      <div class="flex items-center justify-between">
        <span class="{instrumentSerif.className} text-sm text-faint">{m.shell_local_first()}</span>
        <LocaleSwitcher />
      </div>
      <ThemeToggle showLabel class="bg-surface-hover/40" />
    </div>
  </div>
</div>

<style>
  /* Solid bg == the page bg == the theme-color meta, so Safari's top bar / status
     strip / Dynamic Island and the header read as ONE continuous surface
     (seamless on iOS, esp. dark). Top padding = the notch inset PLUS a
     comfortable base, so the title never sits flush/cramped at the top. */
  .co-mnav {
    position: sticky;
    top: 0;
    z-index: 30;
    background: var(--bg);
    padding-top: calc(env(safe-area-inset-top) + 0.8rem);
  }
  .co-mscrim {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: rgba(8, 8, 12, 0.45);
    -webkit-backdrop-filter: blur(2px);
    backdrop-filter: blur(2px);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }
  .co-mscrim.open {
    opacity: 1;
    pointer-events: auto;
  }
  .co-mdrawer {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 61;
    width: min(20rem, 86vw);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overscroll-behavior: contain;
    transform: translateX(102%);
    transition: transform 0.34s cubic-bezier(0.32, 0.72, 0, 1);
    will-change: transform;
    box-shadow: -16px 0 48px -16px rgba(0, 0, 0, 0.4);
    padding-top: calc(env(safe-area-inset-top) + 0.25rem);
  }
  .co-mdrawer.open {
    transform: translateX(0);
  }
  .co-msafe {
    padding-bottom: calc(1rem + env(safe-area-inset-bottom));
  }
  .co-pulse {
    animation: co-pulse 1.6s ease-in-out infinite;
  }
  @keyframes co-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .co-mdrawer,
    .co-mscrim {
      transition: none;
    }
    .co-pulse {
      animation: none;
    }
  }
</style>
