// machine-summary.ts — read the Machine Summary block of an evaluation report.
//
// Every report ends with a fenced YAML `## Machine Summary` block (see
// modes/oferta.md). It is the machine-readable half of the report: the score,
// the final decision, hard stops, gaps and strengths. The web reads it for the
// decision card, so a report whose prose is fine but whose summary is missing
// degrades to `null` rather than throwing.
import * as yaml from "js-yaml";

/** The fields the dashboard reads, plus a pass-through for the rest. */
export interface MachineSummary {
  company?: string;
  role?: string;
  score?: number;
  decision?: string;
  hardStops?: unknown[];
  softGaps?: string[];
  topStrengths?: string[];
  requirementImportance?: unknown[];
  [key: string]: unknown;
}

/**
 * The YAML block under `## Machine Summary`, or null when absent/unparseable.
 *
 * @param report - The whole report text.
 */
export function readMachineSummary(report: string): MachineSummary | null {
  const text = String(report ?? "");
  const at = text.search(/^##\s+Machine Summary\s*$/m);
  if (at < 0) return null;
  const rest = text.slice(at);
  const fence = /```ya?ml\s*\n([\s\S]*?)\n```/.exec(rest);
  if (!fence) return null;
  let parsed: unknown;
  try {
    parsed = yaml.load(fence[1]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  return {
    ...raw,
    company: typeof raw.company === "string" ? raw.company : undefined,
    role: typeof raw.role === "string" ? raw.role : undefined,
    score: typeof raw.score === "number" ? raw.score : undefined,
    decision: typeof raw.final_decision === "string" ? raw.final_decision : undefined,
    hardStops: Array.isArray(raw.hard_stops) ? raw.hard_stops : undefined,
    softGaps: Array.isArray(raw.soft_gaps) ? raw.soft_gaps.map(String) : undefined,
    topStrengths: Array.isArray(raw.top_strengths) ? raw.top_strengths.map(String) : undefined,
    requirementImportance: Array.isArray(raw.requirement_importance) ? raw.requirement_importance : undefined,
  };
}

/**
 * The one-sentence reason shown on the decision card.
 *
 * Read from the `## Verdict (lead)` block, not from the header: the header
 * repeats the verdict sentence verbatim, so reading either gives the same text,
 * and the verdict block is the one guaranteed to exist on old reports too.
 *
 * @param report - The whole report text.
 */
export function cardReason(report: string): string | null {
  const text = String(report ?? "");
  const at = text.search(/^##\s+.*\bVerdict\b.*\(lead\)\s*$/im);
  if (at < 0) return null;
  const rest = text.slice(at);
  const end = rest.search(/\n##\s+/);
  const content = (end < 0 ? rest : rest.slice(0, end))
    .split("\n")
    .slice(1)
    .join("\n")
    .trim();
  if (!content) return null;
  const plain = content
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return plain || null;
}
