import fs from "node:fs";
import path from "node:path";

// Synchronous mirror of packages/core/src/kernel/path-resolver.ts for the synchronous web readers.
// tracker-files.test.ts checks parity against the core resolver, including
// overrides, legacy layouts, and symlinks.
export function resolveTrackerPath(root: string): string {
  const override = process.env.CAREER_OPS_TRACKER?.trim();
  const candidate = path.resolve(override || (
    fs.existsSync(path.join(root, "data/applications.md"))
      ? path.join(root, "data/applications.md")
      : path.join(root, "applications.md")
  ));
  try {
    return fs.realpathSync(candidate);
  } catch {
    return candidate;
  }
}

export function readTrackerFile(root: string, sibling?: string): string | null {
  const tracker = resolveTrackerPath(root);
  const file = sibling ? path.join(path.dirname(tracker), sibling) : tracker;
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "ENOENT") return null;
    throw error;
  }
}
