import { pipelineSummary } from "@/lib/career-ops";
import type { PageServerLoad } from "./$types";

// Always read fresh local files (the Next page's `export const dynamic =
// "force-dynamic"`). The tab/min/sort state lives in the URL, so a query
// navigation re-runs this on every change — the same refetch Next did.
//
// Only the two arrays cross to the client: the summary's `root`/`rootExists`
// are server-side facts the view never renders.
export const load: PageServerLoad = () => {
  const { inbox, applications } = pipelineSummary();
  return { inbox, applications };
};
