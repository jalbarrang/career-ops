/**
 * pipeline-sections.ts — the Pending and Processed headings of data/pipeline.md.
 *
 * Each modes/<lang>/pipeline.md tells the agent to write these two sections in
 * its own language, and to keep the language an existing file already uses.
 * scan.ts, sync-batch-input.ts and reconcile-pipeline.ts read and write the
 * same file, so they share this one table.
 */

const SECTION_PAIRS = [
  ['Pending', 'Processed'],
  ['Pendientes', 'Procesadas'],
  ['Pendentes', 'Processadas'],
  ['Offen', 'Verarbeitet'],
  ['En attente', 'Traitees'],
  ['In attesa', 'Elaborati'],
  ['In afwachting', 'Verwerkt'],
  ['Afventer', 'Behandlede'],
  ['Oczekujące', 'Przetworzone'],
  ['Bekleyenler', 'İşlenenler'],
  ['Menunggu', 'Diproses'],
  ['Ожидающие', 'Обработанные'],
  ['Очікуючі', 'Оброблені'],
  ['लंबित', 'संसाधित'],
  ['대기', '처리 완료'],
];

// Accents and case are folded, so a hand-typed "Traitées" matches the
// "Traitees" that modes/fr writes.
const fold = (text: string): string => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

interface SectionHeading {
  kind: 'pending' | 'processed';
  processed?: string;
}

const KIND = new Map<string, SectionHeading>(SECTION_PAIRS.flatMap(([pending, processed]): Array<[string, SectionHeading]> => [
  [fold(pending), { kind: 'pending', processed }],
  [fold(processed), { kind: 'processed' }],
]));

/**
 * @param line - One line of pipeline.md.
 * @returns The section a `## ` heading opens, or null.
 */
export function sectionKind(line: string): 'pending' | 'processed' | null {
  const m = /^##[ \t]+(.+?)[ \t]*\r?$/.exec(line);
  return m ? KIND.get(fold(m[1]))?.kind ?? null : null;
}

/**
 * @param pendingLine - A line for which sectionKind() is 'pending'.
 * @returns The Processed heading in the same language.
 */
export function processedHeadingFor(pendingLine: string): string {
  const m = /^##[ \t]+(.+?)[ \t]*\r?$/.exec(pendingLine);
  return `## ${(m && KIND.get(fold(m[1]))?.processed) || 'Processed'}`;
}
