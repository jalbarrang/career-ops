<script lang="ts">
  import { getLocale, locales, setLocale } from "@/lib/paraglide/runtime";
  import { m } from "@/lib/paraglide/messages";
  import { cn } from "@/lib/cn";

  // Two-letter codes in a tight row — this is a local dashboard, not a marketing
  // site, so the switcher earns its space by being one click and no dropdown.
  //
  // `setLocale()` is left on its default behaviour (reload) on purpose: the
  // locale lives in a cookie and every string is rendered on the server, so a
  // client-only swap would leave the already-hydrated text in the old language.
  let { class: klass }: { class?: string } = $props();

  const current = getLocale();
</script>

<div class={cn("flex items-center gap-1", klass)} role="group" aria-label={m.shell_language()}>
  {#each locales as locale (locale)}
    <button
      type="button"
      onclick={() => setLocale(locale)}
      lang={locale}
      aria-current={locale === current ? "true" : undefined}
      class="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-faint transition-colors hover:bg-surface-hover hover:text-foreground aria-[current]:bg-brand-soft aria-[current]:text-brand-text"
    >
      {locale}
    </button>
  {/each}
</div>
