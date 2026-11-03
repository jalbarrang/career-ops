<script lang="ts">
  import { onMount } from "svelte";
  import { Settings, Sparkles, X } from "@lucide/svelte";

  type Doctor = { available: boolean; onboardingNeeded: boolean; missing: string[]; warnings: string[] };

  function hasCli(): boolean {
    try {
      return !!JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId;
    } catch {
      return false;
    }
  }

  const LABELS: Record<string, string> = {
    "cv.md": "your CV",
    "config/profile.yml": "your profile — target roles, comp, location",
    "modes/_profile.md": "your personalization",
    "portals.yml": "the companies to scan",
  };

  // Detect (via the core's doctor.mjs) whether setup is incomplete, and offer to
  // finish it CONVERSATIONALLY — the assistant asks in plain language and writes
  // the canonical files (no YAML to edit). This is the #1 adoption barrier.
  let d = $state<Doctor | null>(null);
  let dismissed = $state(false);
  let cli = $state(true); // assume until read (avoid CTA flash)

  onMount(() => {
    cli = hasCli();
    fetch("/api/doctor")
      .then((r) => r.json())
      .then((j: Doctor) => (d = j))
      .catch(() => {});
  });

  const items = $derived((d?.missing ?? []).map((m) => LABELS[m] ?? m));
  const kickoff = $derived(
    `Help me finish setting up career-ops. I still need to add ${items.join(", ")} — walk me through just those, conversationally, and write the files for me. Don't ask me for anything that's already set up (for example, don't ask for my CV if it's already saved).`,
  );
</script>

{#if !dismissed && d && d.onboardingNeeded}
  <div class="dot-bg relative mb-6 overflow-hidden rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/10 via-surface/40 to-transparent p-5">
    <button
      onclick={() => (dismissed = true)}
      class="absolute right-3 top-3 text-faint transition-colors hover:text-foreground"
      aria-label="Dismiss"
    >
      <X class="size-4" />
    </button>
    <h2 class="font-display text-xl text-landing">Let's finish setting you up</h2>
    <p class="mt-1.5 max-w-xl text-sm text-muted">
      career-ops works best when it knows you. We still need {items.join(", ")}.{" "}
      <span class="text-foreground">No YAML to edit</span> — answer in plain language and the assistant writes it
      for you.
    </p>
    {#if cli}
      <button
        onclick={() => window.dispatchEvent(new CustomEvent("co-assistant", { detail: { message: kickoff } }))}
        class="mt-4 inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
      >
        <Sparkles class="size-4" /> Set me up with the assistant
      </button>
    {:else}
      <!-- The assistant needs a CLI to run — without one the kickoff would silently
           drop. Send them to connect one first. -->
      <a
        href="/config"
        class="mt-4 inline-flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200"
      >
        <Settings class="size-4" /> Connect your AI CLI to get started
      </a>
    {/if}
  </div>
{/if}
