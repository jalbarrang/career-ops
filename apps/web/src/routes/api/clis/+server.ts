import { json } from "@sveltejs/kit";
import { detectClis } from "@/lib/clis";

// Detects which agnostic CLIs are installed on THIS machine (local-first). The
// web delegates career-ops to one of these in headless mode, on the user's own
// auth/tokens — no API key needed.
export async function GET() {
  return json({ clis: detectClis() });
}
