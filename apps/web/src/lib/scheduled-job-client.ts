export const MIN_SCHEDULE_MINUTES = 15;

export function cadenceMinimum(unit: string): number {
  return unit === "minutes" ? MIN_SCHEDULE_MINUTES : 1;
}

export function cadenceValueForUnit(every: unknown, unit: string): number {
  const value = Number(every);
  return Number.isFinite(value) ? Math.max(cadenceMinimum(unit), value) : cadenceMinimum(unit);
}

/** The POST/PATCH this client issues, narrow enough for a test to stub. */
export type ScheduledJobRequest = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export async function createScheduledJobRequest(payload: unknown, fetcher: ScheduledJobRequest = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher("/api/scheduled-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" && body.error ? body.error : "Could not create the scheduled scan.");
  return body;
}

export async function updateScheduledJobRequest(id: string, payload: unknown, fetcher: ScheduledJobRequest = fetch): Promise<Record<string, unknown>> {
  const response = await fetcher(`/api/scheduled-jobs/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === "string" && body.error ? body.error : "Could not update the scheduled scan.");
  return body;
}
