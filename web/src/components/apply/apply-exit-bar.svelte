<script lang="ts">
  import { onMount } from "svelte";
  import { goto, invalidateAll } from "$app/navigation";
  import { ArrowLeft, ClipboardCheck, Loader2 } from "@lucide/svelte";
  import { useApply } from "@/lib/apply.svelte";
  import { needsLeaveConfirmation, resolveReturnPath } from "@/lib/apply/exit.mjs";

  // ── Leaving the page: back out, or record that you applied ─────────────────
  // You submit the real form yourself on the employer's site, so the moment you
  // apply happens outside career-ops — this is where you tell the tracker about
  // it. The write goes through /api/status, the same route the tracker's own
  // status control uses, so there is only ever one writer to the table.
  const a = useApply();

  let confirming = $state(false);
  let marking = $state(false);
  let error = $state("");
  // The status write outlives this bar when the user navigates while it is in
  // flight. The write still lands; what must not happen is dragging them back
  // off whatever page they moved on to once it returns.
  // Starts true and is only ever cleared on teardown, so a late response is the
  // only thing it can refuse — never the bar's own first render.
  let onPage = true;
  onMount(() => {
    return () => {
      onPage = false;
    };
  });

  // reset() also closes the headless form session on the user's machine —
  // navigating away without it strands the browser this page opened. The
  // destination is read before reset() clears the origin it comes from.
  //
  // The staleness check comes FIRST, before reset(). By the time a late status
  // response gets here the user may have started a different application, and
  // reset() is not addressed to a particular session: it would close whichever
  // one is open now, taking a form the user is in the middle of with it.
  // Leaving that session alone is the same outcome as navigating away from the
  // page by any other route.
  function leave(): void {
    if (!onPage) return;
    const target = resolveReturnPath(a.from);
    a.reset();
    // The Next app's router.push() + router.refresh(): navigate, then drop the
    // server data the tracker pages cached so the row they return to is fresh.
    void goto(target).then(() => invalidateAll());
  }

  async function markApplied(): Promise<void> {
    marking = true;
    error = "";
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n: a.n, status: "Applied" }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        if (!onPage) return; // moved on already; the row is unchanged
        error = d.error || "Couldn't mark it applied — the tracker row is unchanged.";
        marking = false;
        return;
      }
      leave();
    } catch {
      if (!onPage) return; // moved on already
      // The route writes the tracker before it answers, so a connection that
      // drops on the way back leaves the write's fate genuinely unknown —
      // claiming the row is untouched here would be a guess.
      error = "Couldn't confirm the update — check the row in your tracker before relying on it.";
      marking = false;
    }
  }
</script>

{#if confirming}
  <div class="co-rise mt-8 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 backdrop-blur-sm">
    <p class="text-sm font-medium text-foreground">Leave this application?</p>
    <p class="mt-1 text-xs text-muted">Your drafted answers live only on this page. Going back discards them and closes the form.</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <button
        type="button"
        onclick={leave}
        class="inline-flex items-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-amber-600 max-sm:min-h-[44px]"
      >
        <ArrowLeft class="size-3.5" /> Leave and discard
      </button>
      <button
        type="button"
        onclick={() => (confirming = false)}
        class="rounded-md border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
      >
        Stay here
      </button>
    </div>
  </div>
{:else}
  <div class="mt-8 border-t border-border/70 pt-5">
    <div class="flex flex-wrap items-center gap-3">
      <button
        type="button"
        onclick={() => (needsLeaveConfirmation({ status: a.status, answers: a.answers }) ? (confirming = true) : leave())}
        class="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm font-medium text-muted transition-colors hover:border-brand/40 hover:text-brand max-sm:min-h-[44px]"
      >
        <ArrowLeft class="size-4" /> Back
      </button>
      {#if a.n}
        <button
          type="button"
          onclick={markApplied}
          disabled={marking}
          title={`Set tracker row #${a.n} to Applied and go back`}
          class="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-700 transition-colors hover:bg-emerald-500/20 disabled:opacity-50 dark:text-emerald-400 max-sm:min-h-[44px]"
        >
          {#if marking}<Loader2 class="size-4 animate-spin" />{:else}<ClipboardCheck class="size-4" />{/if}
          {marking ? "Updating your tracker…" : "Mark applied"}
        </button>
      {/if}
      {#if a.n}<span class="text-xs text-muted">Click this once you have submitted the real form yourself.</span>{/if}
    </div>
    {#if error}<p class="mt-2 text-xs text-red-500">{error}</p>{/if}
  </div>
{/if}
