import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { careerOpsRoot, rootScript } from "@/lib/career-ops";
import { rootScriptEnv } from "@/lib/core/root-env.ts";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { emptyProfile, ensureShape, parseValidationErrors, profileCounts, totalFacts, unverifiedCount } from "@/lib/cv-profile.ts";

// Read and write `data/career-profile.yml` for the builder.
//
// The core owns the schema and its validation (`career-profile.ts validate`),
// so a save is only committed after the core has accepted the exact bytes about
// to be written: dump -> temp file -> validate -> atomic replace. This module
// never reimplements `validateProfile`, which is the rule that keeps a profile
// the builder accepted from being one the pipeline rejects.
//
// The temp file lives in the OS temp dir, not the data root: a validation
// failure must not leave anything behind in the user's own tree.
const VALIDATE_TIMEOUT_MS = 30_000;

function profilePath(): string {
  return path.join(careerOpsRoot(), "data", "career-profile.yml");
}

function fingerprintOf(file: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

type Validation = { checked: boolean; valid: boolean; errors: string[] };

function validateWithCore(script: string, root: string, file: string): Promise<Validation> {
  return new Promise((resolve) => {
    execFile(
      "bun",
      [script, "validate", file],
      { cwd: root, env: rootScriptEnv(root), timeout: VALIDATE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // `Invalid profile:` then one `- <error>` line each; a passing run prints
        // `Valid Master Career Profile: <path>` on stdout.
        const errors = parseValidationErrors(`${stdout ?? ""}\n${stderr ?? ""}`);
        resolve({ checked: true, valid: !err, errors });
      },
    );
  });
}

export async function GET() {
  const root = careerOpsRoot();
  const file = profilePath();
  const script = rootScript("career-profile");
  const fingerprint = fingerprintOf(file);

  if (fingerprint === null) {
    const profile = emptyProfile();
    return Response.json({
      exists: false,
      profile,
      fingerprint: null,
      counts: profileCounts(profile),
      totalFacts: 0,
      unverified: 0,
      validation: { checked: false, valid: true, errors: [] },
    });
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(file, "utf8"));
  } catch (error) {
    // A broken file must not read as "no profile yet" (that is how a config gets
    // silently replaced with a default). Say what is wrong and let the user act.
    return Response.json({
      exists: true,
      error: `data/career-profile.yml could not be parsed: ${(error as Error).message}`,
    }, { status: 422 });
  }

  const profile = ensureShape(parsed);
  const validation: Validation = fs.existsSync(script)
    ? await validateWithCore(script, root, "data/career-profile.yml")
    : { checked: false, valid: true, errors: [] };

  return Response.json({
    exists: true,
    profile,
    fingerprint,
    counts: profileCounts(profile),
    totalFacts: totalFacts(profile),
    unverified: unverifiedCount(profile),
    validation,
  });
}

export async function POST({ request }: { request: Request }) {
  let body: { profile?: unknown; fingerprint?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  if (!body.profile || typeof body.profile !== "object" || Array.isArray(body.profile)) {
    return Response.json({ error: "profile required" }, { status: 400 });
  }

  const file = profilePath();
  const current = fingerprintOf(file);
  // The builder holds the whole document, so a save replaces what is on disk.
  // Without this check, an import approved in another tab (or by the CLI) would
  // be silently overwritten by a stale page.
  if (current !== null && typeof body.fingerprint === "string" && body.fingerprint !== current) {
    return Response.json({ error: "data/career-profile.yml changed since it was loaded — reload before saving" }, { status: 409 });
  }
  if (current === null && typeof body.fingerprint === "string" && body.fingerprint !== "") {
    return Response.json({ error: "data/career-profile.yml changed since it was loaded — reload before saving" }, { status: 409 });
  }

  const profile = ensureShape(body.profile);
  // The importer is the only writer that may initialize a profile from nothing;
  // this route only edits one that exists (or is being created deliberately by
  // the user pressing save in the builder).
  let dumped: string;
  try {
    dumped = yaml.dump(profile, { noRefs: true, lineWidth: 100 });
  } catch (error) {
    return Response.json({ error: `could not serialize the profile: ${(error as Error).message}` }, { status: 500 });
  }

  const root = careerOpsRoot();
  const script = rootScript("career-profile");
  if (fs.existsSync(script)) {
    let dir = "";
    try {
      dir = mkdtempSync(path.join(os.tmpdir(), "career-ops-profile-"));
      const candidate = path.join(dir, "career-profile.yml");
      writeFileSync(candidate, dumped, "utf8");
      const validation = await validateWithCore(script, root, candidate);
      if (!validation.valid) {
        return Response.json({ error: "The core rejected this profile", errors: validation.errors }, { status: 422 });
      }
    } catch (error) {
      return Response.json({ error: `could not validate the profile: ${(error as Error).message}` }, { status: 500 });
    } finally {
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // The temp dir is outside the user's tree; a failed cleanup must not
          // fail the save that already succeeded.
        }
      }
    }
  }

  try {
    const backedUp = atomicWriteWithBackup(file, dumped);
    return Response.json({ ok: true, backedUp: Boolean(backedUp), fingerprint: fingerprintOf(file) });
  } catch {
    return Response.json({ error: "write failed" }, { status: 500 });
  }
}
