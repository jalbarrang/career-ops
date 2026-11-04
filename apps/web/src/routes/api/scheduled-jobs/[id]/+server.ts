import { json } from "@sveltejs/kit";
import { ScheduledJobValidationError, deleteScheduledJob, patchScheduledJob } from "@/lib/scheduled-jobs";

export async function PATCH({ params, request }) {
  const { id } = params;
  try {
    const body = await request.json();
    const job = await patchScheduledJob(id, body);
    return job ? json(job) : json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    const status =
      error instanceof ScheduledJobValidationError || error instanceof SyntaxError
        ? 400
        : error instanceof Error && /lock timeout/i.test(error.message)
          ? 409
          : 500;
    return json({ error: status === 500 ? "Could not update scheduled job." : error instanceof Error ? error.message : "Invalid update" }, { status });
  }
}

export async function DELETE({ params }) {
  const { id } = params;
  try {
    const job = await deleteScheduledJob(id);
    return job ? json(job) : json({ error: "Not found" }, { status: 404 });
  } catch (error) {
    const status = error instanceof Error && /lock timeout/i.test(error.message) ? 409 : 500;
    return json({ error: status === 409 ? "Scheduled jobs are busy; try again." : "Could not delete scheduled job." }, { status });
  }
}
