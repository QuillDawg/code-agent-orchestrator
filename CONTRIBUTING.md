# Contributing

Thanks for looking. This is a pre-1.0 project: the YAML schema, the CLI output and the library exports may
still change in a minor version, so a change that adjusts one of them is welcome — it just has to say so.

Security problems do **not** go in the issue tracker. See [SECURITY.md](SECURITY.md).

## Getting set up

```bash
git clone https://github.com/QuillDawg/code-agent-orchestrator.git
cd code-agent-orchestrator
npm install
npm run build
npm link            # optional: puts your checkout's `cao` on PATH
```

Node 22.12 or newer: `.nvmrc` pins the 22 line, and commander 15 sets the 22.12 floor (CI also runs 24).
A real `git` is needed for the worktree and end-to-end suites — without it they skip themselves with a
message rather than failing.

This is an npm workspace root. `packages/protocol/` is `code-agent-orchestrator-protocol`, the wire
contract shared with CAO Desktop, and `cao` depends on it like any other dependency. `npm install` links
and builds it for you; `npm run typecheck`, `npm run lint` and `npm test` rebuild it first, so editing
`packages/protocol/src/` needs no separate step. Two rules govern what may go in it: **nothing that needs
a Node builtin, a DOM API or a dependency** — a test bundles it for a browser with no externals and fails
on any import that is not relative — and **nothing that is presentation**. It carries its own semver,
moved only when the contract moves, so most `cao` releases do not bump it.

Run the CLI straight from the sources while you work, no build step:

```bash
npm run dev -- validate examples/sequential-issues.yaml
npm run dev -- run examples/sequential-issues.yaml --dry-run
```

## The fake agents

Nothing in this repository ever calls a real model. `test/fixtures/fake-claude.mjs` speaks Claude's
`stream-json` protocol; `test/fixtures/fake-codex.mjs` speaks both Codex exec JSONL and app-server JSON-RPC.
The tests drive these stand-ins. You can use either fixture for a whole workflow too:

```bash
CAO_CLAUDE_COMMAND="node test/fixtures/fake-claude.mjs" npm run dev -- run examples/sequential-issues.yaml
```

On PowerShell: `$env:CAO_CLAUDE_COMMAND = "node test/fixtures/fake-claude.mjs"`. `CAO_CODEX_COMMAND` does
the same for `node test/fixtures/fake-codex.mjs`.

**The fakes are a contract, not a mirror.** Both validate their own command line the way the real binary
does and exit non-zero with the vendor's wording when CAO sends something invalid - an unknown flag, a
global flag written after `codex exec`, `--approve-for-me` next to `--sandbox`, an output schema that is not
OpenAI-strict. Each fake keeps one table of the flags it accepts (`FLAGS`, near the top of the file), so
teaching it a new flag is one edit. If a test starts failing because a fake got stricter, the runner is what
needs fixing: a permissive fake agrees with every bug CAO has, which is how two Codex flag bugs reached
users past a green suite.

**A runner change without a matching fake change is incomplete.** A new flag, a new event, a new request or
response shape, a new failure the runner classifies — the fake has to be able to produce it, and to reject
the wrong version of it, before the change is done. Two rules follow from that:

- Make the fake **stricter**, never more permissive. If a new flag would make an existing fake exit 2,
  that is the fake telling you the flag is wrong, or that its `FLAGS` table is out of date — decide which,
  and say so in the commit body. Loosening a check to make a test pass removes the only thing standing
  between a shipped argv bug and a user.
- Add the **mode** that produces the situation rather than mocking the runner. Every mode in the tables
  below exists because some behaviour had no other way to be produced on demand; a mode is also how the
  next person reproduces the bug by hand with `CAO_CODEX_COMMAND` / `CAO_CLAUDE_COMMAND`.

That runs a whole workflow — worktrees, merges, diff capture, the dashboard, the run report — for free. It is
the fastest way to see a change working end to end, and the right way to reproduce a bug report.

`FAKE_CLAUDE_MODE` (or `FAKE_CLAUDE_SCRIPT`, a JSON script) picks what the fake worker does. The modes are
listed in the header comment of the file and cover the cases that are otherwise hard to produce on demand:

| Mode | What it exercises |
|---|---|
| `success` (default), `failed`, `blocked`, `needs_input`, `skipped` | each completion status |
| `invalid`, `no-result`, `crash`, `hang`, `error-result`, `api-error`, `api-error-stderr` | the failure paths that are not a clean status, including a transient error the resumed session recovers from |
| `bad-schema`, `open-tool-exit` | the rows of the outcome map with no other producer: the API refusing `--json-schema` (a `config_error`), and a clean exit with a tool call still open (a `crash` naming it) |
| `commit`, `shell`, `edge`, `noop` | git capture: a real commit, changes made outside the tool stream, renames into paths with spaces and binary files, a task that changes nothing |
| `permission`, `permission-always`, `question`, `question-multi`, `permission-cancel`, `permission-hang` | the interactive stdio control protocol (needs `--input-format stream-json`) |
| `permission-two`, `permission-cancel-late`, `permission-give-up` | two prompts open at once answered in either order, a withdrawal of an already-answered request, and a session that is refused everything and gives up carrying `permission_denials` |
| `question-resumable`, `prose-no-json` | what `cao resume --task X --input "…"` and the result nudge do to a session: both ask once and finish when the session is resumed |
| `subagent`, `subagents`, `orphan-tool`, `thinking` | transcript shapes: nested subagent entries, a call whose result never arrives, thinking blocks |
| `steer`, `steer-exit` | steering a running turn (needs `--input-format stream-json`): `steer` ends the current turn and starts a new one from the message queued on stdin, `steer-exit` dies mid-turn holding a message so the delivery ends up `failed` rather than `queued` |

`FAKE_CLAUDE_DELAY_MS` slows it down so you can watch the dashboard; `FAKE_CLAUDE_TRACE=<file>` appends the
cwd and prompt of every invocation, which is how the isolation and context-passing tests assert what each
worker actually received. `FAKE_CLAUDE_STEER_WAIT_MS` bounds how long `steer`/`steer-exit` wait for the
queued message; `FAKE_CLAUDE_NO_REPLAY=1` drops `--replay-user-messages` from the fake's advertised flags,
modelling a CLI too old to echo a steered message back.

`FAKE_CODEX_MODE` (or `FAKE_CODEX_TASK_MODES='{"task-id":"hang"}'`) does the same for the Codex fixture, and
`FAKE_CODEX_TRACE=<file>` records the argv, the prompt and which command line was used (`exec`,
`exec resume`, `app-server`):

| Mode | What it exercises |
|---|---|
| `success` (default), `invalid`, `api-error`, `hang` | the exec and app-server outcome paths; `invalid` and `api-error` recover when the session is resumed, so a run exercises nudge-then-success and transient-then-resume |
| `interim` | a completion object mid-turn, more work, then a different one: the object is protocol, not prose, and only the last one is the outcome |
| `schema-rejected`, `open-command` | the API refusing the output schema (a `config_error` on both transports), and a command the stream never completes (a `crash` naming it) |
| `exec-approval`, `exec-user-input` | **exec only**: the CLI rejecting a command approval and a `request_user_input` the way the real binary does, which is H3.7 row 10. Both are skipped on `exec resume`, modelling an answer that resolved the request |
| `approval`, `approval-always`, `approval-decline`, `file-approval`, `question`, `question-multi` | **app-server only**: command, file-change and `requestUserInput` requests, and each decision the protocol allows. Responses are validated against codex-cli's own response schemas, so an answer of the wrong shape fails the turn |
| `question-recovers`, `question-then-resume`, `unknown-request` | a worker that finishes without its answer, one that finishes when the session is resumed with it, and a request CAO must refuse with `-32601` |
| `failure`, `interrupted`, `mcp-failure`, `overload-once` | typed turn failures, an interrupted turn, a required MCP server that will not start, a `-32001` overload on `thread/start` |
| `strict-schema`, `malformed`, `wrong-model`, `missing-policy` | free-form result data, junk on stdout, and a server that reports a security envelope CAO did not ask for |
| `steer` | **app-server only**: holds a turn open for a `turn/steer`. `FAKE_CODEX_STEER` selects one of the server's refusals instead of success (`no-turn`, `review`, `compact`, `empty-input`, `schema`), covering every rejection row of spec §3.5; `FAKE_CODEX_STEER_WAIT_MS` bounds how long the turn waits |

`FAKE_CODEX_RESUME_CONFLICT=1` makes a `thread/resume` answer "already has an active writer", modelling a
thread another process still has open.

## Tests

```bash
npm test                       # everything, offline
npm test -- test/unit          # one directory
npm test -- report             # one file, by substring
npm run test:watch
npm run test:agents            # the checks that need the real CLIs on PATH
npm run smoke:pack             # pack, install, and smoke the packaged CLI against the fakes
```

`npm run test:agents` is the check to run before touching a runner. It builds the argv for a matrix of
workflow options through the production argument builders and asserts that every flag CAO can emit is one
the installed binary advertises, on the right side of the subcommand, with a value the help text allows. It
lives outside `npm test` (`vitest.agents.config.ts`) so the default suite stays offline, and it skips - with
the reason printed - when `codex` or `claude` is missing or below `MINIMUM_AGENT_VERSIONS`.

`npm run smoke:pack` packs the tarball, installs it into a scratch global prefix, and drives the packaged
`cao` against the fake agents - `--help`, a bare invocation, `doctor --json` with no probe, a fixture run,
`ui` in a non-TTY, `diagnostics --out` - so a `files`, `bin` or `exports` entry missing from `package.json`
fails here instead of at publish. It lives in `scripts/smoke-packaged.mjs` and cleans up its own temp
directories; run it after touching anything packaging depends on.

The layout:

- **`test/unit/`** — one file per area, no processes beyond the fake agent: config and normalization,
  the scheduler and its state machines, both runners and their parsers, the transcript renderer, the
  dashboard and review views (Ink, via `ink-testing-library`), the report, the diff renderer, `cao doctor`,
  the CLI's argument and reference handling, packaging.
- **`test/integration/`** — the parts that need the filesystem and a real `git`: `e2e.test.ts` drives the
  actual CLI through a whole run, `codex-e2e.test.ts` does the same for both Codex transports,
  `worktree.test.ts` and `git.test.ts` cover isolation, merge-back and diff capture, `run-store.test.ts`
  covers persistence and resume, `interactive.test.ts` the permission protocol, `process-manager.test.ts`
  spawning and tree-kill. `agent-surface.test.ts` is the exception: it needs the real CLIs and runs under
  `npm run test:agents`, not `npm test`.
- **`test/helpers/index.ts`** — temporary repositories, workflow builders and the assertions shared by both.
- **`test/helpers/ink-harness.ts`** — `renderTree(element, { columns, rows })` for a whole screen.
  `ink-testing-library` fakes a stdout of 100 columns with no `rows` at all, so it cannot answer "does this
  fit the terminal"; the harness does, and adds `write(keys)` (see its `KEYS` table for the raw escapes),
  `waitFor(predicate)`, `resize(columns, rows)` and `frameHeight()`. Use it for anything that sizes itself
  to the terminal, and `ink-testing-library` for a single component.
- **`test/fixtures/`** — the fake Claude/Codex agents, a fake `$VISUAL`/`$EDITOR` (`fake-editor.mjs`, for the
  composer and task editor's `Ctrl+O` round trip) and the expected report document.
- **`test/fixtures/frames/`** — the dashboard's frames, captured through the harness and compared by
  `test/unit/dashboard-frames.test.tsx`. They are colour-stripped and every digit is flattened to `#`, so
  what they pin is the layout, not a clock reading. Re-capture with `CAO_UPDATE_FRAMES=1 npx vitest run
  test/unit/dashboard-frames.test.tsx`, and only when the change to the dashboard was the point.

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
npm run test:agents # if you touched a runner, its arguments or its detection
npm run smoke:pack  # if you touched package.json's files/bin/exports, or anything under scripts/
```

CI runs the first three plus `npm run build`, on Node 22 and 24, on Linux and Windows, and then a second
job that packs the tarball and drives the installed `cao` against the fake agents (`npm run smoke:pack`),
asserts the resolved `ink` is at or above 7.0.6, and runs `npm audit --omit=dev --audit-level=high`. It does
not run `npm run test:agents`: that one needs the real agent CLIs, which CI never has, so it is on you.
Windows is not optional: paths, process trees and line endings all differ there, and this project spawns
processes and reads git output on both.

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
- **Never build a run-directory path by hand.** `createRunPaths` (via `persistence/paths.ts`, which spells
  its results with the platform separator) is the one description of the layout, and it lives in the
  protocol package so that CAO Desktop reads the same one. A `'.orchestrator'` string literal outside that
  package is how a second, silently diverging copy of the layout starts, and a test fails on one.

Comments explain why, not what. `.editorconfig` carries the whitespace rules; there is no formatter to run.
