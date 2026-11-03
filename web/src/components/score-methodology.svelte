<script lang="ts">
  import { ChevronDown, ExternalLink } from "@lucide/svelte";

  // Transparency = our differentiator ("why it's a 4.0 for YOU"). The wording is
  // the CANONICAL public text from career-ops.org/methodology + /docs — rendered
  // verbatim, NOT a web reinterpretation of the rubric (whose weights live in the
  // core, modes/_shared.md). Native <details> → no client JS.

  const DIMENSIONS: [string, string][] = [
    ["Match", "how well your CV maps to the role's requirements"],
    ["North-star alignment", "how far the role moves you toward your stated career goal"],
    ["Compensation", "the offer vs market rates (says “insufficient data” when comp is missing — never invents numbers)"],
    ["Cultural signals", "team, values and ways-of-working signals from the posting"],
    ["Red flags", "ghost-job, scam or mismatch warnings"],
    ["Overall", "the single judgment that rolls the above into the score"],
  ];

  const BLOCKS: [string, string][] = [
    ["A", "Plain-English summary of the role"],
    ["B", "A table of how your CV matches each requirement, how much each requirement matters for this posting, and the gaps"],
    ["C", "Strategy — how to position yourself for this role"],
    ["D", "Compensation research, comparing the offer to market rates"],
    ["E", "Personalization notes for your application"],
    ["F", "Interview prep — STAR stories tailored to this job"],
    ["G", "Posting legitimacy — a check that the listing is real, not a scam or ghost job"],
  ];
</script>

<details class="group mt-10 overflow-hidden rounded-2xl border border-border bg-surface/30">
  <summary class="flex cursor-pointer list-none items-center gap-2 px-5 py-3.5 text-sm font-medium transition-colors hover:bg-surface-hover">
    How career-ops scored this — and why it's for <span class="text-landing">you</span>
    <ChevronDown class="ml-auto size-4 text-faint transition-transform group-open:rotate-180" />
  </summary>
  <div class="space-y-5 border-t border-border px-5 py-4 text-sm">
    <p class="text-muted">
      Every role is scored <strong class="text-foreground">1.0–5.0</strong> across six dimensions.
      <strong class="text-brand">4.0</strong> is the apply / don't-apply line — below it, career-ops recommends against applying.
    </p>
    <div>
      <div class="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-faint">The six dimensions</div>
      <ul class="space-y-1.5">
        {#each DIMENSIONS as [k, v] (k)}
          <li>
            <span class="font-medium text-foreground">{k}</span> <span class="text-muted">— {v}</span>
          </li>
        {/each}
      </ul>
    </div>
    <div>
      <div class="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-faint">What each report block means</div>
      <ul class="space-y-2">
        {#each BLOCKS as [k, v] (k)}
          <li class="flex items-start gap-2.5">
            <span class="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded bg-brand-soft text-xs font-semibold text-brand">
              {k}
            </span>
            <span class="text-muted">{v}</span>
          </li>
        {/each}
      </ul>
    </div>
    <a
      href="https://career-ops.org/methodology"
      target="_blank"
      rel="noreferrer"
      aria-label="Full methodology (opens in a new tab)"
      class="inline-flex min-h-[24px] items-center gap-1 text-xs text-brand transition-colors hover:underline max-sm:min-h-[44px]"
    >
      Full methodology <ExternalLink class="size-3" aria-hidden="true" />
    </a>
  </div>
</details>
