# docs-and-changelog

Bring the documentation in line with everything implemented in this run. The summaries of
every implementation task are in context; the commits are in `git log`.

## Deliverables

- README: install via `npm install -g code-agent-orchestrator@beta` (clone instructions move
  under Development); a short pre-1.0 stability notice near the top; a sentence that the
  CLI makes no network calls of its own and sends no telemetry; the `cao` bin-name collision
  note; a neutral quick-start path instead of a Windows drive path; the CLI table and the
  dashboard-keys paragraph checked against `src/cli/program.ts` and `src/tui/app.tsx`.
- `CAO_CLAUDE_COMMAND`, `CAO_CODEX_COMMAND` and `CAO_DEBUG` documented together; `cao --help`
  mentions exit codes and these variables if the CLI pass did not add that.
- `docs/configuration.md`: `git.captureDiff`, `git.maxDiffBytes`, any other new keys.
- `docs/capabilities.md` and `docs/architecture.md`: diff capture, `report.md`, doctor, the
  new transcript entry kinds, the run directory layout.
- `CONTRIBUTING.md` (running the fake agent, test layout, commit style) and `SECURITY.md`.
- `CHANGELOG.md`: Keep a Changelog preamble; move Unreleased into `## [0.1.0] - <today>` as
  the initial public release, folding "Removed (breaking, library API)" into an "initial
  public API" note; list everything from this run.
- Every relative link in README, CHANGELOG and docs resolves. Commit with `docs:`.

`summary` says what changed; `warnings` lists any claim you could not verify.
