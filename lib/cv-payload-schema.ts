/**
 * Shared CV payload key contract for build-cv-html.ts and build-cv-latex.ts.
 *
 * Both builders render each list section from a fixed set of keys. A payload
 * that names them differently produced an empty block while the JSON report
 * still said {"valid": true} — an education section written as
 * {institution, degree, dates} against the HTML builder rendered nothing at
 * all, and CVs went out with no education section (#3523).
 *
 * The two formats do NOT share one schema, which is how the confusion starts:
 * the LaTeX template's education entry really is {institution, degree, location,
 * dates, coursework}, while the HTML template's is {title, org, location, year,
 * description}. Keeping both tables side by side here makes the divergence
 * explicit and lets each builder reject the other's vocabulary by name instead
 * of silently dropping it.
 */

/** The output formats with a key contract of their own. */
export type PayloadFormat = 'html' | 'tex';

/** A predicate deciding whether a required field carries renderable content. */
export type FieldRule = (value: unknown) => boolean;

/** Per format, per section: the keys the builder reads and the ones it needs. */
export interface EntryFieldSpec {
  /** Without these the entry renders no visible line. */
  required: readonly string[];
  /** Every key the builder reads for this entry. */
  known: readonly string[];
  /** Per-field overrides of the default `hasText` presence rule. */
  rules?: Readonly<Record<string, FieldRule>>;
}

/** The verdict `validatePayload()` returns: errors are fatal, warnings are not. */
export interface PayloadValidation {
  errors: string[];
  warnings: string[];
}

// Per format, per section: the keys the builder reads (`known`) and the ones
// without which the entry renders no visible line (`required`).
export const ENTRY_FIELD_SPECS: Record<PayloadFormat, Record<string, EntryFieldSpec>> = {
  html: {
    experience: {
      required: ['company', 'role'],
      known: ['company', 'role', 'location', 'context', 'dates', 'period', 'bullets'],
    },
    projects: {
      required: ['name'],
      known: ['name', 'badge', 'description', 'bullets', 'tech', 'url'],
    },
    education: {
      required: ['title'],
      known: ['title', 'org', 'location', 'year', 'description'],
    },
    certifications: { required: ['title'], known: ['title', 'org', 'year'] },
    awards: { required: ['title'], known: ['title', 'org', 'year'] },
    // category is optional — buildSkills() renders the line without its prefix.
    skills: { required: ['items'], known: ['category', 'items'], rules: { items: hasRenderableItems } },
  },
  tex: {
    experience: {
      required: ['company', 'role'],
      known: ['company', 'role', 'location', 'dates', 'bullets'],
    },
    projects: {
      required: ['name'],
      known: ['name', 'context', 'dates', 'bullets', 'url'],
    },
    education: {
      required: ['institution', 'degree'],
      known: ['institution', 'degree', 'location', 'dates', 'coursework'],
    },
    awards: { required: ['title'], known: ['title', 'org', 'year'] },
    skills: { required: ['items'], known: ['category', 'items'], rules: { items: hasRenderableItems } },
  },
};

// Every root key a builder reads. validatePayload() iterates the spec table, so
// without this it can only see sections it already knows: a payload whose
// section is misspelled ("educations") matches no spec, is never visited, and
// validates clean while the section silently vanishes from the output — the
// same failure as a mistyped field name, one level up (#3523).
export const KNOWN_ROOT_KEYS: Record<PayloadFormat, readonly string[]> = {
  html: [
    'lang', 'page_format', 'country', 'candidate', 'sections', 'summary', 'competencies',
    'experience', 'projects', 'education', 'certifications', 'awards',
    'interests', 'skills', 'consent',
  ],
  tex: [
    'name', 'contact_line', 'email', 'linkedin', 'github',
    'education', 'experience', 'projects', 'awards', 'skills',
  ],
};

// Sections a format has no template block for. Passing them is not an error —
// the payload may be shared across formats — but the entries vanish, so say so
// rather than dropping them in silence.
export const UNRENDERED_SECTIONS: Record<PayloadFormat, readonly string[]> = {
  html: [],
  tex: ['certifications', 'competencies', 'interests', 'summary'],
};

/** True for a non-null, non-array object — the shape every payload level must be. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The section specs for `format`, or undefined when it names no known format.
 * Kept explicit so the lookup only ever reads the table's own keys.
 */
function specsFor(format: string): Record<string, EntryFieldSpec> | undefined {
  return format === 'html' || format === 'tex' ? ENTRY_FIELD_SPECS[format] : undefined;
}

/**
 * A required field counts as present only when it carries non-blank text, so
 * {"title": ""} fails exactly like an absent key.
 *
 * Strings only, deliberately. escapeHtml() renders '' for an object or array
 * and escapeLatex() renders '' for anything that is not a string, so a
 * {"title": {}} would otherwise pass validation and then write the very empty
 * block this module exists to prevent. escapeHtml()'s support for numeric
 * scalars (a payload with year: 2024) is unaffected: it applies to optional
 * fields, which this predicate does not gate.
 *
 * @param value
 */
export function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * `skills[].items` is the one required field that is not plain text: both
 * builders accept a comma-separated string OR an array of strings (joinItems()
 * in the HTML builder, the Array.isArray() branch in the LaTeX one). An empty
 * array, or an array of blanks, renders nothing — so it fails like an absent
 * key, while hasText() stays strict for every other field.
 *
 * EVERY element must be text, not merely one of them: both builders join the
 * whole array, so ['JavaScript', {}] reaches the CV as
 * "JavaScript, [object Object]". A quantifier of `some` would let exactly the
 * junk this module exists to catch through on the strength of its neighbours.
 *
 * @param value
 */
export function hasRenderableItems(value: unknown): boolean {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return items.length > 0 && items.every(item => hasText(item));
  }
  return hasText(value);
}

/**
 * What a root key carries, phrased for a warning — '' when it carries nothing.
 *
 * Arrays, plain objects, text and bare scalars are all shapes a mistyped or
 * unsupported section arrives in: {"educations": [...]}, {"educations": {...}},
 * {"summary": "..."} and {"summary": 2026} are the same mistake wearing
 * different clothes, and a check that only counts arrays sees one of four.
 *
 * Note this deliberately does NOT reuse hasText() for scalars. hasText() is
 * string-only because a required FIELD must render as text, but the question
 * here is different — "did someone put something here that will not render?" —
 * and a number or a boolean answers yes. Sharing the predicate across both
 * questions is what let {"summary": 2026} through in silence.
 */
function populatedContent(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length > 0 ? `${value.length} entr${value.length > 1 ? 'ies' : 'y'}` : '';
  }
  if (value && typeof value === 'object') {
    return Object.keys(value).length > 0 ? 'its content' : '';
  }
  if (value === null || value === undefined) return '';
  // Any remaining scalar (number, boolean, bigint, symbol) was put there on
  // purpose and will not render; a blank or whitespace-only string was not.
  return typeof value === 'string' ? (value.trim() !== '' ? 'its content' : '') : 'its content';
}

// A required field is present when its own rule says so; hasText is the default.
function fieldPresent(entry: Record<string, unknown>, field: string, spec: EntryFieldSpec): boolean {
  const rule: FieldRule = (spec.rules && spec.rules[field]) || hasText;
  return rule(entry[field]);
}

/**
 * Used by the builders as their entry filter: an entry that cannot produce a
 * visible line is dropped rather than emitted as an empty block. The CLIs stop
 * on these before rendering, so this only matters for direct builder calls.
 *
 * @param entry
 * @param section
 * @param format
 */
export function hasRequiredFields(entry: unknown, section: string, format: string): boolean {
  if (!isPlainRecord(entry)) return false;
  const spec = specsFor(format)?.[section];
  if (!spec) return true;
  return spec.required.every(field => fieldPresent(entry, field, spec));
}

/**
 * Validate a CV payload against one format's key contract.
 *
 * @param payload
 * @param format
 * @returns errors are fatal (the caller must not render); warnings describe
 *   keys or sections that will be ignored.
 */
export function validatePayload(payload: unknown, format: string): PayloadValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isPlainRecord(payload)) {
    errors.push('expected the CV payload to be an object, got '
      + (Array.isArray(payload) ? 'an array' : payload === null ? 'null' : typeof payload));
    return { errors, warnings };
  }
  // Narrowed here so every lookup below reads one format's own tables.
  if (format !== 'html' && format !== 'tex') {
    errors.push(`unknown payload format: ${format}`);
    return { errors, warnings };
  }
  const specs = ENTRY_FIELD_SPECS[format];
  const plural = (list: readonly string[]): string => (list.length > 1 ? 's' : '');

  for (const [section, spec] of Object.entries(specs)) {
    const entries = payload[section];
    if (entries === undefined || entries === null) continue;
    if (!Array.isArray(entries)) {
      errors.push(`${section}: expected an array, got ${typeof entries}`);
      continue;
    }
    const list: unknown[] = entries;
    list.forEach((entry: unknown, i: number) => {
      const where = `${section}[${i}]`;
      if (!isPlainRecord(entry)) {
        errors.push(`${where}: expected an object with keys ${spec.known.join(', ')}`);
        return;
      }
      const missing = spec.required.filter(field => !fieldPresent(entry, field, spec));
      const unknown = Object.keys(entry).filter(key => !spec.known.includes(key));
      if (missing.length) {
        errors.push(
          `${where}: missing required field${plural(missing)} ${missing.join(', ')}`
          + (unknown.length
            ? ` — unrecognised key${plural(unknown)} present: ${unknown.join(', ')}`
            : '')
          + ` (known keys: ${spec.known.join(', ')})`
        );
      } else if (unknown.length) {
        warnings.push(
          `${where}: unrecognised key${plural(unknown)} ${unknown.join(', ')} `
          + `will be ignored (known keys: ${spec.known.join(', ')})`
        );
      }
    });
  }

  // An unrecognised root key is a warning, not an error: a payload may be
  // shared across formats and legitimately carry keys this builder ignores.
  // Only a populated one is worth reporting — an empty array or a blank string
  // would have rendered nothing anyway.
  const knownRoots = KNOWN_ROOT_KEYS[format];
  // A section this format declares as unrendered gets the specific message from
  // the loop below — "the template has no such section" is a different fact from
  // "this looks like a typo", and emitting both for one key is noise in the
  // channel that has to stay readable to be read at all.
  const declaredUnrendered = new Set<string>(UNRENDERED_SECTIONS[format]);
  for (const key of Object.keys(payload)) {
    if (knownRoots.includes(key) || declaredUnrendered.has(key)) continue;
    const what = populatedContent(payload[key]);
    if (!what) continue;
    const near = knownRoots.filter(k => k.startsWith(key.slice(0, 4)) || key.startsWith(k.slice(0, 4)));
    warnings.push(
      `${key}: not a section the ${format} builder reads, so ${what} will not `
      + `appear in the output`
      + (near.length ? ` — did you mean ${near.join(' or ')}?` : '')
      + ` (known keys: ${knownRoots.join(', ')})`
    );
  }

  for (const section of UNRENDERED_SECTIONS[format]) {
    const what = populatedContent(payload[section]);
    if (what) {
      warnings.push(
        `${section}: the ${format} template has no ${section} section — `
        + `${what} will not appear in the output`
      );
    }
  }

  return { errors, warnings };
}
