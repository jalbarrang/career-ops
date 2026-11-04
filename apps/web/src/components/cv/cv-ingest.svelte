<script lang="ts">
  import { goto } from "$app/navigation";
  import { marked } from "marked";
  import { AlertTriangle, ArrowRight, Check, FileText, Loader2, Lock, RotateCcw, Upload } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import { instrumentSerif } from "@/lib/fonts";
  import { cvReadiness, parseCvStream, type CvSeed } from "@/lib/cv/quality";
  import { DEFAULT_FILTERS, filtersToParams } from "@/lib/explore";

  type Phase = "input" | "parsing" | "review" | "saving" | "error";

  let { onSaved }: { onSaved?: () => void } = $props();

  function cliId(): string | null {
    try {
      return JSON.parse(localStorage.getItem("career-ops:config") || "{}").cliId || null;
    } catch {
      return null;
    }
  }

  let phase = $state<Phase>("input");
  let paste = $state("");
  let over = $state(false);
  let trace = $state("");
  let md = $state("");
  let seed = $state<CvSeed | null>(null);
  let err = $state("");
  let fileInput = $state<HTMLInputElement | null>(null);

  const readiness = $derived(md ? cvReadiness(md) : null);
  // GFM (tables, strikethrough, autolinks) is on by default in marked, the same
  // set remark-gfm added on top of CommonMark.
  const markedHtml = $derived(marked(md, { async: false }));

  // Stream the ingest, parsing markers live.
  async function runStream(init: RequestInit): Promise<void> {
    phase = "parsing";
    trace = "Reading your CV…";
    err = "";
    try {
      const r = await fetch("/api/cv/ingest", init);
      if (r.status === 404) {
        err = "Connect an AI CLI in Config first — it parses your CV locally.";
        phase = "error";
        return;
      }
      if (!r.body) {
        err = "No response.";
        phase = "error";
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parsed = parseCvStream(buf);
        if (parsed.error) {
          err = parsed.error === "unreadable" ? "I couldn't read text from that file (it may be a scanned image). Paste the text instead." : "Couldn't parse the CV — paste the text instead.";
          phase = "error";
          return;
        }
        if (parsed.trace) trace = parsed.trace.split("\n").filter(Boolean).slice(-1)[0] || "Reading your CV…";
        if (parsed.markdown) md = parsed.markdown;
        if (parsed.seed) seed = parsed.seed;
      }
      const final = parseCvStream(buf);
      if (!final.markdown.trim()) {
        err = "Couldn't read a CV there — paste the text instead.";
        phase = "error";
        return;
      }
      md = final.markdown;
      seed = final.seed;
      phase = "review";
    } catch (e) {
      err = e instanceof Error ? e.message : "stream error";
      phase = "error";
    }
  }

  function ingestText(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      err = "That looks empty — paste your CV instead.";
      phase = "error";
      return;
    }
    // Pasted text is already readable. Same path as a .md/.txt drop — no CLI.
    // (PDF/DOCX still need a CLI below.)
    const id = cliId();
    if (!id) {
      seed = null;
      md = trimmed;
      phase = "review";
      return;
    }
    void runStream({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: trimmed, cliId: id }) });
  }

  function ingestFile(file: File): void {
    // .md/.txt/.markdown fast path — plain text, NO CLI needed, instant.
    if (/\.(md|markdown|txt)$/i.test(file.name)) {
      file
        .text()
        .then((t) => {
          if (!t.trim()) {
            err = "That file looks empty — paste your CV instead.";
            phase = "error";
            return;
          }
          seed = null;
          md = t.trim();
          phase = "review";
        })
        .catch(() => {
          err = "Couldn't read that file — paste your CV instead.";
          phase = "error";
        });
      return;
    }
    // PDF/other → the user's CLI parses it. Needs a configured CLI.
    const id = cliId();
    if (!id) {
      err = "needs-cli";
      phase = "error";
      return;
    }
    const form = new FormData();
    form.append("file", file);
    form.append("cliId", id);
    void runStream({ method: "POST", body: form });
  }

  let saveErr = $state("");
  async function save(): Promise<void> {
    if (!md.trim()) {
      saveErr = "Your CV looks empty — paste it again.";
      return;
    }
    saveErr = "";
    phase = "saving";
    try {
      const r = await fetch("/api/cv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: md }) });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        saveErr = d.error || "Couldn't save your CV — try again.";
        phase = "review"; // keep the parsed CV so they don't lose it
        return;
      }
    } catch {
      saveErr = "Couldn't save your CV — check your connection and try again.";
      phase = "review";
      return;
    }
    onSaved?.();
    // WOW #1 — land in the Explorer with the CV-derived filters in the URL + run=1,
    // so the Explorer auto-fires the FREE scan itself (robust, no push/replaceState race).
    // GENEROUS first scan so it never comes back empty (that would kill the wow): roles
    // only + a wide 30-day window; location stays a refinement for the deepen step, NOT a
    // hard exclude (allow=[] passes everything). Recall over precision for the first reveal.
    const roles = seed?.roles?.length ? seed.roles : seed?.title ? [seed.title] : [];
    const f = { ...DEFAULT_FILTERS, ats: [...DEFAULT_FILTERS.ats], positive: roles, sinceDays: 30 };
    const qs = filtersToParams(f);
    void goto(`/explore?${qs}${qs ? "&" : ""}run=1`);
  }
</script>

<!-- ── INPUT ── -->
{#if phase === "input" || phase === "error"}
  <div class="space-y-3">
    <!-- Drag-and-drop is an enhancement, not the way in: the textarea and the
         upload button inside are the accessible path, so the wrapper needs no
         role of its own. -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="co-cvdrop p-6"
      data-over={over ? "true" : "false"}
      ondragover={(e) => {
        e.preventDefault();
        over = true;
      }}
      ondragleave={() => (over = false)}
      ondrop={(e) => {
        e.preventDefault();
        over = false;
        const f = e.dataTransfer?.files?.[0];
        if (f) ingestFile(f);
      }}
    >
      <textarea
        value={paste}
        oninput={(e) => (paste = e.currentTarget.value)}
        onkeydown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && paste.trim()) ingestText(paste.trim());
        }}
        placeholder="Paste your CV here — or drop a PDF / .md file below. Even a rough paste works; we'll clean it up."
        class="h-32 w-full resize-none bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-faint"
      ></textarea>
      <div class="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <button
          type="button"
          onclick={() => fileInput?.click()}
          class="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface/50 px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-brand/40 hover:text-brand max-sm:min-h-[44px] max-sm:px-4"
        >
          <Upload class="size-3.5" /> Upload PDF / file
        </button>
        <input
          bind:this={fileInput}
          type="file"
          accept=".pdf,.md,.markdown,.txt,.docx"
          hidden
          onchange={(e) => e.currentTarget.files?.[0] && ingestFile(e.currentTarget.files[0])}
        />
        <span class="inline-flex items-center gap-1 text-[11px] text-faint">
          <Lock class="size-3" /> Stays on your machine. Parsed by your own AI.
        </span>
        <button
          type="button"
          disabled={!paste.trim()}
          onclick={() => ingestText(paste.trim())}
          class="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-brand-foreground shadow-sm transition hover:brightness-110 disabled:opacity-50 max-sm:min-h-[44px]"
        >
          Read my CV <ArrowRight class="size-4" />
        </button>
      </div>
    </div>
    {#if phase === "error"}
      {#if err === "needs-cli"}
        <div class="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[13px] text-amber-700 dark:text-amber-300">
          <AlertTriangle class="size-3.5 shrink-0" />
          <span>To read a PDF or Word file, connect an AI CLI in Config. Paste or drop .md / .txt to start without one.</span>
          <a
            href="/config"
            class="ml-auto inline-flex items-center gap-1 rounded-md bg-amber-500/20 px-2.5 py-1 font-medium text-amber-700 transition hover:bg-amber-500/30 dark:text-amber-200"
          >
            Connect your AI CLI <ArrowRight class="size-3.5" />
          </a>
        </div>
      {:else}
        <p class="flex items-center gap-1.5 text-[13px] text-amber-600 dark:text-amber-400">
          <AlertTriangle class="size-3.5 shrink-0" /> {err}
        </p>
      {/if}
    {/if}
  </div>
{:else if phase === "parsing"}
  <!-- ── PARSING (the 10s bridge) ── -->
  <div class="rounded-2xl border border-border bg-surface/60 p-6 backdrop-blur-sm">
    <div class="flex items-center gap-2.5">
      <Loader2 class="size-4 animate-spin text-brand" />
      <span class="{instrumentSerif.className} text-lg text-foreground">{trace || "Reading your CV…"}</span>
    </div>
    <div class="mt-3 inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
      <span class="size-1.5 rounded-full bg-emerald-500"></span> 0 tokens · $0.00 · local
    </div>
    {#if md}
      <div class="co-cvtrace mt-4 max-h-40 overflow-hidden rounded-lg border border-border bg-surface/40 p-3 text-[11px] text-faint">{md.slice(0, 400)}…</div>
    {/if}
  </div>
{:else}
  <!-- ── REVIEW (propose → confirm) ── -->
  <div class="rounded-2xl border border-border bg-surface/60 p-4 backdrop-blur-sm md:p-5">
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <FileText class="size-4 text-brand" />
      <h3 class="{instrumentSerif.className} text-lg text-foreground">Here&#39;s your CV — review and save</h3>
      {#if readiness}
        <span
          class={cn(
            "ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
            readiness.scoreable ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-amber-500/10 text-amber-600 dark:text-amber-400",
          )}
        >
          {#if readiness.scoreable}<Check class="size-3" />{:else}<AlertTriangle class="size-3" />{/if}
          {readiness.scoreable ? "Ready to match" : "A bit thin"}
        </span>
      {/if}
    </div>
    {#if readiness?.hint}<p class="mb-2 text-[12px] text-amber-600 dark:text-amber-400">{readiness.hint}</p>{/if}
    {#if saveErr}
      <p class="mb-2 flex items-center gap-1.5 text-[12px] text-red-500">
        <AlertTriangle class="size-3.5 shrink-0" /> {saveErr}
      </p>
    {/if}
    <div class="grid gap-3 md:grid-cols-2">
      <textarea
        value={md}
        oninput={(e) => (md = e.currentTarget.value)}
        class="h-72 w-full resize-none rounded-lg border border-border bg-surface/40 p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-brand/40"
      ></textarea>
      <div class="prose prose-sm dark:prose-invert h-72 max-w-none overflow-y-auto rounded-lg border border-border bg-surface/40 p-3 text-[13px]">
        {@html markedHtml}
      </div>
    </div>
    <div class="mt-4 flex flex-wrap items-center gap-3">
      <button
        type="button"
        onclick={save}
        disabled={phase === "saving"}
        class="inline-flex items-center gap-2 rounded-xl bg-brand px-5 py-2.5 text-sm font-semibold text-brand-foreground shadow-sm transition hover:brightness-110 disabled:opacity-60"
      >
        {#if phase === "saving"}<Loader2 class="size-4 animate-spin" />{:else}<Check class="size-4" />{/if}
        Save &amp; find my matches
      </button>
      <button
        type="button"
        onclick={() => {
          md = "";
          seed = null;
          phase = "input";
        }}
        class="inline-flex items-center gap-1.5 text-[13px] text-muted transition hover:text-foreground"
      >
        <RotateCcw class="size-3.5" /> Start over
      </button>
      <span class="ml-auto inline-flex items-center gap-1 text-[11px] text-faint">
        <Lock class="size-3" /> Saved locally to cv.md
      </span>
    </div>
  </div>
{/if}

<style>
  .co-cvdrop {
    position: relative;
    border: 1.5px dashed color-mix(in srgb, var(--fg) 22%, transparent);
    border-radius: 1rem;
    transition:
      border-color 0.2s,
      background 0.2s;
  }
  .co-cvdrop[data-over="true"] {
    border-color: hsl(26 73% 51%);
    background: hsl(26 73% 51% / 0.05);
  }
  .co-cvtrace {
    animation: co-rise 0.4s ease both;
  }
</style>
