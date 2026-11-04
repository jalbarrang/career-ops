# `fork/` — this checkout's own engine changes

This fork carries one change **inside the engine**: `data/career-profile.yml`
schema **v2**, where an experience is a company with nested roles.

```yaml
schema_version: 2
experiences:
  - id: experiences-…
    company:
      name: Series Entertainment
      evidence: { source: cv.md, line: 3, quote: "### Series Entertainment" }
    roles:
      - id: experiences-…
        name: Senior Full Stack Engineer
        period: March 2025 - September 2026
        location: Remote          # optional
        review_status: verified
        evidence: { source: cv.md, line: 4, quote: "**Senior Full Stack Engineer:**" }
        facts:
          - { id: …, text: "Shipped Creator Quests…", review_status: verified, evidence: {…} }
```

Why: upstream v1 stores one flat entry per CV line, so a normal job arrives as
three entries (company, title, dates) with the bullets hanging off the date one,
and two roles at the same employer look like two unrelated companies. v2 gives
one card per employer and a role list under it, which is also what a career
progression looks like.

## The contract

These files live in the updater's manifest, so `bun packages/cli/src/commands/platform/update-system.ts apply`
reverts them. **The fork's copies live in `fork/core/` and are installed with:**

```bash
bun fork/apply.ts            # install
bun fork/apply.ts --check    # report drift, change nothing
```

Run it **after every career-ops update**. `apply` refuses to overwrite a file
whose content is neither the recorded upstream base nor what the fork installed
last time — that is what an upstream change to the same file looks like, and it
needs a human decision, not a silent overwrite. After reviewing upstream's
version, either port the fork change by hand or:

```bash
bun fork/apply.ts --reset-base   # accept what is on disk as the new base
```

Files owned (`fork/base.json` records the hashes):

| File | Why it is forked |
|---|---|
| `packages/cli/src/commands/profile/career-profile.ts` | the importer that WRITES the profile: block classification (company / role / period) and the merge |
| `packages/core/src/profile/career-profile.ts` | `validateProfile` — the gate every write goes through |
| `packages/core/src/profile/profile-cv-selection.ts` | a CV slot binds to a ROLE, so the lookup flattens companies |
| `tests/career-profile.test.ts` | upstream's v1 suite, ported: every upstream scenario is kept, asserted through `roles[]` |
| `tests/profile-cv-selection.test.ts` | same, plus `tests/fixtures/profile-cv-selection.json` |

## Rules this follows

- **The review protocol is unchanged.** `import --review` still reads one answer
  per candidate (`y` / `n` / `e` + text / `q`) on stdin, so the web review queue
  drives it unchanged.
- **Evidence is never invented.** Company, role and period each keep the CV line
  they came from; a fact keeps its own.
- **Ids survive.** A role keeps its id across re-imports — a saved CV selection
  is bound to it. Identity is the evidence line plus the facts a role owns, so
  two same-titled blocks at one employer stay distinct and follow their bullets
  when reordered.
- **Upstream's behaviour is preserved.** Skipping a job's line skips its bullets;
  a plain re-approval never reverts a wording the user edited; the import still
  refuses to read a profile it cannot validate.

## Not done here

Schema v1 files are **not** migrated: `validateProfile` rejects
`schema_version: 1` on purpose, so the fork cannot silently read the old shape.
If a v1 profile ever needs converting, that is a separate `import` run.
