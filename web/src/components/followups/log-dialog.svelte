<script lang="ts">
  import { untrack } from "svelte";
  import { Loader2, X } from "@lucide/svelte";
  import { CHANNELS, localISODate, type CadenceEntry, type Channel } from "@/lib/followups";
  import { cn } from "@/lib/cn";

  // "Log" — the full-fidelity FollowUp entry (date, channel enum, contact,
  // notes). Appends one table row via /api/followups/log.
  let {
    entry,
    onclose,
    onlogged,
  }: { entry: CadenceEntry; onclose: () => void; onlogged: () => void } = $props();

  // Local day, not UTC — east of UTC toISOString() defaults to "yesterday"
  // and its max would block picking the user's actual today.
  let date = $state(localISODate());
  let channel = $state<Channel>("Email");
  // untrack() documents the intent the React original had by construction:
  // these are FORM INITIALISERS, not mirrors of the prop. Retyping in the
  // dialog must not be reset when the parent re-renders.
  let contact = $state(untrack(() => entry.contacts[0]?.email ?? ""));
  let notes = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);

  // Keep free text single-line and pipe-free BEFORE it leaves the client
  // (the API's cell() normalizes again server-side — defense in depth): the
  // log is a pipe-delimited markdown table, so `|` and newlines would break
  // the row format.
  const tableSafe = (s: string) => s.replace(/[\r\n]+/g, " ").replace(/\|/g, "/").trim();

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    saving = true;
    error = null;
    try {
      const res = await fetch("/api/followups/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appNum: entry.num,
          company: entry.company,
          role: entry.role,
          date,
          channel,
          contact: tableSafe(contact),
          notes: tableSafe(notes),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        error = typeof j.error === "string" ? j.error : "Could not log the follow-up.";
        saving = false;
        return;
      }
      onlogged();
      onclose();
    } catch {
      error = "Could not log the follow-up.";
      saving = false;
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
    aria-label={`Log follow-up for ${entry.company}`}
    class="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-xl"
  >
    <div class="flex items-start justify-between gap-4">
      <div>
        <h2 class="font-display text-lg">Log follow-up</h2>
        <p class="mt-0.5 text-sm text-muted">
          {entry.company} · {entry.role} <span class="text-faint">(#{entry.num})</span>
        </p>
      </div>
      <button type="button" onclick={onclose} aria-label="Close" class="rounded p-1 text-faint transition hover:text-foreground">
        <X class="size-4" />
      </button>
    </div>

    <form onsubmit={submit} class="mt-4 space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <label class="block text-xs font-medium text-muted">
          Date
          <input
            type="date"
            required
            value={date}
            max={localISODate()}
            onchange={(e) => (date = e.currentTarget.value)}
            class={cn(inputCls, "mt-1")}
          />
        </label>
        <label class="block text-xs font-medium text-muted">
          Channel
          <select
            value={channel}
            onchange={(e) => (channel = e.currentTarget.value as Channel)}
            class={cn(inputCls, "mt-1")}
          >
            {#each CHANNELS as c (c)}
              <option value={c}>{c}</option>
            {/each}
          </select>
        </label>
      </div>
      <label class="block text-xs font-medium text-muted">
        Contact <span class="font-normal text-faint">(optional)</span>
        <input
          value={contact}
          oninput={(e) => (contact = e.currentTarget.value)}
          placeholder="who you reached out to"
          list={entry.contacts.length ? `co-contacts-${entry.num}` : undefined}
          class={cn(inputCls, "mt-1")}
        />
        {#if entry.contacts.length > 0}
          <datalist id={`co-contacts-${entry.num}`}>
            {#each entry.contacts as c (c.email)}
              <option value={c.email}>{c.name ?? ""}</option>
            {/each}
          </datalist>
        {/if}
      </label>
      <label class="block text-xs font-medium text-muted">
        Notes <span class="font-normal text-faint">(optional)</span>
        <textarea
          value={notes}
          oninput={(e) => (notes = e.currentTarget.value)}
          rows={3}
          placeholder="what you said, what you're waiting on…"
          class={cn(inputCls, "mt-1 resize-none")}
        ></textarea>
      </label>
      {#if error}<p class="text-xs text-red-500">{error}</p>{/if}
      <div class="flex justify-end gap-2 pt-1">
        <button type="button" onclick={onclose} class="rounded-md px-3 py-2 text-sm text-muted transition hover:text-foreground">
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          class="inline-flex items-center gap-1.5 rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:pointer-events-none disabled:opacity-60"
        >
          {#if saving}<Loader2 class="size-3.5 animate-spin" />{/if} Log follow-up
        </button>
      </div>
    </form>
  </div>
</div>
