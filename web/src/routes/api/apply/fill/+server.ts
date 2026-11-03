import { json } from "@sveltejs/kit";
import { fillSession, handoffSession, getSession } from "@/lib/apply/session";
import { resolveSessionCv } from "@/lib/apply/cv";
import type { ApplyField } from "@/lib/apply/extract";

// Fill the real form behind the scenes (headed-but-off-screen), screenshotting
// each step for the "behind the scenes" strip, then bring the window to the front
// so the HUMAN reviews and submits. NEVER submits — there is no submit path here.
export async function POST({ request }: { request: Request }) {
  let body: { sessionId?: string; answers?: Record<string, string>; fields?: ApplyField[]; handoff?: boolean; company?: string; application?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, { status: 400 });
  }
  const { sessionId, answers = {}, fields = [], handoff, company, application } = body;
  if (!sessionId) return json({ error: "sessionId required" }, { status: 400 });
  if (company !== undefined && typeof company !== "string") {
    return json({ error: "company must be a string" }, { status: 400 });
  }
  if (application !== undefined && typeof application !== "string") {
    return json({ error: "application must be a string" }, { status: 400 });
  }

  // Resolve the tailored CV server-side (never trust a client path): by the
  // offer's company if known, else best-effort from the form title.
  const session = getSession(sessionId);
  const cvPath = (await resolveSessionCv({ company, application, title: session?.title })) ?? undefined;

  try {
    const result = await fillSession(sessionId, answers, fields, cvPath);
    if (handoff) await handoffSession(sessionId).catch(() => {});
    return json({ ...result, handedOff: !!handoff, cvAttached: !!cvPath });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : "fill failed" }, { status: 500 });
  }
}
