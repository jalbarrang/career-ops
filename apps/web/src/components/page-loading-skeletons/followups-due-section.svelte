<script lang="ts">
  import { Skeleton } from "@/components/ui/skeleton";

  let { rows = 3 }: { rows?: number } = $props();
</script>

<section class="mt-10" aria-label="Loading follow-ups due">
  <div class="mb-3 flex items-center gap-2">
    <Skeleton class="size-4 rounded" />
    <Skeleton class="h-3 w-28" />
    <Skeleton class="h-3 w-64 max-w-[50vw]" />
  </div>
  <div class="grid gap-2.5">
    {#each Array.from({ length: rows }) as _, i (i)}
      <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface/40 px-3.5 py-3">
        <div class="flex min-w-0 flex-[1_1_55%] items-center gap-3">
          <Skeleton class="size-[22px] shrink-0 rounded-full" />
          <div class="min-w-0 flex-1 space-y-2">
            <Skeleton class="h-4 w-48 max-w-full" />
            <Skeleton class="h-3 w-28" />
          </div>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <Skeleton class="h-7 w-28 rounded-md" />
          <Skeleton class="size-6 rounded" />
          <Skeleton class="h-4 w-12" />
        </div>
      </div>
    {/each}
  </div>
</section>
