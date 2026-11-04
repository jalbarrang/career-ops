<script lang="ts">
  import { Radar } from "@lucide/svelte";
  import PortalsView from "@/components/portals-view.svelte";
</script>

<div class="mx-auto max-w-3xl px-6 py-8">
  <div class="flex items-center gap-3">
    <Radar class="size-6 text-brand" />
    <h1 class="font-display text-2xl tracking-tight text-landing">Portals</h1>
  </div>
  <p class="mt-1.5 max-w-xl text-sm text-muted">
    The companies career-ops watches for new roles. Run a health check to catch company boards that have quietly
    broken — a broken link means that company silently disappears from every future scan.
  </p>
  <p class="mt-1.5 text-xs text-faint">
    Backed by <code class="text-muted">portals.yml</code> — edit it directly or ask the assistant.
  </p>
  <div class="mt-6">
    <PortalsView />
  </div>
</div>
