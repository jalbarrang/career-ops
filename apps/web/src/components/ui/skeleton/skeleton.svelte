<script lang="ts">
  import { cn, type WithElementRef, type WithoutChildren } from "@/lib/cn.js";
  import type { HTMLAttributes } from "svelte/elements";

  // shadcn-svelte's Skeleton. The shimmer comes from the app's own `.skeleton`
  // class (app.css) rather than shadcn's `bg-muted animate-pulse`, for two
  // reasons: `--color-muted` here is a TEXT colour (used ~300× as `text-muted`),
  // so `bg-muted` would paint the text colour as a surface; and the app already
  // renders a directional sheen that matches the route transition bar.
  let {
    ref = $bindable(null),
    class: className,
    ...restProps
  }: WithoutChildren<WithElementRef<HTMLAttributes<HTMLDivElement>>> = $props();
</script>

<div bind:this={ref} data-slot="skeleton" class={cn("skeleton rounded-xl", className)} {...restProps}></div>
