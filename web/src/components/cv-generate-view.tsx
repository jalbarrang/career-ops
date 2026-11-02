"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CircleAlert, Download, Eye, Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { allRoles } from "@/lib/cv-profile.mjs";

type Fact = { id: string; text: string; review_status?: string };
type Role = { id: string; name?: string; period?: string; location?: string; facts?: Fact[] };
type Company = { id: string; company?: { name?: string }; roles?: Role[] };
type Entry = { id: string; label: string; facts?: Fact[] };
type RoleRef = { company: Company; role: Role };
const pickableRoles = (profile: Profile) => allRoles(profile) as RoleRef[];

type Profile = {
  summary: Fact[];
  experiences: Company[];
  projects: Entry[];
  education: Entry[];
  certifications: Fact[];
  skills: Fact[];
};

type Gap = { entryId: string; label?: string; reason: string; missing?: string[] };

type Result = {
  ok?: boolean;
  html?: string;
  htmlPath?: string;
  pdfPath?: string;
  messages?: string[];
  gaps?: Gap[];
  warnings?: string[];
  counts?: { summary: number; experience: number; bullets: number; skills: number };
  error?: string;
  details?: string[];
};

export function CvGenerateView() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [label, setLabel] = useState("");
  const [summaryIds, setSummaryIds] = useState<string[]>([]);
  const [entryFacts, setEntryFacts] = useState<Record<string, string[]>>({});
  const [skillIds, setSkillIds] = useState<string[]>([]);

  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"html" | "pdf" | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cv/profile");
      const body = (await res.json()) as { profile?: Profile; error?: string };
      if (!res.ok || !body.profile) {
        setError(body.error ?? "Could not read the career profile.");
        return;
      }
      setProfile(body.profile);
      // Start with the newest role pre-selected, and everything under it — the
      // common case is "the top of my history", not an empty grid.
      // v2: roles live under companies, so the first selectable thing is a role.
      const firstCompany = body.profile.experiences?.[0];
      const firstRole = firstCompany?.roles?.[0];
      if (firstRole) {
        setEntryFacts({ [firstRole.id]: (firstRole.facts ?? []).map((fact) => fact.id) });
        setLabel([firstCompany?.company?.name, firstRole.name].filter(Boolean).join(' — ') || 'cv');
      }
    } catch {
      setError("Couldn’t reach the server.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selection = useMemo(
    () => ({
      summaryIds,
      experiences: Object.entries(entryFacts)
        .filter(([, factIds]) => factIds.length > 0)
        .map(([entryId, factIds]) => ({ entryId, factIds })),
      skills: skillIds,
    }),
    [summaryIds, entryFacts, skillIds],
  );

  const bulletCount = Object.values(entryFacts).reduce((total, factIds) => total + factIds.length, 0);

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }

  async function generate(format: "html" | "pdf") {
    setBusy(format);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/cv/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection, label, format }),
      });
      const body = (await res.json()) as Result;
      setResult(body);
      if (!res.ok) setError(body.error ?? "Generation failed.");
    } catch {
      setError("Couldn’t reach the server.");
    } finally {
      setBusy(null);
    }
  }

  const gaps = result?.gaps ?? [];
  const warnings = result?.warnings ?? [];

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <Link href="/cv/profile" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> Career profile
      </Link>

      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl tracking-tight text-landing">Generate a CV</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Pick what goes in, then render it through the same builders the CLI uses. The payload is validated by <code className="text-foreground">build-cv-html.mjs</code>{" "}
            and the PDF runs the fact gate — neither is bypassed here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void generate("html")}
            disabled={busy !== null || bulletCount === 0}
            className="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50 max-sm:min-h-[44px]"
          >
            {busy === "html" ? <Loader2 className="size-4 animate-spin" /> : <Eye className="size-4" />} Preview
          </button>
          <button
            type="button"
            onClick={() => void generate("pdf")}
            disabled={busy !== null || bulletCount === 0}
            className={cn(
              "inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
              bulletCount > 0 ? "bg-brand text-brand-foreground hover:bg-brand-200" : "border border-border bg-surface text-muted",
            )}
          >
            {busy === "pdf" ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />} Render PDF
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-600 dark:text-red-400">
          {error}
          {result?.details && result.details.length > 0 && (
            <ul className="mt-1 space-y-0.5 font-mono text-xs">
              {result.details.map((line) => (
                <li key={line} className="break-words">
                  {line}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {gaps.length > 0 && (
        <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          <p className="inline-flex items-center gap-1.5 font-medium">
            <CircleAlert className="size-4" /> {gaps.length} selected role{gaps.length === 1 ? "" : "s"} cannot render
          </p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {gaps.map((gap) => (
              <li key={gap.entryId}>
                {gap.label ?? gap.entryId} — {gap.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-xl border border-border bg-surface/40 px-4 py-2 text-xs text-muted">
          {warnings.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}

      {result?.pdfPath && (
        <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-400">
          PDF written to <code>{result.pdfPath}</code>
          {result.htmlPath && <span className="ml-1 text-xs text-faint">· HTML: {result.htmlPath}</span>}
        </p>
      )}

      {!profile && loading && (
        <div className="mt-8 flex items-center gap-2 text-sm text-muted">
          <Loader2 className="size-4 animate-spin" /> Reading career-profile.yml…
        </div>
      )}

      {profile && (
        <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <div className="space-y-3">
            <label className="block text-sm text-muted">
              Name this CV after the posting
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="acme-senior-engineer"
                className="mt-1 w-full rounded-xl border border-border bg-surface/50 px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-brand/40"
              />
            </label>

            {profile.summary.length > 0 && (
              <section className="rounded-2xl border border-border bg-surface/30 p-3">
                <h2 className="text-sm font-medium text-foreground">Summary</h2>
                <ul className="mt-2 space-y-1">
                  {profile.summary.map((fact) => (
                    <li key={fact.id}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1 text-xs text-muted hover:bg-surface-hover">
                        <input
                          type="checkbox"
                          checked={summaryIds.includes(fact.id)}
                          onChange={() => setSummaryIds((current) => toggle(current, fact.id))}
                          className="mt-0.5 accent-[var(--color-brand)]"
                        />
                        <span className="text-foreground/90">{fact.text}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section className="rounded-2xl border border-border bg-surface/30 p-3">
              <h2 className="text-sm font-medium text-foreground">Roles</h2>
              {pickableRoles(profile).length === 0 && <p className="mt-1 text-xs text-faint">No roles recorded yet.</p>}
              <ul className="mt-2 space-y-2">
                {pickableRoles(profile).map(({ company, role: entry }) => {
                  const employer = company.company?.name ?? '';
                  const picked = entryFacts[entry.id] ?? [];
                  const canRender = Boolean(employer && entry.name);
                  return (
                    <li key={entry.id} className={cn("rounded-xl border p-2", picked.length > 0 ? "border-brand/40 bg-brand-soft/30" : "border-border")}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-foreground">{[entry.name || "(untitled role)", employer].filter(Boolean).join(" · ")}</p>
                          <p className="text-xs text-faint">
                            {canRender ? `${entry.period ?? "no dates"}` : "needs a company and a role name in the profile builder"}
                            {!canRender && <span className="ml-1 text-amber-600 dark:text-amber-400">·</span>}
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setEntryFacts((current) => {
                              const next = { ...current };
                              if (picked.length > 0) delete next[entry.id];
                              else next[entry.id] = (entry.facts ?? []).map((fact) => fact.id);
                              return next;
                            })
                          }
                          className={cn(
                            "shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors",
                            picked.length > 0 ? "border-brand/50 text-brand-text" : "border-border text-muted hover:text-foreground",
                          )}
                        >
                          {picked.length > 0 ? `${picked.length} selected` : "Include all"}
                        </button>
                      </div>

                      {picked.length > 0 && (entry.facts?.length ?? 0) > 0 && (
                        <ul className="mt-1.5 space-y-0.5 border-l border-border pl-2">
                          {(entry.facts ?? []).map((fact) => (
                            <li key={fact.id}>
                              <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-hover">
                                <input
                                  type="checkbox"
                                  checked={picked.includes(fact.id)}
                                  onChange={() =>
                                    setEntryFacts((current) => {
                                      const list = current[entry.id] ?? [];
                                      const next = toggle(list, fact.id);
                                      const copy = { ...current };
                                      if (next.length > 0) copy[entry.id] = next;
                                      else delete copy[entry.id];
                                      return copy;
                                    })
                                  }
                                  className="mt-0.5 accent-[var(--color-brand)]"
                                />
                                <span className="text-foreground/80">{fact.text}</span>
                              </label>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>

            {profile.skills.length > 0 && (
              <section className="rounded-2xl border border-border bg-surface/30 p-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-medium text-foreground">Skills</h2>
                  <button
                    type="button"
                    onClick={() => setSkillIds(skillIds.length === profile.skills.length ? [] : profile.skills.map((fact) => fact.id))}
                    className="text-xs text-muted transition-colors hover:text-foreground"
                  >
                    {skillIds.length === profile.skills.length ? "Clear" : "Select all"}
                  </button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {profile.skills.map((fact) => (
                    <button
                      key={fact.id}
                      type="button"
                      onClick={() => setSkillIds((current) => toggle(current, fact.id))}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs transition-colors",
                        skillIds.includes(fact.id) ? "border-brand/50 bg-brand-soft text-brand-text" : "border-border text-muted hover:text-foreground",
                      )}
                    >
                      {fact.text}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <p className="text-xs text-faint">
              {Object.keys(entryFacts).length} role{Object.keys(entryFacts).length === 1 ? "" : "s"} · {bulletCount} bullet{bulletCount === 1 ? "" : "s"} ·{" "}
              {skillIds.length} skill{skillIds.length === 1 ? "" : "s"}
            </p>
          </div>

          <div className="rounded-2xl border border-border bg-surface/30">
            <div className="border-b border-border px-3 py-2 text-xs text-faint">Preview</div>
            {result?.html ? (
              // The template's own `.page` rule is `width: 100%; max-width:
              // {{PAGE_WIDTH}}`, so the sheet reflows to this panel. Rendered at
              // panel width rather than scaled: scaling a fixed-width sheet into
              // an unknown column is what clipped the right edge twice while this
              // was being built, and a preview that hides content is worse than
              // one whose line breaks differ from the PDF's.
              <iframe
                title="CV preview"
                srcDoc={result.html}
                sandbox=""
                className="h-[70vh] w-full rounded-b-2xl border-0 bg-white"
              />
            ) : (
              <div className="flex h-[70vh] items-center justify-center px-6 text-center text-sm text-muted">
                {result?.pdfPath ? "PDF rendered — open the file above." : "Pick what goes in, then press Preview."}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
