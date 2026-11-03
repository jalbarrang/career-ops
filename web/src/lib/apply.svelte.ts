// Client-side Apply state: one live application-form session.
//
// This replaces the Next app's ApplyProvider context. The shape is deliberately
// the same — one store instance, handed down through Svelte context — so a
// session opened from the tracker's Apply button survives the navigation to
// /apply exactly as it did before. The fallback in useApply() below keeps that
// true even before a layout provides one.
import { getContext, setContext } from "svelte";
// `$app/environment` was SvelteKit 2's name; v3 exposes it as `$app/env`.
import { browser } from "$app/env";
import type { ApplyField } from "@/lib/apply/extract";
import type { ApplyIssue, DriveStep } from "@/lib/apply/issue";
import { resolveLateSession } from "@/lib/apply/exit.mjs";

export type FillStep = { fieldId: string; label: string; ok: boolean; thumb?: string };
type Meta = { needsConfirmation?: boolean };
type Status = "idle" | "opening" | "driving" | "prefilling" | "ready" | "filling" | "done" | "error";

/** The payload /api/apply/session answers with. `id` and `error` are exclusive. */
type SessionResponse = {
  id?: string;
  title?: string;
  shots?: string[];
  needsDrive?: boolean;
  fields?: ApplyField[];
  issues?: ApplyIssue[];
  error?: string;
};

type OpenOpts = { prefill?: boolean; company?: string; n?: string; from?: string };

type PrefillAnswer = { value?: string; needs_confirmation?: boolean };

const CONTEXT_KEY = "career-ops:apply-store";

/** Release the headless browser behind a session id. Fire-and-forget: the page
 *  is usually navigating away as this goes out, hence keepalive. */
function closeSession(id: string): void {
  void fetch("/api/apply/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id }), keepalive: true }).catch(() => {});
}

const CONFIG_KEY = "career-ops:config";
function cliId(): string | null {
  try {
    return JSON.parse(localStorage.getItem(CONFIG_KEY) || "{}").cliId || null;
  } catch {
    return null;
  }
}

export class ApplyStore {
  status = $state<Status>("idle");
  url = $state("");
  title = $state("");
  company = $state("");
  /** Tracker row this session was opened for, "" when opened from a pasted URL. */
  n = $state("");
  /** Path the session was opened from, so the page has somewhere to go back to. */
  from = $state("");
  fields = $state<ApplyField[]>([]);
  answers = $state<Record<string, string>>({});
  meta = $state<Record<string, Meta>>({});
  steps = $state<FillStep[]>([]);
  shots = $state<string[]>([]);
  prefillLog = $state<string[]>([]);
  issues = $state<ApplyIssue[]>([]);
  driveSteps = $state<DriveStep[]>([]);
  error = $state("");

  // Plain (non-reactive) session bookkeeping. The company and tracker identity
  // are mirrored for the async fetches below: those fire after state may have
  // moved on, so a stale read could send the NEXT session's report identity.
  #sessionId: string | null = null;
  #companyRef = "";
  #nRef = "";
  // Bumped every time a session is abandoned or replaced. Leaving the page is
  // reachable while a request or stream is still in flight, and none of them can
  // be recalled, so each one carries the generation it started in and drops its
  // results if that generation is no longer current.
  #generation = 0;
  // When a session opens with {prefill:true}, auto-fire prefill once fields are
  // ready. Fired from #markReady (not a setTimeout) so it can't race the session
  // response or a navigation.
  #pendingPrefill = false;

  // Stream the agentic drive (the AI reaching the form live) and finalize the
  // session when it succeeds → fields ready → auto-prefill fires.
  async #drive(id: string): Promise<void> {
    const gen = this.#generation;
    this.driveSteps = [];
    try {
      const r = await fetch("/api/apply/drive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId: id, cliId: cliId(), goal: "reach" }) });
      if (this.#generation !== gen) return; // left mid-drive
      if (!r.body) {
        this.error = "The agent couldn't start.";
        this.status = "error";
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finished = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.#generation !== gen) return; // left mid-drive
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: { t?: string; message?: string; fields?: ApplyField[]; title?: string; issues?: ApplyIssue[] } & Partial<DriveStep>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === "step") this.driveSteps = [...this.driveSteps, ev as DriveStep];
          else if (ev.t === "done") {
            finished = true;
            this.fields = ev.fields ?? [];
            if (ev.title) this.title = ev.title;
            this.issues = ev.issues ?? [];
            this.#markReady(); // → the ready step auto-prefills if pending
          } else if (ev.t === "error") {
            finished = true;
            this.error = ev.message || "The agent couldn't reach a fillable form.";
            this.status = "error";
          }
        }
      }
      if (this.#generation !== gen) return; // left mid-drive
      if (!finished) {
        this.error = "The agent stopped before reaching a form.";
        this.status = "error";
      }
    } catch (e) {
      if (this.#generation !== gen) return; // left mid-drive
      this.error = `The agent couldn't reach the form: ${e instanceof Error ? e.message : "stream error"}.`;
      this.status = "error";
    }
  }

  /** Fields are ready. Auto-prefill exactly once when the session asked for it. */
  #markReady(): void {
    this.status = "ready";
    if (this.#pendingPrefill) {
      this.#pendingPrefill = false;
      void this.prefill();
    }
  }

  async open(u: string, opts?: OpenOpts): Promise<void> {
    const gen = ++this.#generation;
    // Opening a second form abandons the first one's browser exactly the way
    // leaving the page does, so it is released here too.
    if (this.#sessionId) closeSession(this.#sessionId);
    this.#sessionId = null;
    this.status = "opening";
    this.error = "";
    this.fields = [];
    this.answers = {};
    this.meta = {};
    this.steps = [];
    this.shots = [];
    this.issues = [];
    this.driveSteps = [];
    this.url = u;
    this.company = opts?.company ?? "";
    this.#companyRef = opts?.company ?? "";
    this.n = opts?.n ?? "";
    this.#nRef = opts?.n ?? "";
    this.from = opts?.from ?? "";
    this.#pendingPrefill = false;
    try {
      const r = await fetch("/api/apply/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: u, cliId: cliId() }) });
      const d = (await r.json()) as SessionResponse;
      // The user can leave while this is in flight, and the request can't be
      // recalled — a session that lands after they left is closed here or its
      // headless browser runs forever, unreferenced.
      const late = resolveLateSession({ stale: this.#generation !== gen, sessionId: d.id });
      if (late !== "apply") {
        if (late === "close" && d.id) closeSession(d.id);
        return;
      }
      if (d.error) {
        this.error = d.error;
        this.status = "error";
        return;
      }
      if (!d.id) {
        this.error = "Could not open the form.";
        this.status = "error";
        return;
      }
      this.#sessionId = d.id;
      this.title = d.title ?? "";
      this.shots = d.shots ?? [];
      this.#pendingPrefill = !!opts?.prefill;
      if (d.needsDrive) {
        // The form is behind navigation → the agent drives to reach it, streamed.
        this.status = "driving";
        await this.#drive(d.id);
        return;
      }
      this.fields = d.fields ?? [];
      this.issues = d.issues ?? [];
      this.#markReady();
    } catch {
      if (this.#generation !== gen) return; // left while it was opening
      this.error = "Could not open the form.";
      this.status = "error";
    }
  }

  async prefill(): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId) return;
    const gen = this.#generation;
    if (!cliId()) {
      this.error = "Configure a CLI in Config first, then pre-fill from your CV.";
      return;
    }
    this.status = "prefilling";
    this.error = "";
    this.prefillLog = [];
    const applyAnswers = (raw: Record<string, PrefillAnswer>) => {
      const a: Record<string, string> = {};
      const m: Record<string, Meta> = {};
      for (const [id, v] of Object.entries(raw)) {
        a[id] = v?.value ?? "";
        m[id] = { needsConfirmation: !!v?.needs_confirmation };
      }
      this.answers = a;
      this.meta = m;
    };
    try {
      // company + application travel with the pre-fill for the same reason they
      // travel with the fill: both halves resolve the one tailored CV from them.
      const r = await fetch("/api/apply/prefill", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, cliId: cliId(), company: this.#companyRef, application: this.#nRef }) });
      if (this.#generation !== gen) return; // left mid-prefill
      if (!r.body) {
        this.error = "Couldn't pre-fill — no response stream.";
        this.status = "ready";
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let got = false;
      let sawError = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.#generation !== gen) return; // left mid-prefill
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: { t?: string; m?: string; el?: number; raw?: string; answers?: Record<string, PrefillAnswer>; count?: number; truncated?: boolean };
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === "log") {
            this.prefillLog = [...this.prefillLog, `+${((ev.el ?? 0) / 1000).toFixed(1)}s  ${ev.m}`];
          } else if (ev.t === "done") {
            got = true;
            applyAnswers(ev.answers ?? {});
            if ((ev.count ?? 0) === 0) this.error = "The planner returned 0 answers — see the diagnostics log below.";
            else if (ev.truncated) this.error = "The planner was cut off — some fields were recovered, others may be blank. See diagnostics.";
          } else if (ev.t === "error") {
            sawError = true;
            this.error = ev.m ? `Couldn't pre-fill: ${ev.m}` : "Couldn't pre-fill from your CV.";
            this.prefillLog = [...this.prefillLog, `✗ ${ev.m ?? "error"}${ev.raw ? ` — raw tail: ${ev.raw.slice(0, 160)}` : ""}`];
          }
        }
      }
      if (this.#generation !== gen) return; // left mid-prefill
      if (!got && !sawError) this.error = "Pre-fill ended without answers — see the diagnostics log below.";
      this.status = "ready";
    } catch (e) {
      if (this.#generation !== gen) return; // left mid-prefill
      this.error = `Couldn't pre-fill from your CV: ${e instanceof Error ? e.message : "stream error"}. See diagnostics.`;
      this.status = "ready";
    }
  }

  /** Address one field by its id, or by the closest label match the agent names. */
  setAnswer(idOrLabel: string, value: string): void {
    const fs = this.fields;
    const key = idOrLabel.toLowerCase();
    const f =
      fs.find((x) => x.id === idOrLabel) ||
      fs.find((x) => x.label.toLowerCase().includes(key)) ||
      fs.find((x) => key.includes(x.label.toLowerCase()) && x.label.length > 2);
    if (f) this.answers = { ...this.answers, [f.id]: value };
  }

  async fill(): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId) return;
    const gen = this.#generation;
    this.status = "filling";
    this.steps = [];
    try {
      const r = await fetch("/api/apply/fill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, answers: this.answers, fields: this.fields, handoff: true, company: this.#companyRef, application: this.#nRef }),
      });
      const d = (await r.json()) as { steps?: FillStep[]; issues?: ApplyIssue[]; navigated?: boolean; error?: string };
      // Also stops the escalation below from starting an agent drive on a
      // session the user has already walked away from.
      if (this.#generation !== gen) return; // left mid-fill
      if (d.error) {
        this.error = d.error;
        this.status = "error";
        return;
      }
      this.steps = d.steps ?? [];
      // merge the verify-after-fill warnings (required-empty / mismatch / validation)
      if (Array.isArray(d.issues) && d.issues.length) {
        const seen = new Set(this.issues.map((i) => i.message));
        this.issues = [...this.issues, ...d.issues.filter((i) => !seen.has(i.message))];
      }
      if (d.navigated) this.error = "Heads up: the form's page changed during fill — review it carefully before submitting (career-ops never submits for you).";
      this.status = "done";
      // ESCALATION ("si no va, full agente"): if deterministic fill clearly
      // didn't land (most fields failed / mismatched), let the agent fill it.
      const okCount = (d.steps ?? []).filter((s) => s.ok).length;
      const total = (d.steps ?? []).length;
      const mismatch = (d.issues ?? []).some((i) => i.code === "fill-mismatch");
      if (cliId() && total > 0 && (okCount === 0 || (mismatch && okCount < total / 2))) {
        await this.agentFill();
      }
    } catch {
      if (this.#generation !== gen) return; // left mid-fill
      this.error = "Fill failed.";
      this.status = "error";
    }
  }

  // FULL-AGENT FILL — the agent fills the real form turn-by-turn from the verified
  // answers, streamed (drive panel), never submits, then hands off. Used as the
  // escalation when deterministic fill fails, or on demand.
  async agentFill(): Promise<void> {
    const sessionId = this.#sessionId;
    if (!sessionId) return;
    const gen = this.#generation;
    const a = this.answers;
    const ans = this.fields.filter((f) => f.type !== "file" && (a[f.id] || "").trim()).map((f) => ({ label: f.label || f.id, value: a[f.id] }));
    this.driveSteps = [];
    this.error = "";
    this.status = "filling";
    try {
      const r = await fetch("/api/apply/drive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sessionId, cliId: cliId(), goal: "full", answers: ans }) });
      if (this.#generation !== gen) return; // left mid-fill
      if (!r.body) {
        this.error = "The agent couldn't start filling.";
        this.status = "error";
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.#generation !== gen) return; // left mid-fill
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: { t?: string; message?: string; filled?: boolean } & Partial<DriveStep>;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.t === "step") this.driveSteps = [...this.driveSteps, ev as DriveStep];
          else if (ev.t === "done") {
            this.issues = [
              ...this.issues,
              {
                level: "info",
                code: "ai-filled",
                message: ev.filled ? "AI filled the form for you — review every answer on the real form, then submit it yourself." : "AI did its best but couldn't finish — check the real form before submitting.",
              },
            ];
            this.status = "done";
          } else if (ev.t === "error") {
            this.error = ev.message || "The agent couldn't fill the form.";
            this.status = "error";
          }
        }
      }
    } catch (e) {
      if (this.#generation !== gen) return; // left mid-fill
      this.error = `The agent couldn't fill the form: ${e instanceof Error ? e.message : "stream error"}.`;
      this.status = "error";
    }
  }

  reset(): void {
    // Invalidate anything still in flight before clearing state, so a response
    // that lands after this can't repopulate the page the user just left.
    this.#generation += 1;
    if (this.#sessionId) closeSession(this.#sessionId);
    this.#sessionId = null;
    this.#companyRef = "";
    this.#nRef = "";
    this.#pendingPrefill = false;
    this.status = "idle";
    this.url = "";
    this.title = "";
    this.company = "";
    this.n = "";
    this.from = "";
    this.fields = [];
    this.answers = {};
    this.meta = {};
    this.steps = [];
    this.shots = [];
    this.prefillLog = [];
    this.issues = [];
    this.driveSteps = [];
    this.error = "";
  }
}

/**
 * One store for the whole tab. An Apply button on the tracker writes a session
 * into it and /apply then renders that same session; with a new instance per
 * component the session the button opened would be gone by the time the page
 * mounts.
 *
 * Browser-only: nothing on the server ever reads it, so no session leaks across
 * requests.
 */
let clientStore: ApplyStore | null = null;

function sharedStore(): ApplyStore {
  clientStore ??= new ApplyStore();
  return clientStore;
}

/** Create the store and make it available to every descendant. */
export function provideApply(): ApplyStore {
  // Reuse what the layout already provided (a page can call this too) so the
  // session isn't split in two. On the server, a fresh instance per render.
  const inherited = getContext<ApplyStore | undefined>(CONTEXT_KEY);
  if (inherited) return inherited;
  const store = browser ? sharedStore() : new ApplyStore();
  setContext(CONTEXT_KEY, store);
  return store;
}

export function useApply(): ApplyStore {
  const store = getContext<ApplyStore | undefined>(CONTEXT_KEY);
  if (store) return store;
  return browser ? sharedStore() : new ApplyStore();
}
