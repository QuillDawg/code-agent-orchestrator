# Architecture

`cao` is a lightweight workflow engine whose workers are disposable Claude Code or Codex CLI processes. The engine owns all state; workers only receive a prompt and return a structured result.

```
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
   (.orchestrator)     (shared / worktree)   └─ ProcessManager ─► agent CLI (child)
                    │
               EventBus ──► persistence (events.jsonl) ──► plain renderer / Ink dashboard
```

## Directory structure

```
src/
  bin.ts, index.ts            CLI entry / library exports
  cli/                        commander program, commands/ (run, validate, resume, stop, status, list, logs, peek, task, diff, report, clean, doctor)
    app.ts                    service layer: prepareWorkflow(), createRuntime()
    crash.ts                  process-level unhandledRejection / uncaughtException handlers, exit 70
    color.ts, util.ts         colour mode (--color/NO_COLOR/FORCE_COLOR), run and task reference resolution, tables, time formats
    render/plain.ts           non-TTY line renderer, startup header, summary
    render/diff.ts            reads a captured diff.patch: section lookup by path (git's quoting undone), stat and colour
  config/                     schema.ts (zod), loader.ts (YAML, repository/launch dir, env), normalize.ts (defaults, templates, foreach, DAG rules)
  workflow/                   graph.ts (Kahn layers, cycles), validator.ts, states.ts (transition tables), scheduler.ts, plan.ts, run-factory.ts (create/resume), completion-store.ts (state: completed markers), report.ts (the run document, shared by cao report and the report.md every run writes), run-view.ts
  runners/                    task-runner.ts (TaskRunner, RunnerRegistry); claude/ (claude-runner, event-parser, protocol = stdio control protocol, models = context windows, contract, transient, detect); codex/ (codex-runner, detect)
  execution/                  process-manager.ts (registry, ring buffers, timeouts, tree kill), signals.ts (Ctrl+C), hooks.ts
  context/context-builder.ts  structured results → "# Previous Task Context"
  conditions/evaluator.ts     safe `when` expression grammar
  templates/engine.ts         safe {{path}} substitution
  workspace/                  git.ts (explicit git wrapper), workspace-manager.ts (shared + git worktree strategies, merge-back), diff.ts (tree snapshots through a throwaway index, diff.patch/diff.json capture)
  persistence/                run-store.ts (atomic snapshots, events, live.json, lock, heartbeat), paths.ts, run-id.ts, transcript-log.ts (pages older entries back out of an attempt's events.jsonl)
  events/event-bus.ts         typed synchronous event bus
  logging/                    logger.ts, redact.ts
  tui/                        app.tsx (Ink dashboard: table, detail, usage, help), viewer.tsx (follow view, shared with `cao logs --follow`),
                              dashboard/ (modal.tsx for permission prompts, questions and approvals; review.tsx + files.ts + editor.ts for the
                              `C` review view; activity.ts for the activity cell; pane.ts), history.ts (attempt and interaction tables, shared
                              by `cao task` and the detail view), transcript.ts + markdown.ts + format.ts (one renderer for every transcript
                              surface), logs.tsx, follow.ts (file tailer)
  util/                       text.ts (strips escapes and control characters from anything shown to a human), glyphs.ts + marks.ts (Unicode/ASCII
                              fallback, CAO_ASCII/CAO_UNICODE), package-info.ts, async-queue, duration, errors, fs, misc
  types/                      shared type definitions (transcript.ts and interaction.ts carry the live-visibility contracts)
test/
  fixtures/fake-claude.mjs    scripted stream-json Claude stand-in (permission prompts, questions, cancellation, usage, transient errors,
                              subagents, thinking, shell-only and binary changes)
  helpers/index.ts            temporary git repositories, workflow builders, CLI capture
  unit/, integration/         vitest suites
```

The run directory a run writes is documented in
[capabilities.md](capabilities.md#where-the-truth-lives) — `workflow.json`, `events.jsonl`, `live.json`,
`lock.json`, `stop.json`, `report.md`, and per attempt `prompt.md`, `attempt.json`, `diff.patch`,
`diff.json`, `stdout.log`, `stderr.log` and the attempt's own `events.jsonl`.

## Key abstractions

| Name | Responsibility |
|---|---|
| `WorkflowDefinition` / `TaskDefinition` | raw YAML shape (zod-validated) |
| `ResolvedWorkflow` / `ResolvedTask` | after defaults, templates, foreach, template rendering, path resolution and DAG rules |
| `WorkflowRun`, `TaskRunState`, `TaskAttempt` | persisted run state; attempts are monotonic and never reused |
| `TaskResult` / `EnrichedTaskResult` | the completion contract (+ git info, usage) |
| `TaskRunner` | `run(input, hooks) → RunnerOutcome`; never rejects. `ClaudeRunner` and `CodexRunner` ship in the box; `agent:` (or legacy `runner:`) selects from `RunnerRegistry` |
| `WorkspaceManager` | `prepareRun`, `acquire`, `finalize` (git capture + merge-back), `completeMerge`, `cleanupRun`, `lockShared` |
| `RunStore` | persistence interface; `FileRunStore` writes `.orchestrator/runs/<id>/…` atomically |
| `EventBus` | `WorkflowEvent` union consumed by persistence, renderers and the dashboard |
| `ProcessManager` | every child process the orchestrator spawns: registry, output capture, timeouts, tree termination |

## State machines

Task: `pending → ready → running → success | failed | blocked | skipped | cancelled | needs_input`, plus `pending → awaiting_approval → success | failed` and `running ⇄ waiting` while a worker is blocked on a human answer (the worker process stays alive; `waiting` keeps every exit `running` has). `running → ready` is a retry; `failed/blocked/cancelled → pending` happens only on resume. Every transition passes `assertTaskTransition` (`workflow/states.ts`) and is persisted before the next side effect.

Run: `created → running → completed | failed | paused | interrupted`; `paused/failed/interrupted → running` on resume.

## Scheduler

`WorkflowScheduler.execute()`:

1. Mark the run `running`, persist, run `WorkspaceManager.prepareRun` (base commit/branch, `.git/info/exclude`, prune), run `beforeWorkflow` hooks, apply `--task/--from` selection.
2. Loop: `promoteReady()` (topological walk: dependency check → `when` → approval gates → ready) → `launchReady()` (respects `maxConcurrency` and retry delays) → wait on a wake queue (`attempt_done`, `approval`, `retry_due`, `stop`) → handle → persist.
3. `launch()`: allocate attempt number, mark `running`, **persist**, acquire workspace (shared mutex or worktree), build context + prompt (`prompt.md`, `context.md`), emit `task.started`, run `beforeTask` hooks, start the runner without awaiting it. Failures anywhere in launch become a `crash` outcome and flow through the normal failure path.
4. `handleAttemptDone()`: record the attempt, finalize the workspace (git capture, merge-back), on merge conflict start a `merge` attempt (Claude session in the shared tree) if configured, then apply the outcome: success / skipped / needs_input / blocked / cancelled / retryable failure. Retry budget = `retry.attempts` counting only task attempts since `retryWindowStart` (reset on resume). `onFailure` then applies `stop`, `continue` or `skip_dependents`.
5. `finalize()`: cancel leftover pending tasks when stopping, compute the run state (`interrupted` for Ctrl+C, `paused` for approvals/input, `failed`, `completed`), run cleanup and `afterWorkflow`, persist, release the lock, emit the terminal event.

Invariants: a single loop mutates task state; persist-before-act; a process exit code is never a result; the scheduler never imports the TUI; all timers go through an injectable `Clock`.

Worktree selection is static: a task uses the `parallel` workspace when it sits in a plan layer with more than one task and `maxConcurrency > 1`; two tasks alone in their layers can never overlap, so this is safe and visible in `--dry-run`.

## Agent session isolation

Each attempt: a new session id, a new process, the prompt on stdin, the completion contract in the system prompt, a JSON schema for structured output, and no interactive permission prompts. Nothing from a previous session is reused; the only carry-over is the explicit context section built from stored results. The resolved `model`/`effort` for the task are passed to whichever CLI runs it (see [models.md](models.md)).

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
(fail only for Node, git, and having no agent CLI at all), and prints the command that fixes what it found.
It reads only: it will name a `cao clean` invocation but never run one.

## Process management and Ctrl+C

`ProcessManager.spawn` pipes stdin/stdout/stderr (stdin can be kept open for interactive workers: `writeStdin`/`endStdin`), writes `stdout.log`/`stderr.log`, keeps a ring buffer, enforces the task timeout and registers the process. Workspace finalization after an attempt (git capture, merge-back) runs off the scheduler loop and re-enters through a `finalized` wake, so a merge-resolution session holding the shared-tree lock can never deadlock another task's merge-back. Termination: POSIX children are spawned detached and killed by process group (SIGTERM, then SIGKILL after `killGrace`); on Windows stdin is closed, then `taskkill /PID <pid> /T /F` kills the tree. `createInterruptController` handles SIGINT/SIGTERM and the dashboard's Ctrl+C: first interrupt → `scheduler.requestStop('cancel', 'signal')` + graceful shutdown; second → force kill, synchronous state save, exit 130. `process.on('exit')` performs a last kill sweep.

## Persistence and resume

`FileRunStore` writes `workflow.json` atomically after every transition (writes are serialized), appends `events.jsonl`, and throttles `live.json` (immediate on state changes). `lock.json` (pid + heartbeat) prevents two orchestrators from owning a run. `reconcileForResume` closes running attempts as `interrupted` (killing a still-alive worker pid first), returns failed/cancelled/blocked tasks to `pending`, re-evaluates `when`, applies `--approve/--reject/--input`, and re-runs explicitly selected tasks. The scheduler then continues from the same code path with `isResume: true`.

## Live visibility

- Every runner emits typed `TranscriptEntry` records (`types/transcript.ts`): agent text, thinking, commands, tool calls, tool output, permissions, questions, results. They go to the bus as `task.transcript`, into a per-task ring buffer the dashboard reads, and verbatim into the attempt's `events.jsonl`; one renderer (`tui/transcript.ts`, markdown-aware, ANSI-coloured) draws them everywhere — as a whole transcript for a screen or a tail, and line by line (`createTranscriptStream`) for `cao logs --follow` and `cao peek`, which see one entry at a time and have to remember the calls earlier lines opened. A call and its result share a `toolUseId` (so the renderer can show how long the tool took) and everything a subagent produced carries the `parentToolUseId` of the `Agent:` call that spawned it (so it nests under it). `thinking` entries are the one kind the renderer drops unless a surface asks for them (`showThinking`), which is what makes `T` in the viewer and `--thinking` on `cao logs` the only ways to see them.
- Runners also report live usage (`task.usage`: tokens, context size, cost — Claude from every assistant message's `usage` and the final `modelUsage`; Codex from `turn.completed`) and file changes (`task.files`, from Edit/Write tool calls or Codex `file_change` items).
- In-process dashboard (Ink, `tui/app.tsx`): a controller that can be minimised (`Q`) and reopened (`D`, or automatically when a worker needs a human); follow view = `tui/viewer.tsx`, shared with `cao logs --follow`; prompts, questions and approval gates use one modal (`tui/dashboard/modal.tsx`).
- Cross-process: `cao status` reads `workflow.json` + `live.json` (which now carries usage, file counts and the pending interaction); `cao peek`/`cao logs --follow` tail the attempt's `events.jsonl` with a polling tailer (works on Windows and network drives); the viewer lets you switch tasks and attempts and reads finished tasks in full. Scrolling above the oldest entry still in the ring buffer pages older ones back in through `persistence/transcript-log.ts`, which finds the caller's oldest entry in the attempt's `events.jsonl` and returns the page before it. The buffer spans every attempt while each file covers one, so a beginning-of-file is not a beginning-of-transcript: paging walks back into the previous attempt's file, and "nothing older" is remembered against the entry it was said about rather than the task, so it cannot latch for the session.
- Worker interaction (Claude): `runners/claude/protocol.ts` speaks the stream-json control protocol (`can_use_tool` requests answered on stdin); the scheduler's `handleInteraction` flips the task to `waiting`, runs `hooks.onInputRequired`, races the dashboard handler against `execution.interactionTimeout`, and denies when nobody can answer. A worker making parallel tool calls can block on several requests at once, so they are tracked per task and the state returns to `running` only when the last one is answered; `pendingInteraction` is the oldest still open. The handler is given its own abort signal, aborted as soon as the request stops needing an answer (withdrawn, timed out, answered), which is how the dashboard knows to take a modal down — one cancellation channel, so no decided prompt is ever left in front of a live one.

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
- CI (`.github/workflows/ci.yml`) runs typecheck, lint, test and build on Node 22 and 24, on
  `ubuntu-latest` and `windows-latest`. It needs a real `git`; it never needs Claude or Codex, because every
  agent process in the suites is `test/fixtures/fake-claude.mjs`. Without `git` the worktree and end-to-end
  suites skip themselves with a message instead of failing inside `git init`.

## Extending

- New runner: implement `TaskRunner` and register it in `createRuntime`; select with `agent: <name>`.
- New workspace strategy: implement `WorkspaceManager`.
- New renderer: subscribe to the `EventBus`.
