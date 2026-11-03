<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { Check, Pencil, X } from "@lucide/svelte";
  import { CANONICAL_STATES, statusDot } from "@/lib/format";
  import { cn } from "@/lib/cn";
  import { saveStatus } from "@/lib/pipeline-status.mjs";

  // Status writeback control. Updates the existing tracker row (status cell) via
  // /api/status — never adds rows. Reverts on failure; confirms with the
  // terminal-popup animation.
  //
  // The React version keyed the editor on props.n (`<StatusEditor key={n}>`) so
  // switching rows reset its local state. In Svelte the caller does the same
  // with `{#key n}` — pipeline-view.svelte wraps every row's control in one.
  let {
    n,
    current,
    inline = false,
    applicationLabel,
    onSaved,
  }: {
    n: string;
    current: string;
    inline?: boolean;
    applicationLabel?: string;
    onSaved?: (status: string, restoreFocus: boolean) => void;
  } = $props();

  // The React app used useId(): one stable id per editor, linking the <select>
  // to its label and its error line.
  const id = $props.id();
  const label = $derived(applicationLabel ?? `application #${n}`);

  // Seeded from the row once. The select owns its value afterwards, so a parent
  // re-render must not clobber an edit in progress.
  let status = $state(untrack(() => current));
  let saved = $state(false);
  let busy = $state(false);
  let editing = $state(false);
  let error = $state("");

  // Plain refs, not reactive: these gate writes and timers, never markup.
  let saving = false;
  let mounted = false;
  let savedTimer: ReturnType<typeof setTimeout> | null = null;
  let pencil = $state<HTMLButtonElement | null>(null);
  let select = $state<HTMLSelectElement | null>(null);

  $effect(() => {
    // Read `current` so an external change (a tracker refresh) re-syncs the
    // editor — but never while our own write is in flight.
    const next = current;
    if (!saving) status = next;
  });

  onMount(() => {
    mounted = true;
    return () => {
      mounted = false;
      if (savedTimer) clearTimeout(savedTimer);
    };
  });

  $effect(() => {
    if (editing && inline) select?.focus();
  });

  function cancel() {
    if (saving) return;
    status = current;
    editing = false;
    error = "";
    requestAnimationFrame(() => pencil?.focus());
  }

  async function onChange(event: Event & { currentTarget: EventTarget & HTMLSelectElement }) {
    const next = event.currentTarget.value;
    const prev = inline ? current : status;
    if (saving || next === prev) return;
    const hadFocus = document.activeElement === select;
    saving = true;
    status = next;
    busy = true;
    saved = false;
    error = "";
    try {
      const confirmed = await saveStatus(n, prev, next);
      if (!confirmed) return;
      // A filter may unmount this editor while the write is in flight. Still
      // refresh; the parent's callback captures identity, never row position.
      // Disabling a focused select can move focus to body. Restore it only
      // if the user has not moved to search, tabs or another row meanwhile.
      const restoreFocus = hadFocus && (document.activeElement === document.body || document.activeElement === select);
      if (onSaved) onSaved(confirmed, restoreFocus);
      else void invalidateAll();
      if (!mounted) return;
      status = confirmed;
      editing = false;
      saved = true;
      if (savedTimer) clearTimeout(savedTimer);
      savedTimer = setTimeout(() => (saved = false), 2000);
      if (inline && restoreFocus) {
        requestAnimationFrame(() => pencil?.focus());
      }
    } catch (cause) {
      if (!mounted) return;
      status = prev; // revert on failure
      error = cause instanceof Error ? cause.message : "Could not save status. Please try again.";
    } finally {
      saving = false;
      if (mounted) busy = false;
    }
  }

  const shown = $derived(inline && !busy ? current : status);
  const known = $derived((CANONICAL_STATES as readonly string[]).includes(shown));
  const buttonClass =
    "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-brand focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50 max-sm:size-11";
</script>

<span class="inline-flex flex-wrap items-center gap-2" aria-busy={busy}>
  {#if inline}
    {#if editing}
      <select
        bind:this={select}
        {id}
        aria-label={`Status for ${label}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        value={shown}
        onchange={onChange}
        onkeydown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            cancel();
          }
        }}
        disabled={busy}
        class="rounded-md border border-border bg-surface px-2.5 py-1 text-sm text-foreground outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50 max-sm:min-h-[44px]"
      >
        {#if !known}
          <option value={shown}>{shown}</option>
        {/if}
        {#each CANONICAL_STATES as s (s)}
          <option value={s}>{s}</option>
        {/each}
      </select>
      <button
        type="button"
        aria-label={`Cancel editing status for ${label}`}
        title="Cancel"
        onclick={cancel}
        disabled={busy}
        class={buttonClass}
      >
        <X aria-hidden="true" class="size-3.5" />
      </button>
    {:else}
      <span class="inline-flex items-center gap-1.5">
        <span aria-hidden="true" class={cn("size-1.5 shrink-0 rounded-full", statusDot(shown))}></span>
        {shown}
      </span>
      <button
        bind:this={pencil}
        type="button"
        aria-label={`Edit status for ${label}`}
        title="Edit status"
        onclick={() => {
          error = "";
          editing = true;
        }}
        class={buttonClass}
      >
        <Pencil aria-hidden="true" class="size-4" />
      </button>
    {/if}
  {:else}
    <label for={id} class="text-xs text-faint">status</label>
    <select
      bind:this={select}
      {id}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      value={shown}
      onchange={onChange}
      disabled={busy}
      class="rounded-md border border-border bg-surface px-2.5 py-1 text-sm text-foreground outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40 disabled:opacity-50 max-sm:min-h-[44px]"
    >
      {#if !known}
        <option value={shown}>{shown}</option>
      {/if}
      {#each CANONICAL_STATES as s (s)}
        <option value={s}>{s}</option>
      {/each}
    </select>
  {/if}
  {#if busy}<span role="status" class="text-xs text-faint">saving…</span>{/if}
  {#if saved}
    <span role="status" class="animate-terminal-popup inline-flex items-center gap-1 text-xs font-medium text-brand">
      <Check aria-hidden="true" class="size-3" /> saved
    </span>
  {/if}
  {#if error}
    <span id={`${id}-error`} role="alert" class="basis-full whitespace-normal text-xs text-red-600">{error}</span>
  {/if}
</span>
