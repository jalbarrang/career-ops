import type { Job } from "@/lib/jobs.svelte";

// The canonical worker colour scale, shared by the card, the sidebar pills and
// the jobs timeline. Lives in a plain module (not the component) so the ported
// call sites that imported `TONE` / `pillTone` from worker-card keep working.
export const TONE = {
  good: { bar: "bg-emerald-500/70", chip: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400", icon: "text-emerald-500" },
  warn: { bar: "bg-amber-500/70", chip: "bg-amber-500/15 text-amber-700 dark:text-amber-400", icon: "text-amber-500" },
  bad: { bar: "bg-red-400/70", chip: "bg-red-500/15 text-red-700 dark:text-red-400", icon: "text-red-400" },
  muted: { bar: "bg-zinc-400/50", chip: "bg-surface-hover text-muted", icon: "text-zinc-400" },
} as const;

export function pillTone(j: Job): keyof typeof TONE {
  if (j.status === "error") return "bad";
  if (j.status === "done") return j.result?.tone ?? "muted";
  return "muted";
}
