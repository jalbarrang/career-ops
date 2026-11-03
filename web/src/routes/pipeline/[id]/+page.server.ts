import { error } from "@sveltejs/kit";
import { readReport, findApplication, pdfReadyForReport, trackerCanDelete } from "@/lib/career-ops";
import { resolveTailoredCover } from "@/lib/apply/cover";
import type { PageServerLoad } from "./$types";

// Read fresh local files on every request (the Next page's `dynamic =
// "force-dynamic"`), and 404 exactly where `notFound()` did.
export const load: PageServerLoad = async ({ params }) => {
  const id = params.id;
  const app = findApplication(id);
  const report = readReport(id);
  if (!app && !report) error(404, "Not found");
  // Resolved here rather than in the component so the link is only rendered when
  // THIS application's cover is actually on disk. `id` is passed as the
  // application number, never as a company: a report with no tracker row has no
  // identity to match on, and guessing one from the id would surface another
  // offer's cover.
  const coverReady = (await resolveTailoredCover(app?.company, id)) !== null;
  return {
    id,
    app,
    report: report?.content ?? null,
    file: report?.file ?? null,
    canDelete: trackerCanDelete(),
    pdfReadyFromIndex: await pdfReadyForReport(id),
    coverReady,
  };
};
