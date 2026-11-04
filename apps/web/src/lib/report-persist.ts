// report-persist.ts — the web's writer for the tracker-addition TSV.
//
// A mirror of core packages/core/src/tracker/tracker-addition.ts's trackerTsvLine(). The web build
// cannot import the core module (its bundler root is pinned to web/), and the
// two writers must produce byte-identical output: tests/tracker-columns.test.ts
// and tests/persist-evaluation-report.test.ts assert exactly that, because a
// header spelled differently from packages/core/src/tracker/tracker-aliases.json would make
// packages/cli/src/commands/tracker/merge-tracker.ts read the row as headerless.
//
// The headed form is deliberate (#3517): labels above values means ingestion
// resolves fields by NAME, so column order carries no meaning and there is no
// score/status transposition to guess at.

/** One evaluation, as the web persist step knows it. */
export interface TrackerAdditionRow {
  num: string;
  today: string;
  company: string;
  role: string;
  score: string;
  reportFile: string;
  notes: string;
  via: string | null;
  url: string | null;
}

/**
 * The two-line TSV (header + one row) for an evaluation.
 *
 * @param row - The evaluation to persist.
 */
export function trackerTsvLine({ num, today, company, role, score, reportFile, notes, via, url }: TrackerAdditionRow): string {
  const labels: string[] = ['num', 'date', 'company', 'role', 'status', 'score', 'pdf', 'report', 'notes'];
  const fields: string[] = [
    num,
    today,
    company,
    role,
    'Evaluated',
    score,
    '❌',
    `[${num}](reports/${reportFile})`,
    notes,
  ];
  if (via) {
    labels.push('via');
    fields.push(via);
  }
  if (url) {
    labels.push('url');
    fields.push(url);
  }
  return `${labels.join('\t')}\n${fields.join('\t')}\n`;
}
