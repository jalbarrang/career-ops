<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowLeft, CircleAlert, Download, Eye, Loader2 } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import { allRoles } from "@/lib/cv-profile.ts";

  type Fact = { id: string; text: string; review_status?: string };
  type Role = { id: string; name?: string; period?: string; location?: string; facts?: Fact[] };
  type Company = { id: string; company?: { name?: string }; roles?: Role[] };
  type Entry = { id: string; label: string; facts?: Fact[] };
  type RoleRef = { company: Company; role: Role };

  type Profile = {
    summary: Fact[];
    experiences: Company[];
    projects: Entry[];
    education: Entry[];
    certifications: Fact[];
    skills: Fact[];
  };

  const pickableRoles = (profile: Profile) => allRoles(profile) as RoleRef[];

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

  let profile = $state<Profile | null>(null);
  let error = $state("");
  let loading = $state(true);

  let label = $state("");
  let summaryIds = $state<string[]>([]);
  let entryFacts = $state<Record<string, string[]>>({});
  let skillIds = $state<string[]>([]);

  let result = $state<Result | null>(null);
  let busy = $state<"html" | "pdf" | null>(null);

  async function load(): Promise<void> {
    loading = true;
    try {
      const res = await fetch("/api/cv/profile");
      const body = (await res.json()) as { profile?: Profile; error?: string };
      if (!res.ok || !body.profile) {
        error = body.error ?? "Could not read the career profile.";
        return;
      }
      profile = body.profile;
      // Start with the newest role pre-selected, and everything under it — the
      // common case is "the top of my history", not an empty grid.
      // v2: roles live under companies, so the first selectable thing is a role.
      const firstCompany = body.profile.experiences?.[0];
      const firstRole = firstCompany?.roles?.[0];
      if (firstRole) {
        entryFacts = { [firstRole.id]: (firstRole.facts ?? []).map((fact) => fact.id) };
        label = [firstCompany?.company?.name, firstRole.name].filter(Boolean).join(" — ") || "cv";
      }
    } catch {
      error = "Couldn’t reach the server.";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  const selection = $derived({
    summaryIds,
    experiences: Object.entries(entryFacts)
      .filter(([, factIds]) => factIds.length > 0)
      .map(([entryId, factIds]) => ({ entryId, factIds })),
    skills: skillIds,
  });

  const bulletCount = $derived(Object.values(entryFacts).reduce((total, factIds) => total + factIds.length, 0));

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
  }

  async function generate(format: "html" | "pdf"): Promise<void> {
    busy = format;
    error = "";
    result = null;
    try {
      const res = await fetch("/api/cv/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection, label, format }),
      });
      const body = (await res.json()) as Result;
      result = body;
      if (!res.ok) error = body.error ?? "Generation failed.";
    } catch {
      error = "Couldn’t reach the server.";
    } finally {
      busy = null;
    }
  }

  const gaps = $derived(result?.gaps ?? []);
  const warnings = $derived(result?.warnings ?? []);
  // Read outside the click handler: a handler is a closure, where TypeScript
  // no longer narrows the nullable `profile`.
  const allSkillIds = $derived(profile?.skills.map((fact) => fact.id) ?? []);
</script>

<div class="mx-auto max-w-6xl px-6 py-8">
  <a href="/cv/profile" class="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-foreground">
    <ArrowLeft class="size-4" /> Career profile
  </a>

  <div class="mt-3 flex flex-wrap items-end justify-between gap-4">
    <div>
      <h1 class="font-display text-2xl tracking-tight text-landing">Generate a CV</h1>
      <p class="mt-1 max-w-2xl text-sm text-muted">
        Pick what goes in, then render it through the same builders the CLI uses. The payload is validated by <code class="text-foreground">build-cv-html.ts</code>{" "}
        and the PDF runs the fact gate — neither is bypassed here.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={() => void generate("html")}
        disabled={busy !== null || bulletCount === 0}
        class="inline-flex items-center gap-2 rounded-full border border-border px-4 py-2 text-sm text-muted transition-colors hover:text-foreground disabled:opacity-50 max-sm:min-h-[44px]"
      >
        {#if busy === "html"}<Loader2 class="size-4 animate-spin" />{:else}<Eye class="size-4" />{/if} Preview
      </button>
      <button
        type="button"
        onclick={() => void generate("pdf")}
        disabled={busy !== null || bulletCount === 0}
        class={cn(
          "inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-medium transition-colors max-sm:min-h-[44px]",
          bulletCount > 0 ? "bg-brand text-brand-foreground hover:bg-brand-200" : "border border-border bg-surface text-muted",
        )}
      >
        {#if busy === "pdf"}<Loader2 class="size-4 animate-spin" />{:else}<Download class="size-4" />{/if} Render PDF
      </button>
    </div>
  </div>

  {#if error}
    <div role="alert" class="mt-4 rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-2 text-sm text-red-600 dark:text-red-400">
      {error}
      {#if result?.details && result.details.length > 0}
        <ul class="mt-1 space-y-0.5 font-mono text-xs">
          {#each result.details as line (line)}
            <li class="break-words">{line}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if gaps.length > 0}
    <div class="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
      <p class="inline-flex items-center gap-1.5 font-medium">
        <CircleAlert class="size-4" /> {gaps.length} selected role{gaps.length === 1 ? "" : "s"} cannot render
      </p>
      <ul class="mt-1 space-y-0.5 text-xs">
        {#each gaps as gap (gap.entryId)}
          <li>{gap.label ?? gap.entryId} — {gap.reason}</li>
        {/each}
      </ul>
    </div>
  {/if}

  {#if warnings.length > 0}
    <ul class="mt-4 space-y-1 rounded-xl border border-border bg-surface/40 px-4 py-2 text-xs text-muted">
      {#each warnings as line (line)}
        <li>{line}</li>
      {/each}
    </ul>
  {/if}

  {#if result?.pdfPath}
    <p class="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-400">
      PDF written to <code>{result.pdfPath}</code>
      {#if result.htmlPath}<span class="ml-1 text-xs text-faint">· HTML: {result.htmlPath}</span>{/if}
    </p>
  {/if}

  {#if !profile && loading}
    <div class="mt-8 flex items-center gap-2 text-sm text-muted">
      <Loader2 class="size-4 animate-spin" /> Reading career-profile.yml…
    </div>
  {/if}

  {#if profile}
    <div class="mt-6 grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <div class="space-y-3">
        <label class="block text-sm text-muted">
          Name this CV after the posting
          <input
            value={label}
            oninput={(event) => (label = event.currentTarget.value)}
            placeholder="acme-senior-engineer"
            class="mt-1 w-full rounded-xl border border-border bg-surface/50 px-3 py-2 text-sm text-foreground outline-none placeholder:text-faint focus:border-brand/40"
          />
        </label>

        {#if profile.summary.length > 0}
          <section class="rounded-2xl border border-border bg-surface/30 p-3">
            <h2 class="text-sm font-medium text-foreground">Summary</h2>
            <ul class="mt-2 space-y-1">
              {#each profile.summary as fact (fact.id)}
                <li>
                  <label class="flex cursor-pointer items-start gap-2 rounded-lg px-1 py-1 text-xs text-muted hover:bg-surface-hover">
                    <input
                      type="checkbox"
                      checked={summaryIds.includes(fact.id)}
                      onchange={() => (summaryIds = toggle(summaryIds, fact.id))}
                      class="mt-0.5 accent-[var(--color-brand)]"
                    />
                    <span class="text-foreground/90">{fact.text}</span>
                  </label>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        <section class="rounded-2xl border border-border bg-surface/30 p-3">
          <h2 class="text-sm font-medium text-foreground">Roles</h2>
          {#if pickableRoles(profile).length === 0}<p class="mt-1 text-xs text-faint">No roles recorded yet.</p>{/if}
          <ul class="mt-2 space-y-2">
            {#each pickableRoles(profile) as { company, role: entry } (entry.id)}
              {@const employer = company.company?.name ?? ""}
              {@const picked = entryFacts[entry.id] ?? []}
              {@const canRender = Boolean(employer && entry.name)}
              <li class={cn("rounded-xl border p-2", picked.length > 0 ? "border-brand/40 bg-brand-soft/30" : "border-border")}>
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="truncate text-sm text-foreground">{[entry.name || "(untitled role)", employer].filter(Boolean).join(" · ")}</p>
                    <p class="text-xs text-faint">
                      {canRender ? `${entry.period ?? "no dates"}` : "needs a company and a role name in the profile builder"}
                      {#if !canRender}<span class="ml-1 text-amber-600 dark:text-amber-400">·</span>{/if}
                    </p>
                  </div>
                  <button
                    type="button"
                    onclick={() => {
                      const next = { ...entryFacts };
                      if (picked.length > 0) delete next[entry.id];
                      else next[entry.id] = (entry.facts ?? []).map((fact) => fact.id);
                      entryFacts = next;
                    }}
                    class={cn(
                      "shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors",
                      picked.length > 0 ? "border-brand/50 text-brand-text" : "border-border text-muted hover:text-foreground",
                    )}
                  >
                    {picked.length > 0 ? `${picked.length} selected` : "Include all"}
                  </button>
                </div>

                {#if picked.length > 0 && (entry.facts?.length ?? 0) > 0}
                  <ul class="mt-1.5 space-y-0.5 border-l border-border pl-2">
                    {#each entry.facts ?? [] as fact (fact.id)}
                      <li>
                        <label class="flex cursor-pointer items-start gap-2 rounded px-1 py-0.5 text-xs text-muted hover:bg-surface-hover">
                          <input
                            type="checkbox"
                            checked={picked.includes(fact.id)}
                            onchange={() => {
                              const list = entryFacts[entry.id] ?? [];
                              const next = toggle(list, fact.id);
                              const copy = { ...entryFacts };
                              if (next.length > 0) copy[entry.id] = next;
                              else delete copy[entry.id];
                              entryFacts = copy;
                            }}
                            class="mt-0.5 accent-[var(--color-brand)]"
                          />
                          <span class="text-foreground/80">{fact.text}</span>
                        </label>
                      </li>
                    {/each}
                  </ul>
                {/if}
              </li>
            {/each}
          </ul>
        </section>

        {#if profile.skills.length > 0}
          <section class="rounded-2xl border border-border bg-surface/30 p-3">
            <div class="flex items-center justify-between">
              <h2 class="text-sm font-medium text-foreground">Skills</h2>
              <button
                type="button"
                onclick={() => (skillIds = skillIds.length === allSkillIds.length ? [] : allSkillIds)}
                class="text-xs text-muted transition-colors hover:text-foreground"
              >
                {skillIds.length === allSkillIds.length ? "Clear" : "Select all"}
              </button>
            </div>
            <div class="mt-2 flex flex-wrap gap-1.5">
              {#each profile.skills as fact (fact.id)}
                <button
                  type="button"
                  onclick={() => (skillIds = toggle(skillIds, fact.id))}
                  class={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    skillIds.includes(fact.id) ? "border-brand/50 bg-brand-soft text-brand-text" : "border-border text-muted hover:text-foreground",
                  )}
                >
                  {fact.text}
                </button>
              {/each}
            </div>
          </section>
        {/if}

        <p class="text-xs text-faint">
          {Object.keys(entryFacts).length} role{Object.keys(entryFacts).length === 1 ? "" : "s"} · {bulletCount} bullet{bulletCount === 1 ? "" : "s"} ·{" "}
          {skillIds.length} skill{skillIds.length === 1 ? "" : "s"}
        </p>
      </div>

      <div class="rounded-2xl border border-border bg-surface/30">
        <div class="border-b border-border px-3 py-2 text-xs text-faint">Preview</div>
        {#if result?.html}
          <!-- The template's own `.page` rule is `width: 100%; max-width:
               {{PAGE_WIDTH}}`, so the sheet reflows to this panel. Rendered at
               panel width rather than scaled: scaling a fixed-width sheet into
               an unknown column is what clipped the right edge twice while this
               was being built, and a preview that hides content is worse than
               one whose line breaks differ from the PDF's. -->
          <iframe title="CV preview" srcdoc={result.html} sandbox="" class="h-[70vh] w-full rounded-b-2xl border-0 bg-white"></iframe>
        {:else}
          <div class="flex h-[70vh] items-center justify-center px-6 text-center text-sm text-muted">
            {result?.pdfPath ? "PDF rendered — open the file above." : "Pick what goes in, then press Preview."}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
