<script lang="ts">
  import { untrack } from "svelte";
  import { Loader2, Pin, PinOff, X } from "@lucide/svelte";
  import { localISODate, type CadenceEntry } from "@/lib/followups";
  import { cn } from "@/lib/cn";

  /** Local today + N days, as YYYY-MM-DD. */
  function plusDays(n: number): string {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return localISODate(d);
  }

  // Pin a custom NEXT follow-up date for one application — overrides the
  // computed cadence (even revives a cold one) until a follow-up is logged after
  // the pin, which resumes the normal schedule. POST/DELETE /api/followups/override.
  let {
    entry,
    onclose,
    onchanged,
  }: { entry: CadenceEntry; onclose: () => void; onchanged: () => void } = $props();

  const today = localISODate();
  // A form initialiser, not a mirror of the prop — see log-dialog.svelte.
  let date = $state(untrack(() => (entry.nextFollowupDate && entry.nextFollowupDate > today ? entry.nextFollowupDate : plusDays(3))));
  let busy = $state<"set" | "clear" | null>(null);
  let error = $state<string | null>(null);

  async function call(method: "POST" | "DELETE", body: Record<string, unknown>, kind: "set" | "clear"): Promise<void> {
    busy = kind;
    error = null;
    try {
      const res = await fetch("/api/followups/override", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        error = typeof j.error === "string" ? j.error : "Could not update the pin.";
        busy = null;
        return;
      }
      onchanged();
      onclose();
    } catch {
      error = "Could not update the pin.";
      busy = null;
    }
  }

  const inputCls =
    "w-full rounded-md border border-border bg-surface/60 px-3 py-2 text-sm outline-none transition-colors placeholder:text-faint focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40";
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === "Escape") onclose();
  }}
/>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
  role="presentation"
  onmousedown={(e) => {
    if (e.target === e.currentTarget) onclose();
  }}
>
  <div
    role="dialog"
    aria-modal="true"
    aria-label={`Pin next follow-up date for ${entry.company}`}
    class="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-xl"
  >
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="font-display text-lg">Pin next follow-up</h2>
        <p class="mt-0.5 text-sm text-muted">
          {entry.company} · {entry.role} <span class="text-faint">(#{entry.num})</span>
        </p>
      </div>
      <button type="button" onclick={onclose} aria-label="Close" class="rounded p-1 text-faint transition hover:text-foreground">
        <X class="size-4" />
      </button>
    </div>

    <form
      onsubmit={(e) => {
        e.preventDefault();
        void call("POST", { appNum: entry.num, date }, "set");
      }}
      class="mt-4 space-y-3"
    >
      <label class="block text-xs font-medium text-muted">
        Next follow-up date
        <input
          type="date"
          required
          value={date}
          min={today}
          onchange={(e) => (date = e.currentTarget.value)}
          class={cn(inputCls, "mt-1")}
        />
      </label>
      <div class="flex gap-2">
        {#each [3, 7, 14] as n (n)}
          <button
            type="button"
            onclick={() => (date = plusDays(n))}
            class={cn(
              "rounded-md border border-border bg-surface px-2.5 py-1 text-xs font-medium transition-colors hover:bg-surface-hover",
              date === plusDays(n) && "border-brand/50 bg-brand-soft text-brand",
            )}
          >
            +{n} days
          </button>
        {/each}
      </div>
      <p class="text-xs leading-relaxed text-faint">
        Overrides the computed schedule until you log a follow-up, which resumes the normal cadence.
      </p>
      {#if error}<p class="text-xs text-red-500">{error}</p>{/if}
      <div class="flex items-center justify-end gap-2 pt-1">
        {#if entry.nextOverride}
          <button
            type="button"
            disabled={busy !== null}
            onclick={() => void call("DELETE", { appNum: entry.num }, "clear")}
            class="mr-auto inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium text-muted transition-colors hover:text-red-500 disabled:pointer-events-none disabled:opacity-60"
            title={`Currently pinned to ${entry.nextOverride}`}
          >
            {#if busy === "clear"}<Loader2 class="size-3.5 animate-spin" />{:else}<PinOff class="size-3.5" />{/if} Clear pin
          </button>
        {/if}
        <button type="button" onclick={onclose} class="rounded-md px-3 py-2 text-sm text-muted transition hover:text-foreground">
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy !== null}
          class="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:pointer-events-none disabled:opacity-60"
        >
          {#if busy === "set"}<Loader2 class="size-3.5 animate-spin" />{:else}<Pin class="size-3.5" />{/if} Pin date
        </button>
      </div>
    </form>
  </div>
</div>
