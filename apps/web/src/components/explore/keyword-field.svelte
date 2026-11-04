<script lang="ts">
  import { Ban, X } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import { cleanChips } from "@/lib/explore";

  // A chip list that commits on an EXPLICIT separator only — see commit() for why
  // spaces are never one. Mirrors filter-builder's local KeywordField.
  let {
    values,
    tone,
    placeholder,
    ariaLabel,
    onchange,
  }: {
    values: string[];
    tone: "inc" | "exc";
    placeholder: string;
    ariaLabel?: string;
    onchange: (v: string[]) => void;
  } = $props();

  let draft = $state("");

  // Split only on UNAMBIGUOUS item separators (comma / newline / semicolon) — never
  // bare spaces, which are legitimate inside multi-word entries ("AI platform",
  // "New York", "Costa Rica"). A space-only paste stays one chip on purpose (#1147).
  function commit(text: string): void {
    const parts = text.split(/[,\n;\t\r]+/);
    onchange(cleanChips([...values, ...parts]));
    draft = "";
  }

  function onPaste(e: ClipboardEvent): void {
    e.preventDefault();
    const text = e.clipboardData?.getData("text") ?? "";
    const merged = draft + text;
    // Only commit to chips when the paste contains item separators.
    // A plain-text paste (e.g. pasting "-EMEA" after typing "Remote")
    // stays in the input field so the user can keep editing.
    if (/[,;\n\t\r]/.test(text)) commit(merged);
    else draft = merged;
  }
</script>

<div class={cn("co-fb__field border border-border bg-surface/40 focus-within:border-brand/40 transition-colors")}>
  {#each values as v (v)}
    <span class={cn("co-fb__chip", tone === "inc" ? "inc" : "border-border bg-surface-hover text-muted")}>
      {#if tone === "exc"}<Ban class="size-3 opacity-70" />{/if}
      {v}
      <button type="button" aria-label={`Remove ${v}`} onclick={() => onchange(values.filter((x) => x !== v))}>
        <X class="size-3" />
      </button>
    </span>
  {/each}
  <input
    aria-label={ariaLabel}
    value={draft}
    oninput={(e) => {
      const val = e.currentTarget.value;
      if (/[,\n;\t\r]$/.test(val)) commit(val);
      else draft = val;
    }}
    onkeydown={(e) => {
      if (e.key === "Enter" && draft.trim()) {
        e.preventDefault();
        commit(draft);
      } else if (e.key === "Backspace" && !draft && values.length) {
        onchange(values.slice(0, -1));
      }
    }}
    onpaste={onPaste}
    onblur={() => {
      if (draft.trim()) commit(draft);
    }}
    placeholder={values.length ? "" : placeholder}
  />
</div>

<style>
  :global(.co-fb__chip) {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    border-radius: 999px;
    padding: 0.2rem 0.5rem 0.2rem 0.6rem;
    font-size: 12.5px;
    line-height: 1.2;
    border: 1px solid transparent;
  }
  :global(.co-fb__chip button) {
    display: inline-flex;
    opacity: 0.6;
    transition: opacity 0.15s;
  }
  :global(.co-fb__chip button:hover) {
    opacity: 1;
  }
  :global(.co-fb__chip.inc) {
    color: hsl(26 78% 42%);
    background: hsl(26 73% 51% / 0.11);
    border-color: hsl(26 73% 51% / 0.26);
  }
  :global(html.dark .co-fb__chip.inc) {
    color: hsl(26 86% 70%);
    background: hsl(26 80% 55% / 0.14);
    border-color: hsl(26 80% 55% / 0.28);
  }
  :global(.co-fb__field) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    align-items: center;
    min-height: 2.6rem;
    padding: 0.45rem 0.55rem;
    border-radius: 0.7rem;
  }
  :global(.co-fb__field input) {
    flex: 1;
    min-width: 7rem;
    background: transparent;
    border: none;
    outline: none;
    font-size: 13.5px;
    color: inherit;
  }
  :global(.co-fb__field input::placeholder) {
    color: var(--co-faint, hsl(0 0% 60%));
  }
  @media (max-width: 639px) {
    :global(.co-fb__chip button) {
      min-width: 44px;
      min-height: 44px;
      justify-content: center;
    }
    :global(.co-fb__chip) {
      min-height: 44px;
    }
    :global(.co-fb__field) {
      min-height: 44px;
    }
    :global(.co-fb__field input) {
      min-height: 32px;
    }
  }
</style>
