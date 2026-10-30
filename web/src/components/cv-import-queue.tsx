"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Pencil, SkipForward, X } from "lucide-react";
import { cn } from "@/lib/cn";

type Candidate = {
  section: string;
  parent: string | null;
  isHeading: boolean;
  text: string;
  label: string;
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

export function CvImportQueue() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/cv/profile/import");
      const body = (await res.json()) as Preview & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not read the import preview.");
        return;
      }
      setPreview(body);
    } catch {
      setError("Couldn’t reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const candidates = preview?.candidates ?? [];

  const visible = useMemo(
    () => candidates.map((candidate, index) => ({ candidate, index })).filter(({ candidate }) => filter === "all" || candidate.section === filter),
    [candidates, filter],
  );

  const counts = useMemo(() => {
    const bySection = new Map<string, number>();
    for (const candidate of candidates) bySection.set(candidate.section, (bySection.get(candidate.section) ?? 0) + 1);
    return bySection;
  }, [candidates]);

  // An entry heading with no facts under it is what the conservative parser
  // makes of a role line or a date range: approving it writes an empty entry
  // into the profile. Worth saying out loud, since skipping it is almost always
  // what the user wants.
  const emptyHeadings = useMemo(() => {
    const factsUnder = new Map<string, number>();
    for (const candidate of candidates) {
      if (candidate.isHeading || candidate.parent === null) continue;
      const key = `${candidate.section}\0${candidate.parent}`;
      factsUnder.set(key, (factsUnder.get(key) ?? 0) + 1);
    }
    return new Set(
      candidates
        .filter((candidate) => candidate.isHeading && (factsUnder.get(`${candidate.section}\0${candidate.text}`) ?? 0) === 0)
        .map((candidate) => `${candidate.section}\0${candidate.text}`),
    );
  }, [candidates]);

  const decided = Object.values(decisions).filter((decision) => decision.action === "approve" || decision.action === "edit").length;

  function setDecision(index: number, decision: Decision | null) {
    setDecisions((current) => {
      const next = { ...current };
      if (decision) next[index] = decision;
      else delete next[index];
      return next;
    });
  }

  function acceptVisible() {
    setDecisions((current) => {
      const next = { ...current };
      for (const { index } of visible) next[index] = { action: "approve" };
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    setResult("");
    try {
      const payload = candidates.map((_, index) => decisions[index] ?? { action: "skip" as const });
      const res = await fetch("/api/cv/profile/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions: payload, cvFingerprint: preview?.cvFingerprint }),
      });
      const body = (await res.json()) as { summary?: string; error?: string; details?: string[] };
      if (!res.ok) {
        setError([body.error, ...(body.details ?? [])].filter(Boolean).join(" — ") || "The import was rejected.");
        return;
      }
      setResult(body.summary ?? "Saved.");
      setDecisions({});
      await load();
    } catch {
      setError("Couldn’t reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link href="/cv" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> CV editor
      </Link>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Import into your career profile</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Every fact <code className="text-foreground">career-profile.mjs</code> pulled out of <code className="text-foreground">cv.md</code>, with the line it
            came from. Approve what is accurate, rewrite what needs wording, skip the rest. Nothing is saved until you press save — and only what you approve lands in
            <code className="text-foreground"> data/career-profile.yml</code>.
          </p>
        </div>
        {preview && (
          <p className="text-sm text-faint">
            {preview.total} candidate{preview.total === 1 ? "" : "s"} from {preview.source}
            {preview.profileExists && <span className="ml-1">· profile exists, approved items merge into it</span>}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {result && (
        <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-400">{result}</p>
      )}
      {preview && !preview.totalMatches && (
        <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          The importer reported {preview.total} candidates but only {preview.candidates.length} parsed. Reload before saving — answers line up by position.
        </p>
      )}

      {loading ? (
        <div className="mt-8 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Reading cv.md…
        </div>
      ) : (
        preview && (
          <>
            <div className="mt-6 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setFilter("all")}
                className={cn(
                  "rounded-full px-3 py-1 text-sm transition-colors",
                  filter === "all" ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground",
                )}
              >
                All <span className="text-xs text-faint">{candidates.length}</span>
              </button>
              {[...counts.entries()].map(([section, count]) => (
                <button
                  key={section}
                  type="button"
                  onClick={() => setFilter(section)}
                  className={cn(
                    "rounded-full px-3 py-1 text-sm transition-colors",
                    filter === section ? "bg-brand-soft text-brand-text" : "text-muted hover:text-foreground",
                  )}
                >
                  {SECTION_LABEL[section] ?? section} <span className="text-xs text-faint">{count}</span>
                </button>
              ))}
            </div>

            <ul className="mt-4 max-h-[58vh] space-y-1.5 overflow-auto rounded-2xl border border-border bg-surface/30 p-2">
              {visible.map(({ candidate, index }) => {
                const decision = decisions[index] ?? { action: "skip" as const };
                const approved = decision.action === "approve" || decision.action === "edit";
                return (
                  <li
                    key={index}
                    className={cn(
                      "rounded-xl border px-3 py-2 transition-colors",
                      approved ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-surface/60",
                    )}
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-faint">
                          {candidate.isHeading ? (
                            <span className="text-brand-text">{SECTION_LABEL[candidate.section] ?? candidate.section} entry</span>
                          ) : (
                            <>
                              {SECTION_LABEL[candidate.section] ?? candidate.section}
                              {candidate.parent && <span className="text-muted"> · {candidate.parent}</span>}
                            </>
                          )}
                        </p>

                        {editing === index ? (
                          <div className="mt-1.5">
                            <textarea
                              value={draft}
                              onChange={(event) => setDraft(event.target.value)}
                              rows={3}
                              className="w-full resize-y rounded-lg border border-border bg-surface p-2 font-mono text-xs leading-relaxed outline-none focus:border-brand/40"
                            />
                            <div className="mt-1.5 flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  setDecision(index, { action: "edit", text: draft });
                                  setEditing(null);
                                }}
                                className="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200"
                              >
                                Use this wording
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditing(null)}
                                className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <p className={cn("text-sm", candidate.isHeading ? "font-medium text-foreground" : "text-foreground/90")}>
                              {decision.action === "edit" && decision.text ? decision.text : candidate.text}
                              {decision.action === "edit" && decision.text && <span className="ml-2 text-xs text-brand-text">rewritten</span>}
                            </p>
                            {candidate.isHeading && emptyHeadings.has(`${candidate.section}\0${candidate.text}`) && (
                              <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">
                                No facts under this heading — approving it adds an empty entry.
                              </p>
                            )}
                          </>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setDecision(index, approved ? null : { action: "approve" })}
                          aria-label={approved ? `Skip ${candidate.text}` : `Approve ${candidate.text}`}
                          className={cn(
                            "rounded-full border p-1.5 transition-colors",
                            approved ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "border-border text-muted hover:text-foreground",
                          )}
                        >
                          {approved ? <Check className="size-3.5" /> : <SkipForward className="size-3.5" />}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(index);
                            setDraft(decision.action === "edit" ? (decision.text ?? candidate.text) : candidate.text);
                          }}
                          aria-label={`Rewrite ${candidate.text}`}
                          className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDecision(index, null)}
                          aria-label={`Clear decision for ${candidate.text}`}
                          className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
              {visible.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Nothing in this section.</li>}
            </ul>

            <div className="sticky bottom-4 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-surface/90 px-4 py-3 backdrop-blur">
              <div className="text-sm text-muted">
                <span className="text-foreground">{decided}</span> of {candidates.length} approved
                {decided === 0 && <span className="ml-1 text-faint">· nothing will be written</span>}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={acceptVisible}
                  className="rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
                >
                  Approve all shown
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving || decided === 0}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
                    decided > 0 ? "bg-brand text-brand-foreground hover:bg-brand-200" : "border border-border bg-surface text-muted",
                  )}
                >
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  Save {decided > 0 ? `${decided} ` : ""}to profile
                </button>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
}
