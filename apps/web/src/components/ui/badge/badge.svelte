<script lang="ts" module>
  import { type VariantProps, tv } from "tailwind-variants";

  // shadcn-svelte's Badge, extended with this app's score/status tones.
  //
  // The tones (good / warn / bad / info / muted) predate shadcn here: they are
  // what `scoreTone()` and `followupStatusTone()` return, and ~8 call sites pass
  // them as `tone=`. They are registered as variants so both spellings work and
  // a single component serves shadcn-style usage and the app's semantics.
  //
  // `tabular-nums` is deliberate on the tones: a score badge sits in a table
  // column, and proportional digits make every row shift as the number changes.
  export const badgeVariants = tv({
    base: "h-5 gap-1 rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium transition-all has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-3! group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none",
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary: "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive dark:bg-destructive/20",
        outline: "border-border text-foreground [a]:hover:bg-surface-hover [a]:hover:text-muted-foreground",
        ghost: "hover:bg-surface-hover hover:text-muted-foreground dark:hover:bg-surface-hover/50",
        link: "text-primary underline-offset-4 hover:underline",
        // career-ops tones
        good: "bg-emerald-500/15 text-emerald-700 tabular-nums dark:text-emerald-400",
        warn: "bg-amber-500/15 text-amber-700 tabular-nums dark:text-amber-400",
        bad: "bg-red-500/15 text-red-700 tabular-nums dark:text-red-400",
        info: "bg-sky-500/15 text-sky-700 tabular-nums dark:text-sky-400",
        muted: "bg-surface-hover text-muted tabular-nums",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  });

  export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];
  /** The app's score/status tones, now a subset of BadgeVariant. */
  export type BadgeTone = "good" | "warn" | "bad" | "info" | "muted";
</script>

<script lang="ts">
  import { cn, type WithElementRef } from "@/lib/cn.js";
  import type { HTMLAnchorAttributes } from "svelte/elements";

  let {
    ref = $bindable(null),
    href,
    class: className,
    variant,
    tone,
    children,
    ...restProps
  }: WithElementRef<HTMLAnchorAttributes> & {
    variant?: BadgeVariant;
    /** career-ops score/status tone; wins over `variant` when both are given. */
    tone?: BadgeTone;
  } = $props();

  const resolved = $derived(tone ?? variant ?? "default");
</script>

<svelte:element
  this={href ? "a" : "span"}
  bind:this={ref}
  data-slot="badge"
  {href}
  class={cn(badgeVariants({ variant: resolved }), className)}
  {...restProps}
>
  {@render children?.()}
</svelte:element>
