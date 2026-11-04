<script lang="ts">
  import type { PageData } from "./$types";
  import OnboardingBanner from "@/components/onboarding-banner.svelte";
  import FirstRunHome from "@/components/home/first-run-home.svelte";
  import TodayDashboard from "@/components/home/today-dashboard.svelte";

  // The snapshot (applications/inbox) and the lifecycle phase come from the
  // server load; this page only picks which home to show — the same branch the
  // Next page made in render.
  let { data }: { data: PageData } = $props();
</script>

{#if data.phase === "first-run"}
  <FirstRunHome />
{:else}
  {#if data.onboardingNeeded}<OnboardingBanner />{/if}
  <TodayDashboard applications={data.applications} inbox={data.inbox} inBetween={data.phase === "in-between"} />
{/if}
