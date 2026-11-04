<script lang="ts">
  // The conversation-history bar: pick a saved chat, rename or delete it, and the
  // two alert rows that stand between a failed save and a lost conversation. All
  // state stays in the console — this is a pure render of it.
  type ChatEntry = { id: string; title: string; revision: number };

  let {
    chats,
    selected,
    revision,
    locked,
    warnings,
    saveError,
    chatReady,
    busy,
    chatPending,
    onselect,
    onrename,
    ondelete,
    onretry,
    onexport,
    ondiscard,
    onreload,
  }: {
    chats: ChatEntry[];
    selected: string;
    revision: number;
    locked: boolean;
    warnings: { id: string; error: string }[];
    saveError: string;
    chatReady: boolean;
    busy: boolean;
    chatPending: boolean;
    onselect: (id?: string) => void;
    onrename: () => void;
    ondelete: () => void;
    onretry: () => void;
    onexport: () => void;
    ondiscard: () => void;
    onreload: () => void;
  } = $props();
</script>

<div class="flex gap-2 border-b border-border px-4 py-2">
  <select
    aria-label="Conversation history"
    class="min-w-0 flex-1 bg-surface text-sm"
    value={selected}
    disabled={locked}
    onchange={(e) => onselect(e.currentTarget.value || undefined)}
  >
    <option value="">New chat</option>
    {#each chats as c (c.id)}
      <option value={c.id}>{c.title}</option>
    {/each}
  </select>
  <button type="button" class="text-xs text-muted disabled:opacity-40" disabled={locked || !revision} onclick={onrename}>Rename</button>
  <button type="button" class="text-xs text-muted disabled:opacity-40" disabled={locked || !revision} onclick={ondelete}>Delete</button>
</div>

{#each warnings as warning (warning.id)}
  <div role="alert" class="px-4 py-2 text-sm text-amber-600">{warning.error}. Other conversations are still available.</div>
{/each}

{#if saveError}
  <div role="alert" class="space-y-2 px-4 py-2 text-sm text-amber-600">
    <p>{saveError}</p>
    {#if chatReady}
      <div class="flex flex-wrap gap-3">
        <button type="button" class="underline" disabled={busy || chatPending} onclick={onretry}>Retry save</button>
        <button type="button" class="underline" disabled={busy || chatPending} onclick={onexport}>Export conversation</button>
        <button type="button" class="underline" disabled={busy || chatPending} onclick={ondiscard}>Discard unsaved changes and start new chat</button>
      </div>
    {:else}
      <button type="button" class="underline" onclick={onreload}>Reload</button>
    {/if}
  </div>
{/if}
