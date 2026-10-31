"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Check, Loader2, Pencil, SkipForward, X } from "lucide-react";
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

export function CvImportQueue() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  // One entry per candidate, positionally — the importer answers prompts in
  // order, so this array IS the answer sheet buildReviewInput consumes.
  const [decisions, setDecisions] = useState<(Decision | undefined)[]>([]);
  // Company / role / dates per block, pre-filled from the block's own lines and
  // editable before the import writes them onto the entry it creates.
  const [entryFields, setEntryFields] = useState<Record<string, { company: string; role: string; dates: string }>>({});
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
      setDecisions(new Array(body.candidates.length).fill(undefined));
      const seeded: Record<string, { company: string; role: string; dates: string }> = {};
      for (const block of groupImportBlocks(body.candidates) as Block[]) {
        if (block.kind === "entry" && block.labels.length > 1) seeded[block.key] = suggestEntryFields(block.labels);
      }
      setEntryFields(seeded);
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

  // Grouped into the units a person reviews: one job is one block, even when the
  // parser split it into a company line, a role line and a date range.
  const blocks = useMemo(() => groupImportBlocks(candidates) as Block[], [candidates]);

  const visible = useMemo(() => blocks.filter((block) => filter === "all" || block.section === filter), [blocks, filter]);

  const counts = useMemo(() => {
    const bySection = new Map<string, number>();
    for (const candidate of candidates) bySection.set(candidate.section, (bySection.get(candidate.section) ?? 0) + 1);
    return bySection;
  }, [candidates]);

  /** A block is chosen when the entry it would create is approved. */
  function blockApproved(block: Block): boolean {
    const target = block.ownerIndex >= 0 ? block.ownerIndex : block.factIndices[0];
    const decision = decisions[target];
    return decision?.action === "approve" || decision?.action === "edit";
  }

  function blockChoice(block: Block, action: "approve" | "skip") {
    setDecisions((current) => applyBlockDecision(block, action, current) as (Decision | undefined)[]);
  }

  function setDecision(index: number, decision: Decision | null) {
    setDecisions((current) => {
      const next = [...current];
      next[index] = decision ?? undefined;
      return next;
    });
  }

  function acceptVisible() {
    setDecisions((current) => {
      let next = current;
      for (const block of visible) next = applyBlockDecision(block, "approve", next) as (Decision | undefined)[];
      return next;
    });
  }

  const decided = decisions.filter((decision) => decision?.action === "approve" || decision?.action === "edit").length;

  async function save() {
    setSaving(true);
    setError("");
    setResult("");
    try {
      const payload = candidates.map((_, index) => decisions[index] ?? { action: "skip" as const });
      const res = await fetch("/api/cv/profile/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: payload,
          cvFingerprint: preview?.cvFingerprint,
          // Only for the blocks being approved, and only when the reviewer left
          // something in them: untouched suggestions still describe the role.
          entryFields: blocks
            .filter((block) => block.kind === "entry" && blockApproved(block))
            .map((block) => ({
              section: block.section,
              ownerLabel: block.labels[block.labels.length - 1],
              ...(entryFields[block.key] ?? { company: "", role: "", dates: "" }),
            }))
            .filter((fields) => fields.company || fields.role || fields.dates),
        }),
      });
      const body = (await res.json()) as { summary?: string; error?: string; details?: string[] };
      if (!res.ok) {
        setError([body.error, ...(body.details ?? [])].filter(Boolean).join(" — ") || "The import was rejected.");
        return;
      }
      setResult(body.summary ?? "Saved.");
      setDecisions(new Array(candidates.length).fill(undefined));
      await load();
    } catch {
      setError("Couldn’t reach the server.");
    } finally {
      setSaving(false);
    }
  }

  /** The text of one candidate, or the textarea while it is being rewritten. */
  function renderBody(index: number) {
    const candidate = candidates[index];
    const decision = decisions[index];
    const isEditing = editing === index;

    if (isEditing) {
      return (
        <div className="mt-1">
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
      );
    }

    return (
      <p className={cn("text-sm", candidate.isHeading ? "font-medium text-foreground" : "text-foreground/90")}>
        {decision?.action === "edit" && decision.text ? decision.text : candidate.text}
        {decision?.action === "edit" && decision.text && <span className="ml-2 text-xs text-brand-text">rewritten</span>}
      </p>
    );
  }

  /** Approve / rewrite / clear controls for exactly one candidate. */
  function renderControls(index: number) {
    const approved = decisions[index]?.action === "approve" || decisions[index]?.action === "edit";
    return (
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={() => setDecision(index, approved ? null : { action: "approve" })}
          aria-label={approved ? "Skip this" : "Approve this"}
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
            setDraft(decisions[index]?.action === "edit" ? (decisions[index]?.text ?? candidates[index].text) : candidates[index].text);
          }}
          aria-label="Rewrite this"
          className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
        >
          <Pencil className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setDecision(index, null)}
          aria-label="Clear this decision"
          className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <Link href="/cv/profile" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> Career profile
      </Link>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Import into your career profile</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Every fact <code className="text-foreground">career-profile.mjs</code> pulled out of <code className="text-foreground">cv.md</code>, with the line it came from.
            One role is one decision: the company, title and date lines the parser split apart stay together here, and only the block you approve becomes an entry.
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

            <ul className="mt-4 max-h-[58vh] space-y-2 overflow-auto rounded-2xl border border-border bg-surface/30 p-2">
              {visible.map((block) => {
                const approved = blockApproved(block);
                const isEntry = block.kind === "entry";
                const ownerIndex = block.ownerIndex >= 0 ? block.ownerIndex : block.factIndices[0];
                const metadata = block.labels.slice(0, -1);

                return (
                  <li
                    key={block.key}
                    className={cn("rounded-xl border px-3 py-2 transition-colors", approved ? "border-emerald-500/40 bg-emerald-500/5" : "border-border bg-surface/60")}
                  >
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-faint">
                          <span className={isEntry ? "text-brand-text" : undefined}>{SECTION_LABEL[block.section] ?? block.section}</span>
                          {isEntry && <span className="ml-1">entry · {block.factIndices.length} fact(s)</span>}
                        </p>

                        {isEntry && metadata.length > 0 && !(entryFields[block.key]?.company && entryFields[block.key]?.role) && (
                          <p className="mt-0.5 text-xs text-muted">
                            {metadata.join(" · ")}
                            <span className="ml-1 text-faint">— same role, kept out as its own entry</span>
                          </p>
                        )}

                        {isEntry ? (
                          // Title the block the way the entry will be named once the
                          // fields below are applied, instead of the parser's own
                          // heading (usually the date range).
                          <p className="text-sm font-medium text-foreground">
                            {entryFields[block.key]?.company && entryFields[block.key]?.role
                              ? `${entryFields[block.key].company} — ${entryFields[block.key].role}`
                              : candidates[ownerIndex].text}
                            {approved && <span className="ml-2 text-xs font-normal text-emerald-600 dark:text-emerald-400">included</span>}
                          </p>
                        ) : (
                          renderBody(ownerIndex)
                        )}

                        {isEntry && (
                          <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
                            {(["company", "role", "dates"] as const).map((field) => (
                              <label key={field} className="text-xs text-faint">
                                <span className="capitalize">{field}</span>
                                <input
                                  value={entryFields[block.key]?.[field] ?? ""}
                                  onChange={(event) =>
                                    setEntryFields((current) => ({
                                      ...current,
                                      [block.key]: { ...(current[block.key] ?? { company: "", role: "", dates: "" }), [field]: event.target.value },
                                    }))
                                  }
                                  placeholder={field === "company" ? "Acme Inc." : field === "role" ? "Senior Engineer" : "2024 – 2026"}
                                  className="mt-0.5 w-full rounded-lg border border-border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none placeholder:text-faint focus:border-brand/40"
                                />
                              </label>
                            ))}
                          </div>
                        )}

                        {isEntry && block.factIndices.length === 0 && (
                          <p className="mt-0.5 text-xs text-amber-600 dark:text-amber-400">No facts under this heading — approving it adds an empty entry.</p>
                        )}

                        {isEntry && block.factIndices.length > 0 && (
                          <ul className="mt-1.5 space-y-1 border-l border-border pl-2">
                            {block.factIndices.map((index) => (
                              <li key={index}>
                                <div className="flex items-start gap-2">
                                  <div className="min-w-0 flex-1">{renderBody(index)}</div>
                                  {renderControls(index)}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => blockChoice(block, approved ? "skip" : "approve")}
                          aria-label={approved ? "Skip this role" : "Approve this role"}
                          className={cn(
                            "rounded-full border p-1.5 transition-colors",
                            approved ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "border-border text-muted hover:text-foreground",
                          )}
                        >
                          {approved ? <Check className="size-3.5" /> : <SkipForward className="size-3.5" />}
                        </button>
                        {!isEntry && renderControls(ownerIndex)}
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
