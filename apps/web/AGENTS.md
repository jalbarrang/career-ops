# Working in `web/`

The web app is a **view over the user's own files**, not a second engine. Read this
before changing anything under `web/`.

It is a **SvelteKit 3 + Svelte 5** app (App Router-free; the Next.js version is
gone). Server work happens in `+page.server.ts` / `+server.ts`, state lives in
runes stores under `web/src/lib/*.svelte.ts`, and the shell is `src/routes/+layout.svelte`.

UI primitives are **shadcn-svelte** (bits-ui) under `src/components/ui/`; strings go
through **Paraglide JS** (see Localization below).

## The three rules that are not style preferences

1. **Orchestrate the core; never reimplement it.** The CLI already resolves tracker
   paths, matches tailored CVs and canonicalises statuses: call it, or mirror it
   behind a parity test. A second implementation of the same rule is how the two
   halves start disagreeing, and the disagreement is always silent.
   `web/src/lib/core/` holds the access layer for exactly this.

2. **Markdown is the source of truth.** `data/applications.md`, `cv.md`, `reports/`
   are canonical; anything else is a derived index. Status changes go through
   `/api/status`, which delegates to the root `packages/cli/src/commands/tracker/set-status.ts`. That is the single
   write path, and it is single on purpose. Never write a user's file from a route
   that bypasses it.

3. **Nothing is ever submitted automatically.** The apply flow fills in and previews;
   a human presses send. There is no exception, no flag, and no "just for testing".

## A missing file is not a malformed file

Treating a parse error as "not there yet" is how a user's config gets overwritten
with the shipped example. Distinguish `ENOENT` from every other failure, and let a
broken user-layer file surface as an error the user can act on rather than as an
empty default. (`apps/web/src/lib/portals-config.ts` is the worked example.)

## Testing

Logic that deserves a test lives in a plain `.ts` module so `bun test` can import
it with no build step and no `@/` alias loader. See `tracker-table.ts`,
`cv-selection.ts`, `report-sections.ts`. A component is not a place to put a rule
you want to assert.

```
bun test          # discovers tests/**/*.test.ts
bun run typecheck # svelte-check
bun run dev       # the app, reading the sibling career-ops files
bun run build     # vite build → build/ (served by `bun start`)
```

A few suites assert on *source shape* (route X calls Y before Z). When a file moves,
repoint the path; when the framework's syntax changes the shape, adapt the assertion
and say in a comment why the property still holds. Deleting those tests loses the
guard; leaving them reading a deleted file is worse.

Point `CAREER_OPS_ROOT` at a scratch directory when you need data to test against;
it is how the app finds the user's files, and it keeps your real pipeline out of it.

## UI components (shadcn-svelte)

Primitives are vendored shadcn-svelte components in `src/components/ui/`. Only what
the app actually uses is vendored — `button`, `badge`, `dialog`, `skeleton`. Add
another with the CLI rather than by hand:

```bash
bunx shadcn-svelte add card --overwrite --skip-preflight   # then import from @/components/ui/card
```

Two project-specific rules apply to anything you add:

1. **`components.json` aliases point at this app's tree**: `ui` → `@/components/ui`,
   `utils` → `@/lib/cn` (which also exports shadcn's `WithElementRef`,
   `WithoutChild`, `WithoutChildren`, `WithoutChildrenOrChild` helpers). Add a new
   component with `bunx shadcn-svelte add <name> --overwrite --skip-preflight`;
   `--overwrite` is only needed when a file already exists.
   Note `--overwrite` is required once a directory exists, and the CLI rewrites the
   `index.ts` barrel each time.
2. **The CSS tokens are MAPPED, not adopted.** `src/app.css` defines shadcn's names
   (`--color-card`, `--color-popover`, `--color-primary`, `--color-accent`,
   `--color-ring`, …) as aliases of the career-ops palette, so a generated component
   inherits the brand instead of replacing it. The ONE name that keeps our meaning
   is `muted`: shadcn uses it as a **surface** (`bg-muted`), this app uses it as
   **text** (`text-muted`, ~300 call sites). `--color-muted` therefore stays the text
   colour, `--color-muted-foreground` carries shadcn's secondary text, and the few
   generated `bg-muted` classes were rewritten to `bg-surface-hover`. **Never add a
   `--muted` surface variable** — it would silently repaint every paragraph.

`src/components/ui/badge/badge.svelte` extends shadcn's variants with this app's
score/status **tones** (`good|warn|bad|info|muted`), which is what `scoreTone()` and
`followupStatusTone()` return. `src/components/scheduled-scans/scheduled-overlay.svelte`
is a thin wrapper over shadcn's `Dialog` (centre + right-drawer variants) — use it
for new modals rather than hand-rolling a scrim and a focus trap.

## Localization (Paraglide JS)

Translations are an inlang project. Before localization work, read
`project.inlang/README.md`. Two rules:

- **Edit `messages/{locale}.json`.** Never edit `src/lib/paraglide/` — it is
  generated (and carries its own `.gitignore`). Locales are `en` (base) and `es`;
  adding one means adding it to `project.inlang/settings.json` too.
- **Labels are lazily evaluated.** The locale is per request (a cookie), so a string
  captured at module load freezes the language the server booted with. In
  `src/lib/nav-items.ts` labels are `() => m.nav_today()` for that reason. UI text is
  `m.some_key()` inside markup; `src/hooks.server.ts` runs Paraglide's middleware
  after the origin guard and fills `%lang%` / `%dir%` in `app.html`.

`bun run check:i18n` lints the catalogue; `bun run typecheck` compiles the messages
first, so a fresh clone typechecks without a build.

## Reviews and scope

`web/` is maintained as first-party: functional and correctness fixes are very
welcome, design and feature proposals are routed to Discussion #156 so the surface
stays coherent. That is a routing decision, not a judgement on the work.

<!-- BEGIN:sveltekit-agent-rules -->

# This is NOT the SvelteKit you know

SvelteKit 3 and Svelte 5 changed enough that trained-in knowledge is actively
wrong. Verify against `node_modules/@sveltejs/kit/types/index.d.ts` and
`node_modules/svelte/types/index.d.ts` in this directory before writing code.

- **There is no `svelte.config.js`.** Kit options (`adapter`, `compilerOptions`)
  are passed to the `sveltekit()` Vite plugin in `vite.config.ts`.
- **`$lib` no longer exists** in v3. This app keeps the Next-era `@/` alias
  (`@/lib/...`, `@/components/...`), configured in `vite.config.ts` and
  `tsconfig.json`. Keep using it.
- **`$app/stores` was removed.** Import `page`, `navigating`, `updated` from
  `$app/state` and read them without the `$` prefix: `page.url.pathname`.
- **`$app/environment` is now `$app/env`.**
- **Hook types live in `@sveltejs/kit/hooks`**, not the package root —
  `import type { Handle } from "@sveltejs/kit/hooks"`.
- **Route handlers** are `+server.ts` exporting `GET`/`POST`/…, taking one
  `RequestEvent` (`{ request, params, url }`). `params` is synchronous. Use
  `json()` from `@sveltejs/kit`. `export const runtime`/`dynamic` do not exist.
- **`.svelte` files have a default export and nothing else.** A named import of a
  component is a build error.
- **Never `export` from an instance `<script>`** in runes mode. Shared consts and
  types go in a plain `.ts` module or a `<script module lang="ts">` block.
- **`goto(url, { replace, reset })`** — `noScroll`/`keepFocus`/`replaceState` are
  gone or deprecated.
- Attributes are lowercase DOM names: `class`, `onclick`, `bind:this`. Children are
  snippets: `{@render children()}`.

<!-- END:sveltekit-agent-rules -->
