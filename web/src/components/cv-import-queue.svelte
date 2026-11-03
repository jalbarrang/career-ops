<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowLeft, Check, Loader2, Pencil, SkipForward, X } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import { applyBlockDecision, groupImportBlocks, suggestEntryFields } from "@/lib/cv-import.mjs";

  type Candidate = {
    section: string;
    parent: string | null;
    isHeading: boolean;
    text: string;
    label: string;
  };

  type Block = {
    key: string;
    kind: "entry" | "flat";
    section: string;
    headingIndices: number[];
    ownerIndex: number;
    factIndices: number[];
    labels: string[];
  };

  type Preview = {
    candidates: Candidate[];
    total: number;
    totalMatches: boolean;
    source: string;
    cvFingerprint: string | null;
    profileExists: boolean;
  };

  type Decision = { action: "approve" | "skip" | "edit"; text?: string };

  const SECTION_LABEL: Record<string, string> = {
    summary: "Summary",
    experiences: "Experience",
    projects: "Projects",
    education: "Education",
    certifications: "Certifications",
    skills: "Skills",
  };

  let preview = $state<Preview | null>(null);
  let error = $state("");
  let loading = $state(true);
  let filter = $state<string>("all");
  // One entry per candidate, positionally — the importer answers prompts in
  // order, so this array IS the answer sheet buildReviewInput consumes.
  let decisions = $state<(Decision | undefined)[]>([]);
  let editing = $state<number | null>(null);
  let draft = $state("");
  let saving = $state(false);
  let result = $state("");

  async function load(): Promise<void> {
    loading = true;
    error = "";
    try {
      const res = await fetch("/api/cv/profile/import");
      const body = (await res.json()) as Preview & { error?: string };
      if (!res.ok) {
        error = body.error ?? "Could not read the import preview.";
        return;
      }
      preview = body;
      decisions = new Array(body.candidates.length).fill(undefined) as (Decision | undefined)[];
    } catch {
      error = "Couldn’t reach the server.";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  const candidates = $derived(preview?.candidates ?? []);

  // Grouped into the units a person reviews: one job is one block, even when the
  // parser split it into a company line, a role line and a date range.
  const blocks = $derived(groupImportBlocks(candidates) as Block[]);

  const visible = $derived(blocks.filter((block) => filter === "all" || block.section === filter));

  const counts = $derived.by(() => {
    const bySection = new Map<string, number>();
    for (const candidate of candidates) bySection.set(candidate.section, (bySection.get(candidate.section) ?? 0) + 1);
    return bySection;
  });

  /** A block is chosen when the entry it would create is approved. */
  function blockApproved(block: Block): boolean {
    const target = block.ownerIndex >= 0 ? block.ownerIndex : block.factIndices[0];
    const decision = decisions[target];
    return decision?.action === "approve" || decision?.action === "edit";
  }

  function blockChoice(block: Block, action: "approve" | "skip"): void {
    decisions = applyBlockDecision(block, action, decisions) as (Decision | undefined)[];
  }

  function setDecision(index: number, decision: Decision | null): void {
    const next = [...decisions];
    next[index] = decision ?? undefined;
    decisions = next;
  }

  function acceptVisible(): void {
    let next = decisions;
    for (const block of visible) next = applyBlockDecision(block, "approve", next) as (Decision | undefined)[];
    decisions = next;
  }

  const decided = $derived(decisions.filter((decision) => decision?.action === "approve" || decision?.action === "edit").length);

  async function save(): Promise<void> {
    saving = true;
    error = "";
    result = "";
    try {
      const payload = candidates.map((_, index) => decisions[index] ?? { action: "skip" as const });
      const res = await fetch("/api/cv/profile/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: payload,
          cvFingerprint: preview?.cvFingerprint,
        }),
      });
      const body = (await res.json()) as { summary?: string; error?: string; details?: string[] };
      if (!res.ok) {
        error = [body.error, ...(body.details ?? [])].filter(Boolean).join(" — ") || "The import was rejected.";
        return;
      }
      result = body.summary ?? "Saved.";
      decisions = new Array(candidates.length).fill(undefined) as (Decision | undefined)[];
      await load();
    } catch {
      error = "Couldn’t reach the server.";
    } finally {
      saving = false;
    }
  }

  /** The text of one candidate, or the textarea while it is being rewritten. */
</script>

{#snippet renderBody(index: number)}
  {@const candidate = candidates[index]}
  {@const decision = decisions[index]}
  {#if editing === index}
    <div class="mt-1">
      <textarea
        value={draft}
        oninput={(event) => (draft = event.currentTarget.value)}
        rows="3"
        class="w-full resize-y rounded-lg border border-border bg-surface p-2 font-mono text-xs leading-relaxed outline-none focus:border-brand/40"
      ></textarea>
      <div class="mt-1.5 flex items-center gap-1.5">
        <button
          type="button"
          onclick={() => {
            setDecision(index, { action: "edit", text: draft });
            editing = null;
          }}
          class="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200"
        >
          Use this wording
        </button>
        <button
          type="button"
          onclick={() => (editing = null)}
          class="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  {:else}
    <p class={cn("text-sm", candidate.isHeading ? "font-medium text-foreground" : "text-foreground/90")}>
      {decision?.action === "edit" && decision.text ? decision.text : candidate.text}
      {#if decision?.action === "edit" && decision.text}
        <span class="ml-2 text-xs text-brand-text">rewritten</span>
      {/if}
    </p>
  {/if}
{/snippet}

{#snippet renderControls(index: number)}
  {@const approved = decisions[index]?.action === "approve" || decisions[index]?.action === "edit"}
  <div class="flex shrink-0 items-center gap-1">
    <button
      type="button"
      onclick={() => setDecision(index, approved ? null : { action: "approve" })}
      aria-label={approved ? "Skip this" : "Approve this"}
      class={cn(
        "rounded-full border p-1.5 transition-colors",
        approved ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "border-border text-muted hover:text-foreground",
      )}
    >
      {#if approved}<Check class="size-3.5" />{:else}<SkipForward class="size-3.5" />{/if}
    </button>
    <button
      type="button"
      onclick={() => {
        editing = index;
        draft = decisions[index]?.action === "edit" ? (decisions[index]?.text ?? candidates[index].text) : candidates[index].text;
      }}
      aria-label="Rewrite this"
      class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
    >
      <Pencil class="size-3.5" />
    </button>
    <button
      type="button"
      onclick={() => setDecision(index, null)}
      aria-label="Clear this decision"
      class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
    >
      <X class="size-3.5" />
    </button>
  </div>
{/snippet}

<div class="mx-auto max-w-5xl px-6 py-8">
  <a href="/cv/profile" class="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground">
    <ArrowLeft class="size-4" /> Career profile
  </a>

  <div class="mt-3 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="font-display text-2xl tracking-tight text-landing">Import into your career profile</h1>
      <p class="mt-1 max-w-2xl text-sm text-muted">
        Every fact <code class="text-foreground">career-profile.mjs</code> pulled out of <code class="text-foreground">cv.md</code>, with the line it came from.
        One role is one decision: the company, title and date lines the parser split apart stay together here, and only the block you approve becomes an entry.
      </p>
    </div>
    {#if preview}
      <p class="text-sm text-faint">
        {preview.total} candidate{preview.total === 1 ? "" : "s"} from {preview.source}
        {#if preview.profileExists}<span class="ml-1">· profile exists, approved items merge into it</span>{/if}
      </p>
    {/if}
  </div>

  {#if error}
    <p role="alert" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-600 dark:text-red-400">
      {error}
    </p>
  {/if}
  {#if result}
    <p class="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-400">{result}</p>
  {/if}
  {#if preview && !preview.totalMatches}
    <p class="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
      The importer reported {preview.total} candidates but only {preview.candidates.length} parsed. Reload before saving — answers line up by position.
    </p>
  {/if}

  {#if loading}
    <div class="mt-8 flex items-center gap-2 text-sm text-muted">
      <Loader2 class="size-4 animate-spin" /> Reading cv.md…
    </div>
  {:else if preview}
    <div class="mt-6 flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onclick={() => (filter = "all")}
        class={cn("rounded-full px-3 py-1 text-sm transition-colors", filter === "all" ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground")}
      >
        All <span class="text-xs text-faint">{candidates.length}</span>
      </button>
      {#each [...counts.entries()] as [section, count] (section)}
        <button
          type="button"
          onclick={() => (filter = section)}
          class={cn("rounded-full px-3 py-1 text-sm transition-colors", filter === section ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground")}
        >
          {SECTION_LABEL[section] ?? section} <span class="text-xs text-faint">{count}</span>
        </button>
      {/each}
    </div>

    <ul class="mt-4 max-h-[58vh] space-y-2 overflow-auto rounded-2xl border border-border bg-surface/30 p-2">
      {#each visible as block (block.key)}
        {@const approved = blockApproved(block)}
        {@const isEntry = block.kind === "entry"}
        {@const ownerIndex = block.ownerIndex >= 0 ? block.ownerIndex : block.factIndices[0]}
        {@const metadata = block.labels.slice(0, -1)}
        <li class={cn("rounded-xl border px-3 py-2 transition-colors", approved ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-surface/60")}>
          <div class="flex items-start gap-3">
            <div class="min-w-0 flex-1">
              <p class="text-xs text-faint">
                <span class={isEntry ? "text-brand-text" : undefined}>{SECTION_LABEL[block.section] ?? block.section}</span>
                {#if isEntry}<span class="ml-1">entry · {block.factIndices.length} fact(s)</span>{/if}
              </p>

              {#if isEntry && metadata.length > 0 && !(suggestEntryFields(block.labels).company && suggestEntryFields(block.labels).role)}
                <p class="mt-0.5 text-xs text-muted">
                  {metadata.join(" · ")}
                  <span class="ml-1 text-faint">— same role, kept out as its own entry</span>
                </p>
              {/if}

              {#if isEntry}
                <!-- Title the block the way the entry will be named once the
                     fields below are applied, instead of the parser's own
                     heading (usually the date range). -->
                <p class="text-sm font-medium text-foreground">
                  {suggestEntryFields(block.labels).company && suggestEntryFields(block.labels).role
                    ? `${suggestEntryFields(block.labels).company} — ${suggestEntryFields(block.labels).role}`
                    : candidates[ownerIndex].text}
                  {#if approved}<span class="ml-2 text-xs font-normal text-emerald-600 dark:text-emerald-400">included</span>{/if}
                </p>
              {:else}
                {@render renderBody(ownerIndex)}
              {/if}

              {#if isEntry}
                {@const guess = suggestEntryFields(block.labels)}
                {@const parts = [guess.company, guess.role, guess.dates].filter(Boolean)}
                {#if parts.length > 0}
                  <p class="mt-1 text-xs text-muted">
                    Saves as <span class="text-foreground">{guess.company || "(no company)"}</span>
                    {#if guess.role}· <span class="text-foreground">{guess.role}</span>{/if}
                    {#if guess.dates}· <span class="text-foreground">{guess.dates}</span>{/if}
                  </p>
                {/if}
              {/if}

              {#if isEntry && block.factIndices.length === 0}
                <p class="mt-0.5 text-xs text-amber-600 dark:text-amber-400">No facts under this heading — approving it adds an empty entry.</p>
              {/if}

              {#if isEntry && block.factIndices.length > 0}
                <ul class="mt-1.5 space-y-1 border-l border-border pl-2">
                  {#each block.factIndices as index (index)}
                    <li>
                      <div class="flex items-start gap-2">
                        <div class="min-w-0 flex-1">{@render renderBody(index)}</div>
                        {@render renderControls(index)}
                      </div>
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>

            <div class="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onclick={() => blockChoice(block, approved ? "skip" : "approve")}
                aria-label={approved ? "Skip this role" : "Approve this role"}
                class={cn(
                  "rounded-full border p-1.5 transition-colors",
                  approved ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "border-border text-muted hover:text-foreground",
                )}
              >
                {#if approved}<Check class="size-3.5" />{:else}<SkipForward class="size-3.5" />{/if}
              </button>
              {#if !isEntry}{@render renderControls(ownerIndex)}{/if}
            </div>
          </div>
        </li>
      {/each}
      {#if visible.length === 0}
        <li class="px-3 py-6 text-center text-sm text-muted">Nothing in this section.</li>
      {/if}
    </ul>

    <div class="sticky bottom-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface/90 px-4 py-3 backdrop-blur">
      <div class="text-sm text-muted">
        <span class="text-foreground">{decided}</span> of {candidates.length} approved
        {#if decided === 0}<span class="ml-1 text-faint">· nothing will be written</span>{/if}
      </div>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={acceptVisible}
          class="rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
        >
          Approve all shown
        </button>
        <button
          type="button"
          onclick={() => void save()}
          disabled={saving || decided === 0}
          class={cn(
            "inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
            decided > 0 ? "bg-brand text-brand-foreground hover:bg-brand-200" : "border border-border bg-surface text-muted",
          )}
        >
          {#if saving}<Loader2 class="size-4 animate-spin" />{/if}
          Save {decided > 0 ? `${decided} ` : ""}to profile
        </button>
      </div>
    </div>
  {/if}
</div>
