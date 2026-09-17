# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0 a minor version may change the
workflow YAML schema, the CLI output or the library exports; when it does, this file says so.

## [Unreleased]

### Added

- **A run can be driven from another terminal: the request inbox.** A process that does not own a run now
  asks it for something by writing one file into the run's own directory —
  `requests/<ULID>-<kind>.json` with `stop`, `kill` or `restart` — and reads the answer back out of
  `requests/acks/<ULID>.json`. The owner picks it up on the 500 ms tick it already ran for `stop.json`,
  hands it to the run controller so it is applied inside the scheduler's loop like every other command, and
  writes the acknowledgment **before** it deletes the request, so a crash in between leaves a request that
  is asked again rather than one nobody answered. The ULID is also the file name's prefix, which makes a
  plain directory listing request order, and an id is answered once for the life of the run: a resend after
  a lost ack gets the first answer back, verbatim, instead of doing the thing twice. A request naming a
  task can carry `expected: { attempt, revision }` and is refused if the task has moved on since.
  `approve`, `reject` and `answer` are read and refused with a reason: a permission decision must not be
  grantable by anyone who can write a file in the repository, and they stay something you do in the
  terminal that owns the run until presence gating ships. A file that cannot be read, or that was written
  by a newer `cao` than this one, is moved to `requests/rejected/` with a `.reason.txt` beside it rather
  than guessed at or thrown away; a sync-conflict copy is skipped the way the registry skips one.
  **Nothing about `cao stop` changes**: it still writes `stop.json`, which the owner translates into a stop
  request of its own, and a second one is still the kill.
- **`cao emit status` says what a run can be asked to do.** A new `Controls:` row, and a `capabilities`
  field in `--json`, list what a run this `cao` starts wires up — the same list it writes into its registry
  entry. "Why is the thing I am sending having no effect" is the other half of the question `cao emit
  status` exists to answer.
- Protocol package `0.2.0` (`cao` follows to `^0.2.0`): `createRunPaths` gains `requestsDir`,
  `requestAcksDir` and `requestRejectedDir`; `CONTROL_REQUEST_KINDS` gains `edit` and `prompt`;
  `ControlRequest` gains `expected`, `changes`, `restart`, `text` and `mode`; and `TaskEdit`,
  `TaskRevision`, `PromptDelivery`, `QuotaSnapshot`, `ControlExpectation`, `PROMPT_DELIVERY_MODES` and
  `TASK_EDIT_FIELDS` are new, along with the `edit` and `prompt` capability tokens. All additive:
  `WorkflowRun.schemaVersion` stays `1` and workflow YAML is untouched.
- **One door into a running workflow: the run controller.** Everything outside `src/workflow/` that changes
  a run's execution state now goes through one object, built with the runtime and handed to the dashboard
  and to signal handling. A command carries an envelope — a ULID, who sent it, their pid, and optionally
  the attempt and revision the sender believed the task was on — and comes back with one acknowledgment:
  `applied`, `accepted` or `rejected` with a reason written as a sentence for a human. The id deduplicates
  for the life of the run (kept in `workflow.json` under `run.controls.seen`, the last 1000), so a command
  sent twice is applied once and the resend gets the first answer back, and a request built on state that
  has since moved on is refused instead of applied to something nobody looked at. Every command is applied
  **inside** the scheduler's loop, between two of its own events, so it can never land halfway through an
  attempt finishing.
  The commands are `stop`, `kill`, `restart` and the new `cancelTask`; `edit`, `prompt`, `approve`,
  `reject` and `answer` are declared and answered with "not available yet", so the surfaces that will send
  them can be built against the whole shape. **Nothing about using `cao` changes**: Ctrl+C, `cao stop` and
  the dashboard's `R` do exactly what they did, through the new door.
  For an embedder, `createRuntime()` now returns a `controller` beside the scheduler, and
  `createRunController`, `controlEnvelope`, `RunController`, `ControlCommand`, `ControlEnvelope`, `TaskEdit`
  and `Runtime` are exported from the library root.
- **`cancelTask`: stop one task without stopping the run.** The attempt's abort signal fires, whatever it
  was asking a human is denied first (with the same "finish with status needs_input if you cannot continue"
  hint every other denial carries), the attempt is recorded as `cancelled` and the task ends `cancelled`
  — which `restart` and `cao resume` already accept. A task whose attempt has already ended and is merging
  back cannot be aborted, so the command is acknowledged as `accepted` and takes effect when that
  finalization lands, ending the task rather than spending a retry on it. No key or CLI flag sends this
  yet; the screens and commands that will are next.
- **`cao run --emit`, `cao resume --emit`, `CAO_EMIT` and `cao emit enable|disable|status`: the switch that
  turns announcing on.** In precedence order, `--emit` / `--no-emit` on the command line wins over
  `CAO_EMIT=1` / `CAO_EMIT=0`, which wins over the per-user opt-in `cao emit enable` writes to
  `~/.cao/config.json`, which wins over the default — **off**. The flag is strictly boolean and takes no
  value, so `cao run --emit workflow.yaml` runs `workflow.yaml` rather than reading the path as the flag's
  argument. `--emit-feed` and `CAO_EMIT_FEED` are reserved for the per-run live feed a later release adds;
  they parse today, say they are reserved, and are never implied by the persisted opt-in.
  `cao emit status` is the one command to run when a desktop surface shows nothing: it prints the effective
  setting **and which row of that table decided it**, the resolved `~/.cao` and whether it passed the
  path-shape check, how many entries are live and how many are retained, and which surfaces are present on
  this machine right now. `--json` prints the same thing for a program to read. An entry's `capabilities`
  list is written from **what the run actually wired up**, never from a constant, so a run advertises only
  what it can really do.
  **Nothing about using `cao` changes with the switch off**, which is the default: a run with emit off does
  not create or touch `~/.cao` at all.
- **`~/.cao/runs/<runId>@<repoHash>.json`: a run can announce itself to a desktop surface.** The new
  `src/persistence/registry.ts` is the first user-level state in this codebase — every other path `cao`
  builds derives from a repository root, so a run has until now been findable only by someone who already
  knew which checkout it belonged to. An announced run writes one entry once it is running, rewrites it on
  the same 20 s tick that already refreshes `lock.json` and `live.json`, and writes it a last time with the
  terminal state, `endedAt` and `exitCode`. The entry is a **pointer plus a heartbeat, never a second copy
  of run state**: everything else a reader shows comes from the run directory it points at, which is what
  keeps a stale entry harmless. The key carries a hash of the repository root because run ids are unique
  only within one repository, and two checkouts running on the same day both allocate `2026-09-10-001`.
  Entries are retained after the run ends and reaped once they are older than `retainDays` (14 by default,
  in `~/.cao/config.json`) — either since they ended, or, for an orchestrator that was hard-killed and
  never got to say so, since they last heartbeated. Reaping deletes **pointers, never run directories**.
  `CAO_HOME` moves the whole directory; one that is a UNC path, a mapped network drive, inside a
  OneDrive/Dropbox/Google Drive folder or (on POSIX) not owner-only is refused with a reason, and a synced
  directory's conflict copies are ignored rather than parsed.
  **Nothing about using `cao` changes.** No command turns this on yet: announcing is off unless the
  scheduler is handed an `emit` announcement, and with it off `cao` does not touch `~/.cao` at all. Every
  registry call is best-effort — a home directory it cannot write warns once and never fails a run.
- **A second published package: `code-agent-orchestrator-protocol`.** The types and pure logic that
  describe what `cao` writes to disk now live in `packages/protocol/`, an npm workspace in this repository
  with its own semver. It has zero runtime dependencies, uses no Node builtins and is browser-safe, so a
  desktop or web surface can share `cao`'s wire contract without bundling the CLI — whose entry point
  reaches `node:fs` and cannot be built for a browser at all. It carries the workflow, run, result, event,
  interaction and transcript types, the run-directory layout (`createRunPaths`), the transcript structure
  (`planTranscript`, `PlannedEntry`, the kind filters), and the schemas of the registry, request,
  pending-interaction and presence files a companion surface will exchange with a run.
- **`createTranscriptPlan()` in `code-agent-orchestrator-protocol`: the transcript tree, kept up to date as
  the log arrives.** `planTranscript` reads a whole attempt to decide which calls went unanswered, which is
  what `cao logs` and `cao peek` want and what a live view cannot afford — a following surface would re-plan
  tens of thousands of entries several times a second and rebuild every row each time. The stateful planner
  takes entries as they land (`append`, which reports what actually moved), hands back a tree whose
  unchanged nodes are the same objects they were (`plan`), marks the calls nobody answered when the attempt
  stops (`end`), and forgets an attempt at a retry boundary, where tool ids stop pairing (`reset`).
  **`planTranscript` is untouched**; the two are separate implementations held together by a property test
  that runs the incremental planner against it at every split point of every recorded attempt log, and of a
  thousand generated ones whose entries arrive in orders no agent produces.
  `cao`'s own transcript rendering still calls `planTranscript` and is unchanged.
  **Nothing about using `cao` changes.** It gained the package as its ninth dependency and re-exports every
  symbol from `src/index.ts`, so `import { … } from 'code-agent-orchestrator'` resolves exactly as before;
  the moved declarations were moved, not copied, and a test fails if any of them is ever declared twice.
- Codex now has a production-default `exec` backend with explicit auto-review and configuration isolation,
  plus an opt-in experimental `appServer` backend for dashboard-mediated command/file approvals, typed
  failures, token usage, interruption, and gated user questions.
- Agent preflight now verifies the installed Claude/Codex version, authentication, and workflow-required
  capabilities before a run mutates its workspace. `cao doctor [workflow] --json` can report only the
  providers and transports that workflow needs.
- Mixed-provider examples cover both Claude implementation with Codex review and Codex implementation with
  Claude review.
- `npm run test:agents` checks the arguments CAO emits against the installed agent CLIs. For a matrix of
  workflow options it builds the real argv and asserts every flag against `codex --help`, `codex exec
  --help`, `codex exec resume --help`, `codex app-server --help` and `claude --help`, including whether the
  flag belongs before or after the subcommand. It skips with a stated reason when a CLI is missing or below
  the supported minimum, so `npm test` stays offline and unchanged.
- Small documentation smoke tests make it easy to verify Codex alone, Claude alone, and a Codex-to-Claude
  review handoff with cost-appropriate models.
- `cao validate` now names, once per workflow, the tasks that run on Codex transport `exec`, and states
  that no human can be reached during them. The run log records the same thing once per such task.

### Changed

- **The dashboard fits an 80-column terminal.** The summary line is truncated rather than wrapped, and
  below 100 columns it drops the token counts (the usage view has them) and halves the progress bar; the
  usage table drops its cache, turns, time and tools columns and shortens its legend; and the help screen
  has a narrow layout. `?` used to draw 28 lines into a 24-row terminal, which scrolled the dashboard out
  of the screen to read it, and the summary line wrapped onto a second line that began with the stray
  space between two of its columns. Nothing changes at 100 columns or wider except the usage legend, which
  was 133 columns and wrapped even there and is now two lines.
- **An announced run now advertises what it accepts.** A registry entry's `capabilities` was always `[]`,
  because nothing polled for requests; a run started by this release writes
  `["requests", "stop", "kill", "restart"]`, which is exactly what its inbox acts on. `edit` and `prompt`
  are parsed and answered but not applied yet, so they are deliberately not in the list — a surface enables
  an affordance by token, and a run must not claim one it cannot honour.
- **An attempt the orchestrator cancelled now ends its transcript with the cancellation.** The attempt's
  `events.jsonl` used to stop at whatever the worker said last, so `cao logs` on a cancelled attempt ended
  mid tool call and gave no sign of why; it now closes with `cancelled by the orchestrator`, like every
  other way an attempt can end. Claude and `codex exec` only — the Codex app-server already wrote it.
- **The dashboard's `R` says what the run controller said.** Pressing `R` on a task that cannot be
  restarted used to print one fixed line whatever the reason; the notice is now the controller's own
  answer, so a task that is still running says so and is told to be cancelled first. The message for a task
  that has simply not failed is unchanged.
- **The terminal UI runs on Ink 7 and React 19.** `ink` moves from 5.2 to `^7.1.1`, `react` and
  `@types/react` to 19, and `commander` to 15; `zustand`, `fuzzysort` and `ink-link` join them. Node 22
  stays the floor and no screen, key or exit code changes: `--help` and `--version` still exit 0, a usage
  error still exits 2, and the dashboard, usage, help and detail views render the same frames they did
  before (`test/fixtures/frames/`). Two things are different in the terminal. Ink 7 renamed the Backspace
  key: it arrives as `key.backspace` where it used to arrive as `key.delete`, so **Delete no longer erases
  the character behind the cursor** when typing a denial reason or a `/` search — Backspace does, as it
  always did. And Ink 7 wraps an over-long line at a different word boundary, so on a terminal narrower
  than about 100 columns the dashboard's summary line now breaks before `$0.00` rather than before `Cost`.
- **An agent CLI that refuses what CAO sent it is now a configuration error, not a crash, and is never
  retried.** `error: the argument '--approve-for-me' cannot be used with '--sandbox <SANDBOX_MODE>'`,
  `error: unknown option '--x'`, an `invalid_json_schema` from the model API, a JSON-RPC `-32602`, and an
  app-server `initialize`/`thread/start` that does not come back with the envelope that was requested all
  end the task once, as the new `config_error` outcome. The message names the offending option and the
  workflow key it came from (`codex.approvals`, `codex.sandbox`, `claude.extraArgs`, ...). `retry.attempts`
  is not spent, and `onFailure` decides what the run does next exactly as before.
- **Preflight runs once per run, before the first worker.** A CLI below `MINIMUM_AGENT_VERSIONS`, or one
  that does not advertise a capability the workflow selected (`exec`, `appServer`, `autoReview`,
  `isolatedConfig`, `streamJson`, `structuredOutput`), now fails every task that would have used it at run
  start, naming the option, the workflow key, the version found and the version needed - instead of being
  discovered per task, mid-run, as a retryable crash.
- **`cao doctor` now starts each mode a workflow can select.** Codex `exec` runs one trivial turn with a
  minimal strict output schema in a temporary read-only directory; Codex `app-server` is taken through
  `initialize` + `thread/start` and interrupted; Claude ask-mode and deny-mode are started with the exact
  argv a run would send and stopped as soon as the session reports it started (so they cost no tokens).
  Each is one actionable line, nothing is left running, and an agent that is not installed or not
  authenticated is not probed.
- Both runners now map the same situation to the same outcome, written down once in
  `src/runners/outcomes.ts` and checked against the table in `docs/agent-cli-integration.md` by a test. A
  process killed from outside now names the signal it died from, and a worker that exits while a tool call
  it made is still unanswered is a `crash` naming that call rather than "no result".
- `cao resume <run> --task <id> --input "..."` now **continues the session that asked** instead of running
  the task again from the top, wherever the paused attempt left a resumable one (both Claude and both Codex
  transports). The answer arrives as that session's next message, quoted next to the question it answers.
  Where no session can be resumed the task still restarts, but its prompt now carries the original question
  beside the answer, so a restarted worker knows what it is answering. `cao task <id>` distinguishes the two.
- `--input` is refused, rather than silently ignored, for a task that is not in `needs_input` (the error
  names the state it is actually in and which tasks are waiting), for an unknown task id, and when several
  `--task` values are given: an answer belongs to the question one worker asked. Tasks nobody answered are
  left holding their questions instead of being restarted unanswered, so a run paused on several of them is
  answered one at a time and says so.
- Only the attempt that actually carries a new answer is labelled `user input` in `cao task` and
  `report.md`; a retry of a failed answering attempt is a retry, and still receives the answer.
- `hooks.onInputRequired` now also fires for a request nobody can answer (headless, `--no-tui`, CI), where
  the notification is the only way an operator finds out at all. `CAO_TASK_STATE` distinguishes the two
  cases: `waiting` while someone can still answer, `needs_input` when nobody can.
- A worker blocked on a human now always ends in one of two documented states, on either agent and whether
  or not a dashboard is attached: `waiting` while the request can still be answered, or `needs_input` once
  the attempt is over. Several paths that used to end as `failed`/`crash` when the real cause was an
  unanswered question now pause the run holding the question instead (see Fixed).
- Every denial a worker receives now names what was refused and tells it to finish with
  `status: needs_input`, whoever produced the denial — the dashboard, a host handler or the interaction
  timeout. The task result an operator reads therefore carries the question or the permission rather than a
  bare "Denied by the user".
- Codex `appServer`: a `item/tool/requestUserInput` that cannot be answered is now declined through the
  protocol instead of killing the app-server process, so the worker keeps its turn and the work in it. Only
  a worker that cannot finish without an answer ends the attempt, and then the result quotes the question
  Codex asked. If the process still has to be killed, the attempt's transcript says so.
- Runner failures now preserve provider codes, HTTP/request metadata, retry timing, session identity, and
  partial-work state. The scheduler honours provider delays and does not retry permanent failures.
- Claude supports explicit inherited or isolated configuration and treats reported MCP/plugin startup
  failures as failures even if the CLI process exits successfully.

### Fixed

- **Ctrl+C in the dashboard no longer opens the review view on its way out.** Ink reports Ctrl+C as the
  letter `c` with a modifier flag, and the dashboard matched on the letter alone: the last frame before the
  run stopped was a diff review, and the "Interrupting: stopping workers… (Ctrl+C again to force)" notice
  was drawn on a screen that was no longer up. Ctrl+R no longer restarts the selected task, Ctrl+U no
  longer leaves the task list, Ctrl+L no longer opens a transcript, and Ctrl+O in the review view no longer
  hands a file to `$VISUAL`. Ctrl+C is the one chord the dashboard reads; Ctrl+A still jumps to the oldest
  line in the transcript viewer.
- **A control command resent after the run has ended gets the answer it got the first time.** A sender that
  loses an acknowledgment and asks again — `cao stop`, or anything writing to the request inbox — was told
  "this run has ended" for a stop that had in fact been applied, and on the inbox path that answer
  overwrote the acknowledgment already on disk. The id is now looked up before the run's liveness is, which
  is what §2.2 always said: a duplicate returns the first ack.
- **A request that lands in the inbox as the run is ending is answered instead of left there.** The owner
  polls `requests/` on a 500 ms tick, so a request written in the half second after the last tick had
  nobody to answer it: the file stayed in `requests/` and its sender waited out the whole of its `--wait`
  for an acknowledgment that was never coming. `cao run` and `cao resume` now answer whatever is left on
  their way out, with the same sentence the run controller uses for a command that arrives too late.
- **Cancelling a task no longer tells the operator to cancel it again.** `cancelTask` answered "attempt N
  was cancelled" while the task went on showing as `Running` until its worker died, and `R` in that window
  was refused with "cancel it first, then restart it" — the very thing that had just been done. The
  acknowledgment now says the attempt is being aborted and that the task ends as cancelled once the worker
  has stopped, and a restart asked for in the meantime is told to wait for it.
- A transcript event type this build does not know is now **rendered rather than dropped**.
  `parseTranscriptLine` returned `null` for any unrecognised `kind`, which put an unknown event in the same
  bucket as a corrupt line: gone from `cao logs`, `cao peek`, the viewer and any surface reading the same
  package. Since new event types land in `cao` first and are read by whatever surface is already installed,
  that is a worker's work made invisible by a version number. Such a line now parses to
  `{ kind: 'unknown', type, raw }` — the type as it was written and the line itself, unparsed — and renders
  as its type with the record beneath it. `null` now means only what it should: not JSON, or JSON that
  names no event type at all.
- A paused run now says what it is waiting for everywhere an operator looks. `cao run`'s "Workflow paused"
  block, `cao status`, `cao task <id>` and `report.md` all quote the question and print the exact
  `cao resume` command that answers it, from one shared derivation. `cao task <id>` never printed a result's
  `error` at all, which is where a `needs_input` result keeps the question; the report counted a task
  waiting for a human as "still running".
- The instruction the orchestrator appends for the worker ("finish with status needs_input if you cannot
  continue") is no longer read back at the operator in `cao status`, `cao task` or the run's closing
  summary; it still reaches the worker unchanged.
- `cao logs` and the dashboard drew a `needs_input` attempt with a green tick, which reads as a task that
  is done when the run is in fact paused on it. It is now the same `?` marker every other surface uses.
- A stop that lets running workers finish (`stopMode: wait`) now settles any prompt still open, so the
  operator who asked the run to stop is not held by a modal and the worker is not left blocked until
  `execution.interactionTimeout` expires.
- The interaction modal clamps agent-written question text and windows a long option list, so a worker
  cannot push the answer keys off the bottom of the terminal.
- A question printed under a paused task now wraps on word boundaries to the terminal width instead of being
  cut at one line: for a Codex `exec` rejection the actionable half was exactly the half being cut off.
- A `codex exec` rejection of an approval or a question is reported once. Codex sends it twice - as the
  error item and again on the failed turn - and both reached the run log.
- `cao resume` now validates its arguments before taking the run lock, so a mistyped `--task` cannot leave
  the run owned by a process that then exits.
- `codex exec` rejects approvals and questions itself, and the rejection used to fall through to
  `invalid_result` or `crash` depending on the exit code, spending a nudge and a retry on a session that
  could never have finished. The rejection is now recognised, the attempt ends as `needs_input` quoting
  what Codex wanted (including the command it was about), and the result names the transport limit and the
  option that would have allowed an answer (`codex.transport: appServer`, `codex.approvals: host`,
  `codex.experimentalUserInput: true`).
- A Claude session whose prompts the CLI denied itself (`claude.permissionPrompts: deny`, which is what a
  headless run uses) and which then gave up now ends as `needs_input` naming the denied tools, instead of
  `crash`.
- A Codex `appServer` task configured with `codex.approvals: host` and run without a dashboard now pauses
  with `needs_input` explaining the two ways to fix it, instead of failing the task as an invalid result.
- A `workflow.warning` printed by `--no-tui` is sanitized like every other agent-controlled line, so a
  rejection message a worker worded cannot repaint the terminal.
- `cao run`'s paused block and `cao status` name an approval gate with the first line of its prompt rather
  than the whole prompt, which used to push the command that resolves the gate down the screen.
- `cao doctor --no-probe` skips the live agent probes, for a scripted or offline check that must not start
  an agent or spend a model call. The probe rows are still printed, as skipped.
- The note a `cao resume` prints for a task it left holding its question now also names the way out for an
  operator who cannot answer it: `cao resume <run> --task <id>` without `--input` runs that task again from
  the top. Documented in configuration.md.
- The `codex exec` "no human can be reached" notice is written to a task's first attempt log only, not to
  every attempt's, so `cao logs <task>` for a retried task no longer opens with the same paragraph three
  times. The run-log warning was already once per task.
- `report.md` no longer reads the orchestrator's instruction to the worker back at the operator: a paused
  task's **Error** block, and the per-attempt error notes, quote the question with `finish with status
  needs_input if you cannot continue` taken off, as `cao run`, `cao status` and `cao task` already did.
- A Codex `appServer` task that stopped on a question it could not ask now reports it as sentences. The
  deny message the worker was given is stripped of the instruction addressed to it and terminated before the
  fix is appended, instead of running the two together (`…answer Which?; finish with status needs_input if
  you cannot continue Run this task with the dashboard…`), and taking that instruction out of the middle of a
  sentence no longer leaves a dangling `; ` behind on `cao run`, `cao status`, `cao task` or in `report.md`.
- Codex `appServer` answers to `item/tool/requestUserInput` are keyed by the server's own question id, as
  the protocol requires; they used to be keyed by the question text, so a worker never received an answer
  it could match to its question. "Allow for the rest of this task" now sends the proposed execpolicy
  amendment for a command approval and an accept-for-the-session for a granted file-change root, rather
  than an accept-for-the-session in both cases.
- The completion object a worker ends on is no longer shown as something the agent said. `cao logs`,
  `cao logs --follow`, `cao peek`, `cao report`, the dashboard follow view and the one-line activity column
  used to print `{"status":"success","summary":"…"` where the agent's own words belong, on both agents. It
  is now recorded as a `result` transcript entry showing its summary, with the object itself kept verbatim
  in the entry's `raw` field so `events.jsonl` and `cao logs --json` lose nothing. An object a worker emits
  mid-run and then keeps working past reads as `intermediate result: …` and does not end the attempt; the
  object an attempt ends on is its outcome and is written once, so a successful attempt no longer prints its
  summary twice. Other JSON a worker prints is untouched.
- A Codex attempt that continues an earlier thread now opens its log with `resumed session <id>`, as a
  Claude attempt already did, so `cao logs` and `cao peek` no longer show a retried or nudged attempt as if
  it were a fresh session.
- Codex tasks no longer fail at turn start with `invalid_json_schema`. Both Codex transports now use the
  closed, fully required schema that strict structured output expects, while preserving free-form result
  data through a JSON-encoded runner boundary.
- Codex `exec` workflows using automatic review no longer pass mutually exclusive approval and sandbox
  flags that made the Codex CLI exit before starting the task.
- A task id longer than the task column pushed every column after it out of line on the dashboard and the
  usage screen. The id is now cut to the column with an ellipsis, so the state, cost and activity columns
  stay aligned however long a task is named.

### Documentation

- [docs/agent-cli-integration.md](docs/agent-cli-integration.md) now has **one** outcome table instead of one
  per agent. It is generated from `src/runners/outcomes.ts`, carries a column for how each runner recognises
  every row, and is compared against the page by a test - two tables of the same situations were how the two
  runners came to disagree in the first place.
- The same page gained a "waiting for a human" section carrying the acceptance matrix every blocked-on-a-human
  case is tested against, including what `codex exec` cannot do and which options change it, and its
  invocation lines were re-checked against the argv the runners build: `--approve-for-me` and `--sandbox` are
  now shown as the mutually exclusive alternatives they are, `codex.configMode: isolated` and Claude's
  `--safe-mode` appear, and the app-server command line is documented for the first time.
- [README.md](README.md) and [docs/capabilities.md](docs/capabilities.md) state the Codex support level
  plainly: `exec` stable, `appServer` and `experimentalUserInput` experimental and opt-in, and the four things
  that are deliberately not supported.
- [CONTRIBUTING.md](CONTRIBUTING.md) documents `npm run test:agents` and the rule that a runner change without
  a matching fake change is incomplete; the fake-agent mode tables are complete again.
- Every `examples/` workflow that runs Codex on `exec` now says in a comment that no human can be reached
  during such a task. No example changed what it does.

### Security

- Development toolchain updated to close the open Dependabot alerts: vitest 2 to 5 (with Vite 8), and
  esbuild pinned to 0.28.1 or later for every package that pulls it in, including tsup. None of these ship
  in the published package; they only affect building and testing this repository.

## [0.1.0-beta.3] - 2026-09-07

`allowUnsafeSharedParallel` now does what its name says.

### Fixed

- `execution.allowUnsafeSharedParallel: true` did not make parallel tasks run in parallel. Every shared-tree
  task still queued on the shared working tree lock, so with `workspaceStrategy: shared` one task ran while
  the rest of its `parallelGroup` sat `ready` for the whole run, whatever `maxConcurrency` said and
  whichever model the tasks used. Shared-tree tasks now take no lock when the flag is set and overlap up to
  `maxConcurrency`; without the flag they still wait for the tree one at a time, as before.

## [0.1.0-beta.2] - 2026-09-07

What a smaller model such as Haiku 4.5 does to a workflow, and what `cao` now does about it.

### Added

- A session that ends its turn without the JSON completion object (prose such as "Done, all tests pass.", or
  JSON the contract rejects) is asked for just the object before a retry is spent: the scheduler resumes the
  same session with a prompt that quotes what was wrong, the attempt shows as `nudge` in `cao task`, and the
  dashboard row says `asking for the result`. `retry.resultNudges` (default 1) bounds it; a nudge that produces
  a valid result does not count against `retry.attempts`. Smaller models end this way often.
- The dashboard shows what the orchestrator is doing for a task before its worker says anything
  (`preparing worktree`, `running beforeTask hook`, `starting claude`) instead of a bare idle timer, and a
  workspace that takes more than 30 seconds to prepare is reported as a warning.
- `cao validate` warns when a Haiku task inherits an `effort`, which Claude Code has no levels for; the flag
  is dropped instead of being passed for the CLI to ignore.
- Claude Code runs its auto permission mode only for Sonnet 5, Opus 4.7 and later, and Fable; for any other
  model it accepts `--permission-mode auto` and silently starts the session in its ordinary prompting mode,
  which asks before every file write and command. That is why a Haiku task under the default mode kept asking
  for approval. `cao validate` now warns about such a task, and the runner compares the mode the worker
  reports at start-up with the one requested and raises a run warning plus a transcript line when they differ.

### Changed

- Results are read the way a careful reader would: `null` for a field that does not apply is treated as
  omitted, `status` is matched case-insensitively and with the usual synonyms (`completed`, `done`, `ok`,
  `failure`, `error`, `needs input`), a missing `summary` is filled from `error` and noted in `warnings`,
  and the object taken from prose is the fenced block or trailing object that carries a `status`, not merely
  the last JSON block in the message.
- The documentation now says what `permissionMode: auto` is (Claude Code's classifier, which allows what it
  judges safe and still asks for the rest, is already the default, and only exists for some models), what
  the other modes do, and which to pick for an unattended run or a Haiku task.

### Fixed

- Two tasks of one layer that both resolve to the shared working tree (`git.enabled: false`, an explicit
  `workspace: shared`, `allowUnsafeSharedParallel`) deadlocked the run: the second task waited for the
  shared-tree lock inside the scheduler loop that the first task needed in order to release it, so the first
  task's result was never processed and the second sat `running` and idle forever. The lock is now only
  taken when it is free; a task whose tree is busy stays `ready` until the holder finishes. The same applied
  to a merge-resolution session started while a shared-tree task was running.

## [0.1.0-beta.1] - 2026-09-07

The first public release, published under the `beta` tag
(`npm install -g code-agent-orchestrator@beta`). Everything below is new to anyone installing it; the
Changed and Fixed sections record how the behaviour got there during development, and are worth reading
because they describe what the software does now and why, not because an earlier version behaved otherwise.

### Added

- `cao doctor` answers the environment questions every "it does not work" report comes down to, one line per
  check: Node against `engines.node`, git and whether it can do worktrees, each agent CLI with its version,
  `lock.json` files left behind by an orchestrator that is gone, worktrees and `orchestrator/*` branches a
  finished run left on disk, and whether `.orchestrator/` is ignored by git. A failing check carries the line
  that fixes it — the `cao clean` invocation naming the run responsible, the environment variable that points
  at a missing CLI — and the command exits 1 only for the three things that stop a run outright (Node, git,
  having no agent CLI at all). It changes nothing itself. `--json` adds the raw facts behind the checks, to
  attach to a bug report.
- An ASCII fallback for every glyph the text surfaces draw. `CAO_ASCII=1` prints `-` for the rules, `v`/`x`
  for the status marks and `...` for a truncation, so a Windows console on a legacy code page or a
  `TERM=dumb` log viewer shows a table rather than mojibake; it is also the default guess on a Windows
  terminal that does not identify itself as UTF-8 capable, and `CAO_UNICODE=1` forces the glyphs back on.
  Every ASCII status mark is one column wide, so the columns line up either way.
- `$COLUMNS` is used to lay tables out when there is no terminal to ask, so piped output and CI logs can be
  given a width instead of always getting 120 columns.
- Every command's `--help` ends with worked examples, and `cao --help` lists `CAO_ASCII` and `COLUMNS`
  alongside the other environment variables. Command descriptions no longer repeat the usage line.

- `cao stop [run]` interrupts a run from another terminal, exactly as Ctrl+C does in the terminal that owns
  it: the orchestrator stops scheduling, terminates its workers, persists `interrupted` and exits 130. The
  request is a `stop.json` in the run directory rather than a signal, so it works the same on Windows, and a
  second `cao stop` forces the kill like a second Ctrl+C.
- `cao report [run]` renders a run as one document from what the run directory already holds: header
  (workflow, repository, base commit, duration, cost, tokens, models, tasks never reached), an overview table
  whose rows link to the sections below, then one section per task with its summary, error, files changed
  largest first with `+`/`-` counts, commits, git shas, decisions, warnings, follow-ups and — only once a
  task needed more than one try — an attempts table. The file counts fall back from the attempt's
  `diff.json` to the per-file records on the result, to the recorded `git diff --stat`, to the agent's own
  list, and the report says which one it used, so a run whose attempts captured no diff no longer reads as
  having changed nothing. Agent prose is made safe for the document around it: an unclosed code fence is
  closed and a heading is demoted under the task's own. The Markdown is shaped to paste into a pull request;
  `--json` is the same structure and `--out <file>` writes it out. Every run also writes `report.md` into its
  run directory when it ends and prints the path beside the summary table.
- The transcript viewer can be navigated: `/` searches it and `n`/`N` step through the matches, `k` cycles a
  kind filter (all, text, tools and commands, errors and questions), and scrolling above the oldest entry
  still in memory pages older ones in from the attempt's `events.jsonl`, so the whole transcript is reachable
  from the dashboard. Timestamps now fall back to `MM:SS` below 100 columns instead of disappearing, and the
  detail view shows them too. The task picker moved from `T` to `P`.
- Thinking blocks are parsed into a `thinking` transcript entry and written to the attempt's `events.jsonl`.
  They are hidden by default everywhere — the activity column, `live.json` and the run-level `events.jsonl`
  never carry them — and shown with `T` in the viewer or `cao logs --thinking`.
- The transcript pairs each tool call with its result and prints how long the tool took on the call line
  (`▸ Grep: TODO in src · 0.4s`). The time an attempt spent inside tool calls is summed into its usage, shown
  as a `Tools` column in the dashboard's usage view (`U`) and on each line of the attempt history.
- Entries a subagent produced are nested in the transcript under the `Agent:` call that spawned them,
  collapsed to a `… 3 subagent entries` line until `t` expands them (the same key as tool output). The runner
  probes `claude --help` once per configured command and passes `--forward-subagent-text` when the installed
  CLI advertises it, so a subagent's prose arrives as well as its tool calls.
- `cao task` and the dashboard's detail view render the attempt and interaction history a run already
  persists: every attempt with its kind, what triggered it, duration, outcome, exit code or signal, cost and
  the reason it was retried, and every permission prompt or question with how long the worker waited and how
  it was answered. The elapsed cell of a table row is now the total across attempts, with the current attempt
  in parentheses; the detail view also shows the result's decisions, warnings and follow-ups; the usage view
  shows cache writes and the duration the agent reported; and `cao task --json` carries the same records with
  a `durationMs`, a `reason` and a `waitedMs`.
- The dashboard's activity column now shows the worker's last *action* (tool, command or prose) instead of
  whatever entry arrived last, so a long tool result no longer masks the tool that is running. After 30
  seconds of silence the cell appends `… 2m idle`, and a task waiting out a retry reads `api retry 2/5 in 12s`
  (transient API error) or `retry 1/2 in 30s` — the same counters the scheduler is spending.
- `[` and `]` switch attempts in the dashboard's follow view, as they already did in `cao logs --follow`.
  An earlier attempt is read from its `events.jsonl`; the newest one goes back to following the live worker.
- The dashboard's help panel (`?`) lists the transcript viewer's own keys.
- The dashboard's `C` view is a review view. Files are listed per task with the status letter and `+N -M`
  from the attempt's `diff.json`, cursor-navigable and scrolling instead of truncating; `Enter` opens that
  file's hunks from its `diff.patch` in a pane with the transcript viewer's scrolling keys, `N`/`P` between
  hunks and `←`/`→` between files; `O` opens the file in `$VISUAL`/`$EDITOR`. A running task still shows its
  live tool-stream list. It lives in `src/tui/dashboard/`.
- `cao logs` and `cao peek` render the transcript as one document instead of one isolated line per event: a
  tool call carries how long it took, a subagent's entries are indented under the `Agent:` call that spawned
  them, and a call the attempt never answered reads `· no result` — the tool a crashed or timed-out worker
  stopped in. Under `--follow` the lines that arrive later are paired against the calls the tail established,
  so the time lands on the result line and a subagent's report is indented the same way as when the whole
  log is read at once.
- `cao diff [run] [task]`: the patch an attempt captured, read from the run directory without touching git or
  the working tree. `--stat` and `--name-only` from `diff.json`, `--file <path>`, `--attempt N`, `--json`, and
  `+`/`-`/`@@` colour on a TTY (`--color auto|always|never`, `NO_COLOR`). Without a task it prints every task
  in execution order under a `#` header, and the plain output stays a unified diff `git apply` accepts. A
  merge-resolution attempt is only shown when named with `--attempt`, since its patch spans the whole merge.
- `cao task` now shows the captured per-file `+`/`-` stat table for a finished attempt, and keeps the live
  tool-stream file list only while the task is running.
- A real per-task diff at the end of every attempt: `diff.patch` and `diff.json` (path, status `A`/`M`/`D`/`R`,
  added/deleted lines, binary flag) in the attempt directory, and the same per-file records in the result's
  `git.files`. Worktree attempts are diffed from the base commit to the branch head after the checkpoint
  commit; shared-tree attempts from git tree snapshots taken at acquire and at finalize through a throwaway
  index, so changes made through the shell are captured as accurately as tool-driven edits; merge-resolution
  attempts get a patch of their own, whether the resolution session succeeded or not.
  `diff.patch` is complete enough for `git apply` to replay the attempt on a checkout of its base: it carries
  binary file contents (`--binary`), full blob ids (`--full-index`) and git's final newline.
- `git.maxDiffBytes` (default 2 MB): past it the patch is truncated on a line boundary with a trailing note
  while `diff.json` stays complete. `git.captureDiff` (already documented, previously read by nothing) now
  switches the whole capture off.
- Human-in-the-loop interaction. A worker's permission prompts and `AskUserQuestion` calls are routed to the
  dashboard over Claude Code's stdio control protocol; the task shows as **Needs you** until it is answered,
  the timeout expires, or the worker withdraws the request.
- Live usage per attempt (tokens, context window, cost), file-change tracking, and a shared transcript viewer
  used by both the dashboard follow view and `cao logs --follow`.
- New library exports: `resolveClaudeOptions`, `parseClaudeEvents`, `describeToolUse`, the Claude stdio
  protocol helpers (`encodeUserMessage`, `encodeControlResponse`, `encodeErrorResponse`, `toInteraction`,
  `permissionResult`, `PendingInteractions`), `renderTranscript`, `renderEntry` and `renderMarkdown`.
- `execution.interactionTimeout` (default `30m`, `never` to disable): how long a worker may wait for a human
  answer before the prompt is denied.
- `hooks.onInputRequired`, run when a worker starts waiting for a human, with `CAO_INTERACTION_KIND`,
  `CAO_INTERACTION_TITLE` and `CAO_INTERACTION_TOOL` in its environment.
- `npm run lint` — an ESLint 10 flat config (`eslint.config.js`) covering `src` and `test`.
- Release packaging: a `LICENSE` file (MIT), `repository`, `homepage`, `bugs`, `keywords`, `author` and
  `publishConfig` in `package.json`, and a `prepublishOnly` that runs typecheck, lint, test and build so a
  publish can never ship a stale `dist/`. An `exports` map limits the public surface to the package root and
  `./package.json`, and `files` publishes `docs/*.md` rather than `docs`, keeping `docs/research/` out of the
  tarball. `.editorconfig` and `.nvmrc` (22) pin the conventions; `.github/` carries a CI workflow (typecheck,
  lint, test, build on Node 22 and 24, on `ubuntu-latest` and `windows-latest`), a "workflow fails" issue
  form that asks for `cao validate --json` and the run directory listing, and a pull request template.
- `CONTRIBUTING.md` (how to drive the fake agent through a whole workflow for free, what each test directory
  is for, commit style, what a pull request needs) and `SECURITY.md` (private reporting, and an explicit
  statement of what the orchestrator runs and what it refuses to run). The README documents installing from
  npm under the `beta` tag, the `cao` bin-name collision, that the CLI makes no network calls of its own and
  sends no telemetry, and every `CAO_*` variable it reads in one table.

### Changed

- The published build carries no sourcemaps. They were the largest thing in the tarball and the bundle is not
  what anyone debugs — `npm run dev` runs tsx straight over `src/`.
- An `uncaughtException` in the CLI is reported like an unhandled rejection already was: one message on stderr
  and exit `70`, instead of Node's default stack dump and exit `1`.
- The worktree and end-to-end test suites skip themselves with a message when there is no usable `git` on
  PATH, instead of failing inside `git init`.
- `cao run` and `cao validate` take the workflow path as an optional argument: with none they use
  `workflow.yaml`, `workflow.yml` or `cao.yaml` from the current directory instead of failing with a
  commander error.
- Task references match like run ids do — exactly, or by a prefix that names one task. An ambiguous prefix is
  refused with the candidates listed. `cao peek` and `cao task` take their references as optional arguments,
  so calling them bare gives the same usage error (listing the run's tasks) that `cao logs` already gave.
- "Run not found" and "no runs found" are usage errors and exit `2` instead of `70`, and both name what to do
  next (`cao list`, `cao run <workflow.yaml>`).
- `cao run` checks the lock it acquires and refuses to start while another orchestrator process is running a
  run in the same repository, naming that run, its pid and how to watch or stop it. Two concurrent runs used
  to go undetected and share the working tree.
- `cao resume` accepts `--max-concurrency`, `--permission-mode` and `--claude-command`, the same overrides
  `cao run` takes.
- `--json` on `cao logs` and `cao peek` writes JSON Lines: one normalized transcript entry per line, no
  header, streaming under `--follow`. `cao peek --json` prints a `{"kind":"peek", ...}` status object first.
  `cao logs --events` is now read rather than declared and ignored: it names the default source explicitly
  and wins over `--raw`/`--stderr`/`--prompt`.
- `cao list` sorts by creation time (newest first) and has an `Age` column; `cao status` and `cao task` print
  one time format, local date and time with the age beside it (`2026-09-04 14:03  (7m ago)`), instead of ISO
  UTC in one and a bare clock in the other.
- Tables pad by printable width and clamp to the terminal, narrowing their widest column until the row fits,
  so `cao status` no longer slices its detail column at a fixed 70 characters and a coloured cell no longer
  shifts the row.
- `cao status` prints the run directory and the orchestrator's pid in its text output, not only in `--json`.
- `run`, `resume` and `validate` mark advisories the same way: `!` for a warning, `✗` for an error, `✓` for
  success. The `WARNING:`/`ERROR:` prefix on diagnostics is gone; the glyph carries it.
- `cao --help` ends with the exit codes and the `CAO_*` environment variables, which were only in the README.
- The dashboard's changed-file counts come from the records the attempt captured (`git.files`) when it has
  them, and from the tool stream otherwise. It no longer stamps every path in `result.filesChanged` as an
  edit, which listed files a worker never touched and showed every one of them as `M`.
- **Behaviour:** with a dashboard attached, Claude workers now default to `permissionPrompts: ask`. A prompt
  that used to be denied immediately now waits for a human for up to `execution.interactionTimeout`
  (default 30 minutes), bounded by the task timeout. Unattended runs should set `permissionPrompts: deny`
  or use `--no-tui` to keep the previous fail-fast behaviour.
- "Allow for the rest of this task" is offered only when the CLI supplied a rule scoped to the request. The
  orchestrator no longer falls back to a blanket allow for the whole tool, which had made a single `A` on one
  `Bash` prompt authorize every later shell command in the session.
- Agent-controlled text is stripped of escape sequences and control characters at every render boundary, so a
  worker cannot repaint the permission prompt an operator is reading. The raw bytes are unchanged in the
  attempt's `events.jsonl`. The same cleaning applies to the `CAO_INTERACTION_*` hook variables, which are
  additionally collapsed to a single line of at most 200 characters — quote them in hook commands anyway.
  File names count as agent-controlled text: every list of them is cleaned too, in `cao task`, in the
  dashboard's task detail and in the review view. The one boundary that stays byte-exact is an uncoloured
  `cao diff`, which has to keep being a patch a pipe can consume; a coloured one — the rendering a human
  reads — cleans its patch text and its `--stat` and `--name-only` paths, as git's pager does for `git diff`.
- The run-level `events.jsonl` records an interaction's summary instead of its raw tool input; file contents
  and full shell commands stay in the attempt directory, as worker output and transcripts already did.
- `FORCE_COLOR=0` (and `false`/`off`/empty) now disables forced colour instead of enabling it.
- Diff snapshot index files live under `.orchestrator/tmp/<run-id>/` instead of `.orchestrator/tmp/`, so two
  runs in one repository cannot collide. The directory is removed when the run ends (including when it was
  interrupted) and by `cao clean`. `snapshotIndexPath()` therefore takes the run id as its second argument,
  and `snapshotIndexDir()` / `removeSnapshotIndexDir()` are new exports.
- `WorkspaceManager` gained `captureMergeAttempt()`, the diff-only counterpart of `completeMerge()` used when
  a merge-resolution session did not succeed.

### Fixed

- `cao logs` and `cao peek` timestamped every transcript entry in UTC while `cao status`, `cao task` and
  `cao list` printed local time, so on any machine off UTC the transcript looked hours away from the run it
  belonged to. All of them now print the local wall clock.
- An unknown command or a bad option value exited 1, contradicting the exit code table `cao --help` prints;
  commander's usage errors now exit 2 like every other usage error, and the full help no longer follows every
  mistyped flag.
- A corrupt `workflow.json` surfaced as a bare `Expected property name or '}'` and exit 70, naming neither
  the run nor the file. It now names both, says what to do about it and exits 2 — and `cao list`, which
  skips run directories it cannot read, names them on stderr instead of reporting an empty directory.
- `cao task` built its log paths by appending `/name` to a Windows directory, producing paths with mixed
  separators; it now joins them properly, and no longer offers a finished attempt's pid as if it were a live
  worker (both `cao task` and `cao peek` mark it `(exited)`).
- A third reference (`cao task <run> <task> <extra>`) was silently ignored rather than refused.
- `cao stop` on a run whose orchestrator was killed said "Run X is not running (state: running)". It now
  reports the process rather than the record.
- Whether an orchestrator is running was read from `lock.json` alone, so a run whose lock file went missing
  under a live orchestrator looked idle to every command that asks: `cao stop` printed "nothing to stop" and
  recommended `cao resume`, which would have started a second orchestrator in the same working tree, and
  `cao run` would have allowed one; `cao logs --follow` and `cao peek --follow` stopped following a task that
  was still going. All of them now fall back to `live.json`, which the orchestrator rewrites on the same
  heartbeat and which carries the same pid (a stale heartbeat or a dead pid still counts as not running), and
  `cao status` says when it had to. The heartbeat also writes the lock file back when it finds it gone, so
  the state repairs itself within twenty seconds.
- `cao logs --raw --json`, `--stderr --json` and `--prompt --json` silently ignored the source flag and
  printed normalized entries instead. `--json` only has entries to print for `events.jsonl`, so the
  combination is now refused with a message that says why (exit 2); `--events` still wins, as its help says.
- The dashboard's live follow view stopped being able to page older entries in from disk on any task that
  had been retried. Its buffer spans every attempt while each `events.jsonl` covers one, so the oldest entry
  on screen usually belonged to an earlier attempt, where the current attempt's file could not find it — and
  the empty answer was taken for "you are at the beginning" and remembered for the rest of the session, with
  nothing on screen to say so. Paging now walks back through the attempt files and carries on into the
  attempt before when it reaches a beginning, "nothing older" is remembered against the entry it was said
  about rather than the whole task, and `start of the transcript` is shown whenever the transcript really
  has none.
- The dashboard task table appended the current attempt's elapsed time after the padded total without
  counting it, so one retried task shifted every cell after Duration — agent, ctx, cost, ±files, activity —
  about ten columns right on that row alone. It is now a column of its own, as wide as the widest one on
  screen and zero wide when no task was retried.
- `cao task` and the dashboard detail view printed `undefined` in the trigger, outcome, answer or source cell
  of a record written by a build with a name they have no label for; they now show the raw value, as
  `report.md` already did.
- `cao run nosuch.yaml` repeated the path and the raw errno text; the message now says what is missing.
- The end-of-run summary table padded to fixed widths, so a long task id or failure message ran past the
  terminal, and it labelled states differently from `cao status`. It uses the same column machinery and the
  same labels, and no table row ends in trailing whitespace.
- `cao logs --stderr` on an empty file printed a header and nothing else.
- The execution plan listed a task the workflow file already records as completed exactly like one that
  would run, so `cao validate` and `cao run --dry-run` on a finished workflow described work that would not
  happen and the run then reported every task "Completed" in no time at all. The plan now marks them
  `already done in run <id>, will not run`, and the `Agents:` line says there is nothing to launch instead of
  `not detected`.
- The transcript renderer dropped every entry of a subagent that itself delegated, and left them out of the
  collapsed `… n subagent entries` count as well.
- A delegating call now keeps its own report with it, so two subagents running at once no longer leave both
  reports in a heap at the end of the transcript with nothing saying which call each one answers.
- The viewer's `/` search counts the matches hidden inside collapsed tool output and collapsed subagent
  entries (`+5 in collapsed output (t to expand)`) instead of answering `no matches` about text that is there.
- The viewer stays on the lines you are reading when a running worker appends new ones; the view used to
  scroll out from under you, and the "n lines above the end" counter went stale with it. `t`, `T` and `k`
  keep your place too, instead of leaving the offset pointing at whatever is now that far from the end.
- Below 100 columns the viewer's meta line and key list use a short form. Truncation used to cut off exactly
  the two things a narrow terminal needs: how far up you have scrolled, and which key leaves.
- Rendering a long transcript no longer redraws every entry from scratch on each new one, so `T` on a long
  attempt stays responsive.
- `cao diff --file` and the review view's hunk pane now find the section of a file whose path contains a space
  or a non-ASCII character. Git disambiguates the first with a trailing tab and C-quotes the second with octal
  UTF-8 bytes, neither of which the section matcher undid, so those files silently showed an empty patch.
- A git read that outgrows its buffer is only treated as a short read when the caller asked for a cap. An
  uncapped command that overran the default now fails instead of handing back partial output that the caller
  would parse as complete.
- A task whose merge-back conflicted and was resolved by a merge-resolution attempt keeps the git block of its
  own attempt — branch, head and per-file stat — instead of ending with none, which left downstream context
  without a diff summary.
- The review view now fits the terminal it was given: a path too long for a row is shortened from the left so
  its `+N -M` survives, the pane's title bar keeps the attempt and the file position, and both footers drop
  their least important hints instead of running off the edge at 80 columns.
- Escape sequences a worker wrote into a file no longer reach the terminal through the hunk pane, and tabs are
  expanded to the terminal's stops so a diff line measures the width it draws at.
- The hunk pane no longer rebuilds and re-colours the whole patch on every spinner tick, and holding `n` or `p`
  now moves one hunk per keystroke instead of one per frame.
- A task that ran and changed nothing, or whose attempt captured no diff, keeps its line in the list and says
  which of the two it is, instead of disappearing.
- The pane leaves out the `diff --git`, `index` and `---`/`+++` header lines that only repeat its own title
  bar, giving four more rows to the diff on a 24-row terminal.
- A withdrawn or timed-out permission prompt is now taken off the dashboard queue. Previously the modal stayed
  on screen for a request the scheduler had already answered, and a genuinely new prompt queued behind it.
- A task stays `waiting` until every concurrent request is answered. A worker making parallel tool calls can
  have two prompts open at once; answering the second used to report the task as running while the first was
  still blocking the worker.
- An attempt's `events.jsonl` now ends with its outcome. The final `result`/`error` entry was written after the
  stream was closed, so `cao logs` and `cao peek` showed the work but never how it finished.
- Wrapped transcript lines keep their styling: the opening colour code no longer bleeds into everything printed
  after it while the continuation lines render unstyled.
- The transcript viewer's footer described the wrong keys (`g` jumps to the oldest line, `Shift+G` follows).
- `stripAnsi` had lost a backslash in its pattern, so it only matched real SGR codes by coincidence and also
  swallowed malformed sequences. It now strips CSI, OSC and two-character escapes deliberately.
- The dashboard's follow view no longer re-renders the whole transcript buffer on every spinner tick.

### Initial public API

The supported surface is exactly what `src/index.ts` re-exports, reached through the package root
(`import { ... } from 'code-agent-orchestrator'`). The `exports` map admits only `"."` and
`"./package.json"`: `dist/bin.js` and any other file in `dist/` are internals and may move without notice.
It covers what a host needs to embed a run — the config loader, `normalizeWorkflow`, `validateWorkflow` and
`TaskGraph`, `WorkflowScheduler` with `createRun`/`reconcileForResume` and `exitCodeFor`, `FileRunStore`,
the workspace managers with `Git` and the diff-capture helpers, `ProcessManager`, `RunnerRegistry` and
`ClaudeRunner` with `buildClaudeArgs`, `resolveClaudeOptions`, `parseClaudeEvents`, `describeToolUse` and
the stdio protocol helpers (`encodeUserMessage`, `encodeControlResponse`, `encodeErrorResponse`,
`toInteraction`, `permissionResult`, `PendingInteractions`), the completion contract, the transcript and
Markdown renderers (`renderTranscript`, `renderEntry`, `planTranscript`, `renderMarkdown`), `Redactor`,
`prepareWorkflow`/`createRuntime` and the shared types.

Anything not on that list is internal, including several things that existed in pre-release builds and are
now gone: `ProcessManager.peek()` (read the attempt's `events.jsonl`, or use
`WorkflowScheduler.peek(taskId, n)`), `FileRunStore.lastLiveWrite` (write throttling, now owned by the
scheduler), `attemptLogPaths()` from `workflow/scheduler.js` (use `RunPaths.attemptDir(runId, taskId,
attempt)`) and `PendingInteractions.has()`. `PendingInteractions.abortAll()` returns nothing: each handler
settles through its own abort signal. `snapshotIndexPath()` takes the run id as its second argument,
alongside the new `snapshotIndexDir()` and `removeSnapshotIndexDir()`.

Pre-1.0, this surface can still change in a minor version.
