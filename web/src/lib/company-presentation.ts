// Human-facing company identity for tracker entries. The canonical `company`
// field remains the end employer, so `?` must never be replaced with the
// recruiter or agency recorded in `via`.

const DIRECT_VIA = /^(n\/?a|tbd|none|null|-|—|–)$/i;

/** The two tracker cells this module reads. */
export interface CompanyLike {
  company?: string;
  via?: string;
  role?: string;
}

/**
 * Return the label and logo identity appropriate for an application row.
 * This module is plain JavaScript so the UI and its Node regression tests use
 * exactly the same behavior.
 *
 * @param {{ company?: string, via?: string }} application
 * @returns {{ label: string, logoName: string }}
 */
export function companyPresentation({ company = "", via = "" }: CompanyLike = {}): { label: string; logoName: string } {
  const companyName = String(company).trim();
  const intermediary = String(via).trim();

  if (companyName !== "?") return { label: company, logoName: company };
  if (intermediary && !DIRECT_VIA.test(intermediary)) {
    return {
      label: `Confidential · via ${intermediary}`,
      logoName: intermediary,
    };
  }
  return { label: "Confidential employer", logoName: "Confidential employer" };
}

export function companySearchText(application: CompanyLike | null | undefined): string {
  const { label } = companyPresentation(application ?? {});
  return `${application?.company ?? ""} ${application?.via ?? ""} ${label} ${application?.role ?? ""}`;
}
