/**
 * Migration planning for the DDD/monorepo restructure.
 *
 * Run: bun scripts/migration/plan.ts [--json]
 *
 * Builds the old-path -> new-path map from three inputs:
 *   1. an explicit bounded-context assignment per repository file,
 *   2. the import graph (a module imported by core code must live in core),
 *   3. a rule: a shebang command script that no core module imports is a CLI
 *      command; everything else is core.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '../..');

export type Context =
  | 'kernel'
  | 'tracker'
  | 'pipeline'
  | 'scanning'
  | 'liveness'
  | 'evaluation'
  | 'cv'
  | 'profile'
  | 'interview'
  | 'outreach'
  | 'insights'
  | 'platform';

/** Root-level scripts and their bounded context. */
export const ROOT_CONTEXT: Record<string, Context> = {
  'add-entry.ts': 'cv',
  'agent-inbox.ts': 'platform',
  'analyze-patterns.ts': 'insights',
  'application-answers.ts': 'evaluation',
  'application-artifacts.ts': 'evaluation',
  'apply-scope.ts': 'platform',
  'archive-posting.ts': 'evaluation',
  'assessment-log.ts': 'insights',
  'ats-payload.ts': 'cv',
  'ats-vendor.ts': 'scanning',
  'audit-portals.ts': 'scanning',
  'batch-evaluate-gemini.ts': 'evaluation',
  'batch-tailor.ts': 'cv',
  'branded-successfactors.ts': 'scanning',
  'browser-extract.ts': 'scanning',
  'build-cv-html.ts': 'cv',
  'build-cv-latex.ts': 'cv',
  'build-dashboard.ts': 'platform',
  'calibrate.ts': 'insights',
  'career-profile.ts': 'profile',
  'check-jd-archive.ts': 'evaluation',
  'check-liveness.ts': 'liveness',
  'check-table-freshness.ts': 'platform',
  'classify-tier.ts': 'evaluation',
  'clean-markers.ts': 'platform',
  'closing-soon.ts': 'insights',
  'company-funded.ts': 'scanning',
  'company-history.ts': 'insights',
  'contact-extract.ts': 'outreach',
  'contact-lookup.ts': 'outreach',
  'contacts.ts': 'outreach',
  'coverage-check.ts': 'pipeline',
  'cv-experience-order.ts': 'cv',
  'cv-sections-core.ts': 'cv',
  'cv-sync-check.ts': 'cv',
  'cv-templates.ts': 'cv',
  'cv-title-check.ts': 'cv',
  'dead-boards.ts': 'scanning',
  'debrief-sync.ts': 'interview',
  'dedup-tracker.ts': 'tracker',
  'detect-reposts.ts': 'insights',
  'discard-analytics.ts': 'insights',
  'discover-ats.ts': 'scanning',
  'discover-new-companies.ts': 'scanning',
  'doctor.ts': 'platform',
  'eval-golden.ts': 'evaluation',
  'evaluation-cache.ts': 'evaluation',
  'extract-latex-content.ts': 'cv',
  'fetch-jd.ts': 'scanning',
  'filter-audit.ts': 'scanning',
  'find.ts': 'pipeline',
  'fingerprint-core.ts': 'scanning',
  'fix-report-links.ts': 'tracker',
  'fix-slugs.ts': 'scanning',
  'followup-cadence.ts': 'outreach',
  'followup-seed.ts': 'outreach',
  'funnel-stages.ts': 'insights',
  'funnel-velocity.ts': 'insights',
  'gemini-eval.ts': 'evaluation',
  'generate-cover-letter.ts': 'cv',
  'generate-latex.ts': 'cv',
  'generate-pdf.ts': 'cv',
  'github-evidence.ts': 'profile',
  'hired-share.ts': 'insights',
  'hired-wall-build.ts': 'insights',
  'history-ats-seeds.ts': 'scanning',
  'i18n-drift.ts': 'platform',
  'ics-interview.ts': 'interview',
  'img-to-pdf.ts': 'cv',
  'install-latex-engine.ts': 'cv',
  'intake.ts': 'profile',
  'invite-match.ts': 'interview',
  'jd-capture.ts': 'evaluation',
  'jd-similarity.ts': 'evaluation',
  'jd-skill-gap.ts': 'evaluation',
  'jsonc-parse.ts': 'kernel',
  'keyword-match.ts': 'evaluation',
  'learn.ts': 'profile',
  'linkedin-join.ts': 'outreach',
  'listing-fingerprint.ts': 'scanning',
  'liveness-api.ts': 'liveness',
  'liveness-browser.ts': 'liveness',
  'liveness-core.ts': 'liveness',
  'manifesto.ts': 'platform',
  'mark-pdf-ready.ts': 'tracker',
  'match-star.ts': 'interview',
  'merge-tracker.ts': 'tracker',
  'migrate-scan-runs.ts': 'scanning',
  'negotiation-roi.ts': 'insights',
  'normalize-statuses.ts': 'tracker',
  'ollama-eval.ts': 'evaluation',
  'onboard-write.ts': 'profile',
  'openai-eval.ts': 'evaluation',
  'openai-tailor.ts': 'cv',
  'openrouter-runner.ts': 'evaluation',
  'outcome.ts': 'tracker',
  'paste-reply.ts': 'outreach',
  'patch-latex-content.ts': 'cv',
  'path-resolver.ts': 'kernel',
  'persist-evaluation-report.ts': 'evaluation',
  'pipeline-lock.ts': 'kernel',
  'plugin-audit.ts': 'platform',
  'plugin-install.ts': 'platform',
  'plugins.ts': 'platform',
  'portal-health-lock.ts': 'kernel',
  'precheck-duplicate.ts': 'tracker',
  'prepare-application.ts': 'evaluation',
  'process-quality.ts': 'outreach',
  'profile-language.ts': 'profile',
  'rank-pipeline.ts': 'pipeline',
  'reconcile-pipeline.ts': 'pipeline',
  'reeval-candidates.ts': 'insights',
  'rejection-latency.ts': 'outreach',
  'remember-cli.ts': 'platform',
  'reply-matcher.ts': 'outreach',
  'reply-watch.ts': 'outreach',
  'reserve-report-num.ts': 'tracker',
  'role-matcher.ts': 'tracker',
  'salary-gap.ts': 'insights',
  'scan-ats-full.ts': 'scanning',
  'scan-dayforce.ts': 'scanning',
  'scan-hn.ts': 'scanning',
  'scan-interamt.ts': 'scanning',
  'scan.ts': 'scanning',
  'seed-fixture.ts': 'platform',
  'session-activity.ts': 'platform',
  'set-status.ts': 'tracker',
  'skill-extract.ts': 'evaluation',
  'skip-blockers.ts': 'insights',
  'stats.ts': 'insights',
  'story-provenance-check.ts': 'interview',
  'sync-batch-input.ts': 'pipeline',
  'sync-pdf-flags.ts': 'tracker',
  'theme-style.ts': 'cv',
  'title-keywords.ts': 'scanning',
  'tracker-links.ts': 'tracker',
  'tracker-parse.ts': 'tracker',
  'tracker-sync-check.ts': 'tracker',
  'tracker-utils.ts': 'tracker',
  'tracker.ts': 'tracker',
  'update-system.ts': 'platform',
  'upskill.ts': 'insights',
  'url-key.ts': 'kernel',
  'user-agent.ts': 'kernel',
  'validate-plugin-registry.ts': 'platform',
  'validate-portals.ts': 'scanning',
  'validate-profile.ts': 'profile',
  'validate-system-paths-coverage.ts': 'platform',
  'validate-untrusted-content-coverage.ts': 'platform',
  'verify-ats.ts': 'cv',
  'verify-cv-facts.ts': 'cv',
  'verify-cv-structure.ts': 'cv',
  'verify-pipeline.ts': 'platform',
  'verify-portals.ts': 'scanning',
  'weekly-digest.ts': 'interview',
};

/** `lib/` modules and their bounded context. */
export const LIB_CONTEXT: Record<string, Context> = {
  'admission-gate.ts': 'kernel',
  'agent-cli.ts': 'kernel',
  'ascii-fold.ts': 'kernel',
  'bun-floor.ts': 'kernel',
  'career-profile.ts': 'profile',
  'chromium-launch-error.ts': 'kernel',
  'cli-flags.ts': 'kernel',
  'context-budget.ts': 'kernel',
  'cv-markdown.ts': 'cv',
  'cv-payload-schema.ts': 'cv',
  'dir-lock.ts': 'kernel',
  'failure-excerpt.ts': 'kernel',
  'gemini-node-floor.ts': 'kernel',
  'golden-budget-analysis.ts': 'evaluation',
  'is-main-module.ts': 'kernel',
  'jd-archive-section.ts': 'evaluation',
  'latex-content.ts': 'cv',
  'latex-escape.ts': 'cv',
  'linkedin-url.ts': 'outreach',
  'local-today.ts': 'kernel',
  'outcome-dir.ts': 'tracker',
  'outcome-types.ts': 'tracker',
  'page-format.ts': 'cv',
  'parse-date.ts': 'kernel',
  'personalization.ts': 'profile',
  'pipeline-sections.ts': 'pipeline',
  'placeholder-cell.ts': 'tracker',
  'profile-cv-selection.ts': 'profile',
  'reply-proposals.ts': 'outreach',
  'run-bounded.ts': 'kernel',
  'scan-history-columns.ts': 'scanning',
  'scan-summary-marker.ts': 'scanning',
  'scratch-dirs.ts': 'kernel',
  'small-board.ts': 'scanning',
  'source-files.ts': 'kernel',
  'status-hooks.ts': 'tracker',
  'story-bank.ts': 'interview',
  'syntax-check.ts': 'kernel',
  'syntax-check-child.ts': 'kernel',
  'template-manifest.ts': 'cv',
  'title-filter-conflicts.ts': 'scanning',
  'tracker-addition.ts': 'tracker',
  'tsv-formula-escape.ts': 'kernel',
  'update-manifest.ts': 'platform',
  'walk-tree.ts': 'kernel',
  'yaml-document.ts': 'kernel',
};

/** Files that stay where they are (harness, config, tooling roots). */
export const STAYS = new Set([
  'test-all.ts',
  'playwright.cv.config.ts',
  'updater-migration-tests.ts',
  'upgrade-tests.ts',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'output', 'data', 'test-results', '.impeccable', 'dashboard', 'apps']);
/** Repo tooling that stays at the root: user-data-adjacent harnesses and the plugin layer. */
const STAYS_DIRS = new Set(['batch', 'scripts', 'plugins', 'fork', 'scaffolder']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const IMPORT_RE = /(?:from|import)\s*\(?\s*(['"])(\.[^'"]+)\1/g;

/**
 * Resolve a relative import specifier to an absolute .ts path, or null.
 */
export function resolveImport(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, base + '.ts', join(base, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep trying
    }
  }
  return null;
}

/** Command scripts declared in package.json ("bun <file>.ts"). */
function packageScriptFiles(): Set<string> {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const out = new Set<string>();
  for (const command of Object.values(pkg.scripts || {})) {
    for (const m of command.matchAll(/bun\s+([a-zA-Z0-9_./-]+\.ts)/g)) out.add(m[1]);
  }
  return out;
}

/**
 * A root file is a CLI command when it has a shebang, is wired to a package
 * script, or guards its tail with isMainModule(). Everything else is a module.
 */
function isCommandScript(file: string): boolean {
  const src = readFileSync(file, 'utf8');
  if (src.startsWith('#!')) return true;
  if (src.includes('isMainModule(import.meta.url)')) return true;
  return packageScriptFiles().has(relative(ROOT, file));
}

/**
 * Build the import graph and return old->new map for every moved file.
 */
export function buildMap(): Map<string, string> {
  const allFiles = walk(ROOT).filter((f) => {
    const rel = relative(ROOT, f);
    if (rel.startsWith('tests/') || rel.startsWith('web/')) return false;
    if (rel.startsWith('scripts/migration/')) return false;
    if (rel.includes('/') && STAYS_DIRS.has(rel.split('/')[0])) return false;
    return true;
  });
  const graph = new Map<string, string[]>();
  for (const file of allFiles) {
    const src = readFileSync(file, 'utf8');
    const deps: string[] = [];
    for (const m of src.matchAll(IMPORT_RE)) {
      const hit = resolveImport(file, m[2]);
      if (hit) deps.push(hit);
    }
    graph.set(file, deps);
  }

  // Core seeds: shared-kernel/lib, provider adapters, batch tooling, scripts,
  // plugins, and every root module that is not a shebang command script.
  const core = new Set<string>();
  for (const file of allFiles) {
    const rel = relative(ROOT, file);
    if (STAYS.has(rel)) continue;
    if (rel.startsWith('lib/') || rel.startsWith('providers/') || rel.startsWith('seeds/') || rel.startsWith('utils/')) {
      core.add(file);
      continue;
    }
    if (!rel.includes('/') && !isCommandScript(file)) core.add(file);
  }
  // Propagate: anything core imports is core.
  const queue = [...core];
  while (queue.length) {
    const file = queue.pop()!;
    for (const dep of graph.get(file) || []) {
      if (!core.has(dep)) {
        core.add(dep);
        queue.push(dep);
      }
    }
  }

  const map = new Map<string, string>();
  const collisions: string[] = [];

  const place = (oldRel: string, target: string) => {
    if (map.has(target)) collisions.push(`${oldRel} -> ${target} (also ${map.get(target)})`);
    map.set(oldRel, target);
  };

  for (const file of allFiles) {
    const rel = relative(ROOT, file);
    if (STAYS.has(rel)) continue;

    if (rel.startsWith('lib/')) {
      const name = rel.slice('lib/'.length);
      const ctx = LIB_CONTEXT[name];
      if (!ctx) throw new Error(`no context for lib/${name}`);
      place(rel, `packages/core/src/${ctx}/${name}`);
      continue;
    }
    if (rel.startsWith('providers/')) {
      place(rel, `packages/core/src/scanning/providers/${rel.slice('providers/'.length)}`);
      continue;
    }
    if (rel.startsWith('seeds/')) {
      place(rel, `packages/core/src/scanning/seeds/${rel.slice('seeds/'.length)}`);
      continue;
    }
    if (rel.startsWith('utils/')) {
      place(rel, `packages/core/src/kernel/${rel.slice('utils/'.length)}`);
      continue;
    }
    if (!rel.includes('/')) {
      const ctx = ROOT_CONTEXT[rel];
      if (!ctx) throw new Error(`no context for ${rel}`);
      const target = core.has(file)
        ? `packages/core/src/${ctx}/${rel}`
        : `packages/cli/src/commands/${ctx}/${rel}`;
      place(rel, target);
    }
  }

  if (collisions.length) {
    throw new Error(`path collisions:\n${collisions.join('\n')}`);
  }
  return new Map([...map.entries()].sort());
}

if (import.meta.main) {
  const map = buildMap();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(Object.fromEntries(map), null, 2));
  } else {
    const byDir = new Map<string, string[]>();
    for (const [from, to] of map) {
      const dir = dirname(to);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir)!.push(`${from} -> ${to}`);
    }
    for (const dir of [...byDir.keys()].sort()) {
      console.log(`\n${dir}/`);
      for (const line of byDir.get(dir)!.sort()) console.log(`  ${line}`);
    }
    console.log(`\n${map.size} files move`);
  }
}
