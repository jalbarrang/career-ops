import { pipelineSummary, readApplicationStatusLog, readStatusLog, type StatusLogRow } from "@/lib/career-ops";
import { cumulativeTilesWithHistory } from "@/lib/funnel-tiles.mjs";
import { canonStatus } from "@/lib/format";
import type { PageServerLoad } from "./$types";

// Two views behind one route, selected by ?view= so the tab is linkable and the
// assistant can navigate straight to it — the same "URL is the source of truth"
// rule pipeline-view.svelte follows for its tabs.
const VIEWS = ["progress", "insights"] as const;
type View = (typeof VIEWS)[number];

export const load: PageServerLoad = async ({ url }) => {
  const raw = url.searchParams.get("view");
  // Anything unrecognized falls back to progress rather than rendering an empty
  // page, so a stale or hand-edited link still lands somewhere useful.
  const view: View = (VIEWS as readonly string[]).includes(String(raw)) ? (String(raw) as View) : "progress";

  // Only the count is shared with the subheading; everything each view needs to
  // read, it reads for itself. Progress reaches into the core to recover funnel
  // history, and Insights renders none of that — so that read belongs behind
  // this branch, not out here where an incomplete core install would take the
  // whole route down with it.
  const { applications } = pipelineSummary();
  const total = applications.length;

  let statusLog: StatusLogRow[] = [];
  let interviews = 0;
  let offers = 0;

  if (view === "progress") {
    statusLog = readStatusLog();
    // CUMULATIVE, unlike the stage bars the page renders: these two tiles are
    // achievement counters whose zero-state shows a coaching nudge, so a
    // candidate who has already advanced past a stage must not read 0 for it (an
    // offer-holder was told "Interviews follow replies — keep follow-ups warm").
    // Mirrors everInterview/everOffer in stats.mjs, including stages recovered
    // from history.
    ({ interviews, offers } = await cumulativeTilesWithHistory(
      applications.map((a) => ({ n: a.n, status: canonStatus(a.status) })),
      readApplicationStatusLog(),
    ));
  }

  return { view, total, applications, statusLog, interviews, offers };
};
