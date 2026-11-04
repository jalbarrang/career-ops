/**
 * lib/update-manifest.ts — the system layer the updater ships (#5554).
 *
 * `bun update-system.ts apply` checks out exactly these paths from upstream
 * and nothing else. A PR that adds a file every install should receive (a
 * script, a mode, a provider, a doc) must add that file's entry here. A
 * trailing `/` makes an entry a directory prefix; every other entry names one
 * file.
 *
 * The updater READS this file; it does not import it. update-system.ts must
 * stay self-loading (#1706): a pre-#1245 client re-execs the new updater with
 * only update-system.ts checked out, so a static import of this module would
 * crash that upgrade before it starts. Instead the updater extracts the array
 * below from source with extractArrayFromSource(), the same parser it uses on
 * the TARGET release's manifest and on a rollback's backup ref. Keep the
 * declaration in that shape:
 *
 *   - one exported SYSTEM_PATHS array literal, closed by a bracket and a
 *     semicolon, holding quoted string literals only: no spread, no template
 *     literals, no computed entries, and no bracket-semicolon inside an entry;
 *   - comments anywhere (the parser blanks them first);
 *   - no imports in this file, so it loads wherever it is read.
 *
 * tests/update-manifest.test.ts fails when the parsed list and the imported
 * one disagree, which is what an unparseable entry would look like.
 *
 * The user layer stays in update-system.ts (USER_PATHS, LOCAL_PATHS_FILE and
 * MANIFEST_USER_PATH_OVERLAPS). Every entry here is checked against it at run
 * time — canonical form before any checkout, then rejectUserLayerPaths() per
 * entry in apply() and isSafeManifestPath() in rollback() — so an entry that
 * names user data is refused rather than shipped. Those checks cover the user
 * layer only. Some system files must stay out of this list for other reasons
 * (.gitignore, SIGNATURES.md: see their notes below and in update-system.ts),
 * and the order matters for one entry (.gitattributes, first).
 */
export const SYSTEM_PATHS = [
  // .gitattributes governs how every other path below is written to disk, and
  // `apply` checks paths out one at a time in this order: if it landed later,
  // everything before it would be written under the old core.autocrlf setting
  // on an existing install, silently (once text=auto is live, git status stays
  // clean and only a second update would repair it).
  '.gitattributes',
  // TypeScript compiler settings for the repository toolchain.
  'tsconfig.json',
  // Skill entrypoints, the lockfile and the fork engine in this checkout are
  // all repository system content: they ship with an install and are never
  // edited as user data. Keep this comment free of quote characters: the
  // updater test extractor matches quoted strings before it blanks comments,
  // so one stray quote pairs with the next entry and corrupts the list.
  '.cursor/skills/career-ops/SKILL.md',
  'bun.lock',
  'fork/README.md',
  'fork/apply.ts',
  'fork/base.json',
  'fork/core/career-profile.ts',
  'fork/core/lib/career-profile.ts',
  'fork/core/lib/profile-cv-selection.ts',
  'fork/core/tests/career-profile.test.ts',
  'fork/core/tests/fixtures/profile-cv-selection.json',
  'fork/core/tests/profile-cv-selection.test.ts',
  'dead-boards.ts',
  'modes/README.md',
  'modes/_shared.md',
  'modes/_writing.md',
  'modes/_profile.template.md',
  'modes/_custom.template.md',
  'modes/_brief.template.md',
  'voice-dna.template.md',
  'modes/oferta.md',
  'modes/oferta-signals/',
  'modes/master-profile.md',
  'modes/pdf.md',
  'modes/ats.md',
  'modes/text.md',
  'modes/pdf/',
  'modes/cover.md',
  'modes/email.md',
  'modes/add.md',
  'modes/expand.md',
  'modes/scan.md',
  'modes/discover.md',
  'modes/batch.md',
  'modes/apply.md',
  'modes/auto-pipeline.md',
  'modes/contacto.md',
  'modes/deep.md',
  'modes/ofertas.md',
  'modes/pipeline.md',
  'modes/triage.md',
  'modes/project.md',
  'modes/tracker.md',
  'modes/training.md',
  'modes/interview.md',
  'modes/interview-redflag.md',
  'modes/latex.md',
  'modes/latex-tex.md',
  'modes/followup.md',
  'modes/offer-prep.md',
  'modes/interview-prep.md',
  'modes/interview/',
  'interview-prep/sessions/.gitkeep',
  'interview-prep/sessions/README.md',
  'modes/patterns.md',
  'modes/calibrate.md',
  'modes/titles.md',
  'modes/upskill.md',
  'modes/intake.md',
  'modes/retro.md',
  'documents/.gitkeep',
  // Empty scaffolds are system-owned exceptions inside otherwise user-owned
  // directories. Ship only these exact files; the data they sit beside stays
  // in USER_PATHS and is never checked out by the updater.
  'data/.gitkeep',
  'data/offers/.gitkeep',
  'data/parser-output/.gitkeep',
  'jds/.gitkeep',
  'output/.gitkeep',
  'reports/.gitkeep',
  'documents/README.md',
  'modes/update.md',
  'modes/agent-inbox.md',
  'modes/reply-watch.md',
  'modes/outcome.md',
  'modes/ar/',
  'modes/da/',
  'modes/de/',
  'modes/de/interview/',
  'modes/fr/',
  'modes/fr/interview/',
  'modes/hi/',
  'modes/es/',
  'modes/es/interview/',
  'modes/id/',
  'modes/id/interview/',
  'modes/it/',
  'modes/it/interview/',
  'modes/ja/',
  'modes/ja/interview/',
  'modes/ko/',
  'modes/ko/interview/',
  'modes/nl/',
  'modes/pl/',
  'modes/pl/interview/',
  'modes/pt/',
  'modes/pt/interview/',
  'modes/ru/',
  'modes/ru/interview/',
  'modes/sg/',
  'modes/tr/',
  'modes/ua/',
  'modes/ua/interview/',
  'modes/vi/',
  'modes/heuristics/',
  'modes/regional/',
  'modes/zh/',
  'modes/zh/interview/',
  'modes/zh-TW/',
  'CLAUDE.md',
  'CODEX.md',
  'OPENCODE.md',
  'AGENTS.md',
  'GEMINI.md',
  'KIMI.md',
  'build-dashboard.ts',
  'clean-markers.ts',
  'cv-experience-order.ts',
  'generate-pdf.ts',
  'hired-share.ts',
  'hired-wall-build.ts',
  'HIRED.md',
  'theme-style.ts',
  'generate-latex.ts',
  'install-latex-engine.ts',
  'extract-latex-content.ts',
  'patch-latex-content.ts',
  'lib/ascii-fold.ts',
  'lib/cli-flags.ts',
  'lib/failure-excerpt.ts',
  'lib/gemini-node-floor.ts',
  'lib/bun-floor.ts',
  'lib/chromium-launch-error.ts',
  'lib/local-today.ts',
  'lib/jd-archive-section.ts',
  'lib/parse-date.ts',
  'lib/personalization.ts',
  'lib/reply-proposals.ts',
  'lib/placeholder-cell.ts',
  'lib/tracker-addition.ts',
  'lib/scan-summary-marker.ts',
  'lib/scan-history-columns.ts',
  'lib/pipeline-sections.ts',
  'lib/small-board.ts',
  'lib/admission-gate.ts',
  'lib/tsv-formula-escape.ts',
  'lib/is-main-module.ts',
  // This file. update-system.ts reads it at run time (see the header), so it
  // ships like any other system file.
  'lib/update-manifest.ts',
  'lib/source-files.ts',
  'lib/syntax-check.ts',
  'lib/syntax-check-child.ts',
  'lib/walk-tree.ts',
  'lib/dir-lock.ts',
  'lib/run-bounded.ts',
  'lib/status-hooks.ts',
  'lib/scratch-dirs.ts',
  'lib/story-bank.ts',
  'lib/outcome-dir.ts',
  'lib/outcome-types.ts',
  'lib/latex-escape.ts',
  'lib/cv-payload-schema.ts',
  'lib/career-profile.ts',
  'lib/profile-cv-selection.ts',
  'lib/cv-markdown.ts',
  'lib/page-format.ts',
  'lib/template-manifest.ts',
  'lib/agent-cli.ts',
  'remember-cli.ts',
  'lib/yaml-document.ts',
  'scan-hn.ts',
  'scripts/check-syntax.ts',
  'scripts/export-ats-text.ts',
  'scripts/followup-sweep.sh',
  'scripts/ui-server.ts',
  'story-provenance-check.ts',
  'lib/latex-content.ts',
  'lib/context-budget.ts',
  // Ships alongside doctor.ts, which imports it: an upgraded install whose
  // updater had no entry for it would check out a doctor that cannot load.
  'lib/title-filter-conflicts.ts',
  // Ships alongside liveness-api.ts, which imports it.
  'lib/linkedin-url.ts',
  // Retired 2026-09-05: the suite moved to tests/context-budget.test.ts. The
  // entry stays so staleSystemFiles() prunes the orphan on an upgraded install;
  // drop it once a release has shipped past that move.
  'lib/context-budget.test.ts',
  'lib/golden-budget-analysis.ts',
  'img-to-pdf.ts',
  'apply-scope.ts',
  'archive-posting.ts',
  'jd-capture.ts',
  'application-answers.ts',
  'generate-cover-letter.ts',
  'merge-tracker.ts',
  'persist-evaluation-report.ts',
  'url-key.ts',
  'sync-pdf-flags.ts',
  'tracker-links.ts',
  'tracker.ts',
  'find.ts',
  'verify-pipeline.ts',
  'discard-analytics.ts',
  'sync-batch-input.ts',
  'reconcile-pipeline.ts',
  'dedup-tracker.ts',
  'precheck-duplicate.ts',
  'add-entry.ts',
  'github-evidence.ts',
  'role-matcher.ts',
  'tracker-utils.ts',
  'tracker-parse.ts',
  'tracker-aliases.json',
  'session-activity.ts',
  'set-status.ts',
  'onboard-write.ts',
  'mark-pdf-ready.ts',
  'normalize-statuses.ts',
  'fix-report-links.ts',
  'cv-sync-check.ts',
  'i18n-drift.ts',
  'verify-cv-facts.ts',
  'verify-cv-structure.ts',
  'verify-ats.ts',
  'ats-payload.ts',
  'update-system.ts',
  'path-resolver.ts',
  'ats-vendor.ts',
  'history-ats-seeds.ts',
  'branded-successfactors.ts',

  'reserve-report-num.ts',
  'scan.ts',
  'migrate-scan-runs.ts',
  'pipeline-lock.ts',
  'portal-health-lock.ts',
  'classify-tier.ts',
  'scan-ats-full.ts',
  'scan-interamt.ts',
  'scan-dayforce.ts',
  'company-funded.ts',
  'match-star.ts',
  'jd-skill-gap.ts',
  'career-profile.ts',
  'cv-title-check.ts',
  'filter-audit.ts',
  'prepare-application.ts',
  'application-artifacts.ts',
  'evaluation-cache.ts',
  'batch-evaluate-gemini.ts',
  'providers/',
  'data-static/',
  'seeds/',
  'tests/',

  // ── Retired paths ─────────────────────────────────────────────────────────
  // These files no longer exist upstream: #3765 moved four root suites into
  // tests/, and #4758 moved tracker-columns-tests.ts once it no longer
  // needed its own timeout. They
  // stay in the manifest anyway, because SYSTEM_PATHS is what `apply()` prunes
  // AGAINST — `staleSystemFiles` (see pathMatchesManifest) only deletes a local
  // file that is gone from the remote tree AND matches an entry here. Drop the
  // entry and an upgrading install keeps its copy of the old root file forever,
  // where tests/root-tests-registration.test.ts then reports it as an
  // unregistered suite and turns `bun test-all.ts` red on a healthy install.
  //
  // Probe on this list vs. the pre-#3765 one, with a local tree holding the
  // four and a remote tree without them: without these entries the prune
  // returns nothing at all; with them it returns all four.
  //
  // NB: keep square brackets out of every comment in this array. Several
  // assertions in test-all.ts extract the manifest with a NON-GREEDY regex
  // that ends at the first closing bracket, so one inside a comment truncates
  // the parsed list and every entry below it reads as missing. That is not
  // hypothetical: the first draft of this block wrote the probe result as an
  // empty-array literal and turned the check-table-freshness assertion red.
  //
  // They are therefore expected to be ABSENT from the working tree, which is
  // why updater-migration-tests.ts lists them in ALLOWED_MISSING_ENTRIES.
  // Safe to delete once no supported install can still be carrying them.
  'agent-inbox-tests.ts',
  'followup-seed-tests.ts',
  'paste-reply-tests.ts',
  'set-status-tests.ts',
  'tracker-columns-tests.ts',
  // ── end retired paths ─────────────────────────────────────────────────────
  'user-agent.ts',
  'doctor.ts',
  'jsonc-parse.ts',
  'check-liveness.ts',
  'liveness-core.ts',
  'liveness-api.ts',
  'liveness-browser.ts',
  'browser-extract.ts',
  'fetch-jd.ts',
  'analyze-patterns.ts',
  'keyword-match.ts',
  'calibrate.ts',
  'upskill.ts',
  'skill-extract.ts',
  'skip-blockers.ts',
  'intake.ts',
  'learn.ts',
  'stats.ts',
  'funnel-stages.ts',
  'detect-reposts.ts',
  'rank-pipeline.ts',
  'discover-ats.ts',
  'discover-new-companies.ts',
  'check-table-freshness.ts',
  'check-jd-archive.ts',
  'fingerprint-core.ts',
  'listing-fingerprint.ts',
  'process-quality.ts',
  'company-history.ts',
  'rejection-latency.ts',
  'closing-soon.ts',
  'reeval-candidates.ts',
  'salary-gap.ts',
  'negotiation-roi.ts',
  'funnel-velocity.ts',
  'assessment-log.ts',
  'contacts.ts',
  'contact-lookup.ts',
  'linkedin-join.ts',
  'weekly-digest.ts',
  'tracker-sync-check.ts',
  'followup-cadence.ts',
  'invite-match.ts',
  'ics-interview.ts',
  'coverage-check.ts',
  'agent-inbox.ts',
  'followup-seed.ts',
  'debrief-sync.ts',
  'profile-language.ts',
  'title-keywords.ts',
  'gemini-eval.ts',
  'ollama-eval.ts',
  'openai-eval.ts',
  'openai-tailor.ts',
  'eval-golden.ts',
  'evals/',
  'openrouter-runner.ts',
  'jd-similarity.ts',
  'test-all.ts',
  // Retired 2026-10-04: the suite moved to tests/tracker-writer-lock.test.ts
  // (#4759). The entry stays so staleSystemFiles() prunes the orphan on an
  // upgraded install; drop it once a release has shipped past that move.
  'tracker-writer-lock-tests.ts',
  'validate-portals.ts',
  'validate-profile.ts',
  'verify-portals.ts',
  'audit-portals.ts',
  'fix-slugs.ts',
  'updater-migration-tests.ts',
  'validate-system-paths-coverage.ts',
  'validate-untrusted-content-coverage.ts',
  'reply-matcher.ts',
  'reply-watch.ts',
  'paste-reply.ts',
  'contact-extract.ts',
  // Retired 2026-10-04: the suite moved to tests/contact-extract.test.ts. The
  // entry stays so staleSystemFiles() prunes the orphan on an upgraded install;
  // drop it once a release has shipped past that move.
  'contact-extract-tests.ts',
  'outcome.ts',
  'batch/batch-prompt.md',
  'batch/batch-runner.sh',
  'batch/company-scope.ts',
  'batch/jd-rescue.ts',
  'batch/aggregate-tokens.ts',
  'batch/README.md',
  'utils/token-tracker.ts',
  'batch-tailor.ts',
  'dashboard/',
  'templates/',
  'config/cv-facts.example.json',
  'fonts/',
  'examples/',
  'config/profile.example.yml',
  'config/local-paths.example.txt',
  '.env.example',
  '.editorconfig',
  '.agents/',
  '.claude/skills/',
  '.opencode/skills/',
  '.opencode/commands/',
  '.claude-plugin/',
  '.codex-plugin/',
  '.qwen/',
  '.antigravitycli/skills/',
  '.grok/skills/',
  '.kimi/skills/',
  'docs/',
  'writing-samples/README.md',
  'VERSION',
  'DATA_CONTRACT.md',
  'MANIFESTO.md',
  'manifesto.ts',
  // SIGNATURES.md cannot join SYSTEM_PATHS: unlike every other system file it
  // is a pure append-only ledger of who signed the manifesto, and it churns
  // far faster than the code it would ship beside (49 commits in the 30 days
  // before this was written). Nothing on an install reads it — manifesto.ts
  // parses MANIFESTO.md and never opens it — so shipping it buys an install
  // nothing, while listing it here puts it in the pathspec check() diffs via
  // systemTreeDiffers, which turns every new signature into a
  // system-files-changed report on every install in the world that no apply
  // can clear for long (#4062). That is one cause of the #3149 class of
  // permanent update-available, beside the SHA-vs-content bug of #2630, the
  // ignore-rule route of #2756, and the symlinked skill entrypoints that a
  // core.symlinks=false checkout materialises into regular files. Do not fix
  // that last one the way this entry was fixed: the entrypoints must stay in
  // SYSTEM_PATHS and be excluded from the drift comparison instead, because
  // ensureSkillEntrypoints only refreshes an entry that still holds the
  // pointer, so an entrypoint dropped from the manifest silently freezes.
  // The SIGNATURES.md repo-only coverage is declared in
  // validate-system-paths-coverage.ts, and the behaviour is pinned by
  // tests/updater-signature-ledger-drift.test.ts.
  //
  // Keep this comment free of straight quotes: updater-migration-tests.ts
  // parses this array with a comment-blind regex, so an apostrophe here
  // becomes a phantom manifest entry.
  'CONTRIBUTING.md',
  'MAINTAINERS.md',
  'ARCHITECTURE.md',
  'README.md',
  'README.ar.md',
  'README.cn.md',
  'README.da.md',
  'README.de.md',
  'README.es.md',
  'README.fr.md',
  'README.hi.md',
  'README.ja.md',
  'README.ko-KR.md',
  'README.pl.md',
  'README.pt-BR.md',
  'README.ru.md',
  'README.ta.md',
  'README.ua.md',
  'README.zh-TW.md',
  'README.tr.md',
  'README.vi.md',
  'README.id.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',
  'CONTRIBUTORS.md',
  '.all-contributorsrc',
  'GOVERNANCE.md',
  'LEGAL_DISCLAIMER.md',
  'SECURITY.md',
  'SUPPORT.md',
  'TRADEMARK.md',
  'LICENSE',
  'CITATION.cff',
  'funding.json',
  '.well-known/',
  '.editorconfig',
  '.github/',
  'package.json',
  'build-cv-latex.ts',
  'build-cv-html.ts',
  'cv-sections-core.ts',
  'cv-templates.ts',
  'playwright.cv.config.ts',
  'scaffolder/',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'cops',
  'DOCKER.md',
  'plugins/',
  'plugins.ts',
  'plugins-registry/',
  'plugin-install.ts',
  'plugin-audit.ts',
  'validate-plugin-registry.ts',
  'config/plugins.example.yml',
  'opencode.example.json',
  'seed-fixture.ts',
  'test-fixtures/',
  'upgrade-tests.ts',
];

// Frozen after the literal, not with `Object.freeze([...])` around it, so the
// declaration keeps the `const NAME = [ ... ];` shape the parser matches.
Object.freeze(SYSTEM_PATHS);

// The table's shape, declared here rather than on the declaration line above:
// extractArrayFromSource() matches `const SYSTEM_PATHS = [`, so an inline type
// annotation would stop the parse and leave an upgrading install with no
// system layer. These two aliases are erased at compile time, so the source
// the updater reads is exactly the source these parsers have always seen.
type SystemPathEntry = (typeof SYSTEM_PATHS)[number];
type AssertAssignable<T extends U, U> = T;
// Fails the build if an entry stops being a path string.
type AssertSystemPathEntries = AssertAssignable<SystemPathEntry, string>;
