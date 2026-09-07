# Contributing

Thanks for looking. This is a pre-1.0 project: the YAML schema, the CLI output and the library exports may
still change in a minor version, so a change that adjusts one of them is welcome — it just has to say so.

Security problems do **not** go in the issue tracker. See [SECURITY.md](SECURITY.md).

## Getting set up

```bash
git clone https://github.com/QuillDawg/code-agent-orchestrator.git
cd CodeAgentOrchestrator
npm install
npm run build
npm link            # optional: puts your checkout's `cao` on PATH
```

Node 22 or newer (`.nvmrc` pins 22; CI also runs 24). A real `git` is needed for the worktree and
end-to-end suites — without it they skip themselves with a message rather than failing.

Run the CLI straight from the sources while you work, no build step:

```bash
npm run dev -- validate examples/sequential-issues.yaml
npm run dev -- run examples/sequential-issues.yaml --dry-run
```

## The fake agent

Nothing in this repository ever calls a real model. `test/fixtures/fake-claude.mjs` is a scripted stand-in
that speaks the same `stream-json` protocol as `claude -p`, and every test drives it. You can too:

```bash
CAO_CLAUDE_COMMAND="node test/fixtures/fake-claude.mjs" npm run dev -- run examples/sequential-issues.yaml
```

On PowerShell: `$env:CAO_CLAUDE_COMMAND = "node test/fixtures/fake-claude.mjs"`.

That runs a whole workflow — worktrees, merges, diff capture, the dashboard, the run report — for free. It is
the fastest way to see a change working end to end, and the right way to reproduce a bug report.

`FAKE_CLAUDE_MODE` (or `FAKE_CLAUDE_SCRIPT`, a JSON script) picks what the fake worker does. The modes are
listed in the header comment of the file and cover the cases that are otherwise hard to produce on demand:

| Mode | What it exercises |
|---|---|
| `success` (default), `failed`, `blocked`, `needs_input`, `skipped` | each completion status |
| `invalid`, `no-result`, `crash`, `hang` | the failure paths that are not a clean status |
| `commit`, `shell`, `edge`, `noop` | git capture: a real commit, changes made outside the tool stream, renames into paths with spaces and binary files, a task that changes nothing |
| `permission`, `permission-always`, `question`, `permission-cancel`, `permission-hang` | the interactive stdio control protocol (needs `--input-format stream-json`) |
| `subagent`, `subagents`, `orphan-tool`, `thinking` | transcript shapes: nested subagent entries, a call whose result never arrives, thinking blocks |

`FAKE_CLAUDE_DELAY_MS` slows it down so you can watch the dashboard; `FAKE_CLAUDE_TRACE=<file>` appends the
cwd and prompt of every invocation, which is how the isolation and context-passing tests assert what each
worker actually received.

## Tests

```bash
npm test                       # everything
npm test -- test/unit          # one directory
npm test -- report             # one file, by substring
npm run test:watch
```

The layout:

- **`test/unit/`** — one file per area, no processes beyond the fake agent: config and normalization,
  the scheduler and its state machines, both runners and their parsers, the transcript renderer, the
  dashboard and review views (Ink, via `ink-testing-library`), the report, the diff renderer, `cao doctor`,
  the CLI's argument and reference handling, packaging.
- **`test/integration/`** — the parts that need the filesystem and a real `git`: `e2e.test.ts` drives the
  actual CLI through a whole run, `worktree.test.ts` and `git.test.ts` cover isolation, merge-back and diff
  capture, `run-store.test.ts` covers persistence and resume, `interactive.test.ts` the permission protocol,
  `process-manager.test.ts` spawning and tree-kill.
- **`test/helpers/index.ts`** — temporary repositories, workflow builders and the assertions shared by both.
- **`test/fixtures/`** — the fake agent and the expected report document.

New behaviour needs a test. Prefer the unit suites; reach for an integration suite when the thing being
proved is the interaction with git, the filesystem or a child process. Assert on what a user sees — the
rendered output, the persisted JSON — rather than on internal calls, which is what makes these suites
survive refactors.

`vitest.config.ts` pins `CAO_UNICODE=1` so expected output does not depend on the terminal the suite runs in;
the ASCII-fallback tests override it themselves.

## Before you open a pull request

```bash
npm run typecheck
npm run lint        # eslint 10 flat config, type-aware, over src and test
npm test
```

CI runs exactly these plus `npm run build`, on Node 22 and 24, on Linux and Windows. Windows is not optional:
paths, process trees and line endings all differ there, and this project spawns processes and reads git
output on both.

Also:

- Update the docs whose surface you changed — `README.md` for the CLI table and keys,
  [docs/capabilities.md](docs/capabilities.md) for what a workflow can express,
  [docs/configuration.md](docs/configuration.md) for schema keys,
  [docs/architecture.md](docs/architecture.md) for internals.
- Add a line under `## Unreleased` in [CHANGELOG.md](CHANGELOG.md), written for someone who will hit the
  behaviour rather than for someone reading the diff.
- The pull request template's checklist is the whole list; fill it in.

## Commit style

Conventional commits, with an optional scope naming the area (`cli`, `tui`, `workspace`, `runners`, …):

```
feat(cli): add cao doctor
fix(tui): keep paging older entries on a task that was retried
docs: record the CLI consistency pass
```

`feat`, `fix`, `docs`, `test`, `chore`, `refactor`. The subject is lower case, imperative and says what the
change does for a user, not which files moved. Anything that needs more than that goes in the body: what was
wrong, why this fix and not another. One commit per self-contained change — several small commits in a pull
request are easier to review than one large one, and easier to revert.

## Code conventions

TypeScript, ESM, strict mode, no `any` that the linter has to be told about. Two things carry more weight
here than style:

- **The orchestrator is deterministic; agents are not.** Anything an agent produced is untrusted input:
  schema-validate it before it becomes state, and strip escape sequences (`util/text.ts`) before it reaches
  a terminal.
- **Every transition is persisted.** If you add state, decide what happens to it when the process is killed
  between two writes, and cover the resume path in a test.

Comments explain why, not what. `.editorconfig` carries the whitespace rules; there is no formatter to run.
