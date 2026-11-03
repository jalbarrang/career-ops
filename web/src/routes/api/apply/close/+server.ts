import { json } from "@sveltejs/kit";
import { closeSession } from "@/lib/apply/session";

// Explicitly close an apply session (the user hit "new" or left the page) so we
// free the off-screen browser tab promptly instead of waiting for the prune.
export async function POST({ request }: { request: Request }) {
  let body: { sessionId?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false }, { status: 400 });
  }
  if (body.sessionId) await closeSession(body.sessionId).catch(() => {});
  return json({ ok: true });
}
