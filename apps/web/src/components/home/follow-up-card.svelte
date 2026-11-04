<script module lang="ts">
  export type FollowUp = {
    num?: number;
    company: string;
    role?: string;
    status?: string;
    appliedDate?: string;
    notes?: string;
    // Raw pass-through from packages/core/src/outreach/followup-cadence.ts — 'urgent'/'overdue' entries
    // are due now, 'waiting'/'cold' are not (#86).
    urgency?: "urgent" | "overdue" | "waiting" | "cold";
    nextFollowupDate?: string | null;
    daysUntilNext?: number | null;
  };
</script>

<script lang="ts">
  import { Check, Clock, FileText, Loader2 } from "@lucide/svelte";
  import { cn } from "@/lib/cn";
  import CompanyLogo from "@/components/company-logo.svelte";

  // One-tap overdue follow-up row (demand loop). "Mark followed up" appends a
  // table row to data/follow-ups.md (append-only) so the core cadence advances;
  // "Snooze" is a client dismiss. The cadence is the core's — we just surface + record.
  let { followup, onLogged }: { followup: FollowUp; onLogged?: () => void } = $props();

  // Not named `state`: a local with that name makes `$state()` parse as a
  // store subscription, and the rune call itself then fails to resolve.
  let status = $state<"idle" | "logging" | "done" | "snoozed" | "error">("idle");
  let errorMsg = $state<string | null>(null);

  async function log(): Promise<void> {
    status = "logging";
    errorMsg = null;
    try {
      const res = await fetch("/api/followups/log", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appNum: followup.num,
          company: followup.company,
          role: followup.role,
          channel: "Other",
          notes: "Followed up",
        }),
      });
      // A 4xx/5xx means nothing was written — showing "done" would silently
      // drop the log and the nag would just come back next visit. Surface the
      // server's error detail so a validation reject reads differently from a
      // transient failure (same j.error contract as next-date-dialog).
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        errorMsg = typeof j.error === "string" ? j.error : `HTTP ${res.status}`;
        status = "error"; // keep the row visible so the user can retry
        return;
      }
      onLogged?.();
      status = "done";
    } catch {
      status = "error"; // keep the row visible so the user can retry
    }
  }
</script>

{#if status !== "snoozed" && status !== "done"}
  <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-surface/40 px-3.5 py-3 transition hover:border-brand/30">
    <div class="flex min-w-0 flex-[1_1_55%] items-center gap-3">
      <CompanyLogo name={followup.company} size={22} />
      <div class="min-w-0 flex-1">
        <p class="truncate text-sm">
          <span class="font-medium text-foreground">{followup.company}</span>
          {#if followup.role}<span class="text-muted"> · {followup.role}</span>{/if}
        </p>
        <p class="flex items-center gap-1 text-[11px] text-faint">
          <Clock class="size-3" /> {followup.appliedDate ? `applied ${followup.appliedDate}` : "follow-up due"}
        </p>
      </div>
    </div>
    <div class="ml-auto flex shrink-0 items-center gap-2">
      <button
        type="button"
        disabled={status === "logging"}
        onclick={log}
        title={status === "error" && errorMsg ? errorMsg : undefined}
        class={cn(
          "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-surface-hover px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:bg-brand-soft hover:text-brand max-sm:min-h-[44px]",
          status === "error" && "text-red-500 hover:text-red-400",
        )}
      >
        {#if status === "logging"}
          <Loader2 class="size-3.5 animate-spin" />
        {:else}
          <Check class="size-3.5" />
        {/if}{" "}
        <span class="hidden max-w-48 truncate sm:inline">{status === "error" ? `${errorMsg ?? "Failed"} — retry` : "Mark followed up"}</span>
        <span class="sm:hidden">{status === "error" ? "Retry" : "Followed up"}</span>
      </button>
      {#if followup.num != null}
        <a
          href={`/pipeline/${followup.num}`}
          title="Open report"
          class="inline-flex shrink-0 items-center justify-center rounded p-1 text-faint transition hover:text-brand max-sm:min-h-[44px] max-sm:min-w-[44px]"
        >
          <FileText class="size-4" />
        </a>
      {/if}
      <button
        type="button"
        onclick={() => (status = "snoozed")}
        class="inline-flex shrink-0 items-center justify-center text-[11px] text-faint transition hover:text-foreground max-sm:min-h-[44px] max-sm:min-w-[44px]"
      >
        Snooze
      </button>
    </div>
  </div>
{/if}
