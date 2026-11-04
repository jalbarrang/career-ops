<script lang="ts">
  import { Asterisk, FileCheck2, Paperclip } from "@lucide/svelte";
  import type { ApplyField } from "@/lib/apply/extract";
  import { cn } from "@/lib/cn";

  let {
    field: f,
    value,
    needs,
    index,
    drafting,
    onChange,
  }: {
    field: ApplyField;
    value: string;
    needs: boolean;
    index: number;
    drafting: boolean;
    onChange: (v: string) => void;
  } = $props();

  // Flash brand-orange the moment a drafted answer first lands (empty → value).
  // Seeded once from the first value, exactly like the React useRef it replaces:
  // it records what was on screen last, so it must not follow the prop.
  // svelte-ignore state_referenced_locally
  let prev = value;
  let flash = $state(false);

  $effect(() => {
    if (!prev && value) {
      flash = true;
      // outlast the staggered animation-delay (≤900ms) + the 1.15s flash
      const t = setTimeout(() => (flash = false), 2300);
      prev = value;
      return () => clearTimeout(t);
    }
    prev = value;
  });

  const base = $derived(
    cn(
      "w-full rounded-lg border bg-surface/60 px-3 py-2 text-sm outline-none transition focus:border-brand/60 focus:ring-2 focus:ring-brand/20",
      needs ? "border-amber-500/50" : "border-border",
    ),
  );
  // While the planner is drafting, an empty answer shimmers like it's being
  // written; it flashes into the real value the instant the draft lands.
  const writing = $derived(drafting && !value && f.type !== "file");
</script>

<div class={flash ? "co-flash" : ""} style:animation-delay={flash ? `${Math.min(index * 70, 900)}ms` : undefined}>
  <label class="mb-1.5 flex items-center gap-1 text-sm font-medium">
    {#if f.label}
      {f.label}
    {:else}
      <span class="text-faint">Untitled field</span>
    {/if}
    {#if f.required}<Asterisk class="size-3 text-brand" />{/if}
    {#if needs}
      <span class="ml-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">you confirm</span>
    {/if}
  </label>
  {#if writing}
    <div class={cn("co-skel", f.type === "textarea" ? "h-[68px]" : "h-9")}></div>
  {:else if f.type === "textarea"}
    <textarea
      rows="3"
      maxlength={f.maxLength}
      {value}
      oninput={(e) => onChange(e.currentTarget.value)}
      placeholder={needs ? "You fill this one." : "…"}
      class={cn(base, "resize-none")}
    ></textarea>
  {:else if (f.type === "select" || f.type === "radio") && f.options && f.options.length > 0}
    <select {value} onchange={(e) => onChange(e.currentTarget.value)} class={base}>
      <option value="">Choose…</option>
      {#each f.options as o, i (i)}
        <option value={o}>{o}</option>
      {/each}
    </select>
  {:else if f.type === "checkbox"}
    <label class="flex items-center gap-2 text-sm text-muted">
      <input
        type="checkbox"
        checked={value === "true" || value === "yes"}
        onchange={(e) => onChange(e.currentTarget.checked ? "true" : "")}
        class="size-4 accent-brand"
      /> {f.label || "Yes"}
    </label>
  {:else if f.type === "file"}
    {#if /resume|résumé|\bcv\b|curriculum|currículum|lebenslauf/i.test(f.label || "")}
      <div class="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
        <FileCheck2 class="size-4 shrink-0" /> Your tailored CV (PDF) will be attached automatically — you can swap it on the real form.
      </div>
    {:else}
      <div class="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-sm text-muted">
        <Paperclip class="size-4 shrink-0" /> Attach this file yourself on the real form at the handoff.
      </div>
    {/if}
  {:else}
    <input
      type={["email", "tel", "url", "number", "date"].includes(f.type) ? f.type : "text"}
      maxlength={f.maxLength}
      {value}
      oninput={(e) => onChange(e.currentTarget.value)}
      placeholder={needs ? "You fill this one." : "…"}
      class={base}
    />
  {/if}
</div>
