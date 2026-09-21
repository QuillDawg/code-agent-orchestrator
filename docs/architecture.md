# Architecture

`cao` is a lightweight workflow engine whose workers are disposable Claude Code or Codex CLI processes. The engine owns all state; workers only receive a prompt and return a structured result.

```
      owning TUI/CLI (in-process)                observer/another terminal
                  │                                          │
                  │                         requests/<ULID>-<kind>.json
                  ▼                                          ▼
           ┌─────────────────────────────────────────────────────────┐
           │  RunController  submit(command, envelope) → ControlAck  │
           │  stop · kill · cancelTask · restart · edit · prompt     │
           └───────────────────────┬─────────────────────────────────┘
                                    ▼  enters as a `control` wake
                 ┌────────────────────────────────────────────┐
  workflow.yaml ─► config (loader → normalize → validator)    │
                 └───────────────┬────────────────────────────┘
                                 ▼  ResolvedWorkflow
                 ┌────────────────────────────────────────────┐
                 │ WorkflowScheduler (single state-owning loop)│
                 │  • DAG readiness   • retries / onFailure    │
                 │  • concurrency     • approvals / when       │
                 └──┬──────────┬─────────────┬────────────────┘
                    │          │             │
        RunStore ◄──┘   WorkspaceManager   TaskRunner (Claude / Codex)
   (.orchestrator,     (shared / worktree)   └─ ProcessManager ─► agent CLI (child)
    requests/, acks/)
                    │
               EventBus ──► persistence (events.jsonl) ──┬─► plain renderer (headless)
                                                          └─► zustand store ──► Ink workspace (TUI)
```

## Directory structure

```
src/
  bin.ts, index.ts            CLI entry / library exports
  cli/                        commander program, commands/ (run, validate, resume, ui, stop, status, list, logs, peek, task,
                              task-control (`task stop|restart`), task-edit (`task edit`, §3.4), task-prompt (`task prompt`, §3.5),
                              diff, report, clean, doctor, diagnostics (`cao diagnostics`, §3.7), emit)
    app.ts                    service layer: prepareWorkflow(), createRuntime(), startRuntime() (the prepared runtime shared by
                              `cao resume` and a workspace action, so the two cannot validate a resume differently)
    ownership.ts              the owner/observer classifier: `readOrchestrator`'s answer turned into self/owned/abandoned/ended,
                              and the header badge, the observer banner and the cross-process refusal sentence, all built from it
    workspace-session.ts      owns the Ink tree across however many executions one `cao run`/`resume`/`ui` session runs, the
                              plain-output fallback, the operator's quit/interrupt intentions, and the exit code
    crash.ts                  process-level unhandledRejection / uncaughtException handlers, exit 70
    color.ts, util.ts         colour mode (--color/NO_COLOR/FORCE_COLOR), run and task reference resolution, tables, time formats
    render/plain.ts           non-TTY line renderer, startup header, summary
    render/diff.ts            reads a captured diff.patch: section lookup by path (git's quoting undone), stat and colour
  config/                     schema.ts (zod), loader.ts (YAML, repository/launch dir, env), normalize.ts (defaults, templates, foreach, DAG rules)
  workflow/                   graph.ts (Kahn layers, cycles), validator.ts, states.ts (transition tables), scheduler.ts, plan.ts, run-factory.ts (create/resume), completion-store.ts (state: completed markers), report.ts (the run document, shared by cao report and the report.md every run writes), run-view.ts, resume-request.ts (the ResumeRequest union an ended run's actions become — resume/re-run/resume-from/answer/follow-up/approve/reject, §2.4, `[D36]` — read by both `cao resume` and the workspace's ended-run actions so there is one resume path, not two)
    control/                  commands.ts (the ControlCommand union and its envelope), controller.ts (RunController: the only way
                              anything outside workflow/ changes execution state while a scheduler is running), observer.ts (watches a run another process
                              owns: polls workflow.json + live.json into the same presentation store, sends stop/kill/restart
                              through the request inbox and shows the ack), detached.ts (a read-only RunController over a run
                              directory nobody is executing, refusing every command with a reason; what `cao ui` reads a
                              finished or another-terminal's run through), local.ts (a per-run map of in-process controllers, so
                              `cao task stop|restart|edit` reaches the owning process directly when it is this one instead of
                              writing a request to itself), edit.ts (what an edit of an unfinished task means: which fields,
                              which states, which dependents block one, the workflow validator run over the edited task, and
                              appending the TaskRevision - shared by the scheduler, `cao task edit` and the TUI form so the
                              three cannot answer differently), prompt.ts (what a `prompt` command means, §3.5: the `PromptDelivery`
                              record appended to an attempt, the refusal sentences a steer fails with, and `promptRow` — the one
                              §3.5 matrix read by the CLI when no mode flag was given, the composer's header, and the scheduler),
                              follow-up.ts (a follow-up as the next attempt rather than a live channel, §3.5 `[D25]`: which session
                              it continues when `retry.resumeSession` allows and one was reported, and the fresh-`# User Input`
                              path otherwise — the general form of what `cao resume --input` always did)
  runners/                    task-runner.ts (TaskRunner, RunnerRegistry; the typed failure contract itself is RunnerFailure, in the protocol package), capabilities.ts, sessions.ts (SessionProbe: whether the session/thread a task reported is still resumable, shared by doctor's `sessions` row and a follow-up's fresh-session check); claude/ (claude-runner, event-parser, protocol = stdio control protocol, models = context windows, transient, detect, steer.ts = steering a live stream-json session through its open stdin and inferring delivery from `--replay-user-messages` or the next turn boundary, §3.5, session-file.ts = whether `~/.claude/projects/<slug>/<id>.jsonl` for a reported session still exists); codex/ (exec runner, app-server, permissions, failure normalization, detect, quota = the session-long app-server that reads account/rateLimits for the footer, session-file.ts = the same presence check over a Codex thread's rollout file); quota.ts (the runner-neutral set of provider quota readers the workspace starts)
  execution/                  process-manager.ts (registry, ring buffers, timeouts, tree kill), signals.ts (Ctrl+C), hooks.ts
  context/context-builder.ts  structured results → "# Previous Task Context"
  conditions/evaluator.ts     safe `when` expression grammar
  templates/engine.ts         safe {{path}} substitution
  workspace/                  git.ts (explicit git wrapper), workspace-manager.ts (shared + git worktree strategies, merge-back), diff.ts (tree snapshots through a throwaway index, diff.patch/diff.json capture)
  persistence/                run-store.ts (atomic snapshots, events, live.json, lock, heartbeat), paths.ts (the protocol package's run-directory layout, normalised to the platform separator), run-id.ts, transcript-log.ts (pages older entries back out of an attempt's events.jsonl), log-pager.ts (reads the tail of an unbounded file, and the page before it, backwards in chunks — what the Logs panel opens `stdout.log`/`stderr.log` with, §3.7), requests.ts (reads and writes the request inbox: requests/<ULID>-<kind>.json, requests/acks/<ULID>.json, requests/rejected/; the CLI-side sendControlRequest, called by `cao task stop|restart|edit|prompt` from another terminal and by the workspace observer's S/K/R), registry.ts (the user-level `~/.cao` registry: an announced run's pointer entry, and `readConfig`/`writeConfig` over `~/.cao/config.json`'s `protocol`/`emit`/`retainDays` keys; `tui/render-options.ts` reads the same file's `altScreen` key separately)
  events/event-bus.ts         typed synchronous event bus
  logging/                    logger.ts, redact.ts
  tui/                        app.tsx (the persistent workspace shell: header, sidebar, tabbed main panel, footer, all fed by the
                              zustand store in store.ts), launcher.tsx (`cao ui` with no run: pick a recent run or a workflow file
                              to start), viewer.tsx (follow view, shared with `cao logs --follow`), theme.ts (the only file under
                              `tui/` allowed to name a colour, which a test enforces: the `cyberpunk` (default) and `mono` token
                              tables as hex, downsampled to 256 and 16 colours the way Ink downsamples its own `color` prop;
                              `--theme` > `CAO_THEME` > `~/.cao/config.json`'s `theme` > `cyberpunk`, with `NO_COLOR`/`TERM=dumb`/a
                              terminal that reports no colour forcing `mono` over all of them), render-options.ts (resolves the alternate-screen setting:
                              `--no-alt-screen` flag, `CAO_ALT_SCREEN` env, `~/.cao/config.json`'s `altScreen`, then the default),
                              window.ts (windowing shared by the sidebar, tables, the review list and the picker), composer.ts (the
                              multiline composer's buffer: `string[]` lines, a code-point cursor, undo — a pure state machine the
                              component only draws, §3.2/§3.5 `[D14]`/`[D16]`), terminal.ts (leaving and restoring the alternate
                              screen from anywhere execution is not ordinary — a crash, a force-kill, a second Ctrl+C — plus
                              `suspendTerminal()`, the escape hatch `$VISUAL`/`$EDITOR` and the composer's Ctrl+O use), history.ts
                              (attempt and interaction tables, shared by `cao task` and the detail view; revisionRows renders the
                              edit history under Attempts), transcript.ts + markdown.ts + format.ts (one renderer for every
                              transcript surface; the ANSI-and-glyph layer only — the structure it draws comes from planTranscript
                              in the protocol package), logs.tsx (the polling tailer shared by `cao logs --follow`/`cao peek` and
                              the workspace's own Logs tab), follow.ts (file tailer), store.ts (the zustand store the workspace is
                              fed from: the run snapshot, the focused tab and panel, per-list cursors, drafts, notices, overlays,
                              the per-provider quota snapshots, and the per-task `activity` map — when each task last produced
                              output, which is what feeds the sidebar's two-frame activity pulse)
    workspace/                 chrome.tsx (header, sidebar, tab bar, footer), overview.tsx (the Overview tab: the ended-run and
                              observer lead lines, the task table, the selected task's detail block), detail.ts (a task's detail
                              block, and the ended-run and observer lead lines above it), ended.ts (the ended-run actions —
                              resume run, re-run task, resume from task, answer and resume, approve/reject — reading the
                              ResumeRequest union from workflow/resume-request.ts), observer.ts (the
                              observer's stop/kill/restart controls, sent as requests), panels.tsx (the Report tab, the
                              command palette, the contextual help, the quit prompt and the answer field), session.tsx (the
                              Session tab: transcript, session identity, pending interactions, prompt deliveries and the
                              composer, §3.5), logs.tsx (the Logs tab: the run's files as sources, the four views, the filters and
                              the page-at-a-time pager over persistence/log-pager.ts), diagnostics.tsx (the Diagnostics tab:
                              agents and transports, effective configuration, retries, RunnerFailure, controls and quotas as
                              one scrollable list), edit.tsx (the task editor `E`
                              opens: the rows, the round-tripping drafts, the inline validation and the read-only context
                              section; the decisions themselves come from workflow/control/edit.ts), prompt-editor.ts (the
                              prompt in $VISUAL/$EDITOR through terminal.ts's suspendTerminal, which hands the terminal over
                              and takes it back), quota.ts (one provider's quota as the line the footer
                              has room for), keys.ts (every key the workspace answers, written down once so the footer and
                              `?` cannot drift apart), layout.ts (row budgets and the 80x24 compact-layout thresholds)
    dashboard/                 modal.tsx (permission prompts, questions and approvals), review.tsx + files.ts + editor.ts (the
                              Changes tab), activity.ts (the activity cell), pane.ts
  util/                       text.ts (strips escapes and control characters from anything shown to a human; also the worker-facing
                              instruction the scheduler appends to deny messages, and the helpers that take it back off for an
                              operator), glyphs.ts + marks.ts (Unicode/ASCII fallback, CAO_ASCII/CAO_UNICODE), package-info.ts,
                              async-queue, duration, errors, fs, misc, ulid.ts (time-sortable ids for control commands)
packages/
  protocol/                   code-agent-orchestrator-protocol: the wire contract, its own npm workspace and its own semver. Zero runtime
                              dependencies, no Node builtins, browser-safe. The workflow/run/result/event/interaction/transcript types, the
                              run-directory layout (createRunPaths), transcript structure (planTranscript one-shot and createTranscriptPlan incremental, the kind filters), and the
                              registry, request, pending-interaction and presence file schemas. `cao` depends on it by caret range and
                              re-exports every symbol from src/index.ts, so its published surface is unchanged.
test/
  fixtures/fake-claude.mjs    scripted stream-json Claude stand-in (permission prompts, questions, cancellation, usage, transient errors,
                              subagents, thinking, shell-only and binary changes)
  fixtures/fake-codex.mjs     scripted Codex exec and app-server stand-in
  helpers/index.ts            temporary git repositories, workflow builders, CLI capture
  unit/, integration/         vitest suites
```

The run directory a run writes is documented in
[capabilities.md](capabilities.md#where-the-truth-lives) — `workflow.json`, `events.jsonl`, `live.json`,
`lock.json`, `stop.json`, `report.md`, `requests/<ULID>-<kind>.json` with `requests/acks/<ULID>.json` and
`requests/rejected/` beside them, and per attempt `prompt.md`, `attempt.json`, `diff.patch`,
`diff.json`, `stdout.log`, `stderr.log` and the attempt's own `events.jsonl`.

## Key abstractions

| Name | Responsibility |
|---|---|
| `WorkflowDefinition` / `TaskDefinition` | raw YAML shape (zod-validated) |
| `ResolvedWorkflow` / `ResolvedTask` | after defaults, templates, foreach, template rendering, path resolution and DAG rules |
| `WorkflowRun`, `TaskRunState`, `TaskAttempt` | persisted run state; attempts are monotonic and never reused |
| `TaskResult` / `EnrichedTaskResult` | the completion contract (+ git info, usage) |
| `TaskRunner` | `run(input, hooks) → RunnerOutcome`; never rejects. `ClaudeRunner` and `CodexRunner` ship in the box; `agent:` (or legacy `runner:`) selects from `RunnerRegistry` |
| `AttemptChannel` | what a running attempt can still be *told*: `steer(text, expected) → SteerResult`, offered through `hooks.onChannel` while the transport has a live channel and forgotten when the attempt ends. An attempt that never offers one has no channel, which is reported as `transport: 'none'` — that, and `SteerResult`, are all the orchestrator learns about the transport ([agent-cli-integration.md](agent-cli-integration.md#steering-a-worker-that-is-running)) |
| `WorkspaceManager` | `prepareRun`, `acquire`, `finalize` (git capture + merge-back), `completeMerge`, `cleanupRun`, `lockShared` |
| `RunStore` | persistence interface; `FileRunStore` writes `.orchestrator/runs/<id>/…` atomically |
| `EventBus` | `WorkflowEvent` union consumed by persistence, renderers and the dashboard |
| `ProcessManager` | every child process the orchestrator spawns: registry, output capture, timeouts, tree termination |
| `RunController` | `submit(command, envelope) → ControlAck`; the single door through which the TUI and the CLI stop, kill, cancel a task, restart, edit or prompt one. Deduplicated by envelope id, refused when the state it was built on has moved on, and applied inside the scheduler loop |
| Ownership classifier (`cli/ownership.ts`) | `self` \| `owned` \| `abandoned` \| `ended`, decided the way `cao status` already decides it (`lock.json`, then `live.json` and its heartbeat); the one source for the workspace's badge, its observer banner and a cross-process refusal sentence |
| Observer (`workflow/control/observer.ts`) | watches a run another live process owns: polls `workflow.json` + `live.json` on the existing 500 ms tick into the presentation store, follows transcripts through `tui/follow.ts`, and sends `stop`/`kill`/`restart` through the request inbox instead of taking the lock |

## State machines

Task: `pending → ready → running → success | failed | blocked | skipped | cancelled | needs_input`, plus `pending → awaiting_approval → success | failed` and `running ⇄ waiting` while a worker is blocked on a human answer (the worker process stays alive; `waiting` keeps every exit `running` has). `running → ready` is a retry; `failed/blocked/cancelled → pending` happens only on resume. Every transition passes `assertTaskTransition` (`workflow/states.ts`) and is persisted before the next side effect.

Run: `created → running → completed | failed | paused | interrupted`; `paused/failed/interrupted → running` on resume.

## Scheduler

`WorkflowScheduler.execute()`:

1. Mark the run `running`, persist, run `WorkspaceManager.prepareRun` (base commit/branch, `.git/info/exclude`, prune), run `beforeWorkflow` hooks, apply `--task/--from` selection.
2. Loop: `promoteReady()` (topological walk: dependency check → `when` → approval gates → ready) → `launchReady()` (respects `maxConcurrency` and retry delays) → wait on a wake queue (`attempt_done`, `finalized`, `approval`, `retry_due`, `stop`, `restart`, `control`) → handle → persist.
3. `launch()`: allocate attempt number, mark `running`, **persist**, acquire workspace (shared mutex or worktree), build context + prompt (`prompt.md`, `context.md`), emit `task.started`, run `beforeTask` hooks, start the runner without awaiting it. Failures anywhere in launch become a `crash` outcome and flow through the normal failure path.
4. `handleAttemptDone()`: record the attempt, finalize the workspace (git capture, merge-back), on merge conflict start a `merge` attempt (Claude session in the shared tree) if configured, then apply the outcome: success / skipped / needs_input / blocked / cancelled / retryable failure. Retry budget = `retry.attempts` counting only task attempts since `retryWindowStart` (reset on resume). `onFailure` then applies `stop`, `continue` or `skip_dependents`.
5. `finalize()`: cancel leftover pending tasks when stopping, compute the run state (`interrupted` for Ctrl+C, `paused` for approvals/input, `failed`, `completed`), run cleanup and `afterWorkflow`, persist, release the lock, emit the terminal event.

Invariants: a single loop mutates task state; persist-before-act; a process exit code is never a result; the scheduler never imports the TUI; all timers go through an injectable `Clock`.

## Run controller

Everywhere a scheduler is running, `RunController` (`workflow/control/controller.ts`), built in
`createRuntime()` and handed to the dashboard and the CLI, is the only way anything outside
`src/workflow/` changes a run's execution state. It is not a second engine: `submit()` puts the command on
the scheduler's wake queue as a `control` wake, so it is applied *between* two of the scheduler's own
events and never inside one — two commands sent in the same tick apply in the order they were sent, and
the second sees what the first did.

- **Commands:** `stop` (`wait` | `cancel`), `kill`, `cancelTask`, `restart`, `edit` (§3.4), `prompt`
  (§3.5), and, declared but not yet applied, `approve`, `reject` and `answer`.
- **Envelope:** a ULID `id`, the `source` (`tui` | `cli` | `inbox` | `desktop`), the sender's pid, a
  timestamp and an optional `expected` (attempt, revision). The id deduplicates for the life of the run —
  persisted under `run.controls.seen` in `workflow.json`, capped at the last 1000 — so a resend after a lost
  ack is answered with the first ack and applied once. A mismatched `expected` is refused rather than
  applied to state the sender never saw.
- **Answer:** one `ControlAck` (`accepted` | `applied` | `rejected`) with a `reason` written as a sentence
  for a human, because it is the text the TUI shows as a notice and the CLI prints. `applied` means the run
  already reflects the command; `accepted` means something has to finish first.
- **`cancelTask`** denies whatever the attempt was asking a human, aborts it, and lets the ordinary
  `cancelled` outcome carry the task to `cancelled` — the state `restart` already accepts. The abort is
  delivered synchronously but the worker takes a moment to die, so the acknowledgment says the attempt is
  *being* aborted, and a `restart` asked for in that window is refused with "it is being cancelled and has
  not stopped yet" rather than with "cancel it first". An attempt that has already ended and is merging
  back cannot be aborted, so the command is `accepted` and applied when that finalization lands, ending the
  task instead of retrying it.
- **After `finalize()`** the controller stays alive: the read-only accessors keep answering and a command
  the run has not seen before is refused with "This run has ended". Identity is checked first, so a resend
  of an id the run already answered still gets that first ack — a stop that was applied must not be
  reported as refused because the run has since ended.
- **The one exception is offline.** When nobody owns the run at all, there is no scheduler to submit a
  command to, so `cao task edit` (`cli/commands/task-edit.ts`'s `offlineEdit`) runs `workflow/control/edit.ts`'s
  `applyEdit` itself and writes the resulting `WorkflowRun` straight to `workflow.json` — the offline
  revision the request inbox describes below. `cao task prompt|stop|restart` do not get this exception:
  with no owner to deliver a prompt to or a process to stop, they refuse and name `cao resume` instead.

Worktree selection is static: a task uses the `parallel` workspace when it sits in a plan layer with more than one task and `maxConcurrency > 1`; two tasks alone in their layers can never overlap, so this is safe and visible in `--dry-run`.

## Request inbox

The cross-process transport that lets another `cao` process reach the run controller without a signal or a
shared process, `persistence/requests.ts` plus the owner's existing 500 ms tick
(`execution/signals.ts:watchStopRequests`, unchanged in name because it grew this rather than gaining a
second timer).

- A sender (a second `cao task stop|restart|edit|prompt`, the workspace observer's `S`/`K`/`R`, eventually
  `cao-desktop`) writes `requests/<ULID>-<kind>.json` into the run directory and reads its answer back from
  `requests/acks/<ULID>.json`; `sendControlRequest` (`persistence/requests.ts`) builds both halves.
- Each tick, the owner reads every file in `requests/` in ULID order (`readPendingRequests`), turns each one
  into a `ControlCommand` (`commandForRequest`, `workflow/control/commands.ts`) and submits it to the
  `RunController` with `source: 'inbox'` and the request's own id as the envelope id — so an inbox command is
  deduplicated, staleness-checked and applied inside the scheduler loop exactly like a `tui` or `cli` one.
  `approve`, `reject` and `answer` are refused rather than translated: a permission decision must not be
  grantable by anyone who can write a file into the repository.
  The ack is written before the request file is deleted, so a crash between the two leaves a request that is
  asked again rather than one nobody answered, and a request already acked is never re-read.
- `stop.json` is drained on the same tick, after the inbox: it becomes a synthetic `stop` request (or `kill`
  if a stop is already pending), so `cao stop` from another terminal is unchanged from the outside and a
  second one is still the kill.
- A file that cannot be parsed, names an unknown kind, or carries a newer `protocol` than this build knows is
  moved to `requests/rejected/` with a `.reason.txt` rather than being guessed at; a sync-conflict copy
  (`*-DESKTOP-*.json`, `*.sync-conflict-*`, …) is skipped the same way `registry.ts` skips one.
- `clearPendingRequests(paths, runId, 'startup' | 'shutdown')` answers whatever is left in `requests/` with a
  rejection at the two ends of a run's process lifetime — a request nobody got to apply must not silently
  stop or kill the run that resumes afterwards, and a sender waiting on `--wait` must not be left hanging
  past the process that could have answered it.
- `wiredCapabilities()` reports `requests`, `stop`, `kill`, `restart`, `edit`, `prompt` for a run built this
  way; `approve`, `reject` and `answer` are parsed and refused, not wired, so they stay out of that list.

## Agent session isolation

Each attempt: a new session id, a new process, the prompt on stdin, the completion contract in the system prompt, a provider-compatible JSON schema for structured output, and no interactive permission prompts. Codex receives a closed schema with every field required; its runner decodes JSON-encoded free-form `data` before applying the shared result validator. Nothing from a previous session is reused; the only carry-over is the explicit context section built from stored results. The resolved `model`/`effort` for the task are passed to whichever CLI runs it (see [models.md](models.md)).

The one deliberate exception is transient-API-error recovery, which relaunches the *same* session id so the interrupted transcript and its completed work are kept.

## Git worktree isolation

- `prepareRun`: base branch + commit, `.orchestrator/` excluded, dirty-tree warning or failure (`git.requireCleanWorkingTree`).
- `acquire(worktree)`: `git worktree add -b orchestrator/<id> .orchestrator/worktrees/<id> <base>`; existing branch → suffix/reuse/fail; stale directories are removed; retries/resumes reuse a healthy worktree (optionally reset).
- `finalize(success)`: capture git info, checkpoint-commit if dirty (`autoCommit`), merge with `--no-ff` into the base branch under the shared-tree mutex, clean up the worktree (branch kept). Conflict → abort merge → `merge` attempt with a generated prompt → `completeMerge` verifies the branch is an ancestor of HEAD.
- `cao clean` removes worktrees and optionally branches.

## Diff capture

`workspace/diff.ts` gives every attempt its own patch, because "what did this task change" cannot be answered
from the working tree once several tasks have touched it.

- A **worktree** attempt is diffed from its base commit to the branch head, after the checkpoint commit, so
  work the agent left uncommitted still counts. Both ends are commits.
- A **shared-tree** attempt is diffed between two tree objects, snapshotted at `acquire` and at `finalize`
  with `git add -A` + `git write-tree` against a throwaway `GIT_INDEX_FILE` under
  `.orchestrator/tmp/<run-id>/`. The real index and working tree are never touched, and because both ends are
  real git objects the diff sees creates, deletes and renames the tool stream never reported — and ignores
  temp files the agent cleaned up again. The directory is removed when the run ends and by `cao clean`.
- A **merge-resolution** attempt gets its own patch against the pre-merge shared HEAD, through
  `completeMerge()` when it succeeded and `captureMergeAttempt()` when it did not.

Output is `diff.patch` (`--binary --full-index`, so `git apply` replays it on a checkout of the base) and
`diff.json` (path, `A`/`M`/`D`/`R`, +/- lines, binary flag) in the attempt directory, plus the same records
on the result's `git.files`. `git.captureDiff` switches it off; `git.maxDiffBytes` truncates the patch on a
line boundary with a trailing note while `diff.json` stays complete. Everything downstream — `cao diff`,
`cao task`, the dashboard's `C` view, `report.md` — reads those two files and never runs git again.

## Reporting and diagnostics

`workflow/report.ts` builds one model of a finished run from the run directory (`workflow.json`, each task's
`result.json`, each attempt's `diff.json`) and renders it as Markdown or JSON, so the two cannot disagree.
The scheduler writes `report.md` into the run directory whenever a run ends — completed, failed, paused or
interrupted — and `cao report` re-renders the same document on demand. File counts fall back from the
attempt's `diff.json` to the result's per-file records, to the recorded `git diff --stat`, to the agent's own
list, and the report says which source it used. Agent prose is made safe for the document around it: an
unclosed code fence is closed, a heading is demoted under the task's own.

`cli/commands/doctor.ts` answers the environment half of the same question. It reuses the detectors the
runners use (`runners/*/detect.ts`) and the paths `FileRunStore` writes, grades each check
(failing for Node, git, an unusable installed CLI, a capability required by a supplied workflow, an
unwritable `.orchestrator/`, or a request a live orchestrator is about to refuse as too new), and
prints the command that fixes what it found. `cao doctor [workflow]` scopes agent probes to that workflow.
It reads only: it will name a `cao clean` invocation but never run one.

Gathering and judging are separate: `gatherFacts` talks to the machine and `evaluate` is a pure function of
what it found, so every grade is unit-testable without having to produce the state it grades. Everything
`gatherFacts` touches that is not a file is behind `DoctorDeps` — the detectors, the liveness test, the
terminal, the session probe and the login-mode reader — which is what keeps `npm test` free of this
machine's terminal, `~/.claude` and `~/.codex`. The per-agent knowledge behind the `controls`, `quota` and
`sessions` rows sits in `runners/controls.ts`, `runners/auth.ts` and `runners/sessions.ts`, the same
runner-neutral seam as `runners/quota.ts` and `runners/diagnostics.ts`: the command renders a
`ControlSupport`, an `AgentAuth` and a `SessionPresence` without naming a CLI. Whether a run is *abandoned*
comes from `readOrchestrator` — the owner in `lock.json`, else a fresh-heartbeat `live.json` — never from the
`running` label a crashed process left on disk. The inbox is read with `readControlHistory`, which changes
nothing, so opening doctor on a live run cannot race the orchestrator for its own requests.

## Process management and Ctrl+C

`ProcessManager.spawn` pipes stdin/stdout/stderr (stdin can be kept open for interactive workers: `writeStdin`/`endStdin`), writes `stdout.log`/`stderr.log`, keeps a ring buffer, enforces the task timeout and registers the process. Workspace finalization after an attempt (git capture, merge-back) runs off the scheduler loop and re-enters through a `finalized` wake, so a merge-resolution session holding the shared-tree lock can never deadlock another task's merge-back. Termination: POSIX children are spawned detached and killed by process group (SIGTERM, then SIGKILL after `killGrace`); on Windows stdin is closed, then `taskkill /PID <pid> /T /F` kills the tree. `createInterruptController` handles SIGINT/SIGTERM and the dashboard's Ctrl+C: first interrupt → a `stop`/`cancel` command through the run controller + graceful shutdown; second → `forceKill()`, which is force kill, synchronous state save, exit 130. A `kill` command escalates to that same `forceKill()` once the run's state has been stopped, so the escalation is named rather than inferred from two interrupts. `process.on('exit')` performs a last kill sweep.

## Persistence and resume

`FileRunStore` writes `workflow.json` atomically after every transition (writes are serialized), appends `events.jsonl`, and throttles `live.json` (immediate on state changes). `lock.json` (pid + heartbeat) prevents two orchestrators from owning a run. `reconcileForResume` closes running attempts as `interrupted` (killing a still-alive worker pid first), returns failed/cancelled/blocked tasks to `pending`, re-evaluates `when`, applies `--approve/--reject/--input`, and re-runs explicitly selected tasks. The scheduler then continues from the same code path with `isResume: true`.

Everything the run controller and the inbox add to `workflow.json` is additive: `WorkflowRun.schemaVersion` stays `1` and workflow YAML `version: 1` is untouched. `TaskRunState.revisions: TaskRevision[]` records each edit (field, old and new value, who made it, the attempt it first reached); `TaskAttempt.prompts` and `TaskRunState.followUps` are `PromptDelivery[]` (id, mode, transport, delivery state, redacted text); `WorkflowRun.controls.seen` is the deduplicated `ControlAck[]` a run has already answered. `QuotaSnapshot` (protocol, provider, state, per-window `usedPercent`/`resetsAt`) is the one addition that is never persisted at all — it lives only in the footer's in-memory state for the life of the workspace process, because it is a reading repeated from a provider, not a fact about the run.

## Live visibility

- Every runner emits typed `TranscriptEntry` records (`packages/protocol/src/transcript.ts`): agent text, thinking, commands, tool calls, tool output, permissions, questions, results, and the operator's own messages (`user`). They go to the bus as `task.transcript`, into a per-task ring buffer the dashboard reads, and verbatim into the attempt's `events.jsonl`; one planner (`planTranscript`, in the protocol package) decides the structure and one renderer (`tui/transcript.ts`, markdown-aware, ANSI-coloured) draws it everywhere — as a whole transcript for a screen or a tail, and line by line (`createTranscriptStream`) for `cao logs --follow` and `cao peek`, which see one entry at a time and have to remember the calls earlier lines opened. A call and its result share a `toolUseId` (so the renderer can show how long the tool took) and everything a subagent produced carries the `parentToolUseId` of the `Agent:` call that spawned it (so it nests under it). `thinking` entries are the one kind the renderer drops unless a surface asks for them (`showThinking`), which is what makes `T` in the viewer and `--thinking` on `cao logs` the only ways to see them.
- The same structure is also available **incrementally**, as `createTranscriptPlan()` in the protocol package. `planTranscript` is global by necessity — whether a call went unanswered is decided by the last entry in the array — so a surface tailing a growing log has to re-read all of it, and rebuild every row, on every batch. The stateful planner keeps the pairing maps between appends, rebuilds only the nodes an append moved, and reports them as `{ added, changed }`; a node nothing touched is the same object it was, which is what lets a DOM renderer with virtual scrolling skip it. `reset()` throws an attempt away, because tool ids come from the agent process and a retry reuses them. Nothing in `cao` calls it yet — the TUI's follow view still uses `planTranscript` and `createTranscriptStream` — and the two are kept honest by a property test (`test/unit/incremental-planner.test.ts`): for every recorded attempt log in `test/fixtures/transcripts/` and every split point, the incremental planner's tree equals `planTranscript`'s. The same property runs over a thousand generated logs whose entries arrive in orders no agent produces — results before their calls, parents that never arrive, one `toolUseId` owned by several calls — because that is where the two implementations can differ without any recording noticing. `scripts/bench-transcript-plan.ts` prints what it buys.
- Runners also report live usage (`task.usage`: tokens, context size, cost — Claude from every assistant message's `usage` and the final `modelUsage`; Codex exec from `turn.completed` and app-server from `thread/tokenUsage/updated`) and file changes (`task.files`, from Edit/Write tool calls or Codex `file_change` items).
- In-process workspace (Ink, `tui/app.tsx`): header, sidebar, tabbed main panel and footer, fed by the zustand store in `tui/store.ts`; follow view = `tui/viewer.tsx`, shared with `cao logs --follow`; prompts, questions and approval gates use one modal (`tui/dashboard/modal.tsx`). It can still be put aside for line output and brought back with `D` (or automatically when a worker needs a human).
- The workspace outlives the run. `cli/workspace-session.ts` owns the Ink tree, the plain-output fallback, the operator's intentions and the exit code; an execution happens inside it and there may be several, because resuming an ended run from the workspace is another one. Each action goes through `startRuntime` (`cli/app.ts`) — the same function `cao resume` calls, so validation, the lock and `reconcileForResume` cannot differ between the two — and the new scheduler is mounted into the store that is already on screen. Between executions the session holds no lock. `cao ui` enters the same session with no execution at all, reading the run through `workflow/control/detached.ts`, a `RunController` over the run directory that refuses every command with a reason.
- Owner and observer are one classifier: `cli/ownership.ts` turns `readOrchestrator`'s answer into `self`, `owned`, `abandoned` or `ended`, and writes the badge, the banner and the refusal from it, so `cao status` and the workspace cannot disagree about a run directory. A run another live process owns is watched by `workflow/control/observer.ts`: a 500 ms poll of `workflow.json` + `live.json` (merged as `cao status` merges them) into the same presentation store, transcripts through `tui/follow.ts`, and a surface that sends `stop`, `kill` and `restart` into `requests/` and reports the ack. It acquires no lock anywhere, and it offers only the capability tokens the run's registry entry advertises. When the poll stops seeing an owner the session drops the observer and the workspace becomes an owner candidate again.
- Cross-process: `cao status` reads `workflow.json` + `live.json` (which now carries usage, file counts and the pending interaction); `cao peek`/`cao logs --follow` tail the attempt's `events.jsonl` with a polling tailer (works on Windows and network drives); the viewer lets you switch tasks and attempts and reads finished tasks in full. Scrolling above the oldest entry still in the ring buffer pages older ones back in through `persistence/transcript-log.ts`, which finds the caller's oldest entry in the attempt's `events.jsonl` and returns the page before it. The buffer spans every attempt while each file covers one, so a beginning-of-file is not a beginning-of-transcript: paging walks back into the previous attempt's file, and "nothing older" is remembered against the entry it was said about rather than the task, so it cannot latch for the session.
- Worker interaction: `runners/claude/protocol.ts` speaks Claude's stream-json control protocol, while Codex app-server sends JSON-RPC command/file approval requests. Both normalize into the same scheduler interaction seam. `handleInteraction` flips the task to `waiting`, runs `hooks.onInputRequired`, races the dashboard handler against `execution.interactionTimeout`, and denies when nobody can answer. A worker making parallel tool calls can block on several requests at once, so they are tracked per task and the state returns to `running` only when the last one is answered; `pendingInteraction` is the oldest still open. The handler is given its own abort signal, aborted as soon as the request stops needing an answer (withdrawn, timed out, answered), which is how the dashboard knows to take a modal down — one cancellation channel, so no decided prompt is ever left in front of a live one. Every denial, whoever produced it, passes through `denyMessage`, which appends what was refused and `finish with status needs_input if you cannot continue`: a worker blocked on a human ends `waiting` or `needs_input`, never `failed`. Where a transport has no channel for the request at all — `codex exec`, or an app-server question with `experimentalUserInput` off — the runner reports that through the ordinary `RunnerOutcome` as a `needs_input` result quoting what was asked (`runners/codex/exec-limits.ts`, `runners/codex/app-server-protocol.ts`), so nothing in `workflow/`, the TUI or the CLI has to know which agent it was.

## Security notes

- Workflow YAML is executable configuration: only its hooks run shell commands; worker output is never executed.
- Templates are plain lookups; `when` uses a closed grammar; both reject code.
- `workingDirectory`, `promptFile`, `envFile` and `copyIgnored` are confined to the repository (or workflow directory).
- `envFile` values and secret-looking keys are redacted from logs, prompts, results and events; token-shaped strings are redacted by pattern.
- Structured results are schema-validated; malformed output is an `invalid_result` failure, not a crash.
- Agent-written text is untrusted display data. `util/text.ts` strips escape sequences and control characters at every boundary where it reaches a terminal — the permission modal above all, plus the transcript renderer, the plain renderer and `hooks.onInputRequired` env values. A worker (or a prompt injection steering it) therefore cannot repaint the prompt an operator is about to answer, or make a dangerous command display as a harmless one. Raw bytes are still stored verbatim in the attempt's `events.jsonl`; only what reaches a screen is cleaned.
- Thinking is recorded in the attempt's `events.jsonl` and nowhere else: `task.transcript` is not persisted to the run log, the runner never turns a thought into an activity line, and `live.json`'s `lastLines` skip it. Opting in is per surface and per session, never a stored setting.
- The run-level `events.jsonl` records an interaction's summary (`InteractionRecord`: id, kind, tool, title), never its raw tool input — the same rule that already keeps worker output, transcripts and usage in the per-attempt directory, so whole file contents and complete shell commands stay out of the artifact people attach to tickets.
- "Allow for the rest of this task" only ever replays a rule the CLI itself suggested, forced to `destination: session`. The orchestrator never widens an approval into a rule of its own, so one `A` cannot authorize a whole tool for the session.

## Packaging

- `dist/` is the whole published payload and is gitignored, so `prepublishOnly` runs typecheck, lint, test
  and then `npm run build`: a publish can never ship a stale or missing build.
- The `exports` map is `"."` and `"./package.json"` only. `dist/bin.js` and any future chunk are internals —
  the supported library surface is exactly what `src/index.ts` re-exports.
- The build carries no sourcemaps. They were the largest thing in the tarball and the bundle is not what
  anyone debugs; a contributor runs `npm run dev` (tsx straight over `src/`) instead.
- `files` lists `docs/*.md`, not `docs`, so `docs/research/` (internal notes) stays out of the tarball.
- `publishConfig.tag` is `beta`, so `npm install -g code-agent-orchestrator` does not resolve to a pre-1.0
  release until a `latest` publish happens.
- **Two packages, two release trains.** `packages/protocol/` publishes `code-agent-orchestrator-protocol`
  on its own semver, moved only when the wire contract moves, so most `cao` releases do not bump it. `cao`
  depends on a caret range and re-exports every symbol from `src/index.ts`, so a consumer of the library
  sees the same surface whichever package a type is declared in. The package tarball is `dist/` plus its
  README, CHANGELOG and LICENSE; `files` in the root package keeps `packages/` out of `cao`'s own tarball.
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, test and build on Node 22 and 24, on
  `ubuntu-latest` and `windows-latest`. It needs a real `git`; it never needs Claude or Codex, because every
  agent process in the suites is a fake Claude or Codex CLI under `test/fixtures/`. Without `git` the worktree and end-to-end
  suites skip themselves with a message instead of failing inside `git init`.

## Extending

- New runner: implement `TaskRunner` and register it in `createRuntime`; select with `agent: <name>`.
- New workspace strategy: implement `WorkspaceManager`.
- New renderer: subscribe to the `EventBus`.
