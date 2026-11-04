import { json } from "@sveltejs/kit";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";

function cvPath() {
  return path.join(careerOpsRoot(), "cv.md");
}

const MAX_CV_BYTES = 200_000;

export async function GET() {
  try {
    return json({ content: fs.readFileSync(cvPath(), "utf8"), exists: true });
  } catch {
    return json({ content: "", exists: false });
  }
}

export async function POST({ request }: { request: Request }) {
  let body: { content?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, { status: 400 });
  }
  if (typeof body.content !== "string") {
    return json({ error: "content required" }, { status: 400 });
  }
  if (Buffer.byteLength(body.content, "utf8") > MAX_CV_BYTES) {
    return json({ error: "CV is too large (over 200KB)" }, { status: 413 });
  }
  // DATA_CONTRACT: cv.md is user-layer and gitignored (no git recovery). Never
  // blind-overwrite — snapshot the prior CV to a .bak first, write atomically.
  try {
    const bak = atomicWriteWithBackup(cvPath(), body.content);
    return json({ ok: true, backedUp: !!bak });
  } catch {
    return json({ error: "write failed" }, { status: 500 });
  }
}
