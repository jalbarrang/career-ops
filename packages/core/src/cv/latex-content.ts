/**
 * Content-level extract/patch for user-owned LaTeX CV templates.
 * v1 families: resumeSubheading | tabularx-itemize
 */

import { escapeLatex } from './latex-escape.ts';

/** The LaTeX CV layout families this module can extract prose from. */
export type LatexFamily = 'resumeSubheading' | 'tabularx-itemize';

/** Absolute character offsets of a slot's editable prose inside the source. */
export interface SlotSpan {
  start: number;
  end: number;
}

/** One editable prose slot, identified and positioned inside the source. */
export interface Slot {
  id: string;
  kind: string;
  text: string;
  span: SlotSpan;
}

/**
 * A slot before it is given an id. The extractors know where the prose sits
 * and what it says, but only `extractSlots` numbers the final slots.
 */
interface UnidentifiedSlot {
  kind: string;
  text: string;
  span: SlotSpan;
}

/** Manifest describing what `packages/cli/src/commands/cv/extract-latex-content.ts` found in a source. */
export interface LatexManifest {
  supported: boolean;
  family: LatexFamily | null;
  source: string;
  slots: Slot[];
  error?: string;
  hint?: string;
}

/** One requested replacement: the slot to rewrite and the prose to put there. */
export interface SlotPatch {
  id: string;
  text: string;
}

/** The part of a slot `applyPatches` needs: its id and where it sits. */
export interface SlotRef {
  id: string;
  span: SlotSpan;
}

/** Options for `extractMacroBodies`. */
interface MacroBodiesOptions {
  useNextGroupIfEmpty?: boolean;
}

/** Options for `applyPatches`. */
interface ApplyPatchesOptions {
  escape?: boolean;
}

export const SUPPORTED_FAMILIES: LatexFamily[] = ['resumeSubheading', 'tabularx-itemize'];

export const UNSUPPORTED_HINT =
  'Unsupported LaTeX CV layout. v1 supports \\resumeSubheading + \\resumeItem macros, ' +
  'or tabularx + itemize without resume macros. Use /career-ops latex (cv.md → career-ops template) instead.';

/**
 * @param tex
 * @param openIdx
 * @returns the index of the `}` matching the `{` at `openIdx`, or -1.
 */
export function findMatchingBrace(tex: string, openIdx: number): number {
  if (tex[openIdx] !== '{') return -1;
  let depth = 0;
  let escaped = false;
  for (let i = openIdx; i < tex.length; i++) {
    const ch = tex[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * @param tex
 */
export function detectFamily(tex: string): LatexFamily | null {
  if (typeof tex !== 'string' || !tex.trim()) return null;
  if (/\\resumeSubheading\b/.test(tex) && /\\(resumeItem|resumeItemWithoutTitle|resumeSubItem)\b/.test(tex)) {
    return 'resumeSubheading';
  }
  const hasTabularx = /\\usepackage\{[^}]*tabularx[^}]*\}/.test(tex) || /\\begin\{tabularx\}/.test(tex);
  const hasItemize = /\\begin\{itemize\}/.test(tex);
  if (hasTabularx && hasItemize && !/\\resumeSubheading\b/.test(tex)) {
    return 'tabularx-itemize';
  }
  return null;
}

/**
 * Index where the document body starts, so extraction can skip macro
 * definitions in the preamble (e.g. `\newcommand{\resumeSubItem}[2]{\resumeItem{#1}{#2}}`
 * would otherwise be captured as a `#1` slot).
 *
 * @param tex
 */
function bodyStart(tex: string): number {
  const docStart = tex.indexOf('\\begin{document}');
  return docStart === -1 ? 0 : docStart;
}

/**
 * True when `idx` sits on a line that is commented out at that position —
 * i.e. an unescaped `%` appears earlier on the same line. Commented macro
 * calls are inert LaTeX (often old bullets kept for reference) and must not
 * become editable slots.
 *
 * @param tex
 * @param idx
 */
function isCommentedAt(tex: string, idx: number): boolean {
  const lineStart = tex.lastIndexOf('\n', idx - 1) + 1;
  for (let i = lineStart; i < idx; i++) {
    if (tex[i] === '\\') {
      i++; // skip escaped char (\% is a literal percent)
      continue;
    }
    if (tex[i] === '%') return true;
  }
  return false;
}

/**
 * Extract macro argument bodies as editable slots. Spans are absolute
 * offsets into `tex`; scanning starts at the document body.
 *
 * `useNextGroupIfEmpty` handles the common `\resumeItemWithoutTitle{}{Text}`
 * pattern (one-parameter macro called with an empty first group followed by a
 * plain braced group): when the captured group is empty/whitespace, the slot
 * points at the immediately following braced group instead.
 *
 * @param tex
 * @param macroName
 * @param kind
 * @param opts
 */
function extractMacroBodies(
  tex: string,
  macroName: string,
  kind: string,
  { useNextGroupIfEmpty = false }: MacroBodiesOptions = {},
): Slot[] {
  const slots: Slot[] = [];
  const needle = `\\${macroName}{`;
  let searchFrom = bodyStart(tex);
  while (searchFrom < tex.length) {
    const idx = tex.indexOf(needle, searchFrom);
    if (idx === -1) break;
    if (isCommentedAt(tex, idx)) {
      searchFrom = idx + needle.length;
      continue;
    }
    const openBrace = idx + needle.length - 1;
    const closeBrace = findMatchingBrace(tex, openBrace);
    if (closeBrace === -1) break;
    let innerStart = openBrace + 1;
    let innerEnd = closeBrace;
    searchFrom = closeBrace + 1;

    if (useNextGroupIfEmpty && !tex.slice(innerStart, innerEnd).trim()) {
      let cursor = closeBrace + 1;
      while (cursor < tex.length && /\s/.test(tex[cursor])) cursor++;
      if (tex[cursor] !== '{') continue; // empty group with no follow-up group — nothing editable
      const openNext = cursor;
      const closeNext = findMatchingBrace(tex, openNext);
      if (closeNext === -1) break;
      innerStart = openNext + 1;
      innerEnd = closeNext;
      searchFrom = closeNext + 1;
    }

    slots.push({
      id: `${kind}-${slots.length}`,
      kind,
      text: tex.slice(innerStart, innerEnd),
      span: { start: innerStart, end: innerEnd },
    });
  }
  return slots;
}

/**
 * Extract the value argument of `\resumeSubItem{Category}{Items}` calls as
 * skill slots. The category (first group) is left untouched; only the second
 * group is editable.
 *
 * @param tex
 */
function extractSubItemValues(tex: string): UnidentifiedSlot[] {
  const slots: UnidentifiedSlot[] = [];
  const needle = '\\resumeSubItem{';
  let searchFrom = bodyStart(tex);
  while (searchFrom < tex.length) {
    const idx = tex.indexOf(needle, searchFrom);
    if (idx === -1) break;
    if (isCommentedAt(tex, idx)) {
      searchFrom = idx + needle.length;
      continue;
    }
    const openCat = idx + needle.length - 1;
    const closeCat = findMatchingBrace(tex, openCat);
    if (closeCat === -1) break;
    searchFrom = closeCat + 1;

    let cursor = closeCat + 1;
    while (cursor < tex.length && /\s/.test(tex[cursor])) cursor++;
    if (tex[cursor] !== '{') continue;
    const openVal = cursor;
    const closeVal = findMatchingBrace(tex, openVal);
    if (closeVal === -1) break;

    slots.push({
      kind: 'skill',
      text: tex.slice(openVal + 1, closeVal),
      span: { start: openVal + 1, end: closeVal },
    });
    searchFrom = closeVal + 1;
  }
  return slots;
}

/**
 * @param tex
 */
function extractSkillValues(tex: string): UnidentifiedSlot[] {
  const slots: UnidentifiedSlot[] = [];
  let searchFrom = bodyStart(tex);
  while (searchFrom < tex.length) {
    const idx = tex.indexOf('\\textbf{', searchFrom);
    if (idx === -1) break;
    if (isCommentedAt(tex, idx)) {
      searchFrom = idx + 8;
      continue;
    }
    const openCat = tex.indexOf('{', idx);
    const closeCat = findMatchingBrace(tex, openCat);
    if (closeCat === -1) break;

    let cursor = closeCat + 1;
    while (cursor < tex.length && /\s/.test(tex[cursor])) cursor++;
    if (tex[cursor] !== '{') {
      searchFrom = closeCat + 1;
      continue;
    }

    const openVal = cursor;
    const closeVal = findMatchingBrace(tex, openVal);
    if (closeVal === -1) break;

    const rawValue = tex.slice(openVal + 1, closeVal);
    const colon = rawValue.match(/^:\s*/);
    if (!colon) {
      searchFrom = closeVal + 1;
      continue;
    }

    const itemsStart = openVal + 1 + colon[0].length;
    const itemsText = tex.slice(itemsStart, closeVal);
    slots.push({
      kind: 'skill',
      text: itemsText,
      span: { start: itemsStart, end: closeVal },
    });
    searchFrom = closeVal + 1;
  }
  return slots;
}

/**
 * @param tex
 */
function extractItemizeItems(tex: string): Slot[] {
  const docStart = tex.indexOf('\\begin{document}');
  const body = docStart === -1 ? tex : tex.slice(docStart);
  const offset = docStart === -1 ? 0 : docStart;
  const slots: Slot[] = [];
  const itemRe = /\\item\b/g;
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(body)) !== null) {
    if (isCommentedAt(body, match.index)) continue;
    let i = match.index + match[0].length;
    while (i < body.length && /\s/.test(body[i])) i++;

    if (body[i] === '{') {
      const openBrace = i;
      const closeBrace = findMatchingBrace(body, openBrace);
      if (closeBrace === -1) continue;
      slots.push({
        id: `item-${slots.length}`,
        kind: 'item',
        text: body.slice(openBrace + 1, closeBrace),
        span: { start: offset + openBrace + 1, end: offset + closeBrace },
      });
      continue;
    }

    const lineEnd = body.indexOf('\n', i);
    const end = lineEnd === -1 ? body.length : lineEnd;
    const text = body.slice(i, end).trim();
    if (!text) continue;
    slots.push({
      id: `item-${slots.length}`,
      kind: 'item',
      text,
      span: { start: offset + i, end: offset + end },
    });
  }
  return slots;
}

/**
 * @param tex
 * @param family
 */
export function extractSlots(tex: string, family: LatexFamily): Slot[] {
  if (family === 'resumeSubheading') {
    const byPosition = <T extends { span: SlotSpan }>(a: T, b: T): number => a.span.start - b.span.start;
    const dedupe = <T extends { span: SlotSpan }>(list: T[]): T[] => {
      const seen = new Set<string>();
      return list.filter(s => {
        const key = `${s.span.start}-${s.span.end}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const bullets: Slot[] = dedupe([
      ...extractMacroBodies(tex, 'resumeItem', 'bullet'),
      ...extractMacroBodies(tex, 'resumeItemWithoutTitle', 'bullet', { useNextGroupIfEmpty: true }),
    ].sort(byPosition)).map((s, i) => ({ ...s, id: `bullet-${i}` }));
    const skills: Slot[] = dedupe([
      ...extractSkillValues(tex),
      ...extractSubItemValues(tex),
    ].sort(byPosition)).map((s, i) => ({ ...s, id: `skill-${i}` }));
    return [...bullets, ...skills];
  }
  if (family === 'tabularx-itemize') {
    return extractItemizeItems(tex);
  }
  return [];
}

/**
 * @param texPath
 * @param tex
 */
export function buildManifest(texPath: string, tex: string): LatexManifest {
  const family = detectFamily(tex);
  if (!family) {
    return {
      supported: false,
      family: null,
      source: texPath,
      slots: [],
      error: UNSUPPORTED_HINT,
      hint: 'Place resume.tex in the project root or set latex.source in config/profile.yml.',
    };
  }

  const slots = extractSlots(tex, family);
  return {
    supported: true,
    family,
    source: texPath,
    slots,
  };
}

/**
 * @param tex
 * @param patches
 * @param slots
 * @param opts
 */
export function applyPatches(
  tex: string,
  patches: readonly SlotPatch[],
  slots: readonly SlotRef[],
  { escape = true }: ApplyPatchesOptions = {},
): string {
  const seen = new Set<string>();
  for (const patch of patches) {
    if (seen.has(patch.id)) throw new Error(`Duplicate patch id: ${patch.id}`);
    seen.add(patch.id);
  }
  const slotById = new Map<string, SlotRef>(slots.map((s): [string, SlotRef] => [s.id, s]));
  const ordered = [...patches]
    .map(p => {
      const slot = slotById.get(p.id);
      if (!slot) return null;
      return { slot, text: p.text };
    })
    .filter((entry): entry is { slot: SlotRef; text: string } => entry !== null)
    .sort((a, b) => b.slot.span.start - a.slot.span.start);

  let out = tex;
  for (const { slot, text } of ordered) {
    const replacement = escape ? escapeLatex(text) : text;
    out = out.slice(0, slot.span.start) + replacement + out.slice(slot.span.end);
  }
  return out;
}
