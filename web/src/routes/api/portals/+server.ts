import path from "node:path";
import * as yaml from "js-yaml";
import { json } from "@sveltejs/kit";
import { careerOpsRoot } from "@/lib/career-ops";
import { atomicWriteWithBackup } from "@/lib/core/safe-write";
import { PortalsConfigError, loadPortalsDocument, mergePortalFilters } from "@/lib/portals-config.mjs";

// Merge-safe writer for portals.yml's web-owned filters (a USER-LAYER file).
// Replaces title_filter.positive and, when provided, location_filter.allow;
// seeds from templates/portals.example.yml on first create; and PRESERVES
// tracked_companies plus every other block. Atomic write, confirm-gated
// (setProfile/setPortals). This loads the first home scan after role confirmation.

export async function POST({ request }) {
  let body: { roles?: string[]; location?: string[] };
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, { status: 400 });
  }
  const roles = (Array.isArray(body.roles) ? body.roles : []).map((r) => String(r).trim()).filter(Boolean).slice(0, 24);
  if (roles.length === 0) return json({ error: "no roles" }, { status: 400 });

  const root = careerOpsRoot();
  const file = path.join(root, "portals.yml");
  let doc: Record<string, unknown>;
  try {
    ({ doc } = loadPortalsDocument(file, path.join(root, "templates", "portals.example.yml")));
  } catch (error) {
    const invalidUserConfig = error instanceof PortalsConfigError && error.kind === "invalid-user-config";
    return json(
      { error: error instanceof Error ? error.message : "could not load portals.yml" },
      { status: invalidUserConfig ? 409 : 500 },
    );
  }

  const locations = Array.isArray(body.location) ? body.location.map((l) => String(l).trim()).filter(Boolean) : undefined;
  doc = mergePortalFilters(doc, roles, locations);

  try {
    atomicWriteWithBackup(file, yaml.dump(doc, { lineWidth: 100, noRefs: true }));
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : "write failed" }, { status: 500 });
  }
  return json({ ok: true, roles: roles.length });
}
