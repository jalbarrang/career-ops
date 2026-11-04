<script lang="ts">
  import { Skeleton } from "@/components/ui/skeleton";

  let { rows = 8, trackerColumn = false }: { rows?: number; trackerColumn?: boolean } = $props();
</script>

{#each Array.from({ length: rows }) as _, i (i)}
  <tr>
    {#if trackerColumn}
      <td class="px-4 py-3"><Skeleton class="h-4 w-8" /></td>
    {/if}
    <td class="px-4 py-3">
      <div class="flex items-center gap-2.5">
        <Skeleton class="size-5 rounded-full" />
        <Skeleton class="h-4 w-28" />
      </div>
    </td>
    <td class="px-4 py-3"><Skeleton class="h-4 w-40" /></td>
    <td class="px-4 py-3"><Skeleton class="h-5 w-12 rounded-full" /></td>
    <td class="whitespace-nowrap px-4 py-3">
      <div class="flex items-center gap-1.5">
        <Skeleton class="size-1.5 rounded-full" />
        <Skeleton class="h-4 w-20" />
      </div>
    </td>
    <td class="whitespace-nowrap px-4 py-3{trackerColumn ? ' hidden lg:table-cell' : ''}"><Skeleton class="h-4 w-20" /></td>
  </tr>
{/each}
