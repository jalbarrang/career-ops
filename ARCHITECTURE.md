# Architecture

A high-level map of how career-ops is put together. For the precise system/user file boundary, see [DATA_CONTRACT.md](DATA_CONTRACT.md); for contribution mechanics, see [CONTRIBUTING.md](CONTRIBUTING.md); for runtime flow diagrams (evaluation steps, batch processing), see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Principles

Career-ops is built on three commitments that every design decision serves:

- **Local-first.** Everything runs on your machine against your files. No account required, no server in the loop for the core tool.
- **AI-agnostic.** The logic lives in Markdown prompt files under `modes/`, executed by whatever AI coding CLI you use (Claude Code, Codex, OpenCode, Gemini, Qwen, Grok, Antigravity) or by standalone scripts. No single model is hardcoded.
- **Human-in-the-loop.** The tool prepares and evaluates; the human reviews and clicks. It never submits applications on your behalf.

## The two layers (the data contract)

The single most important architectural rule: **system files** and **user files** are strictly separated.

- **System layer** — the tool itself: `packages/`, `modes/`, `templates/`, `apps/web/`, the dashboard. These are versioned and updated by `update-system`. Listed in `SYSTEM_PATHS`, in `packages/core/src/platform/update-manifest.ts`.
- **User layer** — your data: `cv.md`, `config/profile.yml`, `modes/_profile.md`, `data/`, `reports/`, `jds/`, etc. The updater **never** touches these. Listed in `USER_PATHS`.

`DATA_CONTRACT.md` is the source of truth for this boundary, and `updater-migration-tests.ts` enforces that no system path ever overlaps a user path.

## Files are canonical — databases are derived

Settled doctrine ([#918](https://github.com/career-ops-hq/career-ops/issues/918)): the human-readable, git-diffable files (`data/applications.md`, `reports/`, `data/pipeline.md`) are the **permanent source of truth**. SQLite exists only as a derived index (fast queries, reindex-on-delete) and will never become a primary store — not even opt-in. The reason is ecosystem-wide: the web UI, the Go dashboard, community plugins, and thousands of fork scripts all read the files; a second canonical store would force every reader to support two modes forever. Performance work is welcome **on the derived layer**; the files stay the brain.

## Layout — one Bun workspace, three layers

The repository is a Bun workspace. The root holds the **data and prompt layer** (what the user edits and reads) plus the test harness; the code lives in packages, split along the dependency rule:

```
package.json                 workspaces: packages/*, apps/*
tsconfig.base.json           shared compiler options; each package extends it
packages/
  core/                      @career-ops/core — domain + application
    src/
      kernel/                shared kernel: paths, dates, YAML, locks, flags,
                             text, the repo-root resolver, the command catalog
      tracker/               applications tracker: parse, rewrite, identity, states
      pipeline/              the inbox: sections, ranking, reconciliation
      scanning/              portals, providers (ATS adapters), scan history, titles
      liveness/              is this posting still open?
      evaluation/            reports, JD archive, skill gap, keyword match
      cv/                    cv.md facts, tailoring payloads, PDF/LaTeX/ATS, cover letters
      profile/               config/profile.yml, career profile, intake, personalization
      interview/             prep, sessions, story bank, invite matching, digests
      outreach/              contacts, replies, follow-ups
      insights/              patterns, calibrate, upskill, stats, funnel, salary
      platform/              updater, plugins, doctor, system validators, tooling
  cli/                       @career-ops/cli — the driving adapter
    src/bin/career-ops.ts    one entrypoint: `career-ops <command>`
    src/commands/<context>/  one file per command, mirroring core's contexts
apps/
  web/                       @career-ops/web — the SvelteKit app
modes/  templates/  data/  reports/  jds/  config/     user + prompt layer
tests/  test-all.ts                                     the suite and its harness
```

The arrow only points one way:

```
apps/web  ──►  packages/cli  ──►  packages/core
```

`packages/core` must not import a command or the web app, and `packages/cli` must not import the web app. `tests/architecture-boundaries.test.ts` enforces both, so the rule is checked rather than remembered. The split exists for that reason alone: a domain module that reaches into a CLI flag turns a driver detail into domain behaviour, and the next flag change silently changes what the domain does.

### Where a file goes

- **A command** — a script a human or an agent runs — goes in `packages/cli/src/commands/<context>/`. A command that a *core* module imports (because other code needs its exported helpers, like `scan.ts`) lives in `packages/core/src/<context>/` instead, keeping its `isMainModule` tail so it can still be run directly. One file = one job, as before.
- **A domain or application module** — parsing, rules, adapters, formatters — goes in the context it belongs to under `packages/core/src/`. `lib/` no longer exists: its modules were distributed to the context that owns them, and only genuinely generic primitives stayed in `kernel/`.
- **A new bounded context** is a new directory under `packages/core/src/` plus its command folder under `packages/cli/src/commands/`. Add it to the command catalog (below), not to a list in the CLI binary.

### The CLI entrypoint

`packages/cli/src/bin/career-ops.ts` resolves a command name to its script through `packages/core/src/kernel/command-catalog.ts`, and runs it in a child process with the caller's arguments and exit code. Every command therefore has two spellings that behave identically:

```bash
career-ops scan --since 14              # the documented entrypoint
bun packages/core/src/scanning/scan.ts --since 14   # the same script, directly
```

The catalog is **generated** from the tree by `bun scripts/regenerate-command-catalog.ts` (a script is runnable when it has a shebang, guards its tail with `isMainModule(import.meta.url)`, or is wired to a package.json script). Re-run it after adding, renaming or moving a runnable script; `--check` fails when it is stale, and the architecture suite verifies that every catalog entry points at a real script.

### The checkout root is not a module's directory

Before the split every script sat at the repository root, so `dirname(import.meta.url)` *was* the checkout and ~75 scripts spelled it that way. That is no longer true. Code that needs the checkout calls `repoRoot()` from `packages/core/src/kernel/repo-root.ts`, which returns the nearest ancestor that is a workspace root (or, for a script copied standalone into a fixture, the module's own directory). Code that needs the **data** root calls `getCareerOpsRoot()` from `kernel/path-resolver.ts`, which honors `CAREER_OPS_ROOT` / `CAREER_OPS_DATA_DIR` / the `.career-ops-data` marker before falling back to the checkout. Two questions, two functions — do not spell either with `import.meta.url` by hand.

Two files inline that walk deliberately rather than importing it: `kernel/path-resolver.ts` (test fixtures copy it standalone, so it must stay dependency-free) and `update-system.ts` (it must stay self-loading for the cross-version re-exec — see its header).

## Tests

Suites live in `tests/`, and `test-all.ts` discovers `tests/**/*.test.ts` — no registration list, so a new suite runs the moment it is written and a typo cannot silently turn CI green ([#1440](https://github.com/career-ops-hq/career-ops/issues/1440)). Write new ones there; `*.test.ts` at the repo root is not discovered and will not run. The suite is the repository's integration layer: it drives real scripts, real files and real sandboxes, which is why it stays at the root rather than inside a package.

Name a suite `{module}.test.ts` when it covers exactly one script. Name it for the behaviour it pins when it spans several, or when it is one of a group carving up a large module — `outcome-tracker-local-dates.test.ts`, `cover-unresolved-placeholders.test.ts`. Behaviour naming is the common case by a wide margin. Neither form is enforced, because discovery is by glob — the name buys legibility and nothing else. `tests/providers/` is the one subtree where module naming is the norm, one suite per provider, alongside cross-provider behaviour suites like `ats-ssrf-hardening.test.ts`; see `tests/README.md`.

Discovery imports a suite in-process and shares its counters; a `node:test` suite is child-processed instead, so its results survive ([#2828](https://github.com/career-ops-hq/career-ops/issues/2828)). A discovered suite therefore reports through `pass`/`fail` from `tests/helpers.ts` and never calls `process.exit()` or `finish()`, both of which would forge the run's verdict.

A handful of `*-tests.ts` harnesses remain at the root, registered by name in `test-all.ts`'s `scripts` list or invoked by a workflow: `upgrade-tests.ts` (a flag-driven CI harness) and `updater-migration-tests.ts` (which asserts on its own filename). `tests/root-tests-registration.test.ts` keeps them reachable ([#3735](https://github.com/career-ops-hq/career-ops/issues/3735)), and `tests/no-root-suites.test.ts` keeps the root empty of `*.test.ts`. Playwright specs are the deliberate exception: `tests/cv-visual/` is named `*.spec.ts`, which discovery does not match, and runs from `playwright.cv.config.ts`.

## Component map

```
AI coding CLI  ─┐
(or scripts)    │  reads prompt files
                ▼
   modes/*.md  ──────────────►  the "brain": scoring, evaluation,
   (_shared.md = scoring core)   apply, scan, interview, etc. prompts
                │
   ┌────────────┼─────────────────────────────────────────────┐
   ▼            ▼                  ▼               ▼            ▼
 scan        evaluate          generate         track       update
scanning/   oferta.md         core/cv +        core/tracker update-system
providers/  (+eval scripts)   cover letters    data/        platform/
```

### Discovery — `scanning/scan.ts` + `scanning/providers/`
Finds jobs from **open, no-auth public sources**. The scanner is zero-token: it calls public ATS APIs (Greenhouse, Ashby, Lever, BambooHR, Teamtailor, Workday, Breezy) and RSS/JSON boards via per-board modules in `providers/`. Auth-gated/login-required sources are intentionally out of core (they belong in the plugin layer). Results land in `data/pipeline.md`.

### Evaluation — `modes/oferta.md` + `modes/_shared.md`
The heart of the tool. `oferta.md` defines the A–H evaluation blocks (H is conditional, on scores of 4.5 and above); `_shared.md` defines the 1–5 scoring system, archetype detection, posting-legitimacy signals, and global rules. The AI reads these plus your `cv.md` and produces a structured report.

**Standalone evaluators** let you run the same scoring without an interactive CLI, against cheaper/local models: `gemini-eval` (Google free tier), `ollama-eval` (fully local), and `openai-eval` (any OpenAI-compatible endpoint) — under `packages/cli/src/commands/evaluation/`.

### Generation — PDFs, CVs, cover letters
`generate-pdf` (Playwright HTML→PDF), `generate-latex` / `build-cv-latex`, `generate-cover-letter`, all in `packages/cli/src/commands/cv/` over the payload and template logic in `packages/core/src/cv/`. ATS-safe templates live in `templates/` and `fonts/`.

### Tracking — `data/` + `reports/` + tracker commands
Every evaluated offer is registered. `data/applications.md` is the canonical tracker table; `reports/{NNN}-{company}-{date}.md` holds full evaluations. `tracker`, `merge-tracker`, `dedup-tracker`, `normalize-statuses` and `reconcile-pipeline` keep it consistent (atomic writes + a SQLite index); parse/rewrite/identity rules live in `packages/core/src/tracker/`. Report numbers are claimed atomically via `reserve-report-num`.

### Liveness — never evaluate a dead posting
`check-liveness` / `packages/core/src/liveness/*` verify a posting is still open (zero-token) before it costs evaluation time.

### Self-update — `packages/cli/src/commands/platform/update-system.ts`
Safely pulls new system files from upstream without touching user data. It backs up, fetches, re-execs the target updater (resolving its import closure so a new import can't break the upgrade), then checks out only `SYSTEM_PATHS` (`packages/core/src/platform/update-manifest.ts`, which the updater reads rather than imports so it stays self-loading). `BOOTSTRAP_PATHS` covers very old installs.

### Multi-CLI entry files
`CLAUDE.md`, `OPENCODE.md` and `CODEX.md` are thin `@AGENTS.md` wrappers around the canonical `AGENTS.md`. `GEMINI.md` is a legacy no-op guard, so Antigravity does not load the project instructions twice. The `.agents/skills/` entrypoints follow the [open agent skill standard](https://agentskills.io) and route into the same modes.

### Dashboard (optional)
A standalone Go TUI under `dashboard/` for browsing the pipeline. Isolated from the core — never required.

## Data flow (a typical run)

```
scan ──► data/pipeline.md ──► evaluate (oferta + cv) ──► reports/NNN-*.md
                                          │                      │
                                          └──► data/applications.md (tracker)
                                                         │
                                          apply (human reviews + clicks)
```

## Quality gates

- `bun test-all.ts` — the full suite (17k+ assertions across scoring, scan, tracker, PDF, security, updater, architecture boundaries).
- `bun run typecheck` — `tsc` over the workspace (advisory; the suite is the gate).
- `updater-migration-tests.ts` — enforces the system/user boundary and safe cross-version upgrades.
- CI: `test` + CodeQL are required; CodeRabbit reviews every PR; Renovate keeps deps current.

## Where to start reading

- The boundary → `DATA_CONTRACT.md`
- The scoring → `modes/_shared.md` + `modes/oferta.md`
- Adding a job source → [`packages/core/src/scanning/providers/ADDING_A_PROVIDER.md`](packages/core/src/scanning/providers/ADDING_A_PROVIDER.md)
- The layout and dependency rule → this file, "Layout"
- The updater → `packages/cli/src/commands/platform/update-system.ts`; the paths it ships → `packages/core/src/platform/update-manifest.ts`
