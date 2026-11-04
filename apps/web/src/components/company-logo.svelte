<script lang="ts">
  import { onMount } from "svelte";
  import { companyInitials, monogramHue } from "@/lib/company";
  import { cn } from "@/lib/cn";

  const CONFIG_KEY = "career-ops:config";

  // A small company mark: the real favicon on a white tile when logos are enabled
  // and resolvable, otherwise a deterministic colored monogram. The monogram is the
  // always-rendered base layer (SSR-safe + offline floor); the logo fades in on top
  // once loaded, and any failure (404/offline/disabled) just leaves the monogram
  // showing. See lib/company.ts + /api/logo.
  let { name, size = 20, class: klass }: { name: string; size?: number; class?: string } = $props();

  let enabled = $state(false); // monogram-only until config known
  let failed = $state(false);
  let loaded = $state(false);

  onMount(() => {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      const v = raw ? JSON.parse(raw) : null;
      enabled = v?.logos !== false; // default ON unless explicitly disabled
    } catch {
      enabled = true;
    }
  });

  const hue = $derived(monogramHue(name));
  const radius = $derived(Math.max(4, Math.round(size * 0.28)));
  // Resolve by NAME, not by a single client-guessed domain: ATS postings carry
  // legal entity names ("Amazon.com Services LLC") that one slug rule cannot
  // resolve, and /api/logo already tries several candidates per name.
  const showImg = $derived(enabled && !!name?.trim() && !failed);
</script>

<span
  class={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden ring-1 ring-black/5 dark:ring-white/10", klass)}
  style="width:{size}px;height:{size}px;border-radius:{radius}px"
  aria-hidden="true"
>
  <span
    class="absolute inset-0 flex items-center justify-center font-semibold leading-none text-white"
    style="background:linear-gradient(135deg, hsl({hue} 55% 48%), hsl({(hue + 28) % 360} 52% 38%));font-size:{Math.round(
      size * 0.42,
    )}px;letter-spacing:-0.02em"
  >
    {companyInitials(name)}
  </span>
  {#if showImg}
    <img
      src="/api/logo?company={encodeURIComponent(name)}"
      alt=""
      width={size}
      height={size}
      loading="lazy"
      referrerpolicy="no-referrer"
      onload={() => (loaded = true)}
      onerror={() => (failed = true)}
      class="absolute inset-0 h-full w-full bg-white object-contain transition-opacity duration-200"
      style="opacity:{loaded ? 1 : 0};padding:{Math.max(1, Math.round(size * 0.1))}px"
    />
  {/if}
</span>
