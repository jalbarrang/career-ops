/**
 * packages/core/src/platform/update-manifest.ts — the system layer the updater ships (#5554).
 *
 * `career-ops update-system apply` checks out exactly these paths from upstream
 * and nothing else. A PR that adds a file every install should receive (a
 * script, a mode, a provider, a doc) must add that file's entry here. A
 * trailing `/` makes an entry a directory prefix; every other entry names one
 * file.
 *
 * The updater READS this file; it does not import it. packages/cli/src/commands/platform/update-system.ts must
 * stay self-loading (#1706): a pre-#1245 client re-execs the new updater with
 * only packages/cli/src/commands/platform/update-system.ts checked out, so a static import of this module would
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
 * The user layer stays in packages/cli/src/commands/platform/update-system.ts (USER_PATHS, LOCAL_PATHS_FILE and
 * MANIFEST_USER_PATH_OVERLAPS). Every entry here is checked against it at run
 * time — canonical form before any checkout, then rejectUserLayerPaths() per
 * entry in apply() and isSafeManifestPath() in rollback() — so an entry that
 * names user data is refused rather than shipped. Those checks cover the user
 * layer only. Some system files must stay out of this list for other reasons
 * (.gitignore, SIGNATURES.md: see their notes below and in packages/cli/src/commands/platform/update-system.ts),
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
  'tsconfig.base.json',
  'packages/core/package.json',
  'packages/core/tsconfig.json',
  'packages/cli/package.json',
  'packages/cli/tsconfig.json',
  'packages/cli/src/bin/career-ops.ts',
  'packages/core/src/kernel/repo-root.ts',
  'packages/core/src/kernel/command-catalog.ts',
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
  'packages/core/src/scanning/dead-boards.ts',
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
  'packages/cli/src/commands/platform/build-dashboard.ts',
  'packages/cli/src/commands/platform/clean-markers.ts',
  'packages/core/src/cv/cv-experience-order.ts',
  'packages/cli/src/commands/cv/generate-pdf.ts',
  'packages/cli/src/commands/insights/hired-share.ts',
  'packages/cli/src/commands/insights/hired-wall-build.ts',
  'HIRED.md',
  'packages/cli/src/commands/cv/theme-style.ts',
  'packages/cli/src/commands/cv/generate-latex.ts',
  'packages/cli/src/commands/cv/install-latex-engine.ts',
  'packages/cli/src/commands/cv/extract-latex-content.ts',
  'packages/cli/src/commands/cv/patch-latex-content.ts',
  'packages/core/src/kernel/ascii-fold.ts',
  'packages/core/src/kernel/cli-flags.ts',
  'packages/core/src/kernel/failure-excerpt.ts',
  'packages/core/src/kernel/gemini-node-floor.ts',
  'packages/core/src/kernel/bun-floor.ts',
  'packages/core/src/kernel/chromium-launch-error.ts',
  'packages/core/src/kernel/local-today.ts',
  'packages/core/src/evaluation/jd-archive-section.ts',
  'packages/core/src/kernel/parse-date.ts',
  'packages/core/src/profile/personalization.ts',
  'packages/core/src/outreach/reply-proposals.ts',
  'packages/core/src/tracker/placeholder-cell.ts',
  'packages/core/src/tracker/tracker-addition.ts',
  'packages/core/src/scanning/scan-summary-marker.ts',
  'packages/core/src/scanning/scan-history-columns.ts',
  'packages/core/src/pipeline/pipeline-sections.ts',
  'packages/core/src/scanning/small-board.ts',
  'packages/core/src/kernel/admission-gate.ts',
  'packages/core/src/kernel/tsv-formula-escape.ts',
  'packages/core/src/kernel/is-main-module.ts',
  // This file. packages/cli/src/commands/platform/update-system.ts reads it at run time (see the header), so it
  // ships like any other system file.
  'packages/core/src/platform/update-manifest.ts',
  'packages/core/src/kernel/source-files.ts',
  'packages/core/src/kernel/syntax-check.ts',
  'packages/core/src/kernel/syntax-check-child.ts',
  'packages/core/src/kernel/walk-tree.ts',
  'packages/core/src/kernel/dir-lock.ts',
  'packages/core/src/kernel/run-bounded.ts',
  'packages/core/src/tracker/status-hooks.ts',
  'packages/core/src/kernel/scratch-dirs.ts',
  'packages/core/src/interview/story-bank.ts',
  'packages/core/src/tracker/outcome-dir.ts',
  'packages/core/src/tracker/outcome-types.ts',
  'packages/core/src/cv/latex-escape.ts',
  'packages/core/src/cv/cv-payload-schema.ts',
  'packages/core/src/profile/career-profile.ts',
  'packages/core/src/profile/profile-cv-selection.ts',
  'packages/core/src/cv/cv-markdown.ts',
  'packages/core/src/cv/page-format.ts',
  'packages/core/src/cv/template-manifest.ts',
  'packages/core/src/kernel/agent-cli.ts',
  'packages/cli/src/commands/platform/remember-cli.ts',
  'packages/core/src/kernel/yaml-document.ts',
  'packages/cli/src/commands/scanning/scan-hn.ts',
  'scripts/check-syntax.ts',
  'scripts/export-ats-text.ts',
  'scripts/followup-sweep.sh',
  'scripts/ui-server.ts',
  'packages/cli/src/commands/interview/story-provenance-check.ts',
  'packages/core/src/cv/latex-content.ts',
  'packages/core/src/kernel/context-budget.ts',
  // Ships alongside packages/cli/src/commands/platform/doctor.ts, which imports it: an upgraded install whose
  // updater had no entry for it would check out a doctor that cannot load.
  'packages/core/src/scanning/title-filter-conflicts.ts',
  // Ships alongside packages/core/src/liveness/liveness-api.ts, which imports it.
  'packages/core/src/outreach/linkedin-url.ts',
  // Retired 2026-09-05: the suite moved to tests/context-budget.test.ts. The
  // entry stays so staleSystemFiles() prunes the orphan on an upgraded install;
  // drop it once a release has shipped past that move.
  'lib/context-budget.test.ts',
  'packages/core/src/evaluation/golden-budget-analysis.ts',
  'packages/cli/src/commands/cv/img-to-pdf.ts',
  'packages/cli/src/commands/platform/apply-scope.ts',
  'packages/cli/src/commands/evaluation/archive-posting.ts',
  'packages/core/src/evaluation/jd-capture.ts',
  'packages/cli/src/commands/evaluation/application-answers.ts',
  'packages/cli/src/commands/cv/generate-cover-letter.ts',
  'packages/cli/src/commands/tracker/merge-tracker.ts',
  'packages/cli/src/commands/evaluation/persist-evaluation-report.ts',
  'packages/core/src/kernel/url-key.ts',
  'packages/cli/src/commands/tracker/sync-pdf-flags.ts',
  'packages/core/src/tracker/tracker-links.ts',
  'packages/cli/src/commands/tracker/tracker.ts',
  'packages/cli/src/commands/pipeline/find.ts',
  'packages/cli/src/commands/platform/verify-pipeline.ts',
  'packages/cli/src/commands/insights/discard-analytics.ts',
  'packages/cli/src/commands/pipeline/sync-batch-input.ts',
  'packages/cli/src/commands/pipeline/reconcile-pipeline.ts',
  'packages/cli/src/commands/tracker/dedup-tracker.ts',
  'packages/cli/src/commands/tracker/precheck-duplicate.ts',
  'packages/cli/src/commands/cv/add-entry.ts',
  'packages/cli/src/commands/profile/github-evidence.ts',
  'packages/core/src/tracker/role-matcher.ts',
  'packages/core/src/tracker/tracker-utils.ts',
  'packages/core/src/tracker/tracker-parse.ts',
  'packages/core/src/tracker/tracker-aliases.json',
  'packages/core/src/platform/session-activity.ts',
  'packages/cli/src/commands/tracker/set-status.ts',
  'packages/cli/src/commands/profile/onboard-write.ts',
  'packages/cli/src/commands/tracker/mark-pdf-ready.ts',
  'packages/cli/src/commands/tracker/normalize-statuses.ts',
  'packages/cli/src/commands/tracker/fix-report-links.ts',
  'packages/cli/src/commands/cv/cv-sync-check.ts',
  'packages/cli/src/commands/platform/i18n-drift.ts',
  'packages/cli/src/commands/cv/verify-cv-facts.ts',
  'packages/cli/src/commands/cv/verify-cv-structure.ts',
  'packages/cli/src/commands/cv/verify-ats.ts',
  'packages/cli/src/commands/cv/ats-payload.ts',
  'packages/cli/src/commands/platform/update-system.ts',
  'packages/core/src/kernel/path-resolver.ts',
  'packages/core/src/scanning/ats-vendor.ts',
  'packages/core/src/scanning/history-ats-seeds.ts',
  'packages/core/src/scanning/branded-successfactors.ts',

  'packages/cli/src/commands/tracker/reserve-report-num.ts',
  'packages/core/src/scanning/scan.ts',
  'packages/cli/src/commands/scanning/migrate-scan-runs.ts',
  'packages/core/src/kernel/pipeline-lock.ts',
  'packages/core/src/kernel/portal-health-lock.ts',
  'packages/core/src/evaluation/classify-tier.ts',
  'packages/cli/src/commands/scanning/scan-ats-full.ts',
  'packages/cli/src/commands/scanning/scan-interamt.ts',
  'packages/cli/src/commands/scanning/scan-dayforce.ts',
  'packages/cli/src/commands/scanning/company-funded.ts',
  'packages/cli/src/commands/interview/match-star.ts',
  'packages/cli/src/commands/evaluation/jd-skill-gap.ts',
  'packages/cli/src/commands/profile/career-profile.ts',
  'packages/cli/src/commands/cv/cv-title-check.ts',
  'packages/cli/src/commands/scanning/filter-audit.ts',
  'packages/cli/src/commands/evaluation/prepare-application.ts',
  'packages/cli/src/commands/evaluation/application-artifacts.ts',
  'packages/cli/src/commands/evaluation/evaluation-cache.ts',
  'packages/cli/src/commands/evaluation/batch-evaluate-gemini.ts',
  'packages/core/src/scanning/providers/',
  'data-static/',
  'packages/core/src/scanning/seeds/',
  'scripts/regenerate-command-catalog.ts',
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
  'packages/core/src/kernel/user-agent.ts',
  'packages/cli/src/commands/platform/doctor.ts',
  'packages/core/src/kernel/jsonc-parse.ts',
  'packages/cli/src/commands/liveness/check-liveness.ts',
  'packages/core/src/liveness/liveness-core.ts',
  'packages/core/src/liveness/liveness-api.ts',
  'packages/core/src/liveness/liveness-browser.ts',
  'packages/cli/src/commands/scanning/browser-extract.ts',
  'packages/cli/src/commands/scanning/fetch-jd.ts',
  'packages/cli/src/commands/insights/analyze-patterns.ts',
  'packages/cli/src/commands/evaluation/keyword-match.ts',
  'packages/cli/src/commands/insights/calibrate.ts',
  'packages/cli/src/commands/insights/upskill.ts',
  'packages/core/src/evaluation/skill-extract.ts',
  'packages/core/src/insights/skip-blockers.ts',
  'packages/cli/src/commands/profile/intake.ts',
  'packages/cli/src/commands/profile/learn.ts',
  'packages/core/src/insights/stats.ts',
  'packages/core/src/insights/funnel-stages.ts',
  'packages/cli/src/commands/insights/detect-reposts.ts',
  'packages/cli/src/commands/pipeline/rank-pipeline.ts',
  'packages/cli/src/commands/scanning/discover-ats.ts',
  'packages/cli/src/commands/scanning/discover-new-companies.ts',
  'packages/cli/src/commands/platform/check-table-freshness.ts',
  'packages/core/src/evaluation/check-jd-archive.ts',
  'packages/core/src/scanning/fingerprint-core.ts',
  'packages/core/src/scanning/listing-fingerprint.ts',
  'packages/cli/src/commands/outreach/process-quality.ts',
  'packages/cli/src/commands/insights/company-history.ts',
  'packages/cli/src/commands/outreach/rejection-latency.ts',
  'packages/cli/src/commands/insights/closing-soon.ts',
  'packages/cli/src/commands/insights/reeval-candidates.ts',
  'packages/cli/src/commands/insights/salary-gap.ts',
  'packages/cli/src/commands/insights/negotiation-roi.ts',
  'packages/core/src/insights/funnel-velocity.ts',
  'packages/cli/src/commands/insights/assessment-log.ts',
  'packages/cli/src/commands/outreach/contacts.ts',
  'packages/cli/src/commands/outreach/contact-lookup.ts',
  'packages/cli/src/commands/outreach/linkedin-join.ts',
  'packages/cli/src/commands/interview/weekly-digest.ts',
  'packages/cli/src/commands/tracker/tracker-sync-check.ts',
  'packages/core/src/outreach/followup-cadence.ts',
  'packages/core/src/interview/invite-match.ts',
  'packages/cli/src/commands/interview/ics-interview.ts',
  'packages/cli/src/commands/pipeline/coverage-check.ts',
  'packages/cli/src/commands/platform/agent-inbox.ts',
  'packages/core/src/outreach/followup-seed.ts',
  'packages/cli/src/commands/interview/debrief-sync.ts',
  'packages/core/src/profile/profile-language.ts',
  'packages/core/src/scanning/title-keywords.ts',
  'packages/cli/src/commands/evaluation/gemini-eval.ts',
  'packages/cli/src/commands/evaluation/ollama-eval.ts',
  'packages/cli/src/commands/evaluation/openai-eval.ts',
  'packages/cli/src/commands/cv/openai-tailor.ts',
  'packages/cli/src/commands/evaluation/eval-golden.ts',
  'evals/',
  'packages/cli/src/commands/evaluation/openrouter-runner.ts',
  'packages/cli/src/commands/evaluation/jd-similarity.ts',
  'test-all.ts',
  // Retired 2026-10-04: the suite moved to tests/tracker-writer-lock.test.ts
  // (#4759). The entry stays so staleSystemFiles() prunes the orphan on an
  // upgraded install; drop it once a release has shipped past that move.
  'tracker-writer-lock-tests.ts',
  'packages/cli/src/commands/scanning/validate-portals.ts',
  'packages/cli/src/commands/profile/validate-profile.ts',
  'packages/core/src/scanning/verify-portals.ts',
  'packages/cli/src/commands/scanning/audit-portals.ts',
  'packages/cli/src/commands/scanning/fix-slugs.ts',
  'updater-migration-tests.ts',
  'packages/cli/src/commands/platform/validate-system-paths-coverage.ts',
  'packages/cli/src/commands/platform/validate-untrusted-content-coverage.ts',
  'packages/core/src/outreach/reply-matcher.ts',
  'packages/cli/src/commands/outreach/reply-watch.ts',
  'packages/cli/src/commands/outreach/paste-reply.ts',
  'packages/cli/src/commands/outreach/contact-extract.ts',
  // Retired 2026-10-04: the suite moved to tests/contact-extract.test.ts. The
  // entry stays so staleSystemFiles() prunes the orphan on an upgraded install;
  // drop it once a release has shipped past that move.
  'contact-extract-tests.ts',
  'packages/cli/src/commands/tracker/outcome.ts',
  'batch/batch-prompt.md',
  'batch/batch-runner.sh',
  'batch/company-scope.ts',
  'batch/jd-rescue.ts',
  'batch/aggregate-tokens.ts',
  'batch/README.md',
  'packages/core/src/kernel/token-tracker.ts',
  'packages/cli/src/commands/cv/batch-tailor.ts',
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
  'packages/cli/src/commands/platform/manifesto.ts',
  // SIGNATURES.md cannot join SYSTEM_PATHS: unlike every other system file it
  // is a pure append-only ledger of who signed the manifesto, and it churns
  // far faster than the code it would ship beside (49 commits in the 30 days
  // before this was written). Nothing on an install reads it — packages/cli/src/commands/platform/manifesto.ts
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
  // packages/cli/src/commands/platform/validate-system-paths-coverage.ts, and the behaviour is pinned by
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
  'packages/cli/src/commands/cv/build-cv-latex.ts',
  'packages/cli/src/commands/cv/build-cv-html.ts',
  'packages/core/src/cv/cv-sections-core.ts',
  'packages/cli/src/commands/cv/cv-templates.ts',
  'playwright.cv.config.ts',
  'scaffolder/',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'cops',
  'DOCKER.md',
  'plugins/',
  'packages/cli/src/commands/platform/plugins.ts',
  'plugins-registry/',
  'packages/cli/src/commands/platform/plugin-install.ts',
  'packages/cli/src/commands/platform/plugin-audit.ts',
  'packages/cli/src/commands/platform/validate-plugin-registry.ts',
  'config/plugins.example.yml',
  'opencode.example.json',
  'packages/cli/src/commands/platform/seed-fixture.ts',
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
