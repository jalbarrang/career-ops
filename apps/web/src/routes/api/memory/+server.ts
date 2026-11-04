import { json } from "@sveltejs/kit";
import { readMemory, rememberFact } from "@/lib/career-ops";

export async function GET() {
  return json({ memory: readMemory() });
}

// Append a durable fact the assistant learned about the user. Written to the
// CANONICAL modes/_profile.md (single source of truth) so the CLI/TUI see it too
// — never a web-only memory store.
export async function POST({ request }: { request: Request }) {
  let b: { fact?: string };
  try {
    b = await request.json();
  } catch {
    return json({ error: "bad json" }, { status: 400 });
  }
  const fact = (b.fact ?? "").toString();
  if (!fact.trim()) return json({ error: "fact required" }, { status: 400 });

  const result = rememberFact(fact);
  if (result === "error") return json({ error: "write failed" }, { status: 500 });
  return json({ ok: true, deduped: result === "deduped" });
}
