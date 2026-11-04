/**
 * context-budget.ts — Token budget management for career-ops evaluators
 *
 * Provides lightweight token estimation and priority-based compression of
 * _shared.md context sections. Keeps evaluation-critical sections (P0:
 * scoring, archetypes, legitimacy, source-of-truth rules, global rules) intact while trimming
 * generation-oriented sections (P2: voice DNA, writing style, ATS rules)
 * when the prompt approaches the model's context limit.
 *
 * Zero external dependencies — uses character-based estimation (~4 chars/token
 * for English text) with a safety margin to stay within model context windows.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Compression priority of a `_shared.md` section: 0 is never removed, 2 goes first. */
export type SectionPriority = 0 | 1 | 2;

/**
 * A `_shared.md` section split off its `## Header` delimiter, or the preamble
 * before the first header (which carries the empty name '').
 */
export interface ContextSection {
  name: string;
  content: string;
}

/** Options for buildBudgetedPrompt(). Every field is optional; defaults apply. */
export interface BudgetedPromptOptions {
  /** Raw _shared.md content. */
  sharedContent?: string;
  /** Raw oferta.md content (evaluation mode). */
  ofertaContent?: string;
  /** Raw cv.md content (candidate resume). */
  cvContent?: string;
  /** Raw profile.yml content (optional). */
  profileYml?: string;
  /** Raw _profile.md content (optional). */
  profileContent?: string;
  /** The job description text to evaluate. */
  jdText?: string;
  /** Model id for context window lookup. */
  modelName?: string;
  /** Explicit context window override. */
  maxTokens?: number;
  /** Reserved for output tokens (default 8192). */
  safetyMargin?: number;
  /** If true, skip compression entirely. */
  noCompress?: boolean;
}

/** Token accounting for one assembled prompt. */
export interface BudgetReport {
  totalTokens: number;
  budget: number;
  compressed: boolean;
  removed: string[];
  beforeTokens: number;
  afterTokens: number;
  overBudget: boolean;
}

/** The assembled prompt body plus the token accounting behind it. */
export interface BudgetedPrompt {
  contextBody: string;
  budgetReport: BudgetReport;
}

// ---------------------------------------------------------------------------
// Token estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the number of tokens in a text string.
 *
 * Uses a simple character-based heuristic: effective characters ÷ 4.
 * Whitespace is collapsed before counting. This is ~12% accurate for English
 * prose, which is sufficient when combined with a safety margin.
 *
 * Accepts `unknown` because callers hand it untrusted option values; anything
 * that is not a string estimates as 0 tokens rather than throwing.
 *
 * @param text - The text to estimate tokens for.
 * @returns Estimated token count (always ≥ 0).
 */
export function estimateTokens(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0;
  // Collapse whitespace (tokens aren't sensitive to repeated spaces/newlines)
  const effectiveChars = text.replace(/\s+/g, ' ').length;
  return Math.ceil(effectiveChars / 4);
}

// ---------------------------------------------------------------------------
// Section priority classification
// ---------------------------------------------------------------------------

/**
 * Priority map for _shared.md sections.
 *
 * P0 (never compress): Scoring System, Archetype Detection, Posting Legitimacy,
 *   Sources of Truth, Global Rules — these directly determine evaluation quality.
 * P1 (compress when budget tight): Company Type taxonomy, Spend Tier routing —
 *   useful but the model often has this knowledge baked in.
 * P2 (prefer to compress): Voice DNA, Writing Style Calibration, Professional
 *   Writing & ATS — these serve text generation, not scoring.
 *
 * Sections not listed default to P2 (safe to compress).
 *
 * Keys are lowercase for case-insensitive matching against `## Section Name` headers.
 */
export const SECTION_PRIORITY: Record<string, SectionPriority> = {
  // P0 — evaluation-critical (never compress)
  'scoring system': 0,
  'archetype detection': 0,
  'posting legitimacy': 0,
  'global rules': 0,
  'data root & path resolution': 0,
  'sources of truth': 0,

  // P1 — useful but non-critical (compress when budget tight)
  'company type and compensation reliability': 1,
  'spend tier': 1,

  // P2 — generation-oriented (prefer to compress)
  'voice dna': 2,
  'writing style calibration': 2,
  'writing style': 2,
  'professional writing & ats compatibility': 2,
};

/**
 * Default priority for sections not explicitly listed in SECTION_PRIORITY.
 * Conservative: unknown sections are treated as safe to compress (P2).
 */
export const DEFAULT_PRIORITY: SectionPriority = 2;

// ---------------------------------------------------------------------------
// Context budget defaults
// ---------------------------------------------------------------------------

/**
 * Default maximum prompt tokens (GPT-4o-mini context window).
 */
export const DEFAULT_MAX_TOKENS: number = 128000;

const MODEL_CONTEXT_WINDOWS: Map<string, number> = new Map(Object.entries({
  'MiniMax-M3': 1000000,
  'MiniMax-M2.7': 204800,
}));

/** Return the known model context window, or the existing default. */
export function contextWindowForModel(modelName?: string): number {
  if (modelName === undefined) return DEFAULT_MAX_TOKENS;
  return MODEL_CONTEXT_WINDOWS.get(modelName) ?? DEFAULT_MAX_TOKENS;
}

/**
 * Safety margin reserved for the model's maxOutputTokens / response.
 */
export const DEFAULT_SAFETY_MARGIN: number = 8192;

// ---------------------------------------------------------------------------
// Section parsing helpers
// ---------------------------------------------------------------------------

/**
 * Split _shared.md into an array of { name, content } section objects.
 *
 * Sections are delimited by `## Section Name` headers. Content before the
 * first `## ` header is treated as a preamble (name = '').
 *
 * @param sharedContent - Raw _shared.md content.
 * @returns One entry per section, preamble first when present.
 */
function parseSections(sharedContent: string): ContextSection[] {
  const sections: ContextSection[] = [];
  // Split on `## ` at line start, capturing the header text.
  // Parts[0] = preamble, then [header1, body1, header2, body2, ...]
  const parts = sharedContent.split(/^## (.+)$/gm);

  if (parts[0] && parts[0].trim()) {
    sections.push({ name: '', content: parts[0] });
  }

  for (let i = 1; i < parts.length; i += 2) {
    const name = (parts[i] || '').trim();
    const body = parts[i + 1] || '';
    if (name) {
      sections.push({ name, content: `## ${name}${body}` });
    }
  }

  return sections;
}

/** Tracks already-warned section names to avoid log spam. */
const _warnedSections: Set<string> = new Set();

/**
 * Look up the priority of a section by its header name.
 *
 * Emits a warning when a section falls through to DEFAULT_PRIORITY so drift
 * between _shared.md headings and SECTION_PRIORITY is observable.
 *
 * @param sectionName - The section header text (e.g., "Scoring System").
 * @returns 0 (P0), 1 (P1), or 2 (P2 / default).
 */
function getPriority(sectionName: string): SectionPriority {
  const key = sectionName.toLowerCase()
    // Strip parenthetical suffixes like "(Block G)" or "(writing guardrail)"
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!(key in SECTION_PRIORITY) && !_warnedSections.has(key)) {
    _warnedSections.add(key);
    console.warn(`⚠️  Unrecognized _shared.md section "${sectionName}" → defaulting to P${DEFAULT_PRIORITY} (compressible). Update SECTION_PRIORITY in lib/context-budget.ts if this section is evaluation-critical.`);
  }
  return SECTION_PRIORITY[key] ?? DEFAULT_PRIORITY;
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/**
 * A parsed section plus the priority and token cost used to decide whether it
 * survives compression. The preamble gets priority -1 (never removable).
 */
interface ClassifiedSection extends ContextSection {
  priority: -1 | SectionPriority;
  tokens: number;
}

/**
 * Compress _shared.md content by removing lower-priority sections.
 *
 * Sections are identified by `## Section Name` headers and removed in
 * priority order (P2 first, then P1) until the target token reduction
 * is met or no more removable sections remain.
 *
 * P0 sections (scoring, archetypes, legitimacy, global rules) are never removed.
 *
 * @param sharedContent - Raw _shared.md content.
 * @param targetReduction - Target number of tokens to remove.
 * @returns compressed — the content with sections removed; removed — list of
 *   section names that were removed.
 */
export function compressSharedContext(sharedContent: string, targetReduction: number): { compressed: string; removed: string[] } {
  if (!sharedContent || targetReduction <= 0) {
    return { compressed: sharedContent || '', removed: [] };
  }

  const sections = parseSections(sharedContent);
  if (sections.length === 0) {
    return { compressed: sharedContent, removed: [] };
  }

  // Classify each section
  const classified: ClassifiedSection[] = sections.map(s => ({
    ...s,
    priority: s.name ? getPriority(s.name) : -1, // preamble: never remove
    tokens: estimateTokens(s.content),
  }));

  // Collect removable sections (P2 first, then P1), sorted by priority descending (2 before 1)
  const removable = classified
    .filter(s => s.priority >= 1)
    .sort((a, b) => b.priority - a.priority); // P2 before P1

  let tokensRemoved = 0;
  const removed: string[] = [];

  for (const section of removable) {
    if (tokensRemoved >= targetReduction) break;
    tokensRemoved += section.tokens;
    removed.push(section.name);
  }

  // Build compressed output: keep sections not in the removed set
  const removedSet = new Set(removed);
  const compressed = classified
    .filter(s => !removedSet.has(s.name))
    .map(s => s.content)
    .join('');

  return { compressed, removed };
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

/** One labelled chunk of the evaluator prompt, before token estimation. */
interface PromptSectionDefinition extends ContextSection {
  /** Only _shared.md may be trimmed; every other chunk is passed through whole. */
  compressible: boolean;
}

/** A prompt chunk with its estimated token cost. */
interface PromptSection extends PromptSectionDefinition {
  tokens: number;
}

/**
 * Build a token-budgeted context body for job offer evaluation.
 *
 * Assembles the context sections from _shared.md, oferta.md, cv.md, and
 * optional profile files. If the total estimated tokens exceed the available
 * budget, lower-priority sections of _shared.md are compressed.
 *
 * The returned `contextBody` is inserted between the evaluator's header
 * and operating rules — each evaluator (Gemini, OpenAI) keeps its own
 * framing text.
 *
 * @param opts - Section contents plus the model/budget overrides.
 * @returns contextBody — the assembled context sections string; budgetReport —
 *   the token accounting (totalTokens, budget, compressed, removed,
 *   beforeTokens, afterTokens, overBudget).
 */
export function buildBudgetedPrompt(opts: BudgetedPromptOptions | null = {}): BudgetedPrompt {
  const safeOpts: BudgetedPromptOptions = opts ?? {};
  const {
    sharedContent = '',
    ofertaContent = '',
    cvContent = '',
    profileYml = '',
    profileContent = '',
    jdText = '',
    modelName,
    maxTokens = contextWindowForModel(modelName),
    safetyMargin = DEFAULT_SAFETY_MARGIN,
    noCompress = false,
  } = safeOpts;

  const budget = maxTokens - safetyMargin;

  // Build the ordered section list (matches the evaluator prompt structure)
  const sectionDefs: PromptSectionDefinition[] = [
    { name: '_shared.md', content: sharedContent, compressible: true },
    { name: 'oferta.md', content: ofertaContent, compressible: false },
    { name: 'cv.md', content: cvContent, compressible: false },
  ];

  if (profileYml) {
    sectionDefs.push({ name: 'profile.yml', content: profileYml, compressible: false });
  }
  if (profileContent) {
    sectionDefs.push({ name: '_profile.md', content: profileContent, compressible: false });
  }

  // JD is always last and non-compressible
  sectionDefs.push({ name: 'JD', content: jdText, compressible: false });

  // Calculate per-section tokens
  const sections: PromptSection[] = sectionDefs.map(s => ({
    ...s,
    tokens: estimateTokens(s.content),
  }));

  const estimatedTotal = sections.reduce((sum, s) => sum + s.tokens, 0);

  // Build the budget report
  const report: BudgetReport = {
    totalTokens: estimatedTotal,
    budget,
    compressed: false,
    removed: [],
    beforeTokens: estimatedTotal,
    afterTokens: estimatedTotal,
    overBudget: false,
  };

  // If under budget or compression disabled, assemble as-is
  if (estimatedTotal <= budget || noCompress) {
    report.overBudget = estimatedTotal > budget;
    const contextBody = assembleContext(sections.map(s => ({
      name: s.name,
      content: s.content,
    })));
    return { contextBody, budgetReport: report };
  }

  // Need to compress _shared.md
  const reductionNeeded = estimatedTotal - budget;
  // The definition list above always starts with _shared.md, so index 0 is it.
  const sharedSection = sections[0];
  const { compressed, removed } = compressSharedContext(sharedSection.content, reductionNeeded);

  report.compressed = removed.length > 0;
  report.removed = removed;

  // Rebuild sections with compressed _shared.md
  const compressedSections: PromptSection[] = sections.map(s => {
    if (s.name === '_shared.md') {
      const compressedTokens = estimateTokens(compressed);
      return { ...s, content: compressed, tokens: compressedTokens };
    }
    return s;
  });

  report.afterTokens = compressedSections.reduce((sum, s) => sum + s.tokens, 0);
  report.overBudget = report.afterTokens > budget;

  const contextBody = assembleContext(compressedSections.map(s => ({
    name: s.name,
    content: s.content,
  })));

  return { contextBody, budgetReport: report };
}

// ---------------------------------------------------------------------------
// Internal: assemble context sections into the prompt body
// ---------------------------------------------------------------------------

/**
 * @param sections - The prompt chunks to render, in order.
 * @returns The labelled chunks joined into one prompt body ('' when empty).
 */
function assembleContext(sections: ContextSection[]): string {
  const labels: Record<string, string> = {
    '_shared.md':   'SYSTEM CONTEXT (_shared.md)',
    'oferta.md':    'EVALUATION MODE (oferta.md)',
    'cv.md':        'CANDIDATE RESUME (cv.md)',
    'profile.yml':  'CANDIDATE PROFILE & TARGETS (config/profile.yml)',
    '_profile.md':  'USER ARCHETYPES & NARRATIVE (_profile.md)',
    'JD':           'JOB DESCRIPTION',
  };

  const parts: string[] = [];
  for (const s of sections) {
    if (!s.content) continue;
    const label = labels[s.name] || s.name;
    parts.push(
      `═══════════════════════════════════════════════════════\n` +
      `${label}\n` +
      `═══════════════════════════════════════════════════════\n` +
      `${s.content}`
    );
  }

  return parts.join('\n\n');
}
