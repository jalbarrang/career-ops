import { doctorState, readApplications, readInbox } from "@/lib/career-ops";
import { todaySnapshot } from "@/lib/home/today-snapshot.mjs";
import { scoreNum } from "@/lib/format";
import type { PageServerLoad } from "./$types";

// Always read fresh local files at request time (the Next page's `export const
// dynamic = "force-dynamic"`, i.e. never at build — CI has no user data).
// SvelteKit prerenders nothing by default, so a server load already runs per
// request.
export const load: PageServerLoad = () => {
  const snapshot = { applications: readApplications(), inbox: readInbox() };
  const { phase, onboardingNeeded } = doctorState(snapshot);

  // First run (truly empty install): the CV-upload takeover IS the home — value
  // before commitment. The full dashboard returns once they have a CV or any data.
  if (phase === "first-run") return { phase, onboardingNeeded, applications: [], inbox: [] };

  const { inbox, applications } = todaySnapshot(snapshot, scoreNum);
  // Established / in-between: the dual-loop retention dashboard. Show the setup
  // banner whenever ANY prereq is missing (mirrors the core doctor.mjs), so a
  // portals-missing user is nudged rather than told "all caught up".
  return { phase, onboardingNeeded, applications, inbox };
};
