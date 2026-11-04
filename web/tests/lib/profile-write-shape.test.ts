import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import * as yaml from "js-yaml";

// Same Node alias-loader convention as apply-cv-resolver.test.ts. Import the
// real route handlers and safe writer, with only CAREER_OPS_ROOT redirected.
const webSrc = fileURLToPath(new URL("../../src/", import.meta.url));
const loader = `
  import { existsSync } from "node:fs";
  import path from "node:path";
  import { pathToFileURL } from "node:url";
  export async function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = path.join(${JSON.stringify(webSrc)}, specifier.slice(2));
      for (const ext of [".ts", ".tsx", ".ts", ".js", ""]) {
        if (existsSync(base + ext)) return { url: pathToFileURL(base + ext).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  }
`;
register(`data:text/javascript,${encodeURIComponent(loader)}`, pathToFileURL(webSrc));

const { POST: updateProfile } = await import("../../src/routes/api/profile/+server.ts");
const { POST: updateCadence } = await import("../../src/routes/api/followups/cadence/+server.ts");

const routes: RouteFixture[] = [
  { name: "profile", post: updateProfile, patch: { name: "Updated Fixture Candidate" } },
  { name: "followups/cadence", post: updateCadence, patch: { applied_first_days: 9 } },
];
const template = "candidate:\n  full_name: Template Candidate\n  location: Template City\ncompensation:\n  currency: USD\n";

/** One route under test, plus the patch that proves the write landed. */
interface RouteFixture {
  name: string;
  post: (event: { request: Request }) => Promise<Response>;
  /** The one field each route's patch is expected to change. */
  patch: { name?: string; applied_first_days?: number };
}

/** The parts of config/profile.yml these assertions index into. Both sequences
 *  exist in every fixture the merge cases use, so they are not optional here. */
interface ProfileDoc {
  candidate: { full_name?: string; email?: string };
  compensation?: { target_range?: string };
  followup_cadence: { applied_first_days?: number; applied_max_followups?: number };
}

async function withFixture(
  source: string | undefined,
  fn: (paths: { config: string; file: string }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "career-ops-profile-shape-"));
  const config = path.join(root, "config");
  const file = path.join(config, "profile.yml");
  mkdirSync(config);
  writeFileSync(path.join(config, "profile.example.yml"), template);
  if (source !== undefined) writeFileSync(file, source);
  const previous = process.env.CAREER_OPS_ROOT;
  process.env.CAREER_OPS_ROOT = root;
  try {
    await fn({ config, file });
  } finally {
    if (previous === undefined) delete process.env.CAREER_OPS_ROOT;
    else process.env.CAREER_OPS_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

// SvelteKit's +server.ts handlers take a request event, not a bare Request, so
// this helper builds the event both routes are called with.
function request(route: RouteFixture): { request: Request } {
  return {
    request: new Request(`http://fixture.invalid/api/${route.name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(route.patch),
    }),
  };
}

for (const route of routes) {
  const shapes: Array<[string, string]> = [
    ["list", "- candidate:\n    full_name: Fixture Candidate\n  compensation:\n    target_range: 100-120\n"],
    ["text scalar", "Fixture candidate notes that must survive\n"],
    ["number scalar", "42\n"],
    ["boolean scalar", "true\n"],
    ["timestamp scalar", "2026-09-12\n"],
    ["null", "null\n"],
    ["empty document", "# Existing profile to repair\n"],
    ["malformed YAML", "candidate: [broken\n"],
  ];
  for (const [shape, source] of shapes) {
    test(`${route.name} rejects an existing ${shape} without writing or backing it up`, async () => {
      await withFixture(source, async ({ config, file }) => {
        const beforeFiles = readdirSync(config).sort();
        const response = await route.post(request(route));
        assert.equal(response.status, 409);
        assert.match((await response.json()).error, /refusing to overwrite/i);
        assert.equal(readFileSync(file, "utf8"), source);
        assert.deepEqual(readdirSync(config).sort(), beforeFiles, "no backup or temp files on rejection");
      });
    });
  }

  test(`${route.name} still merges a valid mapping and backs up the original bytes`, async () => {
    const source = "# Keep these original bytes in the backup\ncandidate:\n  full_name: Fixture Candidate\n  email: fixture@example.invalid\ncompensation:\n  target_range: 100-120\nfollowup_cadence:\n  applied_first_days: 7\n  applied_max_followups: 3\n";
    await withFixture(source, async ({ config, file }) => {
      const response = await route.post(request(route));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
      const expected = yaml.load(source) as ProfileDoc;
      if (route.name === "profile") expected.candidate.full_name = route.patch.name;
      else expected.followup_cadence.applied_first_days = route.patch.applied_first_days;
      assert.deepEqual(yaml.load(readFileSync(file, "utf8")), expected);
      const backups = readdirSync(config).filter((name) => name.startsWith("profile.yml.bak-"));
      assert.equal(backups.length, 1);
      assert.equal(readFileSync(path.join(config, backups[0]), "utf8"), source);
    });
  });

  test(`${route.name} still creates a missing profile from the template`, async () => {
    await withFixture(undefined, async ({ config, file }) => {
      assert.equal(existsSync(file), false);
      const response = await route.post(request(route));
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ok, true);
      const expected = yaml.load(template) as ProfileDoc;
      if (route.name === "profile") expected.candidate.full_name = route.patch.name;
      else expected.followup_cadence = route.patch;
      assert.deepEqual(yaml.load(readFileSync(file, "utf8")), expected);
      assert.deepEqual(readdirSync(config).sort(), ["profile.example.yml", "profile.yml"]);
    });
  });
}
