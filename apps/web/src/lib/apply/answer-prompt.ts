/**
 * answer-prompt.ts - build the planner's pre-fill instruction from a form.
 *
 * Plain .ts with no imports, for the same reason extract-json-object.ts is:
 * the prompt is the part of apply/prefill that decides what the model is
 * allowed to answer, and it was unreachable by a test while it lived inline in
 * the route. The sensitive-field carve-out on the fourth bullet is the line that
 * matters - it is what keeps legal, visa, work-authorization, salary and
 * demographic questions from being auto-filled - and nothing pinned it.
 *
 * Moved verbatim from api/apply/prefill/route.ts. The wording, the
 * tab-separated field list and the arrows are the prompt the planner has been
 * receiving all along; this is a relocation, not a rewrite.
 */

import { DEFAULT_PROFILE_REF, profileNote } from "../core/profile-path.ts";

/**
 * One form control, as much of it as the prompt needs. Structurally satisfied by
 * ApplyField, without importing it: extract.ts pulls in playwright-core, and a
 * module that does cannot be loaded by `node --test`.
 *
 * @typedef {Object} PromptField
 * @property {string} id
 * @property {string} type
 * @property {string} label
 * @property {boolean} [required]
 * @property {string[]} [options]
 */

/**
 * `cvSource` is the tailored CV being uploaded to this same form, as a
 * root-relative readable path (applyCvSource resolves it from the PDF the fill
 * route attaches). The tailoring is the whole point of it: bullets are
 * reselected per offer, role framing is rewritten toward the employer's domain,
 * and engagements may be regrouped under an umbrella firm. The reviewer reads
 * the structured fields beside the attachment, so drafting from master cv.md
 * contradicts the resume stapled to the form and discards the tailoring that
 * made the application relevant. The ownership split below mirrors modes/apply.md Step
 * 4b, which settles the same question on the CLI path. Null when no tailored CV
 * exists for this application, and only then does cv.md own the answers.
 *
 * @param {{title: string, fields: PromptField[], memory?: string, cvSource?: string | null}} opts
 * @returns {string}
 */
interface AnswerPromptOptions {
  title: string;
  fields: Array<{ id: string; type: string; required?: boolean; label: string; options?: string[] }>;
  memory?: string;
  cvSource?: string | null;
  profile?: string | null;
}

function buildAnswerPromptBody({ title, fields, memory = "", cvSource = null, profile }: AnswerPromptOptions) {
  const profileFile = typeof profile === "string" && profile.trim() ? profile : DEFAULT_PROFILE_REF;
  const fieldsList = fields
    .map((f) => `${f.id}\t${f.type}${f.required ? "*" : ""}\t${f.label}${f.options ? `\t[options: ${f.options.join(" | ")}]` : ""}`)
    .join("\n");
  const sources = cvSource
    ? `SOURCES. The document being attached to this form is the tailored CV at ${cvSource} — read it, and read ${profileFile}. If a matching report for this company exists in reports/, read it too.
- ${profileFile} owns name, email, phone, address, links, work authorization, visa status and comp expectations. It is authoritative; no CV overrides it.
- The tailored CV owns employer names, job titles, dates, locations, role descriptions, achievements, education, certifications, skills and the summary. The reviewer is holding it, so every experience answer must describe the roles as it states them.
- cv.md is the fallback only: read it for a whole section the tailored CV omits, never to top up a role the tailored CV already covers. Where the two disagree, the tailored CV wins.`
    : `SOURCES. No tailored CV was found for this application. Read cv.md and ${profileFile}; if a matching report for this company exists in reports/, read it too. ${profileFile} owns name, email, phone, address, links, work authorization, visa status and comp expectations, and is authoritative over cv.md.`;

  return `You are pre-filling a job application for the user (company/role: ${title}).

${sources}

Ground EVERY answer in the REAL candidate — never invent facts.${memory ? `\n\nDurable notes about the user:\n${memory}` : ""}

FIELDS (id ⇥ type ⇥ label ⇥ options):
${fieldsList}

For each field give the best answer:
- identity/contact (name, email, phone, github, linkedin, location) → from ${profileFile}.
- experience (employer, job title, dates, location, role description) → from the source that owns it above, verbatim in substance.
- free-text (Why us?, cover-letter, "most impactful thing you've built", etc.) → a concise, honest, concrete answer in the candidate's own voice (no buzzwords, active voice, real metrics only). Keep each under ~120 words.
- select/radio → choose the best-matching option using the EXACT option text from the list.
- NEVER fill legal / visa / work-authorization / salary / demographic / sensitive fields → set needs_confirmation:true and value:"".

Output ONLY a compact JSON object mapping each field id → {"value": "...", "needs_confirmation": boolean}. No prose, no markdown, no code fence.`;
}


/**
 * Build the apply-form answer prompt, naming the profile the agent must read.
 *
 * @param options - The form, optional tailored CV and profileRef().
 */
export function buildAnswerPrompt(options: AnswerPromptOptions): string {
  const body = buildAnswerPromptBody(options);
  const ref = typeof options.profile === "string" && options.profile.trim() ? options.profile : DEFAULT_PROFILE_REF;
  const note = profileNote(ref);
  return note ? `${body}\n\n${note}` : body;
}
