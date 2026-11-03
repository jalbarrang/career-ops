<script lang="ts">
  import { instrumentSerif } from "@/lib/fonts";

  // Brand mark — lowercase "co" on brand orange in Instrument Serif. Matches the
  // favicon and the career-ops-docs home one-for-one so the app reads as a
  // sibling. Dual meaning: "co" of career-ops AND "co" of companies — the word
  // the manifesto inverts ("…AI to choose companies").
  let { size = 28 }: { size?: number } = $props();
</script>

<span
  aria-hidden="true"
  class="{instrumentSerif.className} inline-flex shrink-0 items-center justify-center rounded-md bg-brand text-white"
  style="width:{size}px;height:{size}px;font-size:{Math.round(size * 0.78)}px;letter-spacing:0.01em;line-height:1;padding-bottom:{Math.round(size * 0.08)}px"
>
  co
</span>
