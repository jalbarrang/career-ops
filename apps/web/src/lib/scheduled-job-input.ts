export function assertScheduledJobBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scheduled job body must be an object.");
  }
  return value as Record<string, unknown>;
}
