<script lang="ts">
  import { Coins, Leaf, Sparkles } from "@lucide/svelte";
  import { COST_META, type CostClass } from "@/lib/explore-cost";

  // One primitive, four variants — the app's cost color-semantics (career-ops-ux
  // lock, for DESIGN_SYSTEM.md): GREEN = free/positive (celebrate); NEUTRAL/muted
  // (+ coin icon) = spend ("Uses tokens") — it INFORMS, it must not alarm nor
  // celebrate, and crucially it must NOT be brand-orange: orange is reserved for
  // the primary action (e.g. "Run your first FREE scan"), so an orange spend badge
  // would collide ("go/free" vs "costs") and shout louder than the action itself.
  // Muted spend AA-verified in both themes. Styles live in app.css (.co-cost).
  let { kind, size = "sm", class: klass = "" }: { kind: CostClass; size?: "xs" | "sm"; class?: string } = $props();

  const tone = $derived(kind === "spend" ? "spend" : "free");
  const Icon = $derived(kind === "spend" ? Coins : kind === "free-gemini" ? Sparkles : Leaf);
</script>

<span class="co-cost {klass}" data-tone={tone} data-size={size} title={COST_META[kind].tip}>
  <Icon aria-hidden="true" />
  {COST_META[kind].label}
</span>
