/**
 * Compare tracker row identifiers as numbers. They arrive from the Markdown
 * tracker as strings, so a plain localeCompare would put #10 before #2.
 */
export function compareTrackerNumbers(a: { n?: string | number }, b: { n?: string | number }): number {
  return Number(a?.n) - Number(b?.n);
}
