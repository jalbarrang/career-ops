<script lang="ts">
  import { onMount } from "svelte";
  import { marked } from "marked";
  import { AlertTriangle, Check, Library, Loader2, Minus, RotateCcw, X } from "@lucide/svelte";
  import { cn } from "@/lib/cn";

  type CheckStatus = "pass" | "warn" | "fail" | "skip";

  type ReviewCheck = {
    id: string;
    label: string;
    status: CheckStatus;
    summary: string;
    details: string[];
  };

  type Review = { checks: ReviewCheck[]; headline: string; ranAt: string };

  type Backup = { name: string; savedAt: string; bytes: number };

  type Tab = "preview" | "review" | "history";

  // The four states the core's commands can land in. "skip" is separate from
  // "pass" on purpose: a check that could not run (no cv.md yet) must never read
  // as a green tick.
  const STATUS_META: Record<CheckStatus, { icon: typeof Check; className: string }> = {
    pass: { icon: Check, className: "text-emerald-600 dark:text-emerald-400" },
    warn: { icon: AlertTriangle, className: "text-amber-600 dark:text-amber-400" },
    fail: { icon: X, className: "text-red-600 dark:text-red-400" },
    skip: { icon: Minus, className: "text-faint" },
  };

  function formatWhen(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
  }

  function formatBytes(bytes: number): string {
    return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
  }

  let content = $state("");
  let loaded = $state(false);
  let exists = $state(true);
  let dirty = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state("");
  let tab = $state<Tab>("preview");

  let review = $state<Review | null>(null);
  let reviewing = $state(false);
  let backups = $state<Backup[]>([]);
  let restoring = $state<string | null>(null);
  let pendingRestore = $state<string | null>(null);

  async function loadReview(): Promise<void> {
    reviewing = true;
    try {
      const res = await fetch("/api/cv/review");
      if (res.ok) review = (await res.json()) as Review;
    } catch {
      // The panel keeps whatever it showed last; a failed re-check is not a
      // reason to blank the findings the user is reading.
    } finally {
      reviewing = false;
    }
  }

  async function loadHistory(): Promise<void> {
    try {
      const res = await fetch("/api/cv/history");
      if (res.ok) backups = ((await res.json()) as { backups?: Backup[] }).backups ?? [];
    } catch {
      backups = [];
    }
  }

  onMount(() => {
    fetch("/api/cv")
      .then((r) => r.json() as Promise<{ content?: string; exists?: boolean }>)
      .then((d) => {
        content = d.content ?? "";
        exists = d.exists ?? false;
      })
      .catch(() => (error = "Couldn’t read cv.md."))
      .finally(() => (loaded = true));
    void loadHistory();
    void loadReview();
  });

  // cv.md is gitignored user-layer data, so a discarded edit cannot be recovered
  // from git — the browser has to ask first.
  $effect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  });

  async function save(): Promise<void> {
    saving = true;
    error = "";
    try {
      const res = await fetch("/api/cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        error = d.error ?? "Save failed.";
        return;
      }
      dirty = false;
      exists = true;
      saved = true;
      setTimeout(() => (saved = false), 2000);
      await Promise.all([loadReview(), loadHistory()]);
    } catch {
      error = "Couldn’t reach the server.";
    } finally {
      saving = false;
    }
  }

  async function restore(name: string): Promise<void> {
    restoring = name;
    error = "";
    try {
      const res = await fetch("/api/cv/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
      if (!res.ok || typeof d.content !== "string") {
        error = d.error ?? "Restore failed.";
        return;
      }
      content = d.content;
      dirty = false;
      exists = true;
      pendingRestore = null;
      await Promise.all([loadReview(), loadHistory()]);
    } catch {
      error = "Couldn’t reach the server.";
    } finally {
      restoring = null;
    }
  }
</script>

{#snippet tabButton(id: Tab, label: string, badge: string | undefined)}
  <button
    type="button"
    onclick={() => (tab = id)}
    class={cn(
      "inline-flex min-h-[36px] items-center gap-1.5 rounded-full px-3 text-sm transition-colors",
      tab === id ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground",
    )}
  >
    {label}
    {#if badge}<span class="text-xs text-faint">{badge}</span>{/if}
  </button>
{/snippet}

<div class="mx-auto max-w-6xl px-6 py-8">
  <div class="flex items-end justify-between gap-4">
    <div>
      <h1 class="font-display text-2xl tracking-tight text-landing">CV editor</h1>
      <p class="mt-1 text-sm text-muted">
        Edit <code class="text-foreground">cv.md</code> with live preview.
        {#if !exists && loaded}<span class="ml-1 text-faint">No cv.md yet — start typing to create it.</span>{/if}
        {#if dirty}<span class="ml-1 text-amber-600 dark:text-amber-400">Unsaved changes.</span>{/if}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <a
        href="/cv/profile"
        class="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
      >
        <Library class="size-4" /> Career profile
      </a>
      <button
        type="button"
        onclick={save}
        disabled={saving || !dirty}
        class={cn(
          "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
          dirty ? "bg-brand text-brand-foreground hover:bg-brand-200" : "border border-border bg-surface text-muted",
        )}
      >
        {#if saving}<Loader2 class="size-4 animate-spin" />{:else if saved}<Check class="size-4" />{/if}
        {saved ? "Saved" : "Save"}
      </button>
    </div>
  </div>

  {#if error}
    <p role="alert" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-600 dark:text-red-400">
      {error}
    </p>
  {/if}

  {#if !loaded}
    <div class="mt-6 text-sm text-muted">Loading…</div>
  {:else}
    <div class="mt-6 grid gap-4 lg:grid-cols-2">
      <textarea
        value={content}
        oninput={(e) => {
          content = e.currentTarget.value;
          dirty = true;
        }}
        spellcheck="false"
        placeholder={"# Your Name\n\n## Summary\n..."}
        class="min-h-[60vh] w-full resize-none rounded-2xl border border-border bg-surface/50 p-4 font-mono text-sm leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-brand/40"
      ></textarea>

      <div class="flex min-h-[60vh] flex-col rounded-2xl border border-border bg-surface/30">
        <div class="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
          <div class="flex items-center gap-1">
            {@render tabButton("preview", "Preview", undefined)}
            {@render tabButton("review", "Review", review ? review.headline : undefined)}
            {@render tabButton("history", "History", backups.length ? String(backups.length) : undefined)}
          </div>
          {#if tab === "review"}
            <button
              type="button"
              onclick={() => void loadReview()}
              disabled={reviewing}
              class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-60"
            >
              {#if reviewing}<Loader2 class="size-3.5 animate-spin" />{:else}<RotateCcw class="size-3.5" />{/if}
              Re-check
            </button>
          {/if}
        </div>

        {#if tab === "preview"}
          <article class="report-prose flex-1 overflow-auto p-5">
            {#if content.trim()}
              {@html marked(content, { async: false })}
            {:else}
              <p class="text-muted">Preview appears here.</p>
            {/if}
          </article>
        {/if}

        {#if tab === "review"}
          <div class="flex-1 overflow-auto p-4">
            {#if !review}
              <p class="text-sm text-muted">{reviewing ? "Running the core’s checks…" : "No checks yet."}</p>
            {:else}
              <ul class="space-y-3">
                {#each review.checks as check (check.id)}
                  {@const meta = STATUS_META[check.status]}
                  {@const Icon = meta.icon}
                  <li class="rounded-xl border border-border bg-surface/60 p-3">
                    <div class="flex items-start gap-2">
                      <Icon class={cn("mt-0.5 size-4 shrink-0", meta.className)} aria-hidden="true" />
                      <div class="min-w-0 flex-1">
                        <p class="text-sm font-medium text-foreground">{check.label}</p>
                        <p class="text-xs text-muted">{check.summary}</p>
                        {#if check.details.length > 0}
                          <details class="mt-2">
                            <summary class="cursor-pointer text-xs text-faint hover:text-muted">{check.details.length} detail(s)</summary>
                            <ul class="mt-1.5 space-y-1 font-mono text-xs text-muted">
                              {#each check.details as line, i (i)}
                                <li class="break-words">{line}</li>
                              {/each}
                            </ul>
                          </details>
                        {/if}
                      </div>
                    </div>
                  </li>
                {/each}
              </ul>
              <p class="mt-3 text-xs text-faint">Checked {formatWhen(review.ranAt)} · results reflect the saved cv.md.</p>
            {/if}
          </div>
        {/if}

        {#if tab === "history"}
          <div class="flex-1 overflow-auto p-4">
            {#if backups.length === 0}
              <p class="text-sm text-muted">No snapshots yet — the first save creates one.</p>
            {:else}
              <ul class="space-y-2">
                {#each backups as bak (bak.name)}
                  <li class="rounded-xl border border-border bg-surface/60 px-3 py-2">
                    <div class="flex items-center justify-between gap-3">
                      <div class="min-w-0">
                        <p class="truncate text-sm text-foreground">{formatWhen(bak.savedAt)}</p>
                        <p class="text-xs text-faint">{formatBytes(bak.bytes)}</p>
                      </div>
                      {#if pendingRestore === bak.name}
                        <div class="flex items-center gap-1.5">
                          <button
                            type="button"
                            onclick={() => void restore(bak.name)}
                            disabled={restoring !== null}
                            class="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-60"
                          >
                            {restoring === bak.name ? "Restoring…" : "Replace cv.md"}
                          </button>
                          <button
                            type="button"
                            onclick={() => (pendingRestore = null)}
                            class="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
                          >
                            Cancel
                          </button>
                        </div>
                      {:else}
                        <button
                          type="button"
                          onclick={() => (pendingRestore = bak.name)}
                          class="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
                        >
                          Restore
                        </button>
                      {/if}
                    </div>
                    {#if pendingRestore === bak.name}
                      <p class="mt-2 text-xs text-amber-600 dark:text-amber-400">
                        This overwrites cv.md{dirty ? " and discards your unsaved edits" : ""}. The current version is snapshotted first, so it stays restorable.
                      </p>
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
