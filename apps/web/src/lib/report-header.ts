// report-header.ts — read the `**Label:** value` header of an evaluation report.
//
// The report header is the block before the first `---`. Its labels are
// localized by the market modes (modes/de/angebot.md writes `**Entscheidung:**`,
// modes/vi writes `**Quyết định:**`, …), so the parser maps every translated
// spelling onto one canonical field name. Only KNOWN labels become fields: a
// free-text line that happens to look like `**Thing:** value` is not header
// data, and prototype names (`constructor`, `__proto__`, `toString`) must never
// become fields.
//
// `Verdict` is deliberately NOT a decision alias. The web job stream latches
// the first `VERDICT:` it sees as the run's score line, and a header label
// ending in `Verdict:` would be read as that line.

/** One header field, with its canonical (English) name. */
export interface ReportHeaderField {
  label: string;
  value: string;
}

/** The parsed header. */
export interface ParsedReportHeader {
  fields: ReportHeaderField[];
}

/** Translated `Decision` labels, one per market mode. */
const DECISION_LABELS = new Set([
  'decision',
  'entscheidung',
  'beslutning',
  'decisión',
  'decision',
  'décision',
  'निर्णय',
  'keputusan',
  'decisione',
  '決定',
  '决定',
  '결정',
  'beslissing',
  'decyzja',
  'decisão',
  'решение',
  'karar',
  'рішення',
  'quyết định',
  'القرار',
]);

/** Non-decision header labels → the canonical name the UI reads. */
const FIELD_ALIASES: Record<string, string> = {
  date: 'Date',
  fecha: 'Date',
  datum: 'Date',
  data: 'Date',
  dato: 'Date',
  tanggal: 'Date',
  score: 'Score',
  punteggio: 'Score',
  puan: 'Score',
  бал: 'Score',
  url: 'URL',
  archetype: 'Archetype',
  arquetipo: 'Archetype',
  legitimacy: 'Legitimacy',
  legitimidad: 'Legitimacy',
  'work auth': 'Work Auth',
  'work authorization': 'Work Auth',
  pdf: 'PDF',
  apply: 'Decision',
};

const FORBIDDEN_LABELS = new Set(['constructor', '__proto__', 'tostring', 'valueof', 'hasownproperty', 'verdict']);

/**
 * Parse the header of a report.
 *
 * @param text - The whole report, or just its header.
 * @returns The known header fields, in file order.
 */
export function readReport(text: string): ParsedReportHeader {
  const source = String(text ?? '');
  const header = source.split(/\n\s*---/)[0] ?? '';
  const fields: ReportHeaderField[] = [];
  for (const line of header.split('\n')) {
    const match = /^\s*\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[1].trim();
    const key = raw.toLowerCase();
    if (FORBIDDEN_LABELS.has(key)) continue;
    const label = DECISION_LABELS.has(key) ? 'Decision' : FIELD_ALIASES[key];
    if (!label) continue;
    fields.push({ label, value: match[2].trim() });
  }
  return { fields };
}
