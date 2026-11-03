<script lang="ts">
  import { Send } from "@lucide/svelte";
  import ApplyView from "@/components/apply-view.svelte";
  import ApplyBackdropMount from "@/components/apply/apply-backdrop-mount.svelte";
  import { provideApply } from "@/lib/apply.svelte";

  // The Apply session store for this page. provideApply() keeps the instance it
  // inherited (a layout, or the client-wide fallback an Apply button's session
  // was written to) instead of opening a second, empty one.
  provideApply();
</script>

<div class="relative min-h-screen">
  <!-- full-viewport blurred form wallpaper (behind everything) -->
  <ApplyBackdropMount />
  <div class="relative z-10 mx-auto max-w-3xl px-6 py-8">
    <div class="flex items-center gap-3">
      <Send class="size-6 text-brand" />
      <h1 class="font-display text-2xl tracking-tight text-landing">Apply</h1>
    </div>
    <p class="mt-1.5 max-w-xl text-sm text-muted">
      career-ops reads the real application form on your machine and re-renders it here in plain language, pre-filled
      from your CV. You verify every answer — then it fills the real form behind the scenes and you submit it yourself.
      It never submits for you.
    </p>
    <div class="mt-6">
      <ApplyView />
    </div>
  </div>
</div>
