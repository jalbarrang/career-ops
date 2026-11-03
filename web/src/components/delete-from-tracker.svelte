<script lang="ts">
  import { goto } from "$app/navigation";
  import { Trash2, Loader2 } from "@lucide/svelte";

  // disc#9: remove a bogus tracker row (e.g. a job marked Evaluated after the CLI
  // errored mid-run). Hard delete via the core write-gate (/api/tracker/delete →
  // tracker.mjs delete), behind a confirm. The soft option (status → Discarded) lives
  // in StatusSelect and stays for real-but-passed applications.
  let { n }: { n: string } = $props();

  let open = $state(false);
  let orphan = $state<string | null>(null);
  let busy = $state(false);
  let err = $state("");

  async function openConfirm() {
    open = true;
    err = "";
    orphan = null;
    try {
      const r = await fetch("/api/tracker/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n, dryRun: true }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string; orphanReport?: string | null };
      if (!r.ok) {
        err = d.error || "This row can’t be removed.";
        return;
      }
      orphan = d.orphanReport ?? null;
    } catch {
      err = "Couldn’t reach the tracker.";
    }
  }

  async function confirmDelete() {
    busy = true;
    err = "";
    try {
      const r = await fetch("/api/tracker/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ n }),
      });
      const d = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        err = d.error || "Delete failed.";
        busy = false;
        return;
      }
      // Row is gone — leave the (now-orphaned) report page for the pipeline. The
      // navigation re-runs the pipeline's load, which is the router.refresh()
      // the React version fired after its push.
      await goto("/pipeline");
    } catch {
      err = "Delete failed.";
      busy = false;
    }
  }
</script>

{#if !open}
  <button
    onclick={openConfirm}
    class="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted max-sm:min-h-[44px] transition-colors hover:border-red-400/50 hover:text-red-500"
  >
    <Trash2 class="size-3.5" /> Remove from tracker
  </button>
{:else}
  <div class="rounded-lg border border-red-400/30 bg-red-500/[0.06] p-3 text-xs">
    <p class="font-medium text-foreground">Permanently remove application #{n} from your tracker?</p>
    <p class="mt-1 text-muted">
      This can’t be undone.{orphan ? ` Its report file (${orphan}) is left on disk.` : ""}
    </p>
    {#if err}<p class="mt-1.5 text-red-500">{err}</p>{/if}
    <div class="mt-2.5 flex gap-2">
      <button
        disabled={busy}
        onclick={confirmDelete}
        class="inline-flex items-center gap-1.5 rounded-md bg-red-500 px-2.5 py-1 font-medium max-sm:min-h-[44px] text-white transition-colors hover:bg-red-600 disabled:opacity-50"
      >
        {#if busy}<Loader2 class="size-3.5 animate-spin" />{:else}<Trash2 class="size-3.5" />{/if} Delete
      </button>
      <button
        disabled={busy}
        onclick={() => (open = false)}
        class="rounded-md border border-border px-2.5 py-1 text-muted max-sm:min-h-[44px] transition-colors hover:text-foreground disabled:opacity-50"
      >
        Cancel
      </button>
    </div>
  </div>
{/if}
