"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
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
import { PeriodField } from "@/components/period-field";
import {
  EXPERIENCE_SECTION,
  FLAT_SECTIONS,
  LABEL_SECTIONS,
  addCompany,
  addEntry,
  addFact,
  addRole,
  ensureShape,
  factsOf,
  moveCompany,
  moveEntry,
  moveFact,
  moveRole,
  profileCounts,
  removeCompany,
  removeEntry,
  removeFact,
  removeRole,
  setFactStatus,
  totalFacts,
  unverifiedCount,
  updateCompanyName,
  updateEntryLabel,
  updateFactText,
  updateRoleField,
} from "@/lib/cv-profile.mjs";

type Fact = { id: string; text: string; review_status?: string; evidence?: { source?: string; line?: number; quote?: string } };
type Evidence = { source?: string; line?: number; quote?: string };
type Role = { id: string; name?: string; period?: string; location?: string; review_status?: string; evidence?: Evidence; facts?: Fact[] };
type Company = { id: string; company?: { name?: string; evidence?: Evidence }; roles?: Role[] };
type Entry = { id: string; label: string; review_status?: string; evidence?: Evidence; facts?: Fact[] };
type Profile = {
  schema_version: number;
  candidate: Record<string, unknown>;
  summary: Fact[];
  experiences: Company[];
  projects: Entry[];
  education: Entry[];
  certifications: Fact[];
  skills: Fact[];
};

type Counts = Record<string, { entries: number; facts: number; roles?: number }>;

type Loaded = {
  exists: boolean;
  profile: Profile;
  fingerprint: string | null;
  totalFacts: number;
  unverified: number;
  validation: { checked: boolean; valid: boolean; errors: string[] };
};

type Scope = { section: string; companyId?: string; roleId?: string; entryId?: string };

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
  experiences: "One card per employer. Roles nest inside it — a promotion is a second role on the same company.",
  projects: "Side projects, open source, anything you built outside a job.",
  education: "Degrees and coursework.",
  certifications: "Certificates, licences, courses you finished.",
  skills: "One skill per fact, so a CV can pick the ones a posting asks for.",
};

const today = () => new Date().toISOString().slice(0, 10);

export function CvProfileBuilder() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [profile, setProfile] = useState<Profile>(ensureShape(null) as Profile);
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
  // Raw text of a field while it is being typed into. The stored value is
  // normalized on every change, and a trailing space is exactly what you type
  // between two words — without this the space never reaches the box.
  const [fieldDrafts, setFieldDrafts] = useState<Record<string, string>>({});
  const [newFact, setNewFact] = useState("");
  const [newEntry, setNewEntry] = useState("");
  const [newCompany, setNewCompany] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/cv/profile");
      const body = (await res.json()) as Loaded & { error?: string };
      if (!res.ok) {
        setError(body.error ?? "Could not read the career profile.");
        return;
      }
      setLoaded(body);
      setProfile(body.profile);
      setFingerprint(body.fingerprint);
      setErrors(body.validation?.errors ?? []);
      setDirty(false);
    } catch {
      setError("Couldn’t reach the server.");
    }
  }, []);

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
    if (next === profile) return;
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

  const counts = useMemo<Counts>(() => profileCounts(profile) as Counts, [profile]);
  const facts = totalFacts(profile);
  const unverified = unverifiedCount(profile);

  const setDraftValue = (key: string, value: string) => setFieldDrafts((current) => ({ ...current, [key]: value }));
  const clearDraft = (key: string) =>
    setFieldDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });

  function factRow(fact: Fact, scope: Scope, list: Fact[], index: number) {
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
                      mutate(updateFactText(profile, { ...scope, factId: fact.id, text: draft }) as Profile);
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
                onClick={() =>
                  mutate(
                    setFactStatus(profile, {
                      ...scope,
                      factId: fact.id,
                      status: fact.review_status === "verified" ? "needs_review" : "verified",
                    }) as Profile,
                  )
                }
                aria-label={fact.review_status === "verified" ? "Mark for review" : "Mark verified"}
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
                onClick={() => mutate(moveFact(profile, { ...scope, factId: fact.id, direction: "up" }) as Profile)}
                disabled={index === 0}
                aria-label="Move up"
                className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => mutate(moveFact(profile, { ...scope, factId: fact.id, direction: "down" }) as Profile)}
                disabled={index === list.length - 1}
                aria-label="Move down"
                className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                onClick={() => mutate(removeFact(profile, { ...scope, factId: fact.id }) as Profile)}
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

  function addFactForm(scope: Scope) {
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
            const result = addFact(profile, { ...scope, text: newFact, date: today() });
            if (!result.added) {
              setError(result.reason === "duplicate" ? "That fact is already in this scope." : "Nothing to add.");
              return;
            }
            setError("");
            setNewFact("");
            mutate(result.profile as Profile);
          }}
          disabled={!newFact.trim()}
          className="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]"
        >
          <Plus className="size-4" /> Add
        </button>
      </div>
    );
  }

  /** A draft-aware text input bound to a profile field. */
  function fieldInput(options: {
    draftKey: string;
    value: string;
    placeholder: string;
    label: string;
    onCommit: (value: string) => void;
    warn?: boolean;
  }) {
    const { draftKey, value, placeholder, label, onCommit, warn } = options;
    return (
      <label className="text-xs text-faint">
        <span>{label}</span>
        <input
          value={fieldDrafts[draftKey] ?? value}
          onChange={(event) => {
            setDraftValue(draftKey, event.target.value);
            onCommit(event.target.value);
          }}
          onBlur={() => clearDraft(draftKey)}
          placeholder={placeholder}
          className={cn(
            "mt-0.5 w-full rounded-lg border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none placeholder:text-faint focus:border-brand/40",
            warn ? "border-amber-500/40" : "border-border",
          )}
        />
      </label>
    );
  }

  function roleCard(company: Company, role: Role, roleIndex: number) {
    const scope: Scope = { section: EXPERIENCE_SECTION, companyId: company.id, roleId: role.id };
    const roleFacts = role.facts ?? [];
    return (
      <div key={role.id} className="rounded-xl border border-border bg-surface/40 p-2.5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 grid gap-1.5 sm:grid-cols-2">
            {fieldInput({
              draftKey: `role:${role.id}:name`,
              value: role.name ?? "",
              placeholder: "Senior Engineer",
              label: "Role",
              onCommit: (value) => mutate(updateRoleField(profile, { companyId: company.id, roleId: role.id, field: "name", value }) as Profile),
              warn: !role.name,
            })}
            {/* The period is a picker, not a free-text field: it composes the
                stored string from start/end + "currently working here". */}
            <div>
              <PeriodField
                key={role.id}
                value={role.period ?? ""}
                onChange={(value) =>
                  mutate(updateRoleField(profile, { companyId: company.id, roleId: role.id, field: "period", value }) as Profile)
                }
              />
            </div>
            {fieldInput({
              draftKey: `role:${role.id}:location`,
              value: role.location ?? "",
              placeholder: "Remote",
              label: "Location",
              onCommit: (value) => mutate(updateRoleField(profile, { companyId: company.id, roleId: role.id, field: "location", value }) as Profile),
            })}
            <p className="self-end text-xs text-faint">
              {roleFacts.length} fact{roleFacts.length === 1 ? "" : "s"}
              {roleFacts.length === 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">no bullets yet</span>}
            </p>
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => mutate(moveRole(profile, { companyId: company.id, roleId: role.id, direction: "up" }) as Profile)}
              disabled={roleIndex === 0}
              aria-label="Move role up"
              className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
            >
              <ArrowUp className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => mutate(moveRole(profile, { companyId: company.id, roleId: role.id, direction: "down" }) as Profile)}
              disabled={roleIndex === (company.roles?.length ?? 1) - 1}
              aria-label="Move role down"
              className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!window.confirm(`Remove the role “${role.name || "untitled"}” and its ${roleFacts.length} fact(s)?`)) return;
                mutate(removeRole(profile, { companyId: company.id, roleId: role.id }) as Profile);
              }}
              aria-label="Delete role"
              className="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>

        <ul className="mt-2 space-y-1.5">{roleFacts.map((fact, index) => factRow(fact, scope, roleFacts, index))}</ul>
        {addFactForm(scope)}
      </div>
    );
  }

  function companyCard(company: Company, companyIndex: number) {
    const roles = company.roles ?? [];
    const companyFacts = roles.reduce((total, role) => total + (role.facts?.length ?? 0), 0);
    return (
      <article key={company.id} className="rounded-2xl border border-border bg-surface/30 p-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {fieldInput({
              draftKey: `company:${company.id}:name`,
              value: company.company?.name ?? "",
              placeholder: "Acme Inc.",
              label: "Company",
              onCommit: (value) => mutate(updateCompanyName(profile, { companyId: company.id, name: value }) as Profile),
              warn: !company.company?.name,
            })}
            <p className="mt-1 text-xs text-faint">
              {roles.length} role{roles.length === 1 ? "" : "s"} · {companyFacts} fact{companyFacts === 1 ? "" : "s"}
              {company.company?.evidence?.source ? ` · ${company.company.evidence.source}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => mutate(moveCompany(profile, { companyId: company.id, direction: "up" }) as Profile)}
              disabled={companyIndex === 0}
              aria-label="Move company up"
              className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
            >
              <ArrowUp className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => mutate(moveCompany(profile, { companyId: company.id, direction: "down" }) as Profile)}
              disabled={companyIndex === profile.experiences.length - 1}
              aria-label="Move company down"
              className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!window.confirm(`Remove “${company.company?.name || "untitled company"}” with its ${roles.length} role(s)?`)) return;
                mutate(removeCompany(profile, { companyId: company.id }) as Profile);
              }}
              aria-label="Delete company"
              className="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>

        <div className="mt-2 space-y-2">{roles.map((role, index) => roleCard(company, role, index))}</div>

        <button
          type="button"
          onClick={() => {
            const result = addRole(profile, { companyId: company.id, date: today() });
            if (!result.added) {
              setError("Could not add a role.");
              return;
            }
            setError("");
            mutate(result.profile as Profile);
          }}
          className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
        >
          <Plus className="size-3.5" /> Add role to {company.company?.name || "this company"}
        </button>
      </article>
    );
  }

  function labelledEntryCard(entry: Entry, index: number) {
    const scope: Scope = { section, entryId: entry.id };
    const entryFacts = entry.facts ?? [];
    return (
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
              <h2 className="text-sm font-medium text-foreground">{entry.label}</h2>
            )}
            <p className="mt-0.5 text-xs text-faint">
              {entryFacts.length} fact{entryFacts.length === 1 ? "" : "s"}
              {entry.evidence?.source ? ` · ${entry.evidence.source}` : ""}
            </p>
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
              disabled={index === 0}
              aria-label="Move up"
              className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
            >
              <ArrowUp className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => mutate(moveEntry(profile, { section, entryId: entry.id, direction: "down" }) as Profile)}
              disabled={index === (profile[section as "projects" | "education"]?.length ?? 1) - 1}
              aria-label="Move down"
              className="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
            >
              <ArrowDown className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!window.confirm(`Remove “${entry.label}” and its ${entryFacts.length} fact(s)?`)) return;
                mutate(removeEntry(profile, { section, entryId: entry.id }) as Profile);
              }}
              aria-label={`Delete ${entry.label}`}
              className="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        </div>

        <ul className="mt-2 space-y-1.5">{entryFacts.map((fact, i) => factRow(fact, scope, entryFacts, i))}</ul>
        {addFactForm(scope)}
      </article>
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
            Everything you have done, kept in one place with the source it came from. One card per employer, roles nested inside it, facts under each role — those facts
            are what a CV is built from later.
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
              const count = counts[key] ?? { entries: 0, facts: 0 };
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
                    {key === EXPERIENCE_SECTION ? `${count.entries} · ${count.roles ?? 0} · ${count.facts}` : count.facts}
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

            {FLAT_SECTIONS.includes(section) && (
              <>
                <ul className="mt-3 space-y-1.5">
                  {(profile[section as "summary" | "certifications" | "skills"] ?? []).map((fact, index, list) =>
                    factRow(fact, { section }, list, index),
                  )}
                </ul>
                {addFactForm({ section })}
              </>
            )}

            {section === EXPERIENCE_SECTION && (
              <div className="mt-3 space-y-3">
                {profile.experiences.map((company, index) => companyCard(company, index))}

                <div className="flex items-start gap-2 rounded-2xl border border-dashed border-border p-3">
                  <input
                    value={newCompany}
                    onChange={(event) => setNewCompany(event.target.value)}
                    placeholder="Add an employer — company name…"
                    className="flex-1 rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-brand/40"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const result = addCompany(profile, { name: newCompany, date: today() });
                      if (!result.added) {
                        setError(result.reason === "duplicate" ? "That company is already in the list." : "Nothing to add.");
                        return;
                      }
                      setError("");
                      setNewCompany("");
                      mutate(result.profile as Profile);
                    }}
                    disabled={!newCompany.trim()}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50 max-sm:min-h-[44px]"
                  >
                    <Plus className="size-4" /> Add company
                  </button>
                </div>
              </div>
            )}

            {LABEL_SECTIONS.includes(section) && (
              <div className="mt-3 space-y-3">
                {(profile[section as "projects" | "education"] ?? []).map((entry, index) => labelledEntryCard(entry, index))}

                <div className="flex items-start gap-2 rounded-2xl border border-dashed border-border p-3">
                  <input
                    value={newEntry}
                    onChange={(event) => setNewEntry(event.target.value)}
                    placeholder={`New ${SECTION_LABEL[section].toLowerCase()} entry…`}
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
