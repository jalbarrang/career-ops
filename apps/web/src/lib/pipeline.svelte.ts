// Client-side pipeline state: a thin mirror of the tracker + inbox so surfaces
// that live OUTSIDE a pipeline page can still read them.
//
// This replaces the Next app's PipelineProvider context. Its only consumer there
// was the assistant console (pages read the pipeline through their own server
// load), and that is still true here — which is why `start()` is called by the
// console on mount instead of by the layout. The shape is deliberately the same
// (inbox/applications/loading/refetch) so the console's context builders and its
// action registry keep working unchanged.
import { getContext, setContext } from "svelte";
import { browser } from "$app/env";
import type { Application, InboxJob } from "@/lib/career-ops";

const CONTEXT_KEY = "career-ops:pipeline-store";

/** The part of `/api/pipeline`'s answer this mirror needs. */
type PipelineResponse = { inbox?: unknown; applications?: unknown };

export class PipelineStore {
  inbox = $state<InboxJob[]>([]);
  applications = $state<Application[]>([]);
  loading = $state(true);

  #started = false;

  /** Re-read the snapshot. Failures leave the last good copy in place — a stale
   *  list is better than an empty one mid-turn. */
  refetch(): void {
    this.loading = true;
    fetch("/api/pipeline")
      .then((r) => r.json() as Promise<PipelineResponse>)
      .then((d) => {
        this.inbox = Array.isArray(d.inbox) ? (d.inbox as InboxJob[]) : [];
        this.applications = Array.isArray(d.applications) ? (d.applications as Application[]) : [];
      })
      .catch(() => {})
      .finally(() => {
        this.loading = false;
      });
  }

  /** Hydrate once and keep the snapshot fresh while the tab is focused.
   *  Idempotent, so every surface that needs the data can just call it. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.refetch();
    if (browser) window.addEventListener("focus", () => this.refetch());
  }
}

// One store for the whole tab: the assistant patches/reads the same snapshot a
// pipeline page wrote, the way the single provider above the routes did. Every
// mutation originates in the browser, so the shared instance is never written
// during SSR — the server gets a fresh instance per render instead.
let clientStore: PipelineStore | null = null;

function sharedStore(): PipelineStore {
  clientStore ??= new PipelineStore();
  return clientStore;
}

/** Create the store and make it available to every descendant. */
export function providePipeline(): PipelineStore {
  // Reuse what a parent already provided so the snapshot isn't split in two.
  const inherited = getContext<PipelineStore | undefined>(CONTEXT_KEY);
  if (inherited) return inherited;
  const store = browser ? sharedStore() : new PipelineStore();
  setContext(CONTEXT_KEY, store);
  return store;
}

export function usePipeline(): PipelineStore {
  const store = getContext<PipelineStore | undefined>(CONTEXT_KEY);
  if (store) return store;
  return browser ? sharedStore() : new PipelineStore();
}
