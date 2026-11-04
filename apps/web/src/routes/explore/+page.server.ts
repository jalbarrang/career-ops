import fs from "node:fs";
import { seedExploreFilters } from "@/lib/core/portals";
import { readInbox, readApplications, careerOpsRoot } from "@/lib/career-ops";
import { DEFAULT_FILTERS } from "@/lib/explore";
import type { PageServerLoad } from "./$types";

// Read live data at request time so a bare checkout (or a build with no
// CAREER_OPS_ROOT) never fails — discovery seeds are best-effort.
export const load: PageServerLoad = () => {
  let seed: { filters: typeof DEFAULT_FILTERS; seededFrom: string[] } = { filters: DEFAULT_FILTERS, seededFrom: [] };
  try {
    seed = seedExploreFilters();
  } catch {
    /* bare checkout → defaults */
  }
  let rootExists = false;
  try {
    rootExists = fs.existsSync(careerOpsRoot());
  } catch {
    /* ignore */
  }
  return { seed, inboxSnapshot: readInbox(), appsSnapshot: readApplications(), rootExists };
};
