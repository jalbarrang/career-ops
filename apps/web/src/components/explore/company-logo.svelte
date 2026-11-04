<script lang="ts">
  // Real company logo (favicon) via the localhost proxy, cached on disk FOREVER per
  // company — so once it resolves it's instant for this card AND every other card,
  // this search or any future one. Falls back to a monogram on miss.
  let { company }: { company: string } = $props();

  let failed = $state(false);

  const letter = $derived((company || "?").trim().charAt(0).toUpperCase());
</script>

{#if failed || !company.trim()}
  <div class="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-sm font-semibold text-brand">{letter}</div>
{:else}
  <img
    src={`/api/logo?company=${encodeURIComponent(company)}`}
    alt=""
    loading="lazy"
    onerror={() => (failed = true)}
    class="size-9 shrink-0 rounded-lg border border-border bg-surface object-contain p-1"
  />
{/if}
