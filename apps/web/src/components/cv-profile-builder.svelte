<script lang="ts">
  import { onMount } from "svelte";
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
  } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import PeriodField from "@/components/period-field.svelte";
  import {
    EXPERIENCE_SECTION,
    FLAT_SECTIONS,
    LABEL_SECTIONS,
    addCompany,
    addEntry,
    addFact,
    addRole,
    ensureShape,
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
    type CareerProfile,
    type ProfileCompany,
    type ProfileEvidence,
    type ProfileFact,
    type ProfileLabeledEntry,
    type ProfileRole,
  } from "@/lib/cv-profile.ts";

  // The builder edits the SAME schema the module's functions do. Local
  // lookalike types drifted from it (optional evidence/facts) and made every
  // mutation call unassignable the moment the module gained real types.
  type Fact = ProfileFact;
  type Evidence = ProfileEvidence;
  type Role = ProfileRole;
  type Company = ProfileCompany;
  type Entry = ProfileLabeledEntry;
  type Profile = CareerProfile;

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

  type FlatSection = "summary" | "certifications" | "skills";
  type LabelSection = "projects" | "education";

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

  let loaded = $state<Loaded | null>(null);
  let profile = $state<Profile>(ensureShape(null) as Profile);
  let fingerprint = $state<string | null>(null);
  let section = $state<string>("summary");
  let dirty = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state("");
  let errors = $state<string[]>([]);
  let editingFact = $state<string | null>(null);
  let draft = $state("");
  let editingEntry = $state<string | null>(null);
  let entryDraft = $state("");
  // Raw text of a field while it is being typed into. The stored value is
  // normalized on every change, and a trailing space is exactly what you type
  // between two words — without this the space never reaches the box.
  let fieldDrafts = $state<Record<string, string>>({});
  let newFact = $state("");
  let newEntry = $state("");
  let newCompany = $state("");

  async function load(): Promise<void> {
    try {
      const res = await fetch("/api/cv/profile");
      const body = (await res.json()) as Loaded & { error?: string };
      if (!res.ok) {
        error = body.error ?? "Could not read the career profile.";
        return;
      }
      loaded = body;
      profile = body.profile;
      fingerprint = body.fingerprint;
      errors = body.validation?.errors ?? [];
      dirty = false;
    } catch {
      error = "Couldn’t reach the server.";
    }
  }

  onMount(() => {
    void load();
  });

  $effect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  });

  function mutate(next: Profile): void {
    if (next === profile) return;
    profile = next;
    dirty = true;
    saved = false;
  }

  async function save(): Promise<void> {
    saving = true;
    error = "";
    errors = [];
    try {
      const res = await fetch("/api/cv/profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile, fingerprint }),
      });
      const body = (await res.json()) as { error?: string; errors?: string[]; fingerprint?: string | null };
      if (!res.ok) {
        error = body.error ?? "Save failed.";
        errors = body.errors ?? [];
        return;
      }
      fingerprint = body.fingerprint ?? null;
      dirty = false;
      saved = true;
      setTimeout(() => (saved = false), 2000);
      await load();
    } catch {
      error = "Couldn’t reach the server.";
    } finally {
      saving = false;
    }
  }

  const counts = $derived(profileCounts(profile) as Counts);
  const facts = $derived(totalFacts(profile) as number);
  const unverified = $derived(unverifiedCount(profile) as number);
  // The two section lists the active tab renders. Narrowed here rather than in
  // the markup: a cast inside an `{#each}` expression is not valid Svelte, and
  // `{#each}` offers no third "the list itself" argument to hand to a row.
  const flatFacts = $derived((FLAT_SECTIONS.includes(section) ? (profile[section as FlatSection] ?? []) : []) as Fact[]);
  const labelEntries = $derived((LABEL_SECTIONS.includes(section) ? (profile[section as LabelSection] ?? []) : []) as Entry[]);

  function setDraftValue(key: string, value: string): void {
    fieldDrafts = { ...fieldDrafts, [key]: value };
  }
  function clearDraft(key: string): void {
    const next = { ...fieldDrafts };
    delete next[key];
    fieldDrafts = next;
  }

  /** The options one draft-aware profile field takes. */
  type FieldInput = {
    draftKey: string;
    value: string;
    placeholder: string;
    label: string;
    onCommit: (value: string) => void;
    warn?: boolean;
  };
</script>

{#snippet factRow(fact: Fact, scope: Scope, list: Fact[], index: number)}
  {@const isEditing = editingFact === fact.id}
  <li class="rounded-xl border border-border bg-surface/60 px-3 py-2">
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        {#if isEditing}
          <div>
            <textarea
              value={draft}
              oninput={(event) => (draft = event.currentTarget.value)}
              rows="3"
              class="w-full resize-y rounded-lg border border-border bg-surface p-2 text-sm leading-relaxed outline-none focus:border-brand/40"
            ></textarea>
            <div class="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onclick={() => {
                  mutate(updateFactText(profile, { ...scope, factId: fact.id, text: draft }) as Profile);
                  editingFact = null;
                }}
                class="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200"
              >
                Use this wording
              </button>
              <button
                type="button"
                onclick={() => (editingFact = null)}
                class="inline-flex items-center gap-1 rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
              >
                <Undo2 class="size-3" /> Cancel
              </button>
            </div>
          </div>
        {:else}
          <p class="text-sm text-foreground/90">{fact.text}</p>
          <p class="mt-0.5 truncate text-xs text-faint" title={fact.evidence?.quote}>
            {fact.evidence?.source}
            {fact.evidence?.line ? `:${fact.evidence.line}` : ""}
            {#if fact.review_status !== "verified"}<span class="ml-2 text-amber-600 dark:text-amber-400">needs review</span>{/if}
          </p>
        {/if}
      </div>

      {#if !isEditing}
        <div class="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onclick={() => {
              editingFact = fact.id;
              draft = fact.text;
            }}
            aria-label={`Reword: ${fact.text.slice(0, 40)}`}
            class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
          >
            <Pencil class="size-3.5" />
          </button>
          <button
            type="button"
            onclick={() =>
              mutate(
                setFactStatus(profile, {
                  ...scope,
                  factId: fact.id,
                  status: fact.review_status === "verified" ? "needs_review" : "verified",
                }) as Profile,
              )}
            aria-label={fact.review_status === "verified" ? "Mark for review" : "Mark verified"}
            class={cn(
              "rounded-full border p-1.5 transition-colors",
              fact.review_status === "verified" ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400" : "border-amber-500/50 text-amber-600 dark:text-amber-400",
            )}
          >
            <Check class="size-3.5" />
          </button>
          <button
            type="button"
            onclick={() => mutate(moveFact(profile, { ...scope, factId: fact.id, direction: "up" }) as Profile)}
            disabled={index === 0}
            aria-label="Move up"
            class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
          >
            <ArrowUp class="size-3.5" />
          </button>
          <button
            type="button"
            onclick={() => mutate(moveFact(profile, { ...scope, factId: fact.id, direction: "down" }) as Profile)}
            disabled={index === list.length - 1}
            aria-label="Move down"
            class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
          >
            <ArrowDown class="size-3.5" />
          </button>
          <button
            type="button"
            onclick={() => mutate(removeFact(profile, { ...scope, factId: fact.id }) as Profile)}
            aria-label={`Delete: ${fact.text.slice(0, 40)}`}
            class="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
          >
            <Trash2 class="size-3.5" />
          </button>
        </div>
      {/if}
    </div>
  </li>
{/snippet}

{#snippet addFactForm(scope: Scope)}
  <div class="mt-2 flex items-start gap-2">
    <textarea
      value={newFact}
      oninput={(event) => (newFact = event.currentTarget.value)}
      rows="2"
      placeholder="Record something you did — one fact per line…"
      class="flex-1 resize-y rounded-xl border border-border bg-surface/50 p-2.5 text-sm leading-relaxed outline-none placeholder:text-faint focus:border-brand/40"
    ></textarea>
    <button
      type="button"
      onclick={() => {
        const result = addFact(profile, { ...scope, text: newFact, date: today() });
        if (!result.added) {
          error = result.reason === "duplicate" ? "That fact is already in this scope." : "Nothing to add.";
          return;
        }
        error = "";
        newFact = "";
        mutate(result.profile as Profile);
      }}
      disabled={!newFact.trim()}
      class="inline-flex items-center gap-1.5 rounded-full bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand-200 disabled:opacity-50 max-sm:min-h-[44px]"
    >
      <Plus class="size-4" /> Add
    </button>
  </div>
{/snippet}

{#snippet fieldInput(options: FieldInput)}
  {@const { draftKey, value, placeholder, label, onCommit, warn } = options}
  <label class="text-xs text-faint">
    <span>{label}</span>
    <input
      value={fieldDrafts[draftKey] ?? value}
      oninput={(event) => {
        setDraftValue(draftKey, event.currentTarget.value);
        onCommit(event.currentTarget.value);
      }}
      onblur={() => clearDraft(draftKey)}
      {placeholder}
      class={cn(
        "mt-0.5 w-full rounded-lg border bg-surface/60 px-2 py-1 text-xs text-foreground outline-none placeholder:text-faint focus:border-brand/40",
        warn ? "border-amber-500/40" : "border-border",
      )}
    />
  </label>
{/snippet}

{#snippet roleCard(company: Company, role: Role, roleIndex: number)}
  {@const scope: Scope = { section: EXPERIENCE_SECTION, companyId: company.id, roleId: role.id }}
  {@const roleFacts = role.facts ?? []}
  <div class="rounded-xl border border-border bg-surface/40 p-2.5">
    <div class="flex items-start gap-2">
      <div class="min-w-0 flex-1 grid gap-1.5 sm:grid-cols-2">
        {@render fieldInput({
          draftKey: `role:${role.id}:name`,
          value: role.name ?? "",
          placeholder: "Senior Engineer",
          label: "Role",
          onCommit: (value) => mutate(updateRoleField(profile, { companyId: company.id, roleId: role.id, field: "name", value }) as Profile),
          warn: !role.name,
        })}
        <!-- The period is a picker, not a free-text field: it composes the
             stored string from start/end + "currently working here". -->
        <div>
          {#key role.id}
            <PeriodField
              value={role.period ?? ""}
              onChange={(value) => mutate(updateRoleField(profile, { companyId: company.id, roleId: role.id, field: "period", value }) as Profile)}
            />
          {/key}
        </div>
        {@render fieldInput({
          draftKey: `role:${role.id}:location`,
          value: role.location ?? "",
          placeholder: "Remote",
          label: "Location",
          onCommit: (value) => mutate(updateRoleField(profile, { companyId: company.id, roleId: role.id, field: "location", value }) as Profile),
        })}
        <p class="self-end text-xs text-faint">
          {roleFacts.length} fact{roleFacts.length === 1 ? "" : "s"}
          {#if roleFacts.length === 0}<span class="ml-1 text-amber-600 dark:text-amber-400">no bullets yet</span>{/if}
        </p>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onclick={() => mutate(moveRole(profile, { companyId: company.id, roleId: role.id, direction: "up" }) as Profile)}
          disabled={roleIndex === 0}
          aria-label="Move role up"
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
        >
          <ArrowUp class="size-3.5" />
        </button>
        <button
          type="button"
          onclick={() => mutate(moveRole(profile, { companyId: company.id, roleId: role.id, direction: "down" }) as Profile)}
          disabled={roleIndex === (company.roles?.length ?? 1) - 1}
          aria-label="Move role down"
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
        >
          <ArrowDown class="size-3.5" />
        </button>
        <button
          type="button"
          onclick={() => {
            if (!window.confirm(`Remove the role “${role.name || "untitled"}” and its ${roleFacts.length} fact(s)?`)) return;
            mutate(removeRole(profile, { companyId: company.id, roleId: role.id }) as Profile);
          }}
          aria-label="Delete role"
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>
    </div>

    <ul class="mt-2 space-y-1.5">
      {#each roleFacts as fact, index (fact.id)}
        {@render factRow(fact, scope, roleFacts, index)}
      {/each}
    </ul>
    {@render addFactForm(scope)}
  </div>
{/snippet}

{#snippet companyCard(company: Company, companyIndex: number)}
  {@const roles = company.roles ?? []}
  {@const companyFacts = roles.reduce((total, role) => total + (role.facts?.length ?? 0), 0)}
  <article class="rounded-2xl border border-border bg-surface/30 p-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        {@render fieldInput({
          draftKey: `company:${company.id}:name`,
          value: company.company?.name ?? "",
          placeholder: "Acme Inc.",
          label: "Company",
          onCommit: (value) => mutate(updateCompanyName(profile, { companyId: company.id, name: value }) as Profile),
          warn: !company.company?.name,
        })}
        <p class="mt-1 text-xs text-faint">
          {roles.length} role{roles.length === 1 ? "" : "s"} · {companyFacts} fact{companyFacts === 1 ? "" : "s"}
          {company.company?.evidence?.source ? ` · ${company.company.evidence.source}` : ""}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onclick={() => mutate(moveCompany(profile, { companyId: company.id, direction: "up" }) as Profile)}
          disabled={companyIndex === 0}
          aria-label="Move company up"
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
        >
          <ArrowUp class="size-3.5" />
        </button>
        <button
          type="button"
          onclick={() => mutate(moveCompany(profile, { companyId: company.id, direction: "down" }) as Profile)}
          disabled={companyIndex === profile.experiences.length - 1}
          aria-label="Move company down"
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
        >
          <ArrowDown class="size-3.5" />
        </button>
        <button
          type="button"
          onclick={() => {
            if (!window.confirm(`Remove “${company.company?.name || "untitled company"}” with its ${roles.length} role(s)?`)) return;
            mutate(removeCompany(profile, { companyId: company.id }) as Profile);
          }}
          aria-label="Delete company"
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>
    </div>

    <div class="mt-2 space-y-2">
      {#each roles as role, index (role.id)}
        {@render roleCard(company, role, index)}
      {/each}
    </div>

    <button
      type="button"
      onclick={() => {
        const result = addRole(profile, { companyId: company.id, date: today() });
        if (!result.added) {
          error = "Could not add a role.";
          return;
        }
        error = "";
        mutate(result.profile as Profile);
      }}
      class="mt-2 inline-flex items-center gap-1.5 rounded-full border border-dashed border-border px-3 py-1.5 text-xs text-muted transition-colors hover:text-foreground"
    >
      <Plus class="size-3.5" /> Add role to {company.company?.name || "this company"}
    </button>
  </article>
{/snippet}

{#snippet labelledEntryCard(entry: Entry, index: number)}
  {@const scope: Scope = { section, entryId: entry.id }}
  {@const entryFacts = entry.facts ?? []}
  <article class="rounded-2xl border border-border bg-surface/30 p-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        {#if editingEntry === entry.id}
          <div>
            <input
              value={entryDraft}
              oninput={(event) => (entryDraft = event.currentTarget.value)}
              class="w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-sm outline-none focus:border-brand/40"
            />
            <div class="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onclick={() => {
                  if (entryDraft.trim()) mutate(updateEntryLabel(profile, { section, entryId: entry.id, label: entryDraft }) as Profile);
                  editingEntry = null;
                }}
                class="rounded-full bg-brand px-3 py-1 text-xs font-medium text-brand-foreground transition-colors hover:bg-brand-200"
              >
                Rename
              </button>
              <button
                type="button"
                onclick={() => (editingEntry = null)}
                class="rounded-full border border-border px-3 py-1 text-xs text-muted transition-colors hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          </div>
        {:else}
          <h2 class="text-sm font-medium text-foreground">{entry.label}</h2>
        {/if}
        <p class="mt-0.5 text-xs text-faint">
          {entryFacts.length} fact{entryFacts.length === 1 ? "" : "s"}
          {entry.evidence?.source ? ` · ${entry.evidence.source}` : ""}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onclick={() => {
            editingEntry = entry.id;
            entryDraft = entry.label;
          }}
          aria-label={`Rename ${entry.label}`}
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground"
        >
          <Pencil class="size-3.5" />
        </button>
        <button
          type="button"
          onclick={() => mutate(moveEntry(profile, { section, entryId: entry.id, direction: "up" }) as Profile)}
          disabled={index === 0}
          aria-label="Move up"
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
        >
          <ArrowUp class="size-3.5" />
        </button>
        <button
          type="button"
          onclick={() => mutate(moveEntry(profile, { section, entryId: entry.id, direction: "down" }) as Profile)}
          disabled={index === (profile[section as "projects" | "education"]?.length ?? 1) - 1}
          aria-label="Move down"
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:text-foreground disabled:opacity-30"
        >
          <ArrowDown class="size-3.5" />
        </button>
        <button
          type="button"
          onclick={() => {
            if (!window.confirm(`Remove “${entry.label}” and its ${entryFacts.length} fact(s)?`)) return;
            mutate(removeEntry(profile, { section, entryId: entry.id }) as Profile);
          }}
          aria-label={`Delete ${entry.label}`}
          class="rounded-full border border-border p-1.5 text-muted transition-colors hover:border-red-500/40 hover:text-red-600 dark:hover:text-red-400"
        >
          <Trash2 class="size-3.5" />
        </button>
      </div>
    </div>

    <ul class="mt-2 space-y-1.5">
      {#each entryFacts as fact, i (fact.id)}
        {@render factRow(fact, scope, entryFacts, i)}
      {/each}
    </ul>
    {@render addFactForm(scope)}
  </article>
{/snippet}

<div class="mx-auto max-w-6xl px-6 py-8">
  <a href="/cv" class="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground">
    <ArrowLeft class="size-4" /> CV editor
  </a>

  <div class="mt-3 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="font-display text-2xl tracking-tight text-landing">Career profile</h1>
      <p class="mt-1 max-w-2xl text-sm text-muted">
        Everything you have done, kept in one place with the source it came from. One card per employer, roles nested inside it, facts under each role — those facts
        are what a CV is built from later.
        {#if dirty}<span class="ml-1 text-amber-600 dark:text-amber-400">Unsaved changes.</span>{/if}
      </p>
    </div>
    <div class="flex items-center gap-2">
      <a
        href="/cv/generate"
        class="inline-flex items-center gap-1.5 rounded-full bg-brand-soft px-4 py-2 text-sm font-medium text-brand-text transition-colors hover:bg-brand-soft/70 max-sm:min-h-[44px]"
      >
        <Sparkles class="size-4" /> Generate CV
      </a>
      <a
        href="/cv/import"
        class="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground max-sm:min-h-[44px]"
      >
        <Upload class="size-4" /> Import from cv.md
      </a>
      <button
        type="button"
        onclick={() => void save()}
        disabled={saving || !dirty}
        class={cn(
          "inline-flex items-center justify-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
          dirty ? "bg-brand text-brand-foreground hover:bg-brand-200" : "border border-border bg-surface text-muted",
        )}
      >
        {#if saving}<Loader2 class="size-4 animate-spin" />{:else if saved}<Check class="size-4" />{/if}
        {saved ? "Saved" : "Save profile"}
      </button>
    </div>
  </div>

  {#if error}
    <div role="alert" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-600 dark:text-red-400">
      {error}
      {#if errors.length > 0}
        <ul class="mt-1 list-disc pl-4 text-xs">
          {#each errors as line (line)}
            <li>{line}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if loaded && loaded.validation.checked && !loaded.validation.valid}
    <div class="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
      <span class="inline-flex items-center gap-1.5">
        <CircleAlert class="size-4" /> The core’s validator rejects what is on disk right now ({loaded.validation.errors.length} error
        {loaded.validation.errors.length === 1 ? "" : "s"}). Fix it here and save.
      </span>
    </div>
  {/if}

  {#if !loaded}
    <div class="mt-8 flex items-center gap-2 text-sm text-muted">
      <Loader2 class="size-4 animate-spin" /> Reading career-profile.yml…
    </div>
  {:else}
    <div class="mt-6 grid gap-4 lg:grid-cols-[220px_1fr]">
      <nav aria-label="Profile sections" class="space-y-1">
        {#each Object.keys(SECTION_LABEL) as key (key)}
          {@const count = counts[key] ?? { entries: 0, facts: 0 }}
          <button
            type="button"
            onclick={() => (section = key)}
            class={cn(
              "flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-sm transition-colors",
              section === key ? "bg-brand-soft text-brand-text" : "text-muted hover:bg-surface-hover hover:text-foreground",
            )}
          >
            <span>{SECTION_LABEL[key]}</span>
            <span class="text-xs text-faint">
              {key === EXPERIENCE_SECTION ? `${count.entries} · ${count.roles ?? 0} · ${count.facts}` : count.facts}
            </span>
          </button>
        {/each}

        <div class="mt-3 rounded-xl border border-border px-3 py-2 text-xs text-faint">
          <p>
            {facts} fact{facts === 1 ? "" : "s"} recorded
          </p>
          {#if unverified > 0}<p class="mt-1 text-amber-600 dark:text-amber-400">{unverified} still need review</p>{/if}
          {#if !loaded.exists}<p class="mt-1">No profile file yet — saving creates it.</p>{/if}
        </div>
      </nav>

      <section>
        <p class="text-sm text-muted">{SECTION_HINT[section]}</p>

        {#if FLAT_SECTIONS.includes(section)}
          <ul class="mt-3 space-y-1.5">
            {#each flatFacts as fact, index (fact.id)}
              {@render factRow(fact, { section }, flatFacts, index)}
            {/each}
          </ul>
          {@render addFactForm({ section })}
        {/if}

        {#if section === EXPERIENCE_SECTION}
          <div class="mt-3 space-y-3">
            {#each profile.experiences as company, index (company.id)}
              {@render companyCard(company, index)}
            {/each}

            <div class="flex items-start gap-2 rounded-2xl border border-dashed border-border p-3">
              <input
                value={newCompany}
                oninput={(event) => (newCompany = event.currentTarget.value)}
                placeholder="Add an employer — company name…"
                class="flex-1 rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-brand/40"
              />
              <button
                type="button"
                onclick={() => {
                  const result = addCompany(profile, { name: newCompany, date: today() });
                  if (!result.added) {
                    error = result.reason === "duplicate" ? "That company is already in the list." : "Nothing to add.";
                    return;
                  }
                  error = "";
                  newCompany = "";
                  mutate(result.profile as Profile);
                }}
                disabled={!newCompany.trim()}
                class="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50 max-sm:min-h-[44px]"
              >
                <Plus class="size-4" /> Add company
              </button>
            </div>
          </div>
        {/if}

        {#if LABEL_SECTIONS.includes(section)}
          <div class="mt-3 space-y-3">
            {#each labelEntries as entry, index (entry.id)}
              {@render labelledEntryCard(entry, index)}
            {/each}

            <div class="flex items-start gap-2 rounded-2xl border border-dashed border-border p-3">
              <input
                value={newEntry}
                oninput={(event) => (newEntry = event.currentTarget.value)}
                placeholder={`New ${SECTION_LABEL[section].toLowerCase()} entry…`}
                class="flex-1 rounded-lg border border-border bg-surface/50 px-3 py-2 text-sm outline-none placeholder:text-faint focus:border-brand/40"
              />
              <button
                type="button"
                onclick={() => {
                  const result = addEntry(profile, { section, label: newEntry, date: today() });
                  if (!result.added) {
                    error = result.reason === "duplicate" ? "That entry already exists." : "Nothing to add.";
                    return;
                  }
                  error = "";
                  newEntry = "";
                  mutate(result.profile as Profile);
                }}
                disabled={!newEntry.trim()}
                class="inline-flex items-center gap-1.5 rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50 max-sm:min-h-[44px]"
              >
                <Plus class="size-4" /> Add entry
              </button>
            </div>
          </div>
        {/if}
      </section>
    </div>
  {/if}
</div>
