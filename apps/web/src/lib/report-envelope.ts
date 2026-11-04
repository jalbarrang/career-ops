// report-envelope.ts — parse the `<<report-md>> … <</report-md>>` envelope a
// worker streams back.
//
// The evaluate worker emits the whole report inside one envelope so the route
// can tell report text apart from the worker's narration. A missing or empty
// envelope is a failed run, not an empty report: persisting "" would create a
// report file with no evaluation in it.

/** The parse result. `ok` is the only field callers must branch on. */
export interface ReportEnvelope {
  ok: boolean;
  markdown?: string;
  error?: string;
}

/**
 * Extract the report markdown from a worker's response.
 *
 * @param text - The worker's full stdout.
 */
export function parseReportEnvelope(text: string): ReportEnvelope {
  const source = String(text ?? "");
  const match = /<<report-md>>\s*\n?([\s\S]*?)\n?\s*<<\/report-md>>/.exec(source);
  if (!match) return { ok: false, error: "missing <<report-md>> envelope" };
  const markdown = match[1].trim();
  if (!markdown) return { ok: false, error: "empty <<report-md>> envelope" };
  return { ok: true, markdown };
}
