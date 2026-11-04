export function isSchedulerStatusPayload(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = (value as { task?: unknown }).task;
  return Boolean(task && typeof task === "object" && !Array.isArray(task));
}
