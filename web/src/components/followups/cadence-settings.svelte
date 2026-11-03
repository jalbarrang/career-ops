<script lang="ts">
  import { onMount } from "svelte";
  import { Check, Loader2 } from "@lucide/svelte";
  import { PROFILE_CADENCE_KEYS, type ProfileCadenceKey } from "@/lib/followups";
  import { cn } from "@/lib/cn";

  // Follow-up cadence knobs → config/profile.yml (followup_cadence). Server-
  // persisted (unlike the localStorage engine prefs above) because the core
  // followup-cadence.mjs reads the same keys — the CLI and the web must agree.

  const FIELDS: { key: ProfileCadenceKey; label: string; hint: string }[] = [
    { key: "applied_first_days", label: "First follow-up", hint: "days after applying before the 1st nudge is due" },
    { key: "applied_subsequent_days", label: "Between follow-ups", hint: "days between nudges while Applied" },
    { key: "applied_max_followups", label: "Max follow-ups", hint: "after this many with no reply the lead goes cold" },
    { key: "responded_initial_days", label: "Reply window", hint: "answer a company response within this many days" },
    { key: "responded_subsequent_days", label: "Responded cadence", hint: "days between touches while in Responded" },
    { key: "interview_thankyou_days", label: "Thank-you note", hint: "due within this many days of reaching Interview" },
  ];

  let values = $state<Record<ProfileCadenceKey, string> | null>(null);
  let loadError = $state(false);
  let saving = $state(false);
  let saved = $state(false);
  let error = $state<string | null>(null);

  // On a failed load, do NOT fall back to defaults: the user would see 7/7/2/…
  // with no warning and a Save would overwrite their real profile.yml
  // overrides. Show an error + Retry instead.
  async function load(): Promise<void> {
    loadError = false;
    try {
      const r = await fetch("/api/followups/cadence");
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as { effective?: Partial<Record<ProfileCadenceKey, number>> };
      // `effective` is already defaults+overrides, computed server-side from
      // the CORE's cadenceDefaults (#2369) — no local defaults table to merge
      // in. A key the core didn't supply renders empty rather than as an
      // invented number.
      const eff = d?.effective ?? {};
      values = Object.fromEntries(
        PROFILE_CADENCE_KEYS.map((k) => [k, eff[k] === undefined ? "" : String(eff[k])]),
      ) as Record<ProfileCadenceKey, string>;
    } catch {
      loadError = true;
    }
  }
  onMount(() => {
    void load();
  });

  async function save(): Promise<void> {
    if (!values) return;
    const payload: Partial<Record<ProfileCadenceKey, number>> = {};
    for (const k of PROFILE_CADENCE_KEYS) {
      // Number(), not parseInt(): "3.5" and "7abc" must be rejected, not truncated.
      const raw = values[k].trim();
      const n = raw === "" ? Number.NaN : Number(raw);
      if (!Number.isInteger(n) || n < 0) {
        error = `"${FIELDS.find((f) => f.key === k)?.label}" must be a whole number ≥ 0.`;
        return;
      }
      payload[k] = n;
    }
    saving = true;
    error = null;
    try {
      const res = await fetch("/api/followups/cadence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        error = typeof j.error === "string" ? j.error : "Could not save.";
      } else {
        saved = true;
        setTimeout(() => (saved = false), 2000);
      }
    } catch {
      error = "Could not save.";
    }
    saving = false;
  }
</script>

<div>
  <!-- A section heading, not a control label: <label> here associated nothing. -->
  <h2 class="mt-8 mb-2 block text-xs font-semibold uppercase tracking-[0.18em] text-muted">Follow-up cadence</h2>
  <div class="rounded-xl border border-border bg-surface/50 p-4">
    <p class="text-xs leading-relaxed text-faint">
      When the <span class="text-muted">Follow-ups</span> tracker nudges you. Saved to{" "}
      <span class="font-mono text-muted">config/profile.yml</span> — the CLI uses the same values.
    </p>
    {#if loadError}
      <div class="mt-3 text-sm text-muted">
        <p class="text-red-500">
          Couldn't read your current cadence settings — not showing defaults, to avoid overwriting real values in{" "}
          <span class="font-mono">config/profile.yml</span>.
        </p>
        <button
          type="button"
          onclick={() => void load()}
          class="mt-2 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-hover"
        >
          Retry
        </button>
      </div>
    {:else if values === null}
      <div class="mt-3 flex items-center gap-2 text-sm text-muted">
        <Loader2 class="size-4 animate-spin" /> Loading…
      </div>
    {:else}
      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        {#each FIELDS as f (f.key)}
          <label class="block">
            <span class="block text-sm font-medium text-foreground">{f.label}</span>
            <span class="mt-0.5 block text-xs text-faint">{f.hint}</span>
            <input
              type="number"
              min={0}
              step={1}
              value={values[f.key]}
              oninput={(e) => {
                if (values) values = { ...values, [f.key]: e.currentTarget.value };
              }}
              class="mt-1.5 w-24 rounded-md border border-border bg-surface/60 px-3 py-1.5 text-sm tabular-nums outline-none transition-colors focus:border-brand/50 focus-visible:ring-2 focus-visible:ring-brand/40"
            />
          </label>
        {/each}
      </div>
      {#if error}<p class="mt-3 text-xs text-red-500">{error}</p>{/if}
      <button
        type="button"
        onclick={() => void save()}
        disabled={saving}
        class={cn(
          "mt-4 inline-flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-medium transition-colors hover:bg-surface-hover",
          "disabled:pointer-events-none disabled:opacity-60",
        )}
      >
        {#if saving}<Loader2 class="size-3.5 animate-spin" />{:else if saved}<Check class="size-3.5 text-emerald-400" />{/if}
        {saved ? "Saved" : "Save cadence"}
      </button>
    {/if}
  </div>
</div>
