"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  Check,
  CircleAlert,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import { cn } from "@/lib/cn";
import {
  ENTITY_SECTIONS,
  ENTRY_FIELDS,
  FLAT_SECTIONS,
  addEntry,
  addFact,
  emptyProfile,
  moveEntry,
  moveFact,
  profileCounts,
  removeEntry,
  removeFact,
  setFactStatus,
  totalFacts,
  unverifiedCount,
  updateEntryField,
  updateEntryLabel,
  updateFactText,
} from "@/lib/cv-profile.mjs";

type Fact = { id: string; text: string; review_status?: string; evidence?: { source?: string; line?: number; quote?: string } };
type Entry = {
  id: string;
  label: string;
  company?: string;
  role?: string;
  location?: string;
  dates?: string;
  review_status?: string;
  evidence?: { source?: string; line?: number; quote?: string };
  facts?: Fact[];
};
type Profile = {
  schema_version: number;
  candidate: Record<string, unknown>;
  summary: Fact[];
  experiences: Entry[];
  projects: Entry[];
  education: Entry[];
  certifications: Fact[];
  skills: Fact[];
};

type Loaded = {
  exists: boolean;
  profile: Profile;
  fingerprint: string | null;
  totalFacts: number;
  unverified: number;
  validation: { checked: boolean; valid: boolean; errors: string[] };
};

const SECTION_LABEL: Record<string, string> = {
  summary: "Summary",
  experiences: "Experience",
  projects: "Projects",
  education: "Education",
  certifications: "Certifications",
  skills: "Skills",
};

const SECTION_HINT: Record<string, string> = {
  summary: "One or two sentences about you. Each line is a separate fact you can pick from later.",
  experiences: "Each role is an entry, with the things you did as facts under it.",
  projects: "Side projects, open source, anything you built outside a job.",
  education: "Degrees and coursework.",
  certifications: "Certificates, licences, courses you finished.",
  skills: "One skill per fact, so a CV can pick the ones a posting asks for.",
};

const today = () => new Date().toISOString().slice(0, 10);

export function CvProfileBuilder() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [profile, setProfile] = useState<Profile>(emptyProfile() as Profile);
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [section, setSection] = useState<string>("summary");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [editingFact, setEditingFact] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [editingEntry, setEditingEntry] = useState<string | null>(null);
  const [entryDraft, setEntryDraft] = useState("");
  // Raw text of an entry field while it is being typed into.
  //
  // The stored value is normalized (trimmed + whitespace collapsed) on every
  // change, which is right for the file but wrong for the keyboard: a trailing
  // space is exactly what you type between two words, so normalizing each
  // keystroke made "Series Entertainment" impossible to type past "Series".
  // The draft holds what was typed; the profile holds the normalized version.
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});
  const [newFact, setNewFact] = useState("");
  const [newEntry, setNewEntry] = useState("");

  const applyLoaded = useCallback((body: Loaded) => {
    setLoaded(body);
    setProfile(body.profile);
    setFingerprint(body.fingerprint);
    setErrors(body.validation?.errors ?? []);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cv/profile");
      const body = (await res.json()) as Loaded & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not read the career profile.");
        return;
      }
      applyLoaded(body);
    } catch {
      setError("Couldn’t reach the server.");
    }
  }, [applyLoaded]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  function mutate(next: Profile) {
    setProfile(next);
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    setSaving(true);
    setError("");
    setErrors([]);
    try {
      const res = await fetch("/api/cv/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, fingerprint }),
      });
      const body = (await res.json()) as { error?: string; errors?: string[]; fingerprint?: string | null };
      if (!res.ok) {
        setError(body.error ?? "Save failed.");
        setErrors(body.errors ?? []);
        return;
      }
      setFingerprint(body.fingerprint ?? null);
      setDirty(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch {
      setError("Couldn’t reach the server.");
    } finally {
      setSaving(false);
    }
  }

  const counts = useMemo(() => profileCounts(profile), [profile]);
  const facts = totalFacts(profile);
  const unverified = unverifiedCount(profile);
  const isEntitySection = ENTITY_SECTIONS.includes(section);
  const isFlat = FLAT_SECTIONS.includes(section);
  const entries = (profile[section as keyof Profile] as Entry[] | Fact[] | undefined) ?? [];

  function addFactHere(entryId: string | null, text: string) {
    const result = addFact(profile, { section, entryId, text, date: today() });
    if (!result.added) {
      setError(result.reason === "duplicate" ? "That fact is already in this section." : "Nothing to add.");
      return;
    }
    setError("");
    mutate(result.profile as Profile);
  }

  function renderFactRow(fact: Fact, entryId: string | null, list: Fact[], index: number) {
    const isEditing = editingFact === fact.id;
    return (
      <li key={fact.id} className="rounded-xl border border-border bg-surface/60 px-3 py-2">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {isEditing ? (
              <div>
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  rows={3}
                  className="w-full resize-y rounded-lg border border-border bg-surface p-2 text-sm leading-relaxed outline-none focus:border-brand/40"
                />
                <div className="mt-1.5 flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      mutate(updateFactText(profile, { section, entryId, factId: fact.id, text: draft }) as Profile);
                      setEditingFact(null);
                    }}
                    className="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200"
                  >
                    Use this wording
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingFact(null)}
                    className="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
                  >
                    <Undo2 className="size-3" /> Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="text-sm text-foreground/90">{fact.text}</p>
                <p className="mt-0.5 truncate text-xs text-faint" title={fact.evidence?.quote}>
                  {fact.evidence?.source}
                  {fact.evidence?.line ? `:${fact.evidence.line}` : ""}
                  {fact.review_status !== "verified" && <span className="ml-2 text-amber-600 dark:text-amber-400">needs review</span>}
                </p>
              </>
            )}
          </div>

          {!isEditing && (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setEditingFact(fact.id);
                  setDraft(fact.text);
                }}
                aria-label={`Reword: ${fact.text.slice(0, 40)}`}
                className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
              >
                <Pencil className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => mutate(setFactStatus(profile, { section, entryId, factId: fact.id, status: fact.review_status === "verified" ? "needs_review" : "verified" }) as Profile)}
                aria-label={fact.review_status === "verified" ? `Mark for review: ${fact.text.slice(0, 40)}` : `Mark verified: ${fact.text.slice(0, 40)}`}
                className={cn(
                  "rounded-full border p-1.5 transition-colors",
                  fact.review_status === "verified"
                    ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                    : "border-amber-500/50 text-amber-600 dark:text-amber-400",
                )}
              >
                <Check className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => mutate(moveFact(profile, { section, entryId, factId: fact.id, direction: "up" }) as Profile)}
                disabled={index === 0}
                aria-label="Move up"
                className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => mutate(moveFact(profile, { section, entryId, factId: fact.id, direction: "down" }) as Profile)}
                disabled={index === list.length - 1}
                aria-label="Move down"
                className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => mutate(removeFact(profile, { section, entryId, factId: fact.id }) as Profile)}
                aria-label={`Delete: ${fact.text.slice(0, 40)}`}
                className="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          )}
        </div>
      </li>
    );
  }

  function addFactForm(entryId: string | null) {
    return (
      <div className="mt-2 flex items-start gap-2">
        <textarea
          value={newFact}
          onChange={(event) => setNewFact(event.target.value)}
          rows={2}
          placeholder="Record something you did — one fact per line…"
          className="flex-1 resize-y rounded-xl border border-border bg-surface/50 p-2.5 text-sm leading-relaxed outline-none placeholder:text-faint focus:border-brand/40"
        />
        <button
          type="button"
          onClick={() => {
            addFactHere(entryId, newFact);
            setNewFact("");
          }}
          disabled={!newFact.trim()}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]"
        >
          <Plus className="size-4" /> Add
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/cv" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> CV editor
      </Link>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Career profile</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Everything you have done, kept in one place with the source it came from. Facts are what a CV is built from later — including the ones that never make it onto
            your current <code className="text-foreground">cv.md</code>.
            {dirty && <span className="ml-1 text-amber-600 dark:text-amber-400">Unsaved changes.</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/cv/generate"
            className="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-4 py-2 text-sm font-medium text-brand-text transition-colors hover:bg-brand-soft/70 max-sm:min-h-[44px]"
          >
            <Sparkles className="size-4" /> Generate CV
          </Link>
          <Link
            href="/cv/import"
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
          >
            <Upload className="size-4" /> Import from cv.md
          </Link>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className={cn(
              "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
              dirty ? "bg-brand text-brand-foreground hover:bg-brand-200" : "border border-border bg-surface text-muted",
            )}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : saved ? <Check className="size-4" /> : null}
            {saved ? "Saved" : "Save profile"}
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
          {errors.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-xs">
              {errors.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {loaded && loaded.validation.checked && !loaded.validation.valid && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          <span className="inline-flex items-center gap-1.5">
            <CircleAlert className="size-4" /> The core’s validator rejects what is on disk right now ({loaded.validation.errors.length} error
            {loaded.validation.errors.length === 1 ? "" : "s"}). Fix it here and save.
          </span>
        </div>
      )}

      {!loaded ? (
        <div className="mt-8 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Reading career-profile.yml…
        </div>
      ) : (
        <div className="mt-6 grid gap-4 lg:grid-cols-[220px_1fr]">
          <nav aria-label="Profile sections" className="space-y-1">
            {Object.keys(SECTION_LABEL).map((key) => {
              const count = counts[key];
              const active = section === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSection(key)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-colors",
                    active ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <span>{SECTION_LABEL[key]}</span>
                  <span className="text-xs text-faint">
                    {ENTITY_SECTIONS.includes(key) ? `${count.entries} · ${count.facts}` : count.facts}
                  </span>
                </button>
              );
            })}

            <div className="mt-3 rounded-xl border border-border px-3 py-2 text-xs text-faint">
              <p>
                {facts} fact{facts === 1 ? "" : "s"} recorded
              </p>
              {unverified > 0 && <p className="mt-1 text-amber-600 dark:text-amber-400">{unverified} still need review</p>}
              {!loaded.exists && <p className="mt-1">No profile file yet — saving creates it.</p>}
            </div>
          </nav>

          <section>
            <p className="text-sm text-muted">{SECTION_HINT[section]}</p>

            {isFlat && (
              <>
                <ul className="mt-3 space-y-1.5">{(entries as Fact[]).map((fact, index) => renderFactRow(fact, null, entries as Fact[], index))}</ul>
                {addFactForm(null)}
              </>
            )}

            {isEntitySection && (
              <div className="mt-3 space-y-3">
                {(entries as Entry[]).map((entry, entryIndex) => (
                  <article key={entry.id} className="rounded-2xl border border-border bg-surface/30 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        {editingEntry === entry.id ? (
                          <div>
                            <input
                              value={entryDraft}
                              onChange={(event) => setEntryDraft(event.target.value)}
                              className="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-brand/40"
                            />
                            <div className="mt-1.5 flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  if (entryDraft.trim()) mutate(updateEntryLabel(profile, { section, entryId: entry.id, label: entryDraft }) as Profile);
                                  setEditingEntry(null);
                                }}
                                className="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200"
                              >
                                Rename
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingEntry(null)}
                                className="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <h2 className="text-sm font-medium text-foreground">
                            {/* The role is typed once, in the Role field. The header
                                shows the composed name as soon as company and role
                                are both there, so the entry is not "named" and
                                "rolled" separately. */}
                            {entry.company && entry.role ? `${entry.company} — ${entry.role}` : entry.label}
                            {entry.company && entry.role && entry.label !== `${entry.company} — ${entry.role}` && (
                              <span className="ml-2 text-xs font-normal text-faint" title={entry.label}>
                                named “{entry.label}”
                              </span>
                            )}
                          </h2>
                        )}
                        <p className="mt-0.5 text-xs text-faint">
                          {entry.facts?.length ?? 0} fact{entry.facts?.length === 1 ? "" : "s"}
                          {entry.evidence?.source ? ` · ${entry.evidence.source}${entry.evidence.line ? `:${entry.evidence.line}` : ""}` : ""}
                          {(entry.facts?.length ?? 0) === 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">empty entry</span>}
                        </p>

                        {/* What the CV payload actually reads. The label above is the
                            entry's identity; these four fields are what
                            build-cv-html.mjs renders, and company + role are
                            mandatory before an entry appears at all. */}
                        {!editingEntry && (
                          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                            {ENTRY_FIELDS.map((field) => {
                              const draftKey = `${entry.id}\u0000${field}`;
                              return (
                                <label key={field} className="text-xs text-faint">
                                  <span className="capitalize">{field}</span>
                                  <input
                                    value={fieldDrafts[draftKey] ?? ((entry[field as keyof Entry] as string | undefined) ?? "")}
                                    onChange={(event) => {
                                      const raw = event.target.value;
                                      setFieldDrafts((current) => ({ ...current, [draftKey]: raw }));
                                      mutate(updateEntryField(profile, { section, entryId: entry.id, field, value: raw }) as Profile);
                                    }}
                                    onBlur={() =>
                                      setFieldDrafts((current) => {
                                        const next = { ...current };
                                        delete next[draftKey];
                                        return next;
                                      })
                                    }
                                    placeholder={field === "company" ? "Acme Inc." : field === "role" ? "Senior Engineer" : field === "dates" ? "2024 – 2026" : "Remote"}
                                    className={cn(
                                      "mt-0.5 w-full rounded-lg border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none placeholder:text-faint focus:border-brand/40",
                                      (field === "company" || field === "role") && !entry[field] ? "border-amber-500/40" : "border-border",
                                    )}
                                  />
                                </label>
                              );
                            })}
                          </div>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingEntry(entry.id);
                            setEntryDraft(entry.label);
                          }}
                          aria-label={`Rename ${entry.label}`}
                          className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => mutate(moveEntry(profile, { section, entryId: entry.id, direction: "up" }) as Profile)}
                          disabled={entryIndex === 0}
                          aria-label="Move entry up"
                          className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
                        >
                          <ArrowUp className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => mutate(moveEntry(profile, { section, entryId: entry.id, direction: "down" }) as Profile)}
                          disabled={entryIndex === (entries as Entry[]).length - 1}
                          aria-label="Move entry down"
                          className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
                        >
                          <ArrowDown className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (!window.confirm(`Remove “${entry.label}” and its ${entry.facts?.length ?? 0} fact(s)?`)) return;
                            mutate(removeEntry(profile, { section, entryId: entry.id }) as Profile);
                          }}
                          aria-label={`Delete ${entry.label}`}
                          className="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
                        >
                          <Trash2 className="size-3.5" />
                        </button>
                      </div>
                    </div>

                    <ul className="mt-2 space-y-1.5">{(entry.facts ?? []).map((fact, index) => renderFactRow(fact, entry.id, entry.facts ?? [], index))}</ul>
                    {addFactForm(entry.id)}
                  </article>
                ))}

                <div className="flex items-start gap-2 rounded-2xl border border-dashed border-border p-3">
                  <input
                    value={newEntry}
                    onChange={(event) => setNewEntry(event.target.value)}
                    placeholder={`New ${SECTION_LABEL[section].toLowerCase()} entry — company, role, dates…`}
                    className="flex-1 rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-brand/40"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const result = addEntry(profile, { section, label: newEntry, date: today() });
                      if (!result.added) {
                        setError(result.reason === "duplicate" ? "That entry already exists." : "Nothing to add.");
                        return;
                      }
                      setError("");
                      setNewEntry("");
                      mutate(result.profile as Profile);
                    }}
                    disabled={!newEntry.trim()}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50 max-sm:min-h-[44px]"
                  >
                    <Plus className="size-4" /> Add entry
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
