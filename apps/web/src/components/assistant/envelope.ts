// The assistant console's message model and its `<<act:ID {json}>>` envelope
// parser. Plain module (not a component) so the parsing rules sit in one place
// and `part-view.svelte` can import the Part types it renders.
import { pendingActOpenerStart } from "@/lib/act-envelope.ts";

// ── message model: messages are PART arrays so a live worker card can render
// inline next to text, both fed by the single jobs store ───────────────────────
export type Part =
  | { type: "text"; text: string }
  | { type: "note"; text: string }
  | { type: "card"; jobId: string }
  | { type: "batch"; batchId: string; jobIds: string[] }
  | { type: "confirm"; cid: string; summary: string; state: "pending" | "done" | "cancelled" };
export type Msg = { role: "user" | "assistant"; parts: Part[] };

export type Envelope = { start: number; end: number; id: string; argsJson: string };

// back-compat shims — the old directives still work, mapped onto the registry
export const NAV_RE = /<<\s*go:\s*(\/[a-z0-9/_-]*)\s*>>/gi;
export const REMEMBER_RE = /<<\s*remember:\s*([^>]+?)\s*>>/gi;

/** Ranges covered by fenced code blocks — an envelope INSIDE one is documentation, not an intent. */
function codeRanges(s: string): [number, number][] {
  const ranges: [number, number][] = [];
  const re = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function inRanges(i: number, ranges: [number, number][]): boolean {
  return ranges.some(([a, b]) => i >= a && i < b);
}

/** Tolerate the curly quotes and trailing comma a model emits under fatigue. */
export function normalizeJson(s: string): string {
  return s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*}$/, "}")
    .trim();
}

/**
 * Find the COMPLETE `<<act:ID {json}>>` envelopes in the streamed answer, plus
 * the offset from which a still-open one (or a `<<act:` prefix) must be hidden
 * so it never flickers into the bubble before its closing `>>` arrives.
 */
export function parseEnvelopes(acc: string): { complete: Envelope[]; hidePartialFrom: number } {
  const ranges = codeRanges(acc);
  const complete: Envelope[] = [];
  let hidePartialFrom = -1;
  const open = /<<act:([a-zA-Z]+)[ \t]+/g;
  let m: RegExpExecArray | null;
  while ((m = open.exec(acc))) {
    const start = m.index;
    if (inRanges(start, ranges)) continue;
    const argsStart = m.index + m[0].length;
    const close = acc.indexOf(">>", argsStart);
    if (close === -1) {
      if (hidePartialFrom === -1 || start < hidePartialFrom) hidePartialFrom = start;
      continue;
    }
    complete.push({ start, end: close + 2, id: m[1], argsJson: acc.slice(argsStart, close).trim() });
  }
  // The regex above only sees an opener once its id letters AND trailing space
  // have streamed in. Also hide a shorter trailing partial (`<<`, `<<act:sav`)
  // so it doesn't flicker into the bubble before the space arrives (#2290-class).
  const pending = pendingActOpenerStart(acc);
  if (pending >= 0 && (hidePartialFrom === -1 || pending < hidePartialFrom)) hidePartialFrom = pending;
  return { complete, hidePartialFrom };
}

/** Remove the given ranges, merging overlaps and sorting first. */
export function removeRanges(s: string, cuts: [number, number][]): string {
  if (!cuts.length) return s;
  const merged = [...cuts].sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out += s.slice(pos, a);
    pos = Math.max(pos, b);
  }
  out += s.slice(pos);
  return out;
}

// Page awareness: describe the route so "this offer" / "apply" resolves to what
// the user is looking at.
export function describePage(p: string): string {
  if (p === "/") return "Today / home — overview of the user's pipeline.";
  if (p === "/pipeline") return "Pipeline — the applications table + the inbox of pending job URLs.";
  const m = p.match(/^\/pipeline\/([^/]+)$/);
  if (m)
    return `The user is viewing the EVALUATION REPORT for application #${m[1]}. If they say "this offer", "apply", "evaluate it", "draft a cover letter", they mean application #${m[1]} — read reports/${m[1]}-*.md or the matching data/applications.md row and act on THAT one.`;
  if (p === "/analytics") return "Analytics — pipeline Sankey, funnel, score distribution, top companies.";
  if (p === "/cv") return "CV editor (cv.md).";
  if (p === "/config") return "Config — CLI / engine setup.";
  if (p === "/apply") return "Apply — the form-proxy: the user is reviewing a job application re-rendered in plain language, pre-filled from their CV. You can write/revise answers via setApplyField.";
  if (p.startsWith("/jobs/")) return "Watching a running worker / evaluation in progress.";
  return `Route ${p}.`;
}

/** The plain-text of a message (its text parts joined), for history + the user bubble.
 *  Also the migration seam: a stored message in the old `{ role, content: string }`
 *  shape is converted to parts by `cleanMessages` before it reaches here. */
export function msgText(m: Msg): string {
  return m.parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();
}
