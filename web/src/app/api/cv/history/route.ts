import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot, isRegularContainedFile } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every save through /api/cv already leaves a `cv.md.bak-{ISO}` snapshot
// (safe-write.ts). user-layer files are gitignored, so those snapshots are the
// only recovery a bad edit has — this route is the surface that makes them
// usable instead of invisible files in the checkout.
//
// Restore writes cv.md and nothing else. It also snapshots what it is about to
// replace, so undoing a restore is itself a restore.
const BACKUP_NAME = /^cv\.md\.bak-[\w.:-]+$/;
const MAX_BACKUPS = 20;
const MAX_CV_BYTES = 200_000;

function cvPath() {
  return path.join(careerOpsRoot(), "cv.md");
}

export async function GET() {
  const dir = path.dirname(cvPath());
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return Response.json({ backups: [] });
  }

  const backups = names
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return { name, savedAt: stat.mtime.toISOString(), bytes: stat.size };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { name: string; savedAt: string; bytes: number } => entry !== null)
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    .slice(0, MAX_BACKUPS);

  return Response.json({ backups });
}

export async function POST(req: Request) {
  let body: { name?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const name = body.name;
  if (typeof name !== "string" || !BACKUP_NAME.test(name)) {
    return Response.json({ error: "unknown backup" }, { status: 400 });
  }

  // The name is matched by regex above, and resolved again here: a name is only
  // restorable if it really is a plain file inside the data root (symlinks and
  // `..` in a filename the regex happens to accept are refused).
  const root = careerOpsRoot();
  const backupFile = path.join(root, name);
  if (!isRegularContainedFile(backupFile, root)) {
    return Response.json({ error: "unknown backup" }, { status: 404 });
  }

  let content: string;
  try {
    content = fs.readFileSync(backupFile, "utf8");
  } catch {
    return Response.json({ error: "backup is unreadable" }, { status: 500 });
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CV_BYTES) {
    return Response.json({ error: "that backup is too large to restore" }, { status: 413 });
  }

  try {
    const backedUp = atomicWriteWithBackup(cvPath(), content);
    return Response.json({ ok: true, restored: name, content, backedUp });
  } catch {
    return Response.json({ error: "restore failed" }, { status: 500 });
  }
}
