<script lang="ts">
  import { Skeleton } from "@/components/ui/skeleton";

  let { rows = 6 }: { rows?: number } = $props();
</script>

{#each Array.from({ length: rows }) as _, i (i)}
  <tr>
    <td class="px-2 py-3"><Skeleton class="size-4 rounded-sm" /></td>
    <td class="px-2.5 py-3"><div class="flex items-center gap-2.5"><Skeleton class="size-5 rounded-full" /><Skeleton class="h-4 w-24" /></div></td>
    <td class="px-2.5 py-3"><Skeleton class="h-4 w-32" /></td>
    <td class="px-2.5 py-3"><Skeleton class="h-5 w-12 rounded-full" /></td>
    <td class="px-2.5 py-3"><Skeleton class="h-5 w-20 rounded-md" /></td>
    <td class="px-2.5 py-3"><Skeleton class="h-5 w-16 rounded-full" /></td>
    <td class="px-2.5 py-3"><Skeleton class="h-4 w-8" /></td>
    <td class="px-2.5 py-3"><Skeleton class="h-4 w-16" /></td>
    <td class="px-2.5 py-3"><Skeleton class="h-4 w-8" /></td>
    <td class="px-2.5 py-3"><Skeleton class="h-4 w-8" /></td>
    <td class="px-2.5 py-3"><Skeleton class="h-6 w-20 rounded-md" /></td>
  </tr>
{/each}
