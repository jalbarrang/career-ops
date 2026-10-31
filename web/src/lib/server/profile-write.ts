import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { rootScript } from "@/lib/career-ops";
import { rootScriptEnv } from "@/lib/core/root-env.mjs";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { parseValidationErrors } from "@/lib/cv-profile.mjs";

// THE one place the web app replaces data/career-profile.yml.
//
// Two routes now write it (the builder's save, and the import queue's follow-up
// consolidation of the entry it just created), and both must be gated by the
// core's own `career-profile.mjs validate` rather than a second opinion in the
// web app. Keeping the dump → validate → atomic replace sequence here means the
// two callers cannot drift into validating differently.
const VALIDATE_TIMEOUT_MS = 30_000;

export type ProfileWriteResult = { ok: true; backedUp: boolean } | { ok: false; errors: string[]; message: string };

function validateWithCore(script: string, root: string, file: string): Promise<{ valid: boolean; errors: string[] }> {
  return new Promise((resolve) => {
    execFile(
      "node",
      [script, "validate", file],
      { cwd: root, env: rootScriptEnv(root), timeout: VALIDATE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // `Invalid profile:` then one `- <error>` line each; a passing run prints
        // `Valid Master Career Profile: <path>` on stdout.
        resolve({ valid: !err, errors: parseValidationErrors(`${stdout ?? ""}\n${stderr ?? ""}`) });
      },
    );
  });
}

/**
 * Serialize, validate with the core, then replace the profile atomically with a
 * timestamped backup. A rejected document never touches the file on disk.
 *
 * The candidate bytes are validated from a temp file OUTSIDE the user's tree, so
 * a rejection cannot leave anything behind in it.
 */
export async function writeProfileValidated({ root, profile, file }: { root: string; profile: unknown; file: string }): Promise<ProfileWriteResult> {
  let dumped: string;
  try {
    dumped = yaml.dump(profile, { noRefs: true, lineWidth: 100 });
  } catch (error) {
    return { ok: false, errors: [], message: `could not serialize the profile: ${(error as Error).message}` };
  }

  const script = rootScript("career-profile");
  if (!script) return { ok: false, errors: [], message: "career-profile.mjs is not in this checkout" };

  let scratch = "";
  try {
    scratch = mkdtempSync(path.join(os.tmpdir(), "career-ops-profile-"));
    const candidate = path.join(scratch, "career-profile.yml");
    writeFileSync(candidate, dumped, "utf8");
    const validation = await validateWithCore(script, root, candidate);
    if (!validation.valid) return { ok: false, errors: validation.errors, message: "The core rejected this profile" };
  } catch (error) {
    return { ok: false, errors: [], message: `could not validate the profile: ${(error as Error).message}` };
  } finally {
    if (scratch) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // Temp dir outside the user's tree; a failed cleanup must not fail a
        // write that already succeeded.
      }
    }
  }

  try {
    const backedUp = atomicWriteWithBackup(file, dumped);
    return { ok: true, backedUp: Boolean(backedUp) };
  } catch {
    return { ok: false, errors: [], message: "write failed" };
  }
}
