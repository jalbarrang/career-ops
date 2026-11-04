#!/usr/bin/env node
/**
 * packages/cli/src/commands/profile/career-profile.ts — Master Career Profile importer (FORK: schema v2).
 *
 * FORK-OWNED. Upstream writes schema v1, where every non-bullet line in a CV
 * block becomes its own entry: `Series Entertainment`, `Senior Full Stack
 * Engineer:` and `March 2025 - September 2026` are three entries, the first two
 * empty, and the third carries all the bullets. This fork keeps the same review
 * protocol and writes a nested profile instead:
 *
 *   experiences:
 *     - company: { id, name, evidence }
 *       roles:
 *         - { id, name, period, location, review_status, evidence, facts[] }
 *
 * A block's lines are classified by SHAPE (a 4-digit year is a period, a
 * sentence is prose, the rest are names: first company, second role), and two
 * blocks naming the same company merge into one company with two roles — which
 * is what a promotion at one employer looks like.
 *
 * Commands (unchanged):
 *   import [cv.md] [--review]
 *   validate [profile.yml]
 *   prepare-cv --payload base.json --selection selection.json
 *   verify-cv --payload base.json --selection selection.json --prepared prepared.json
 */
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { createInterface } from 'readline';
import * as yaml from 'js-yaml';
import { loadYaml } from '../../packages/core/src/kernel/yaml-document.ts';
import { getCareerOpsRoot } from '../../packages/core/src/kernel/path-resolver.ts';
import { withPipelineLock } from '../../packages/core/src/kernel/pipeline-lock.ts';
import { validateProfile, loadValidatedProfile, SCHEMA_VERSION } from '../../packages/core/src/profile/career-profile.ts';
import { prepareCvSelection, verifyCvSelection } from '../../packages/core/src/profile/profile-cv-selection.ts';
import { flagValue, validateFlags } from '../../packages/core/src/kernel/cli-flags.ts';

const root = getCareerOpsRoot();
const profilePath = join(root, 'data', 'career-profile.yml');
const HELP = `Master Career Profile (fork schema v2: company -> roles)

  bun packages/cli/src/commands/profile/career-profile.ts import [cv.md] [--review]
    Preview candidates by default. --review asks you to approve, edit, or skip
    each item; only approved items are saved to data/career-profile.yml.

  bun packages/cli/src/commands/profile/career-profile.ts validate [profile.yml]
    Check the profile structure and source evidence.

  bun packages/cli/src/commands/profile/career-profile.ts prepare-cv --payload base.json --selection selection.json
    Print {payload, mapping} as JSON. Uses data/career-profile.yml by default.

  bun packages/cli/src/commands/profile/career-profile.ts verify-cv --payload base.json --selection selection.json --prepared prepared.json
    Recheck against the current profile and original inputs. Both commands
    accept --profile profile.yml; all paths resolve from the Data Root.
    Neither command renders a CV or replaces the existing CV fact gates.
`;

function normalizeKey(value) {
  return String(value).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
}

function stableId(kind, value, source, parent = '') {
  let normalizedSource = source.replaceAll('\\', '/').replace(/\/+/g, '/');
  if (process.platform === 'win32') normalizedSource = normalizedSource.toLocaleLowerCase('en-US');
  const identity = [kind, normalizedSource, normalizeKey(parent), normalizeKey(value)].join('\0');
  return `${kind}-${createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}

function evidenceKey(item) {
  return `${item?.evidence?.source ?? ''}\0${normalizeKey(item?.evidence?.quote ?? '')}`;
}

function classifyHeading(heading) {
  const text = heading.toLowerCase();
  if (/^(experience|work experience|employment|professional experience|pengalaman kerja|pengalaman)$/.test(text)) return 'experiences';
  if (/^(projects?|selected projects|portfolio|proyek|proyek pilihan)$/.test(text)) return 'projects';
  if (/^(education|academic background|pendidikan)$/.test(text)) return 'education';
  if (/^(skills?|technical skills|core competencies|keahlian|keterampilan)$/.test(text)) return 'skills';
  if (/^(certifications?|certificates?|licenses?|sertifikasi|sertifikat)$/.test(text)) return 'certifications';
  if (/^(summary|profile|about|professional summary|ringkasan|profil)$/.test(text)) return 'summary';
  return null;
}

/** A 4-digit year, and short enough to be a label rather than a paragraph. */
const isPeriod = (value) => /\b(?:19|20)\d{2}\b/.test(value) && !/[.;]$/.test(value) && value.length <= 40;
/** A sentence or a comma-separated list — cv.md prose, not a name. */
const isProse = (value) => value.length > 60 || /[.;]$/.test(value) || /,\s/.test(value);

/**
 * Read one CV block's lines as company / role / period.
 *
 * Shape only, and only when it is unambiguous: a block whose lines do not
 * classify leaves `role` null and the builder asks for it, rather than a guess
 * landing in the profile. A role line is often bolded with a trailing colon
 * ("Technical Lead:"), so the colon is trimmed.
 *
 * @param {{ text: string, line: number, quote: string }[]} lines
 */
function classifyBlock(lines) {
  let company = null;
  let role = null;
  let period = null;
  for (const entry of lines) {
    if (isPeriod(entry.text)) {
      if (!period) period = entry;
      continue;
    }
    if (isProse(entry.text)) continue;
    if (!company) company = entry;
    else if (!role) role = { ...entry, text: entry.text.replace(/:+\s*$/, '').trim() };
  }
  return { company, role, period };
}

/**
 * Parse cv.md into blocks.
 *
 * Experiences become blocks of consecutive non-bullet lines plus the facts that
 * follow them, so a role's company / title / dates stay together. Projects and
 * education keep the flat v1 shape the rest of the engine expects.
 */
function parseCv(text, source) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const result = { candidate: {}, summary: [], experiences: [], projects: [], education: [], certifications: [], skills: [] };
  let section = null;
  let entity = null;
  let block = null;

  const evidenceFor = (lineNo) => ({ source, line: lineNo, quote: lines[lineNo - 1].trim() });
  const newBlock = (lineNo, value) => ({
    id: stableId('experiences', value, source),
    lines: [{ text: value, line: lineNo, quote: lines[lineNo - 1].trim() }],
    facts: [],
  });
  const addFact = (collection, value, line) => {
    const fact = {
      id: stableId(collection, value, source, entity?.label ?? ''),
      text: value,
      evidence: evidenceFor(line),
      review_status: 'needs_review',
    };
    if (collection === 'summary' || collection === 'certifications' || collection === 'skills') result[collection].push(fact);
    else if (entity) entity.facts.push(fact);
    else {
      entity = { id: stableId(collection, `entry:${value}`, `${source}:${line}`), label: value, evidence: evidenceFor(line), facts: [] };
      result[collection].push(entity);
    }
  };

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    const line = raw.trim();
    if (!line) return;

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (heading) {
      const title = heading[2].trim();
      const found = classifyHeading(title);
      if (found) {
        section = found;
        entity = null;
        block = null;
        return;
      }
      if (section === 'experiences') {
        // A heading after facts starts a new role at the same or a new company.
        block = block && block.facts.length === 0
          ? (block.lines.push({ text: title, line: lineNo, quote: raw.trim() }), block)
          : newBlock(lineNo, title);
        if (!result.experiences.includes(block)) result.experiences.push(block);
        return;
      }
      if (section && ['projects', 'education'].includes(section)) {
        entity = { id: stableId(section, title, source), label: title, evidence: evidenceFor(lineNo), facts: [] };
        result[section].push(entity);
      }
      return;
    }

    if (!section) return;
    const value = line.replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/, '').replace(/^\*\*(.+?)\*\*:?\s*/, '$1: ').trim();
    if (!value) return;

    if (section === 'summary') addFact(section, value, lineNo);
    else if (section === 'skills') {
      for (const skill of value.split(/[,;|]/).map((part) => part.trim()).filter(Boolean)) addFact(section, skill, lineNo);
    } else if (section === 'certifications') addFact(section, value, lineNo);
    else if (section === 'experiences') {
      const bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(raw);
      if (bullet) {
        if (!block) {
          block = newBlock(lineNo, value);
          result.experiences.push(block);
        }
        block.facts.push({
          id: stableId('experiences', value, source, block.lines[0].text),
          text: value,
          evidence: evidenceFor(lineNo),
          review_status: 'needs_review',
        });
      } else {
        block = block && block.facts.length === 0
          ? (block.lines.push({ text: value, line: lineNo, quote: raw.trim() }), block)
          : newBlock(lineNo, value);
        if (!result.experiences.includes(block)) result.experiences.push(block);
      }
    } else if (['projects', 'education'].includes(section)) {
      if (/^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(raw) && entity) addFact(section, value, lineNo);
      else {
        entity = { id: stableId(section, value, source), label: value, evidence: evidenceFor(lineNo), facts: [] };
        result[section].push(entity);
      }
    }
  });

  for (const key of ['summary', 'certifications', 'skills']) {
    const unique = new Map();
    for (const fact of result[key]) if (!unique.has(fact.id)) unique.set(fact.id, fact);
    result[key] = [...unique.values()];
  }
  for (const key of ['projects', 'education']) {
    const unique = new Map();
    for (const entry of result[key]) if (!unique.has(entry.id)) unique.set(entry.id, entry);
    result[key] = [...unique.values()];
  }
  // Facts repeated inside one block are the same statement twice.
  for (const entry of result.experiences) {
    const seen = new Set();
    entry.facts = entry.facts.filter((fact) => {
      const key = normalizeKey(fact.text);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return result;
}

function readProfile(file) {
  if (!existsSync(file)) {
    return { schema_version: SCHEMA_VERSION, candidate: {}, summary: [], experiences: [], projects: [], education: [], certifications: [], skills: [] };
  }
  return loadValidatedProfile({ file });
}

async function ask(lines, question) {
  process.stdout.write(question);
  const answer = await lines.next();
  return answer.done ? null : answer.value.trim();
}

async function reviewFact(fact, label, lines) {
  process.stdout.write(`\n${label}: ${fact.text}\n  Evidence: ${fact.evidence.source}:${fact.evidence.line} — ${fact.evidence.quote}\n`);
  while (true) {
    const response = await ask(lines, '  [y] approve / [e] edit / [n] skip / [q] finish: ');
    if (response === null) return { quit: true };
    const answer = response.toLowerCase();
    if (answer === 'y') { fact.review_status = 'verified'; return { fact, edited: false }; }
    if (answer === 'n') return { fact: null, edited: false };
    if (answer === 'q') return { quit: true };
    if (answer === 'e') {
      const edited = await ask(lines, '  Revised wording (blank cancels): ');
      if (edited === null) return { quit: true };
      if (edited) { fact.text = edited; fact.review_status = 'verified'; return { fact, edited: true }; }
    }
  }
}

/**
 * Merge incoming companies into the existing profile.
 *
 * Identity is the company NAME (one card per employer), and inside a company the
 * role is identified by its evidence line, so a re-import after the CV grew by a
 * paragraph updates the same role instead of adding a twin. Ids survive: a role
 * keeps its prior id, which is what a saved CV selection is bound to.
 */
/**
 * Identify a role within its company.
 *
 * The evidence line alone is not enough: two stints at one employer can use the
 * SAME heading text (`### Acme — Analyst` twice), and the parser gives both the
 * same quote. The bullets they own are what actually distinguishes them, so the
 * fact signatures are part of the identity — which is also why reordering the
 * same-titled blocks keeps each id attached to its own facts.
 */
function roleSignature(role) {
  return (role?.facts ?? []).map((fact) => evidenceKey(fact)).sort().join('\0');
}

function roleIdentity(role) {
  return `${evidenceKey(role)}\0${roleSignature(role)}`;
}

/**
 * Which prior role an incoming one continues.
 *
 * Roles sharing an evidence line are disambiguated by how many facts they have
 * in common — that is what a re-import of a reordered same-titled block looks
 * like. A role that gained a bullet still overlaps on the ones it already had,
 * so its id survives the edit.
 */
function matchRole(roles, incoming) {
  const evidence = evidenceKey(incoming);
  const candidates = roles
    .map((role, index) => ({ role, index }))
    .filter(({ role }) => evidenceKey(role) === evidence);
  if (candidates.length <= 1) return candidates.length === 1 ? candidates[0].index : -1;

  const incomingFacts = new Set((incoming.facts ?? []).map((fact) => evidenceKey(fact)));
  let bestIndex = -1;
  let bestScore = 0;
  for (const { role, index } of candidates) {
    const score = (role.facts ?? []).filter((fact) => incomingFacts.has(evidenceKey(fact))).length;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex === -1 ? candidates[0].index : bestIndex;
}

function mergeExperiences(existing, incoming, { editedFacts = new Set(), editedLines = new Set() } = {}) {
  const byName = new Map();
  // A company the user RENAMED in review no longer matches its CV line, so the
  // name cannot be the only identity: the evidence line it came from still does,
  // and without this fallback a re-import would add a twin company.
  const byEvidence = new Map();
  const order = [];
  for (const company of existing) {
    const key = normalizeKey(company?.company?.name ?? '');
    if (!key) continue;
    if (!byName.has(key)) {
      byName.set(key, { ...company, roles: [...(company.roles ?? [])] });
      order.push(key);
    }
    const evidence = evidenceKey(company.company);
    if (evidence.trim() && !byEvidence.has(evidence)) byEvidence.set(evidence, key);
  }

  for (const company of incoming) {
    const key = normalizeKey(company.company.name);
    const matchedKey = byName.has(key) ? key : byEvidence.get(evidenceKey(company.company));
    if (!matchedKey) {
      byName.set(key, company);
      order.push(key);
      const evidence = evidenceKey(company.company);
      if (evidence.trim() && !byEvidence.has(evidence)) byEvidence.set(evidence, key);
      continue;
    }
    const prior = byName.get(matchedKey);
    const roles = [...prior.roles];
    for (const role of company.roles) {
      const index = matchRole(roles, role);
      if (index === -1) {
        roles.push(role);
        continue;
      }
      const previous = roles[index];
      const facts = [...(previous.facts ?? [])];
      for (const fact of role.facts) {
        const factIndex = facts.findIndex((candidate) => evidenceKey(candidate) === evidenceKey(fact));
        if (factIndex === -1) facts.push(fact);
        else {
          const kept = facts[factIndex];
          facts[factIndex] = {
            ...kept,
            // Only an explicit rewording replaces the stored text. Plain
            // approval refreshes evidence, so a re-import after the CV moved
            // cannot silently undo an edit made last time.
            text: editedFacts.has(evidenceKey(kept)) ? fact.text : kept.text,
            evidence: fact.evidence,
            review_status: fact.review_status,
          };
        }
      }
      roles[index] = {
        ...previous,
        // An edited role title wins; otherwise the stored title stands, because a
        // plain re-approval must not revert what the user wrote last time.
        name: editedLines.has(evidenceKey(role)) ? role.name : (previous.name || role.name),
        period: role.period ?? previous.period,
        location: role.location ?? previous.location,
        evidence: role.evidence,
        review_status: role.review_status,
        facts,
      };
    }
    byName.set(matchedKey, {
      ...prior,
      // The company name follows an edit to the line it came from; otherwise the
      // stored name stands, so a plain re-approval cannot revert a rename.
      company: {
        ...prior.company,
        name: editedLines.has(evidenceKey(company.company)) ? company.company.name : prior.company.name,
        evidence: company.company.evidence,
      },
      roles,
    });
  }

  return order.map((key) => byName.get(key));
}

async function doImport(args) {
  const review = args.includes('--review');
  const sourceArg = args.find((arg) => !arg.startsWith('--')) || 'cv.md';
  const sourcePath = resolve(root, sourceArg);
  if (!existsSync(sourcePath)) throw new Error(`CV file not found: ${sourcePath}`);
  const relativeSource = relative(root, sourcePath);
  const outsideRoot = relativeSource === '..' || relativeSource.startsWith(`..${sep}`) || isAbsolute(relativeSource);
  const source = outsideRoot ? sourcePath : relativeSource.split(sep).join('/');
  const extracted = parseCv(readFileSync(sourcePath, 'utf8'), source);

  // The review queue is per LINE and per FACT, exactly as before — that is the
  // protocol the web queue drives — while the write below assembles the blocks.
  const candidates = [];
  for (const key of ['summary', 'experiences', 'projects', 'education', 'certifications', 'skills']) {
    for (const item of extracted[key]) {
      if (key === 'experiences') {
        item.lines.forEach((line, index) => candidates.push({ key, block: item, line, index, label: 'experiences heading' }));
        item.facts.forEach((fact) => candidates.push({ key, block: item, fact, label: `experiences: ${item.lines.at(-1)?.text ?? ''}` }));
      } else if ('facts' in item) {
        candidates.push({ key, item, label: `${key} heading` });
        item.facts.forEach((fact) => candidates.push({ key, item, fact, label: `${key}: ${item.label}` }));
      } else candidates.push({ key, fact: item, label: key });
    }
  }
  process.stdout.write(`Found ${candidates.length} review candidates in ${source}.\n`);
  if (!review) {
    for (const { fact, item, line, label } of candidates) process.stdout.write(`- ${label}: ${fact?.text ?? line?.text ?? item.label}\n`);
    process.stdout.write('Preview only; rerun with --review to approve items and save.\n');
    return;
  }

  const approved = {
    ...extracted,
    candidate: { ...extracted.candidate },
    summary: [], experiences: [], projects: [], education: [], certifications: [], skills: [],
  };
  // Which lines/facts of each block survived review.
  const keptLines = new Map();
  const keptFacts = new Map();
  // Skipping a job's FIRST line means "not this job", so its bullets are not
  // prompted for and not written — the same rule v1 applied to an entry heading.
  const skippedBlocks = new Set();
  // Evidence keys the user rewrote in this run. Only these may replace stored
  // text on a merge; a plain approval refreshes evidence and nothing else.
  const editedFacts = new Set();
  const editedLines = new Set();
  const skippedEntities = new Set();
  let quit = false;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = input[Symbol.asyncIterator]();

  try {
    for (const entry of candidates) {
      if (quit) break;
      if (entry.fact && entry.item && skippedEntities.has(entry.item.id)) continue;

      if (entry.key === 'experiences' && entry.line) {
        // A dropped block is done: the CLI must not prompt its remaining lines,
        // or the answers a caller queued for them land on the NEXT block — the
        // desync that once wrote one employer's bullets onto another.
        if (skippedBlocks.has(entry.block)) continue;
        const target = {
          id: `${entry.block.id}:${entry.index}`,
          text: entry.line.text,
          evidence: { source, line: entry.line.line, quote: entry.line.quote },
          review_status: 'needs_review',
        };
        const decision = await reviewFact(target, entry.label, lines);
        if (decision.quit) { quit = true; break; }
        if (!decision.fact) {
          if (entry.index === 0) skippedBlocks.add(entry.block);
          continue;
        }
        if (decision.edited) editedLines.add(evidenceKey(decision.fact));
        if (!keptLines.has(entry.block)) keptLines.set(entry.block, []);
        keptLines.get(entry.block).push({ ...entry.line, text: decision.fact.text });
        continue;
      }

      if (entry.key === 'experiences' && entry.fact) {
        if (skippedBlocks.has(entry.block)) continue;
        const kept = keptLines.get(entry.block) ?? [];
        const decision = await reviewFact(entry.fact, entry.label, lines);
        if (decision.quit) { quit = true; break; }
        if (!decision.fact) continue;
        if (decision.edited) editedFacts.add(evidenceKey(decision.fact));
        if (!keptFacts.has(entry.block)) keptFacts.set(entry.block, []);
        keptFacts.get(entry.block).push(decision.fact);
        if (kept.length === 0) keptLines.set(entry.block, entry.block.lines.slice(0, 1));
        continue;
      }

      const target = entry.fact ?? { id: entry.item.id, text: entry.item.label, evidence: entry.item.evidence, review_status: 'needs_review' };
      const decision = await reviewFact(target, entry.label, lines);
      if (decision.quit) { quit = true; break; }
      if (!decision.fact) {
        if (!entry.fact) skippedEntities.add(entry.item.id);
        continue;
      }
      const result = decision.fact;
      if (entry.fact) {
        if (entry.item && 'facts' in entry.item) {
          const kept = approved[entry.key].find((x) => x.id === entry.item.id);
          if (kept) kept.facts.push(result);
          else approved[entry.key].push({ ...entry.item, review_status: 'verified', facts: [result] });
        } else approved[entry.key].push(result);
      } else approved[entry.key].push({ ...entry.item, label: result.text, review_status: 'verified', facts: [] });
    }
  } finally {
    input.close();
  }

  // Assemble v2 companies from the approved blocks.
  for (const block of extracted.experiences) {
    if (skippedBlocks.has(block)) continue;
    const keptLineList = keptLines.get(block) ?? [];
    const facts = keptFacts.get(block) ?? [];
    if (keptLineList.length === 0 && facts.length === 0) continue;
    const lineList = keptLineList.length > 0 ? keptLineList : block.lines.slice(0, 1);
    const { company, role, period } = classifyBlock(lineList);
    const companyName = company?.text ?? lineList[0].text;
    const existing = approved.experiences.find((entry) => normalizeKey(entry.company.name) === normalizeKey(companyName));
    // A role's identity is its title plus the block it came from plus the facts
    // it owns: two untitled roles at one company are otherwise the same id, and
    // the profile would be rejected as a duplicate.
    const blockAnchor = `${(company ?? lineList[0]).quote}\0${facts[0]?.evidence?.quote ?? ''}\0${facts.length}`;
    const roleEntry = {
      id: stableId('experiences', role?.text ?? '', source, blockAnchor),
      name: role?.text ?? '',
      ...(period ? { period: period.text } : {}),
      review_status: 'verified',
      evidence: {
        source,
        line: (role ?? period ?? company ?? lineList[0]).line,
        quote: (role ?? period ?? company ?? lineList[0]).quote,
      },
      facts,
    };
    if (existing) {
      existing.roles.push(roleEntry);
    } else {
      approved.experiences.push({
        id: stableId('experiences', companyName, source),
        company: {
          name: companyName,
          evidence: {
            source,
            line: (company ?? lineList[0]).line,
            quote: (company ?? lineList[0]).quote,
          },
        },
        roles: [roleEntry],
      });
    }
  }

  const count = Object.values(approved).filter(Array.isArray).reduce((n, items) => n + items.length, 0);
  if (!count) {
    process.stdout.write('No approved items; profile was not changed.\n');
    return;
  }

  await withPipelineLock(profilePath, () => {
    const existing = readProfile(profilePath);
    const merged = {
      ...existing,
      schema_version: SCHEMA_VERSION,
      candidate: { ...existing.candidate, ...approved.candidate },
      experiences: mergeExperiences(existing.experiences ?? [], approved.experiences, { editedFacts, editedLines }),
    };
    for (const key of ['summary', 'projects', 'education', 'certifications', 'skills']) {
      const byId = new Map((existing[key] ?? []).map((item) => [item.id, item]));
      for (const item of approved[key]) {
        const old = byId.get(item.id);
        if (!old) byId.set(item.id, item);
        else if ('facts' in item) {
          const facts = new Map((old.facts ?? []).map((fact) => [fact.id, fact]));
          for (const fact of item.facts ?? []) facts.set(fact.id, facts.get(fact.id) ? { ...facts.get(fact.id), text: fact.text, evidence: fact.evidence, review_status: fact.review_status } : fact);
          byId.set(item.id, { ...old, ...item, facts: [...facts.values()] });
        } else byId.set(item.id, { ...old, ...item, evidence: item.evidence, review_status: item.review_status });
      }
      merged[key] = [...byId.values()];
    }
    const errors = validateProfile(merged);
    if (errors.length) throw new Error(`Import rejected:\n- ${errors.join('\n- ')}`);
    mkdirSync(dirname(profilePath), { recursive: true });
    const tmpPath = `${profilePath}.tmp`;
    try {
      writeFileSync(tmpPath, yaml.dump(merged, { noRefs: true, lineWidth: 100 }), { encoding: 'utf8', flag: 'w' });
      renameSync(tmpPath, profilePath);
    } catch (error) {
      try { rmSync(tmpPath, { force: true }); } catch { /* keep the save error, not the cleanup one */ }
      throw error;
    }
    const companyCount = merged.experiences.length;
    const roleCount = merged.experiences.reduce((n, company) => n + company.roles.length, 0);
    process.stdout.write(`Saved ${profilePath} — ${companyCount} company(ies), ${roleCount} role(s). Approved items are marked verified; existing entries were preserved.\n`);
  });
}

function doValidate(args) {
  const pathArg = args.find((arg) => !arg.startsWith('--'));
  const file = pathArg ? resolve(root, pathArg) : profilePath;
  if (!existsSync(file)) throw new Error(`Profile not found: ${file}`);
  const errors = validateProfile(loadYaml(readFileSync(file, 'utf8')));
  if (errors.length) { process.stderr.write(`Invalid profile:\n- ${errors.join('\n- ')}\n`); process.exitCode = 1; }
  else process.stdout.write(`Valid Master Career Profile: ${file}\n`);
}

function doCvSelection(command, args) {
  const flags = ['--payload', '--selection', '--profile', ...(command === 'verify-cv' ? ['--prepared'] : [])];
  validateFlags(args, [...flags, '--help', '-h'], HELP, { valueFlags: flags, requireOperand: true });
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].split('=')[0];
    if (!flags.includes(flag) || seen.has(flag)) throw new Error(`Unexpected or repeated argument: ${args[i]}`);
    seen.add(flag);
    if (!args[i].includes('=')) i++;
  }
  const required = ['--payload', '--selection', ...(command === 'verify-cv' ? ['--prepared'] : [])];
  for (const flag of required) if (!seen.has(flag)) throw new Error(`${flag} is required`);
  const fileFor = (flag) => resolve(root, flagValue(args, flag));
  const readJson = (flag) => JSON.parse(readFileSync(fileFor(flag), 'utf8'));
  const profile = loadValidatedProfile({ dataRoot: root, ...(seen.has('--profile') ? { file: fileFor('--profile') } : {}) });
  const inputs = { profile, basePayload: readJson('--payload'), selection: readJson('--selection') };
  if (command === 'prepare-cv') process.stdout.write(`${JSON.stringify(prepareCvSelection(inputs), null, 2)}\n`);
  else {
    verifyCvSelection(inputs, readJson('--prepared'));
    process.stdout.write('Valid Profile CV selection; existing CV checks are still required before rendering.\n');
  }
}

const [command, ...args] = process.argv.slice(2);
try {
  if (!command || command === '--help' || command === '-h') process.stdout.write(HELP);
  else if (command === 'import') await doImport(args);
  else if (command === 'validate') doValidate(args);
  else if (command === 'prepare-cv' || command === 'verify-cv') doCvSelection(command, args);
  else throw new Error(`Unknown command: ${command}\n\n${HELP}`);
} catch (error) {
  const context = ['profile_entry_id', 'fact_id', 'experience_index']
    .filter((key) => error[key] !== undefined)
    .map((key) => `${key}=${JSON.stringify(error[key])}`);
  process.stderr.write(`${error.code ? `[${error.code}] ` : ''}${error.message}${context.length ? ` (${context.join(', ')})` : ''}\n`);
  process.exitCode = 1;
}
