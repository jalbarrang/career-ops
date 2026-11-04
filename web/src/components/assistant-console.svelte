<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { goto, invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import { Maximize2, Minimize2, RotateCcw, Settings, Sparkles, X } from "@lucide/svelte";
  import CoMark from "@/components/co-mark.svelte";
  import { Button } from "@/components/ui/button";
  import Transcript from "@/components/assistant/transcript.svelte";
  import ChatHistory from "@/components/assistant/chat-history.svelte";
  import Composer from "@/components/assistant/composer.svelte";
  import { useJobs } from "@/lib/jobs.svelte";
  import { usePipeline } from "@/lib/pipeline.svelte";
  import { useApply } from "@/lib/apply.svelte";
  import { useExplore } from "@/lib/explore.svelte";
  import { dispatch, type ActionCtx, type DoneInfo } from "@/lib/actions/registry";
  import { estimateRunCost } from "@/lib/run-cost-estimate.ts";
  import { scoreNum } from "@/lib/format";
  import { cleanMessages } from "@/lib/assistant-history.ts";
  import { cn } from "@/lib/cn";
  import {
    NAV_RE,
    REMEMBER_RE,
    describePage,
    msgText,
    normalizeJson,
    parseEnvelopes,
    removeRanges,
    type Msg,
    type Part,
  } from "@/components/assistant/envelope";
  // The assistant console: a streaming chat surface wired to the ONE action
  // registry, so a model intent ("evaluate all the Anthropic ones") drives the
  // same code path a button does. Ported from `assistant-console.tsx`.

  const CONFIG_KEY = "career-ops:config";
  const CHAT_KEY = "career-ops:chat";
  const SIZE_KEY = "career-ops:assistant-size";

  // Panel size. The 400×600 default is fine for a question; an onboarding
  // conversation or a long evaluation debrief is not a 400px-wide affair. Three
  // fixed steps rather than free drag: predictable on touch and small screens,
  // one click to cycle, remembered per browser.
  type PanelSize = "compact" | "wide" | "full";
  const SIZE_ORDER: PanelSize[] = ["compact", "wide", "full"];
  const PANEL_CLASS: Record<PanelSize, string> = {
    compact: "bottom-5 right-5 h-[600px] max-h-[80vh] w-[400px] max-w-[calc(100vw-2.5rem)]",
    wide: "bottom-5 right-5 h-[85vh] w-[720px] max-w-[calc(100vw-2.5rem)]",
    full: "inset-4 h-auto w-auto",
  };
  // The composer grows with its content (a pasted CV, a long answer) up to a cap
  // that scales with the panel, instead of staying a one-line box that scrolls.
  const INPUT_MAX_PX: Record<PanelSize, number> = { compact: 128, wide: 240, full: 360 };
  const SIZE_LABEL: Record<PanelSize, string> = { compact: "Wider", wide: "Full screen", full: "Compact" };

  const GREETING =
    "Hi — I'm your career-ops assistant. I can walk you through onboarding, answer questions about your pipeline, or take you where you need to go. What would you like to do?";

  type ChatEntry = { id: string; title: string; revision: number };
  type ActiveChat = { id: string; revision: number; title?: string };

  /** The `error` string of a parsed JSON body, or "" when the body carries none. */
  function errorOf(body: unknown): string {
    if (typeof body !== "object" || body === null || !("error" in body)) return "";
    const { error } = body as { error?: unknown };
    return typeof error === "string" ? error : "";
  }

  let open = $state(false);
  let cliId = $state<string | null>(null);
  let messages = $state<Msg[]>([]);
  let chats = $state<ChatEntry[]>([]);
  let chatReady = $state(false);
  let chatPending = $state(false);
  let saveError = $state("");
  let chatWarnings = $state<{ id: string; error: string }[]>([]);
  let input = $state("");
  let busy = $state(false);
  let size = $state<PanelSize>("compact");

  // Conversation bookkeeping that the markup never reads stays plain (non
  // reactive): React kept these in refs for the same reason — mutating them must
  // not re-render, and the streaming closure always wants the CURRENT value.
  let activeChat = $state<ActiveChat>({ id: "", revision: 0 });
  let savedSnapshot = "";
  let saveQueue: Promise<void> = Promise.resolve();
  const handled = new Set<string>();
  const confirmRuns = new Map<string, () => DoneInfo>();

  const pathname = $derived(page.url.pathname);

  // React kept `jobsRef` / `pipelineRef` / `applyRef` / `exploreRef` mirrors so the
  // streaming closure would read the LATEST values instead of the ones captured by
  // its own render. A rune read is always live, so the stores are read directly
  // here — there is no mirror left to keep in sync.
  const jobStore = useJobs();
  const pipeline = usePipeline();
  const apply = useApply();
  const explore = useExplore();

  // panel size: restored on mount (client-only, so SSR markup never mismatches),
  // persisted on change
  function cycleSize(): void {
    const next = SIZE_ORDER[(SIZE_ORDER.indexOf(size) + 1) % SIZE_ORDER.length];
    size = next;
    try {
      localStorage.setItem(SIZE_KEY, next);
    } catch {
      /* ignore */
    }
  }

  // composer auto-grow: height follows content up to the per-size cap; clearing
  // the input (after send) shrinks it back to one line. Lives inside <Composer> so
  // the imperative height is set in an effect AFTER the render that wrote the
  // value — setting it inside the input handler is wiped by the very next render.

  async function chatRequest<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const data: unknown = await response.json();
    if (!response.ok) throw new Error(errorOf(data) || "Conversation request failed");
    return data as T;
  }

  async function refreshChats(): Promise<void> {
    const data = await chatRequest<{ chats: ChatEntry[]; errors: { id: string; error: string }[] }>("/api/assistant/chats");
    chats = data.chats;
    chatWarnings = data.errors;
  }

  function flushChat(title?: string): Promise<void> {
    const current = activeChat;
    let snapshot: Msg[];
    try {
      snapshot = cleanMessages(messages) as Msg[];
    } catch (e) {
      const error = e instanceof Error ? e : new Error("Conversation could not be saved");
      saveError = error.message;
      return Promise.reject(error);
    }
    if (!snapshot.some((m) => m.role === "user")) return Promise.resolve();
    const encoded = JSON.stringify(snapshot);
    const operation = saveQueue.catch(() => {}).then(async () => {
      if (encoded === savedSnapshot && title === undefined) return;
      try {
        const chat = await chatRequest<ChatEntry>("/api/assistant/chats", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...current, ...(title ? { title } : {}), messages: snapshot }),
        });
        current.revision = chat.revision;
        current.title = chat.title;
        savedSnapshot = encoded;
        saveError = "";
        await refreshChats();
      } catch (e) {
        saveError = e instanceof Error ? e.message : "Conversation was not saved";
        throw e;
      }
    });
    saveQueue = operation;
    return operation;
  }

  onMount(() => {
    try {
      const raw = localStorage.getItem(SIZE_KEY) as PanelSize | null;
      if (raw && SIZE_ORDER.includes(raw)) size = raw;
    } catch {
      /* ignore */
    }
  });

  // selected CLI from Config (reacts to changes in other tabs)
  onMount(() => {
    function read() {
      try {
        const raw = localStorage.getItem(CONFIG_KEY);
        cliId = raw ? JSON.parse(raw).cliId || null : null;
      } catch {
        cliId = null;
      }
    }
    read();
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  });

  onMount(() => {
    let cancelled = false;
    async function restore() {
      try {
        const data = await chatRequest<{ chats: ChatEntry[]; errors: { id: string; error: string }[] }>("/api/assistant/chats");
        let restored: (ChatEntry & { messages: unknown[] }) | null = null;
        const legacy = localStorage.getItem(CHAT_KEY);
        if (legacy) {
          const migrated = cleanMessages(JSON.parse(legacy)) as Msg[];
          if (migrated.some((m) => m.role === "user")) {
            // A stable migration id makes retrying a lost response safe.
            const key = `${CHAT_KEY}:migration-id`;
            const id = localStorage.getItem(key) || crypto.randomUUID();
            localStorage.setItem(key, id);
            if (data.chats.some((c) => c.id === id)) {
              restored = await chatRequest<ChatEntry & { messages: unknown[] }>(`/api/assistant/chats?id=${id}`);
            } else {
              restored = await chatRequest<ChatEntry & { messages: unknown[] }>("/api/assistant/chats", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id, revision: 0, messages: migrated }),
              });
            }
          }
          localStorage.removeItem(CHAT_KEY); // only after a successful disk write
        }
        if (!restored && data.chats.length) restored = await chatRequest<ChatEntry & { messages: unknown[] }>(`/api/assistant/chats?id=${data.chats[0].id}`);
        if (cancelled) return;
        activeChat = restored ? { id: restored.id, revision: restored.revision, title: restored.title } : { id: crypto.randomUUID(), revision: 0 };
        const next = restored ? (cleanMessages(restored.messages) as Msg[]) : [];
        savedSnapshot = JSON.stringify(next);
        messages = next;
        await refreshChats();
        chatReady = true;
      } catch (e) {
        if (!cancelled) saveError = e instanceof Error ? e.message : "Could not load conversations";
      }
    }
    void restore();
    // The pipeline snapshot the console reads (inbox counts, tracker rows) has no
    // provider above the routes any more — this is its only consumer, so it
    // starts here, exactly where the old PipelineProvider mounted.
    pipeline.start();
    return () => {
      cancelled = true;
    };
  });

  // Debounced autosave: any message change while idle schedules one write.
  $effect(() => {
    void messages; // dependency: a new/changed message restarts the debounce
    if (!chatReady || chatPending || busy) return;
    const timer = setTimeout(() => {
      void flushChat().catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  });

  // A finished turn saves immediately — the debounce above would be cancelled by
  // the `busy` flip and the last assistant message would never reach disk.
  $effect(() => {
    const ready = chatReady;
    const pending = chatPending;
    const working = busy;
    if (!ready || pending || working) return;
    untrack(() => {
      void flushChat().catch(() => {});
    });
  });

  // Leaving the tab: flush, because a hidden page can be discarded at any moment.
  $effect(() => {
    const ready = chatReady;
    const pending = chatPending;
    if (!ready || pending) return;
    const save = () => {
      if (document.visibilityState === "hidden") void flushChat().catch(() => {});
    };
    document.addEventListener("visibilitychange", save);
    return () => document.removeEventListener("visibilitychange", save);
  });

  async function selectChat(id?: string): Promise<void> {
    if (busy || chatPending || !chatReady) return;
    chatPending = true;
    try {
      await flushChat();
      const chat = id ? await chatRequest<ChatEntry & { messages: unknown[] }>(`/api/assistant/chats?id=${id}`) : null;
      activeChat = chat ? { id: chat.id, revision: chat.revision, title: chat.title } : { id: crypto.randomUUID(), revision: 0 };
      const next = chat ? (cleanMessages(chat.messages) as Msg[]) : [];
      savedSnapshot = JSON.stringify(next);
      messages = next;
      input = "";
      confirmRuns.clear();
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Could not switch conversations";
    } finally {
      chatPending = false;
    }
  }

  function exportChat(): void {
    // Export the live draft even if it exceeds the storage limits.
    const blob = new Blob([JSON.stringify({ ...activeChat, messages: $state.snapshot(messages), draft: input }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `conversation-${activeChat.id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function discardAndStartChat(): Promise<void> {
    if (busy || chatPending || !chatReady) return;
    if (!window.confirm("Discard unsaved changes and start a new conversation? Saved conversations stay on disk. Export this conversation first if you want to keep the unsaved text.")) return;
    chatPending = true;
    try {
      // Let writes already in flight finish before changing the active id.
      await saveQueue.catch(() => {});
      activeChat = { id: crypto.randomUUID(), revision: 0 };
      savedSnapshot = "";
      messages = [];
      input = "";
      confirmRuns.clear();
      saveError = "";
    } finally {
      chatPending = false;
    }
  }

  async function renameChat(): Promise<void> {
    const title = window.prompt("Conversation name", activeChat.title || "");
    if (!title?.trim()) return;
    chatPending = true;
    try {
      await flushChat(title.trim());
    } catch {
      /* shown by flushChat */
    } finally {
      chatPending = false;
    }
  }

  async function removeChat(): Promise<void> {
    if (!window.confirm("Delete this conversation?")) return;
    chatPending = true;
    try {
      await flushChat();
      const { id, revision } = activeChat;
      await chatRequest(`/api/assistant/chats?id=${id}&revision=${revision}`, { method: "DELETE" });
      activeChat = { id: crypto.randomUUID(), revision: 0 };
      savedSnapshot = "";
      messages = [];
      confirmRuns.clear();
      await refreshChats();
    } catch (e) {
      saveError = e instanceof Error ? e.message : "Could not delete conversation";
    } finally {
      chatPending = false;
    }
  }

  $effect(() => {
    if (open && messages.length === 0) messages = [{ role: "assistant", parts: [{ type: "text", text: GREETING }] }];
  });

  // ── message mutators (operate on the last assistant message) ──
  function patchLastAssistant(ms: Msg[], fn: (m: Msg) => Msg): Msg[] {
    const copy = [...ms];
    for (let i = copy.length - 1; i >= 0; i--) {
      if (copy[i].role === "assistant") {
        copy[i] = fn(copy[i]);
        break;
      }
    }
    return copy;
  }

  function setStreamText(text: string): void {
    messages = patchLastAssistant(messages, (m) => {
      const parts = [...m.parts];
      const idx = parts.findIndex((p) => p.type === "text");
      if (idx === -1) parts.unshift({ type: "text", text });
      else parts[idx] = { type: "text", text };
      return { ...m, parts };
    });
  }

  function appendParts(newParts: Part[]): void {
    messages = patchLastAssistant(messages, (m) => ({ ...m, parts: [...m.parts, ...newParts] }));
  }

  function appendCards(info: DoneInfo): void {
    const ids = info.jobIds ?? [];
    if (!ids.length) {
      if (info.note) appendParts([{ type: "note", text: info.note }]);
      return;
    }
    if (info.batchId && ids.length > 1) appendParts([{ type: "batch", batchId: info.batchId, jobIds: ids }]);
    else appendParts(ids.map((jobId) => ({ type: "card" as const, jobId })));
  }

  function buildCtx(): ActionCtx {
    return {
      push: (p) => void goto(p),
      replace: (p) => void goto(p, { replaceState: true }),
      startJob: (opts) => jobStore.startJob(opts),
      inbox: pipeline.inbox,
      applications: pipeline.applications,
      jobForUrl: (url) => {
        const m = jobStore.jobs.filter((j) => j.input === url).sort((a, b) => b.startedAt - a.startedAt);
        return m[0];
      },
      estimateCost: (kind, count) => estimateRunCost(jobStore.jobs, kind, count),
      rememberFact: (fact) => {
        fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fact }),
        }).catch(() => {});
      },
      writeStatus: (n, status) => {
        fetch("/api/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ n, status }),
        })
          .then(() => {
            void invalidateAll();
            pipeline.refetch();
          })
          .catch(() => {});
      },
      setApplyField: (idOrLabel, value) => apply.setAnswer(idOrLabel, value),
      startApply: (u) => {
        void goto("/apply");
        setTimeout(() => void apply.open(u), 60);
      },
      applyExplore: (patch, opts) => explore.applyPatch(patch, opts),
      writeProfile: (patch) => {
        fetch("/api/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) })
          .then(() => void invalidateAll())
          .catch(() => {});
      },
      writePortals: (roles, location) => {
        fetch("/api/portals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roles, location }) }).catch(() => {});
      },
    };
  }

  function runDispatch(id: string, args: Record<string, unknown>): void {
    const res = dispatch(id, args, buildCtx());
    if (res.status === "done") appendCards(res);
    else if (res.status === "ignored") {
      if (res.note) appendParts([{ type: "note", text: res.note }]);
    } else if (res.status === "confirm") {
      const cid = `c-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
      confirmRuns.set(cid, res.run);
      appendParts([{ type: "confirm", cid, summary: res.summary, state: "pending" }]);
    }
  }

  function resolveConfirm(cid: string, accept: boolean): void {
    const run = confirmRuns.get(cid);
    confirmRuns.delete(cid);
    const info = accept && run ? run() : null;
    messages = messages.map((m) => {
      if (!m.parts.some((p) => p.type === "confirm" && p.cid === cid)) return m;
      const parts: Part[] = m.parts.map((p) => (p.type === "confirm" && p.cid === cid ? { ...p, state: accept ? "done" : "cancelled" } : p));
      if (info?.jobIds?.length) {
        if (info.batchId && info.jobIds.length > 1) parts.push({ type: "batch", batchId: info.batchId, jobIds: info.jobIds });
        else parts.push(...info.jobIds.map((jobId) => ({ type: "card" as const, jobId })));
      }
      return { ...m, parts };
    });
  }

  // compact pipeline snapshot for the model (counts + per-company pending — lets
  // it offer/act on "all the Anthropic ones" without re-reading files)
  function pipelineContext(): string {
    const pending = pipeline.inbox.filter((j) => !j.done);
    if (!pending.length) return "";
    const counts = new Map<string, number>();
    for (const j of pending) counts.set(j.company, (counts.get(j.company) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    return `\n\nINBOX SNAPSHOT: ${pending.length} pending postings. By company: ${top
      .map(([c, n]) => `${c} (${n})`)
      .join(", ")}. To evaluate every pending posting for one company, emit evaluateCompany with just the company name.`;
  }

  // When the user is on /apply, expose the proxy form's fields + current answers
  // so the assistant can write/revise any answer (setApplyField) on request.
  function applyContext(): string {
    const ap = apply;
    if (!pathname.startsWith("/apply") || !ap.fields.length) return "";
    const lines = ap.fields
      .map((f) => `- ${f.label || f.id}${ap.meta[f.id]?.needsConfirmation ? " (user confirms)" : ""}: ${ap.answers[f.id] ? `"${ap.answers[f.id].slice(0, 240)}"` : "(empty)"}`)
      .join("\n");
    return `\n\nAPPLY FORM — the user is filling "${ap.title}". Current answers:\n${lines}\nTo write or revise an answer, emit setApplyField {"field":"<label or id>","value":"<new text>"}. If a change reveals a durable preference or corrected fact, ALSO remember it.`;
  }

  async function send(forced?: string): Promise<void> {
    const text = (forced ?? input).trim();
    if (!text || busy || !cliId || !chatReady || chatPending) return;
    if (forced === undefined) input = "";
    const history = messages.filter((m) => msgText(m) && msgText(m) !== GREETING).map((m) => ({ role: m.role, content: msgText(m) }));
    const next: Msg[] = [...messages, { role: "user", parts: [{ type: "text", text }] }, { role: "assistant", parts: [{ type: "text", text: "" }] }];
    messages = next;
    busy = true;
    handled.clear();
    const shimsDone = new Set<string>();
    try {
      await flushChat();
      const res = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, cliId, history, pageContext: describePage(pathname) + pipelineContext() + applyContext() }),
      });
      if (!res.ok || !res.body) {
        const err: unknown = await res.json().catch(() => ({}));
        setStreamText(`⚠️ ${errorOf(err) || "Assistant unavailable."}`);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });

        const { complete, hidePartialFrom } = parseEnvelopes(acc);
        const cuts: [number, number][] = complete.map((e) => [e.start, e.end]);
        if (hidePartialFrom >= 0) cuts.push([hidePartialFrom, acc.length]);
        let display = removeRanges(acc, cuts);

        // back-compat shims (strip + queue) on the cleaned text
        const shimNavs: string[] = [];
        const shimRems: string[] = [];
        display = display.replace(NAV_RE, (_, p: string) => {
          shimNavs.push(p);
          return "";
        });
        display = display.replace(REMEMBER_RE, (_, f: string) => {
          shimRems.push(String(f).trim());
          return "";
        });
        setStreamText(display.trimStart());

        for (const e of complete) {
          const key = `${e.start}|${e.id}|${e.argsJson}`;
          if (handled.has(key)) continue;
          handled.add(key);
          let args: Record<string, unknown>;
          try {
            args = JSON.parse(normalizeJson(e.argsJson)) as Record<string, unknown>;
          } catch {
            continue;
          }
          runDispatch(e.id, args);
        }
        for (const p of shimNavs) {
          const k = `go:${p}`;
          if (!shimsDone.has(k)) {
            shimsDone.add(k);
            runDispatch("navigate", { path: p });
          }
        }
        for (const f of shimRems) {
          const k = `rem:${f}`;
          if (f && !shimsDone.has(k)) {
            shimsDone.add(k);
            runDispatch("remember", { fact: f });
          }
        }
      }
      if (!acc.trim()) setStreamText("_(no output — is the CLI authenticated?)_");
    } catch {
      setStreamText("⚠️ Connection error.");
    } finally {
      busy = false;
      void invalidateAll();
      pipeline.refetch();
    }
  }

  // Other surfaces (e.g. the onboarding banner) can open the assistant and kick
  // off a turn via a window event.
  onMount(() => {
    function onOpen(e: Event) {
      open = true;
      const msg = (e as CustomEvent<{ message?: string }>).detail?.message;
      if (msg) setTimeout(() => void send(msg), 80);
    }
    window.addEventListener("co-assistant", onOpen);
    return () => window.removeEventListener("co-assistant", onOpen);
  });

  // ── proactive suggestion chips (onboarding + offer-driven next steps) ──
  const suggestions = $derived.by(() => {
    const chips: { label: string; send: string }[] = [];
    const rep = pathname.match(/^\/pipeline\/(.+)$/);
    if (rep) {
      chips.push({ label: "Why this score?", send: "Walk me through why this offer scored the way it did — strengths and red flags." });
      chips.push({ label: "Should I apply?", send: "Given my profile, should I apply to this one? Be honest." });
      chips.push({ label: "Draft a cover letter", send: "Draft a short, sharp cover letter for this role." });
      return chips;
    }
    const pending = pipeline.inbox.filter((j) => !j.done);
    if (!pipeline.applications.length && !pending.length) {
      return [
        { label: "Help me get set up", send: "Help me get started with career-ops — what do you need from me?" },
        { label: "Improve my CV", send: "Look at my CV and suggest the highest-impact improvements." },
      ];
    }
    if (pending.length) {
      const counts = new Map<string, number>();
      for (const j of pending) counts.set(j.company, (counts.get(j.company) ?? 0) + 1);
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      if (top && top[1] > 1) chips.push({ label: `Evaluate all ${top[0]} (${top[1]})`, send: `Evaluate all the pending ${top[0]} postings in my inbox.` });
      chips.push({ label: `Triage inbox (${pending.length})`, send: `I have ${pending.length} postings in my inbox — which should I evaluate first, and why?` });
    }
    const strong = pipeline.applications.filter((a) => scoreNum(a.score) >= 4.5).length;
    if (strong) chips.push({ label: "Strong matches to act on", send: "Show me my strongest matches (4.5+) I haven't applied to yet, and tell me which to prioritise." });
    chips.push({ label: "What should I do today?", send: "Look at my pipeline and tell me the 3 highest-leverage things I should do today." });
    return chips.slice(0, 4);
  });

  const selectedChatId = $derived(chats.some((c) => c.id === activeChat.id) ? activeChat.id : "");
  const controlsLocked = $derived(busy || chatPending || !chatReady);
</script>

{#if !open}
  <button
    type="button"
    onclick={() => (open = true)}
    class="fixed bottom-5 right-5 z-50 flex items-center justify-center gap-2 rounded-full border border-border bg-surface/90 py-1.5 pl-1.5 pr-4 shadow-lg backdrop-blur transition-colors hover:bg-surface-hover max-sm:min-h-[44px]"
    aria-label="Open assistant"
  >
    <CoMark size={26} />
    <span class="text-sm font-medium">Ask</span>
  </button>
{/if}

{#if open}
  <div class={cn("fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl", PANEL_CLASS[size])}>
    <header class="flex items-center gap-2.5 border-b border-border px-4 py-3">
      <CoMark size={26} />
      <div class="flex-1">
        <div class="text-sm font-semibold tracking-tight">Assistant</div>
        <div class="text-xs text-faint">{cliId ? `via ${cliId}` : "no CLI configured"}</div>
      </div>
      <Button variant="ghost" size="icon" onclick={cycleSize} class="text-muted" aria-label={SIZE_LABEL[size]} title={SIZE_LABEL[size]}>
        {#if size === "full"}
          <Minimize2 class="size-4" />
        {:else}
          <Maximize2 class="size-4" />
        {/if}
      </Button>
      <Button variant="ghost" size="icon" onclick={() => void selectChat()} disabled={controlsLocked} class="text-muted" aria-label="New chat" title="New chat">
        <RotateCcw class="size-4" />
      </Button>
      <Button variant="ghost" size="icon" onclick={() => (open = false)} class="text-muted" aria-label="Close assistant">
        <X class="size-4" />
      </Button>
    </header>

    <ChatHistory
      {chats}
      selected={selectedChatId}
      revision={activeChat.revision}
      locked={controlsLocked}
      warnings={chatWarnings}
      {saveError}
      {chatReady}
      {busy}
      {chatPending}
      onselect={(id) => void selectChat(id)}
      onrename={() => void renameChat()}
      ondelete={() => void removeChat()}
      onretry={() => void flushChat().catch(() => {})}
      onexport={exportChat}
      ondiscard={() => void discardAndStartChat()}
      onreload={() => window.location.reload()}
    />
    <Transcript {messages} jobs={jobStore.jobs} {busy} onConfirm={resolveConfirm} />

    <!-- proactive suggestion chips — onboarding + offer-driven next steps -->
    {#if cliId && !busy && suggestions.length > 0}
      <div class="flex flex-wrap gap-1.5 px-3 pb-1 pt-0.5">
        {#each suggestions as s, i (i)}
          <button
            type="button"
            onclick={() => void send(s.send)}
            class="inline-flex items-center gap-1 rounded-full border border-border bg-surface/60 px-2.5 py-1 text-xs text-muted transition-colors hover:border-brand/40 hover:bg-brand-soft hover:text-brand"
          >
            <Sparkles class="size-3 text-brand/70" />
            {s.label}
          </button>
        {/each}
      </div>
    {/if}

    {#if !cliId}
      <a
        href="/config"
        onclick={() => (open = false)}
        class="mx-4 mb-2 flex items-center gap-2 rounded-lg border border-border bg-surface/50 px-3 py-2 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <Settings class="size-3.5" /> Pick a CLI in Config to enable the assistant →
      </a>
    {/if}

    <Composer bind:input cap={INPUT_MAX_PX[size]} {cliId} {busy} {chatPending} {chatReady} onsend={() => void send()} />
  </div>
{/if}
