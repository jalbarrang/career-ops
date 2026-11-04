<script lang="ts">
  import type { Snippet } from "svelte";
  import { Dialog, DialogContent } from "@/components/ui/dialog";
  import { cn } from "@/lib/cn";

  // The scheduled-scan dialogs, built on shadcn-svelte's Dialog (bits-ui).
  //
  // This used to be a hand-rolled overlay: a fixed scrim, a panel, Escape
  // handling, a hand-written Tab focus trap, focus restore on close, and a
  // scroll lock — ~100 lines re-implementing what bits-ui already ships. The
  // public API is unchanged, so the three call sites keep working; two variants
  // cover the two shapes they need:
  //
  //   center (default) — the create / edit job modals
  //   drawer           — the execution history panel, anchored right, full height
  //
  // `initialfocus` is still honoured: bits-ui focuses the panel, but these forms
  // open with the cursor in the first field, which is what the effect below does.
  let {
    isopen,
    onclose,
    titleid,
    initialfocus = null,
    children,
    variant = "center",
    panelclass = "",
  }: {
    isopen: boolean;
    onclose: () => void;
    titleid: string;
    initialfocus?: HTMLElement | null;
    children?: Snippet;
    variant?: "center" | "drawer";
    panelclass?: string;
  } = $props();

  // DialogContent is centred by default; a drawer re-anchors it to the right edge
  // and lets it fill the viewport height. twMerge resolves these against the base
  // (top-1/2 → top-0, left-1/2 → left-auto, translate-* → 0, grid → flex).
  const DRAWER = "top-0 left-auto right-0 h-full max-h-none w-full max-w-md translate-x-0 translate-y-0 rounded-none rounded-l-2xl p-0 flex flex-col sm:max-w-md";

  // A centred dialog with more content than the viewport would otherwise be
  // pinned at top-1/2 and lose its header above the fold — shadcn's base sets no
  // max-height because its own dialogs are short. dvh (not vh) so a mobile URL
  // bar doesn't hide the save button.
  const CENTERED = "max-h-[90dvh] overflow-y-auto";

  let focusedForOpen = false;
  $effect(() => {
    if (!isopen) {
      focusedForOpen = false;
      return;
    }
    const target = initialfocus;
    if (!target || focusedForOpen) return;
    target.focus();
    focusedForOpen = true;
  });
</script>

<Dialog open={isopen} onOpenChange={(next) => (next ? undefined : onclose())}>
  <DialogContent
    class={cn(variant === "drawer" ? DRAWER : CENTERED, panelclass)}
    showCloseButton={false}
    aria-labelledby={titleid}
  >
    {@render children?.()}
  </DialogContent>
</Dialog>
