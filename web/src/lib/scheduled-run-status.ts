export function runStatusTone(state: unknown): string {
  if (state === "success") return "success";
  if (state === "failed") return "failed";
  return "neutral";
}
