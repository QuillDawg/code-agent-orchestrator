## What changed

<!-- One or two sentences. Link the issue if there is one: Fixes #123 -->

## Why

<!-- The problem this solves, or the behaviour that was wrong. -->

## Checklist

- [ ] `npm run typecheck`, `npm run lint` and `npm test` are green
- [ ] `npm run test:agents` — if you touched a runner, its arguments or its detection
- [ ] `npm run smoke:pack` — if you touched `package.json`'s `files`/`bin`/`exports`, or anything under `scripts/`
- [ ] Tests added or extended for the change (vitest, against the fake CLIs in `test/fixtures/` — no real API calls)
- [ ] Docs updated where the user-facing surface changed (`README.md`, `docs/capabilities.md`, `docs/configuration.md`)
- [ ] A line added under `## Unreleased` in `CHANGELOG.md`, unless this is a documentation-only change
- [ ] Commit messages are conventional (`feat:`, `fix:`, `docs:`, `chore:`)

## Breaking changes

<!-- Pre-1.0 the YAML schema and the library API may change between minors. Say so here, and in the
     CHANGELOG, if this changes either. Otherwise write "none". -->

none
