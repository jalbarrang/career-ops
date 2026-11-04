<script lang="ts" module>
  const START_EVENT = "career-ops:route-progress:start";

  /** Start the navigation indicator before a route transition begins. */
  export function startRouteProgress(): void {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(START_EVENT));
    }
  }
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { navigating } from "$app/state";
  import { m } from "@/lib/paraglide/messages";

  type ProgressState = "idle" | "loading" | "done";

  // SvelteKit exposes navigation directly, so the click-listening the Next app
  // needed is gone: `navigating.to` is the authoritative signal. The manual
  // START_EVENT stays because followups/pipeline call startRouteProgress() for
  // work that is not a route transition (a refetch or a write-back).
  let manual = $state(false);
  let manualTimer: ReturnType<typeof setTimeout> | undefined;

  let settle = $state<ProgressState>("idle");

  const loading = $derived(manual || navigating.to !== null);

  $effect(() => {
    if (loading) {
      settle = "loading";
      return;
    }
    if (untrack(() => settle) === "loading") {
      settle = "done";
      const t = setTimeout(() => (settle = "idle"), 500);
      return () => clearTimeout(t);
    }
  });

  $effect(() => {
    const onStart = () => {
      clearTimeout(manualTimer);
      manual = true;
      // Same-route clicks and cancelled navigations must not leave a bar stuck.
      manualTimer = setTimeout(() => (manual = false), 8000);
    };
    window.addEventListener(START_EVENT, onStart);
    return () => {
      window.removeEventListener(START_EVENT, onStart);
      clearTimeout(manualTimer);
    };
  });
</script>

<div class="sr-only" role="status" aria-live="polite">
  {settle === "loading" ? m.shell_loading_page() : ""}
</div>
<div aria-hidden="true" class="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5">
  <div data-state={settle} class="route-bar h-full w-full rounded-r-full"></div>
</div>
