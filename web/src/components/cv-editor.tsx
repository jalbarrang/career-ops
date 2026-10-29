"use client";

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Check, Loader2, Minus, RotateCcw, X } from "lucide-react";
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

export function CvEditor() {
  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [exists, setExists] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<Tab>("preview");

  const [review, setReview] = useState<Review | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<string | null>(null);

  const loadReview = useCallback(async () => {
    setReviewing(true);
    try {
      const res = await fetch("/api/cv/review");
      if (res.ok) setReview((await res.json()) as Review);
    } catch {
      // The panel keeps whatever it showed last; a failed re-check is not a
      // reason to blank the findings the user is reading.
    } finally {
      setReviewing(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/cv/history");
      if (res.ok) setBackups(((await res.json()) as { backups?: Backup[] }).backups ?? []);
    } catch {
      setBackups([]);
    }
  }, []);

  useEffect(() => {
    fetch("/api/cv")
      .then((r) => r.json())
      .then((d: { content?: string; exists?: boolean }) => {
        setContent(d.content ?? "");
        setExists(d.exists ?? false);
      })
      .catch(() => setError("Couldn’t read cv.md."))
      .finally(() => setLoaded(true));
    void loadHistory();
    void loadReview();
  }, [loadHistory, loadReview]);

  // cv.md is gitignored user-layer data, so a discarded edit cannot be recovered
  // from git — the browser has to ask first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/cv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error ?? "Save failed.");
        return;
      }
      setDirty(false);
      setExists(true);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await Promise.all([loadReview(), loadHistory()]);
    } catch {
      setError("Couldn’t reach the server.");
    } finally {
      setSaving(false);
    }
  }

  async function restore(name: string) {
    setRestoring(name);
    setError("");
    try {
      const res = await fetch("/api/cv/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = (await res.json().catch(() => ({}))) as { content?: string; error?: string };
      if (!res.ok || typeof d.content !== "string") {
        setError(d.error ?? "Restore failed.");
        return;
      }
      setContent(d.content);
      setDirty(false);
      setExists(true);
      setPendingRestore(null);
      await Promise.all([loadReview(), loadHistory()]);
    } catch {
      setError("Couldn’t reach the server.");
    } finally {
      setRestoring(null);
    }
  }

  const tabButton = (id: Tab, label: string, badge?: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setTab(id)}
      className={cn(
        "inline-flex min-h-[36px] items-center gap-1.5 rounded-full px-3 text-sm transition-colors",
        tab === id ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground",
      )}
    >
      {label}
      {badge && <span className="text-xs text-faint">{badge}</span>}
    </button>
  );

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">CV editor</h1>
          <p className="mt-1 text-sm text-muted">
            Edit <code className="text-foreground">cv.md</code> with live preview.
            {!exists && loaded && <span className="ml-1 text-faint">No cv.md yet — start typing to create it.</span>}
            {dirty && <span className="ml-1 text-amber-600 dark:text-amber-400">Unsaved changes.</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={save}
          disabled={saving || !dirty}
          className={cn(
            "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
            dirty
              ? "bg-brand text-brand-foreground hover:bg-brand-200"
              : "border border-border bg-surface text-muted",
          )}
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : saved ? <Check className="size-4" /> : null}
          {saved ? "Saved" : "Save"}
        </button>
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {!loaded ? (
        <div className="mt-6 text-sm text-muted">Loading…</div>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setDirty(true);
            }}
            spellCheck={false}
            placeholder="# Your Name&#10;&#10;## Summary&#10;..."
            className="min-h-[60vh] w-full resize-none rounded-2xl border border-border bg-surface/50 p-4 font-mono text-sm leading-relaxed outline-none transition-colors placeholder:text-faint focus:border-brand/40"
          />

          <div className="flex min-h-[60vh] flex-col rounded-2xl border border-border bg-surface/30">
            <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1.5">
              <div className="flex items-center gap-1">
                {tabButton("preview", "Preview")}
                {tabButton("review", "Review", review ? review.headline : undefined)}
                {tabButton("history", "History", backups.length ? String(backups.length) : undefined)}
              </div>
              {tab === "review" && (
                <button
                  type="button"
                  onClick={() => void loadReview()}
                  disabled={reviewing}
                  className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs text-muted transition-colors hover:text-foreground disabled:opacity-60"
                >
                  {reviewing ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
                  Re-check
                </button>
              )}
            </div>

            {tab === "preview" && (
              <article className="report-prose flex-1 overflow-auto p-5">
                {content.trim() ? (
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                ) : (
                  <p className="text-muted">Preview appears here.</p>
                )}
              </article>
            )}

            {tab === "review" && (
              <div className="flex-1 overflow-auto p-4">
                {!review ? (
                  <p className="text-sm text-muted">{reviewing ? "Running the core’s checks…" : "No checks yet."}</p>
                ) : (
                  <>
                    <ul className="space-y-3">
                      {review.checks.map((check) => {
                        const meta = STATUS_META[check.status];
                        const Icon = meta.icon;
                        return (
                          <li key={check.id} className="rounded-xl border border-border bg-surface/60 p-3">
                            <div className="flex items-start gap-2">
                              <Icon className={cn("mt-0.5 size-4 shrink-0", meta.className)} aria-hidden />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-foreground">{check.label}</p>
                                <p className="text-xs text-muted">{check.summary}</p>
                                {check.details.length > 0 && (
                                  <details className="mt-2">
                                    <summary className="cursor-pointer text-xs text-faint hover:text-muted">
                                      {check.details.length} detail(s)
                                    </summary>
                                    <ul className="mt-1.5 space-y-1 font-mono text-xs text-muted">
                                      {check.details.map((line, i) => (
                                        <li key={i} className="break-words">
                                          {line}
                                        </li>
                                      ))}
                                    </ul>
                                  </details>
                                )}
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    <p className="mt-3 text-xs text-faint">Checked {formatWhen(review.ranAt)} · results reflect the saved cv.md.</p>
                  </>
                )}
              </div>
            )}

            {tab === "history" && (
              <div className="flex-1 overflow-auto p-4">
                {backups.length === 0 ? (
                  <p className="text-sm text-muted">No snapshots yet — the first save creates one.</p>
                ) : (
                  <ul className="space-y-2">
                    {backups.map((bak) => (
                      <li key={bak.name} className="rounded-xl border border-border bg-surface/60 px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm text-foreground">{formatWhen(bak.savedAt)}</p>
                            <p className="text-xs text-faint">{formatBytes(bak.bytes)}</p>
                          </div>
                          {pendingRestore === bak.name ? (
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => void restore(bak.name)}
                                disabled={restoring !== null}
                                className="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-60"
                              >
                                {restoring === bak.name ? "Restoring…" : "Replace cv.md"}
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingRestore(null)}
                                className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setPendingRestore(bak.name)}
                              className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
                            >
                              Restore
                            </button>
                          )}
                        </div>
                        {pendingRestore === bak.name && (
                          <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                            This overwrites cv.md{dirty ? " and discards your unsaved edits" : ""}. The current version is snapshotted first, so it stays restorable.
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
