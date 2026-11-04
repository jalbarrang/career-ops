import { json } from "@sveltejs/kit";
import { openSession } from "@/lib/apply/session";
import { cliSubstitutionNotice, resolveCliOrFallback } from "@/lib/clis";

// Open a persistent apply session: headed-but-off-screen Chrome opens the real
// form, we extract + tag its fields. The session stays open for fill + handoff.
// cliId enables the agentic fallback (the AI interprets the live form) when
// deterministic extraction is low-confidence.
export async function POST({ request }: { request: Request }) {
  let body: { url?: string; cliId?: string; agent?: boolean; _noApplyBtn?: boolean };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, { status: 400 });
  }
  const url = (body.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return json({ error: "A valid application URL (https://…) is required" }, { status: 400 });
  // A stale saved id falls back to the sole installed CLI, as on every other AI
  // route (#4607). Unresolvable → pass it through unchanged: the interpreter
  // already treats a missing CLI as "no agentic fallback".
  const resolved = body.cliId ? resolveCliOrFallback(body.cliId) : null;
  const cliId = resolved?.spec.id ?? body.cliId;
  const substitution = resolved ? cliSubstitutionNotice(resolved) : null;
  try {
    const session = await openSession(url, cliId, body.agent, body._noApplyBtn);
    if (substitution) session.issues.push({ level: "info", code: "cli-substituted", message: substitution });
    return json(session);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message.slice(0, 200) : "could not open the form" }, { status: 500 });
  }
}
