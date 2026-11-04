// Client-side worker state: every CLI run the user starts from the UI.
//
// This replaces the Next app's JobsProvider context. The shape is deliberately
// the same — one store instance created by the layout, handed down through
// Svelte context — so a run survives navigation exactly as it did before, and
// nothing leaks across requests on the server (the instance is per render).
import { getContext, setContext } from "svelte";
import { scoreTone } from "@/lib/format";
import { resolveCliId } from "@/lib/saved-cli";
import { readJobStream } from "@/lib/job-stream.ts";

export type JobStep = { kind: "tool" | "status"; label: string; ts: number };
export type JobResult = { score: number | null; summary: string; tone: "good" | "warn" | "bad" | "muted" };

export type Job = {
  id: string;
  title: string;
  subtitle?: string;
  page?: string; // route the job was launched from / refers to
  input?: string; // the URL/posting it processed (links inbox rows to their worker)
  kind?: string;
  batchId?: string; // groups jobs fired together (e.g. "evaluate all Anthropic")
  status: "running" | "done" | "error";
  steps: JobStep[];
  text: string;
  result?: JobResult;
  cost?: { tokens: number; usd?: number }; // per-run token cost (Claude result event) — local only
  startedAt: number;
  endedAt?: number;
};

type StartOpts = { title: string; subtitle?: string; kind: string; input: string; page?: string; batchId?: string };

const JOBS_KEY = "career-ops:jobs";
const CONTEXT_KEY = "career-ops:jobs-store";

function parseVerdict(text: string): JobResult {
  const m = text.match(/VERDICT:\s*([\d.]+)\s*\/\s*5\s*[—:|-]+\s*(.+)/i);
  if (m) {
    const score = parseFloat(m[1]);
    return { score, summary: m[2].trim().replace(/\s+/g, " ").slice(0, 90), tone: scoreTone(`${score}`) };
  }
  const s = text.match(/\b([0-5](?:\.\d)?)\s*\/\s*5\b/);
  if (s) {
    const score = parseFloat(s[1]);
    return { score, summary: "", tone: scoreTone(`${score}`) };
  }
  return { score: null, summary: "", tone: "muted" };
}

export class JobsStore {
  jobs = $state<Job[]>([]);
  #seq = 0;
  #loaded = false;

  /** Restore history from localStorage. Call once on mount. */
  hydrate(): void {
    try {
      const raw = localStorage.getItem(JOBS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) {
        // Anything left "running" from a previous session is stale → interrupted.
        this.jobs = arr.map((j: Job) =>
          j.status === "running"
            ? {
                ...j,
                status: "error" as const,
                steps: [...(j.steps || []), { kind: "status" as const, label: "Interrupted (page reloaded)", ts: Date.now() }],
              }
            : j,
        );
      }
    } catch {
      /* ignore */
    }
    this.#loaded = true;
  }

  /** Mirror the live list into localStorage. Safe to call before hydrate(). */
  persist(): void {
    if (!this.#loaded) return;
    try {
      localStorage.setItem(JOBS_KEY, JSON.stringify(this.jobs.slice(0, 40)));
    } catch {
      /* quota */
    }
  }

  #patch(id: string, fn: (j: Job) => Job): void {
    this.jobs = this.jobs.map((j) => (j.id === id ? fn(j) : j));
  }

  startJob(opts: StartOpts): string | null {
    const id = `job-${Date.now()}-${this.#seq++}`;
    const job: Job = {
      id,
      title: opts.title,
      subtitle: opts.subtitle,
      page: opts.page,
      input: opts.input,
      kind: opts.kind,
      batchId: opts.batchId,
      status: "running",
      steps: [{ kind: "status", label: "Starting…", ts: Date.now() }],
      text: "",
      startedAt: Date.now(),
    };
    this.jobs = [job, ...this.jobs];

    // Declared before resolveCliId() so its stale-CLI notice lands in the log
    // sent to /api/runs/save, not only in the live job.
    const steps: JobStep[] = [];
    (async () => {
      // resolveCliId() validates the saved id against what is installed; a bare
      // readSavedCliId() here would short-circuit that check and launch a run
      // against an uninstalled CLI (#4012). A stale saved id is replaced silently
      // otherwise — name the switch in the job log so a transient "not installed"
      // can't rewrite the user's choice without a record.
      const cliId = await resolveCliId((stale: string, replacement?: string | null) => {
        const label = replacement
          ? `Saved CLI '${stale}' is not installed — using '${replacement}'`
          : `Saved CLI '${stale}' is not installed`;
        const step: JobStep = { kind: "status", label, ts: Date.now() };
        steps.push(step);
        this.#patch(id, (j) => ({ ...j, steps: [...j.steps, step] }));
      });
      if (!cliId) {
        this.#patch(id, (j) => ({
          ...j,
          status: "error",
          endedAt: Date.now(),
          steps: [...j.steps, { kind: "status", label: "No CLI configured — open Config and click Save config", ts: Date.now() }],
        }));
        return;
      }
      let text = "";
      let verdictLine = ""; // latched separately so the 8000-char tail can't drop it
      let doneTokens = 0; // per-run token cost, forwarded on the done event (#6)
      let doneCostUsd: number | null = null;
      const finish = (status: "done" | "error", lastLabel?: string) => {
        const result = status === "done" ? parseVerdict(verdictLine || text) : undefined;
        const cost = status === "done" && doneTokens > 0 ? { tokens: doneTokens, usd: doneCostUsd ?? undefined } : undefined;
        this.#patch(id, (j) => ({
          ...j,
          status,
          result,
          cost,
          endedAt: Date.now(),
          steps: lastLabel ? [...j.steps, { kind: "status", label: lastLabel, ts: Date.now() }] : j.steps,
        }));
        // Persist a readable log file so the CLI/assistant can read past runs.
        if (status === "done") {
          fetch("/api/runs/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, title: opts.title, subtitle: opts.subtitle, page: opts.page, input: opts.input, result, cost, steps, output: text }),
          }).catch(() => {});
          // Tell server-snapshot surfaces (Today, pipeline) to refetch — the
          // worker just wrote a real tracker row / report they don't yet see.
          if (typeof window !== "undefined" && (opts.kind === "evaluate" || opts.kind === "pdf")) {
            window.dispatchEvent(new CustomEvent("co-job-done", { detail: { kind: opts.kind, input: opts.input } }));
          }
        }
      };

      try {
        const res = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: opts.kind, input: opts.input, cliId }),
        });
        if (!res.ok || !res.body) {
          const e = await res.json().catch(() => ({}));
          finish("error", e.error || "Failed to start");
          return;
        }
        const completion = await readJobStream(res.body, (ev: { type: string; name?: string; label?: string; text?: string }) => {
          if (ev.type === "tool") {
            steps.push({ kind: "tool", label: ev.name ?? "", ts: Date.now() });
            this.#patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "tool", label: ev.name ?? "", ts: Date.now() }] }));
          } else if (ev.type === "status") {
            steps.push({ kind: "status", label: ev.label ?? "", ts: Date.now() });
            this.#patch(id, (j) => ({ ...j, steps: [...j.steps, { kind: "status", label: ev.label ?? "", ts: Date.now() }] }));
          } else if (ev.type === "text") {
            const full = text + ev.text;
            const vm = full.match(/VERDICT:[^\n]*/i);
            if (vm) verdictLine = vm[0];
            text = full.slice(-8000);
            this.#patch(id, (j) => ({ ...j, text }));
          }
        });
        if (completion.status === "error") {
          finish("error", completion.message);
          return;
        }
        doneTokens = completion.tokens ?? 0;
        doneCostUsd = completion.costUsd ?? null;
        finish("done", "Done");
      } catch {
        finish("error", "Connection error");
      }
    })();

    return id;
  }

  removeJob(id: string): void {
    this.jobs = this.jobs.filter((j) => j.id !== id);
  }

  clearFinished(): void {
    this.jobs = this.jobs.filter((j) => j.status === "running");
  }
}

/** Create the app-wide store and make it available to every descendant. */
export function provideJobs(): JobsStore {
  const store = new JobsStore();
  setContext(CONTEXT_KEY, store);
  return store;
}

export function useJobs(): JobsStore {
  const store = getContext<JobsStore | undefined>(CONTEXT_KEY);
  if (!store) throw new Error("useJobs must be used within the app layout");
  return store;
}
