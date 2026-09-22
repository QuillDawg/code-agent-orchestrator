# CAO v2 Beta: Persistent AI Command Center

**Target:** `2.0.0-beta.1`, one release on the `beta` npm tag, built in six internal stages (§4).
**Decisions:** every choice this document rests on is listed with its reason in [cao-v2-beta-decisions.md](cao-v2-beta-decisions.md) (D1–D42). Sections below cite them as `[D7]`.
**Facts:** verified on 2026-09-17 against the working tree at `4a3d5bf` and against vendor sources; every vendor claim carries its source in §7. File references are `path:line` at that commit.

## 0. How to read this document

- **REQUIRED** is the product behaviour the beta must ship. **FOUNDATION** is what makes it reliable. **SUGGESTION** is excluded from acceptance unless adopted.
- Each section names the **stage** that owns it (S0–S5). A stage is an internal milestone, not a release: it lands on `main` green with its exit criteria met, and is implemented as one CAO workflow under the local, git-ignored `.cao-files/v2/` directory with one scope file per task `[D1, D42]`.
- "Owner" means the process that holds the run lock and runs the scheduler. "Observer" means any other process looking at the same run `[D3]`.

## 1. Summary and stocktake

Turn `cao` into a persistent terminal workspace: run workflows, inspect failures, edit unfinished tasks, talk to agents, review results, and never lose the interface when a run ends.

### 1.1 Current inventory (corrected)

| Area | Present today | v2 gap |
|---|---|---|
| CLI | Flat commander 12 program, 14 commands, per-command examples, exit-code and environment footer (`src/cli/program.ts:239-281`) | Bare `cao` prints usage to **stderr and exits 2** (verified). No subcommands, no help groups, no `ui`, `task edit`, `task prompt`, `diagnostics`, `--debug`, `--probe` |
| Execution | Execa, DAG layers, concurrency, retries, transient recovery, timeouts, worktrees. **Per-task restart exists** (`scheduler.requestRestart`, `scheduler.ts:337,1062-1072`). **Lock is released at finalize** (`scheduler.ts:1504`) | No per-task stop, no controller, a finalized scheduler cannot be reused (`finished` gates everything; `scheduler.ts:1533,1585`) |
| TUI | Ink **5.2.1 / React 18.3.1**, table, detail, follow viewer, usage, review, help, one modal; minimise with `Q`, reopen with `D` (`app.tsx:209-212`, `run.ts:156-208`) | Exits 50 ms after `finished` (`app.tsx:132-138`); no alternate screen, no resize listener, colour hard-coded on (`app.tsx:101`), no store, no editor, no composer |
| Persistence | Atomic `workflow.json`, run and attempt `events.jsonl`, `live.json`, `lock.json`, `stop.json`, `orchestrator.log`, per-attempt prompt/diff/logs, `report.md` | No revisions, no prompt records, no acknowledgments; `requests/` and `interactions/` are documented as reserved and do not exist |
| Doctor | node, git, agents, live probes (**on by default**), locks, worktrees, branches, exclude; `--no-probe` | Only the Codex `exec` probe is billable (`codex/probe.ts:32-85`); the Claude probes and the Codex app-server probe cost nothing by construction. New checks in §3.7 |
| Agent sessions | Claude stream-json with control requests in ask mode; Codex `exec` and experimental app-server; session continuation for `--input` on all three transports | Claude stdin is written **once** (`claude-runner.ts:278`); `turn/steer` is never sent; no per-task follow-up outside `--input` |
| Usage | Per-task tokens, context, cost, tool time (`RunnerUsage`) | Zero account-quota code: no `account/rateLimits/*`, no timer, no footer |
| Protocol | `ControlRequest`, `CAPABILITIES`, registry, presence, pending-interaction **types**; `wiredCapabilities()` returns `[]` for every run | No acknowledgment type, no reader or writer of requests anywhere in `src/` |

### 1.2 Confirmed lifecycle issue

`DashboardApp` calls `exit()` 50 ms after `props.finished` turns true (`src/tui/app.tsx:132-138`), `executeRun` awaits `dashboard.finish()` in its `finally` (`src/cli/commands/run.ts:210-223`), and every command handler ends in `exitWith`, which calls `process.exit` (`src/cli/program.ts:64-76`). All three change for persistent operation; `exitWith` stays for headless commands.

### 1.3 What changed from the previous draft

- **Stack:** Ink 6 is already superseded. The target is Ink `^7.1.1` (never below 7.0.6, the Windows rendering fix) and React `^19.3` `[D7]`. `@inkjs/ui`, `ink-scroll-list`, `figures` and `pretty-ms` are dropped `[D8–D10]`; `commander` moves to 15 for help groups `[D18]`.
- **Process model** is explicit: owner and observer, with the request inbox carrying the non-permission controls `[D3]`.
- **Alternate screen** is the default, with an off switch `[D4]`; minimise survives as a quit answer `[D5]`.
- **CLI** nests the task controls under `cao task` with `show` as default `[D6]`.
- **Budget** is `claude.maxBudgetUsd`, Claude only; there is no task-level budget key today `[D20]`.
- **Source YAML** already gets `state: completed` written by `WorkflowCompletionStore`; that is the one documented exception to "no source edits" `[D21]`.
- **Claude quota** is estimated from the session logs Claude Code already writes, and marked as an estimate; no unofficial endpoint is used, because `cao` still makes no network calls of its own `[D29]`. "Fable" is a model name, not a quota category `[D30]`.
- **Codex quota reads need ChatGPT login**; API-key auth is refused by the server, so the footer has an explicit auth-required state (§3.6).
- **Codex `turn/start` on a thread with an active turn is silently treated as a steer** by the server (§7.2). The runner must never rely on `turn/start` to open a second turn.
- **Vendor citations** are corrected: the app-server README was deleted in Codex 0.154.0; the docs page and the protocol crate are the sources now (§7).

## 2. FOUNDATION: architecture

### 2.1 Process model: owner and observer — S0, S1

- **Owner.** `cao run`, `cao resume`, and any workspace action that starts execution hold `lock.json` and run the scheduler in-process. The TUI talks to the run controller directly. `canInteract` keeps its current meaning: an interactive dashboard is attached to *this* process.
- **Observer.** `cao ui <run>` on a run another live process owns, or a workspace whose lock was taken by another process while it was idle, shows the run from files: `workflow.json` and `live.json` polled at the existing 500 ms cadence, transcripts through the existing follow tailer (`src/tui/follow.ts`, `src/persistence/transcript-log.ts`). It sends stop, kill, restart, edit and prompt through the inbox (§2.3) and shows their acknowledgments. Pending approvals and questions are rendered read-only with "answer in the owning terminal (pid N)". It takes no lock `[D37]`.
- **Ownership is decided as `cao status` decides it today:** `lock.json` first, then `live.json` plus the 60 s heartbeat window (`src/cli/util.ts:44-72`). A run with a dead owner is "abandoned": inspectable, and resumable from the workspace, which then becomes owner.
- Daemons and detached execution stay out of scope.

### 2.2 Run controller — S0

One object, created in `createRuntime()`, is the only way anything outside `src/workflow/` changes execution state. The scheduler stays the sole owner of that state; the controller is a caller of it.

```ts
type ControlCommand =
  | { kind: 'stop';    mode: 'wait' | 'cancel' }                       // run-level, as today
  | { kind: 'kill' }                                                    // second stop
  | { kind: 'cancelTask'; taskId }                                      // new: abort one attempt
  | { kind: 'restart'; taskId }                                         // exists: terminal non-success → pending
  | { kind: 'edit';    taskId; changes: TaskEdit; restart: boolean }    // §3.4
  | { kind: 'prompt';  taskId; text; mode: 'steer' | 'followUp' | 'stopAndContinue' } // §3.5
  | { kind: 'approve' | 'reject'; taskId; note? }                       // in-process only
  | { kind: 'answer';  taskId; interactionId; answer }                  // in-process only

interface ControlEnvelope { id: Ulid; source: 'tui' | 'cli' | 'inbox' | 'desktop'; pid; at: IsoDate;
  expected?: { attempt?: number; revision?: number } }                 // stale → rejected
interface ControlAck { protocol: 1; id: Ulid; status: 'accepted' | 'applied' | 'rejected'; reason?: string; at: IsoDate }
```

- Every command enters the scheduler loop as a `control` wake, so state changes stay serialized with `attempt_done`, `finalized`, `approval`, `retry_due`, `stop` and `restart` (`scheduler.ts:68-74`).
- `id` is deduplicated for the life of the run (persisted in `workflow.json` under `run.controls.seen`, capped at the last 1000). A duplicate returns the first ack.
- `expected.attempt` and `expected.revision` reject actions built on stale state with `rejected: task <id> is on attempt 3, request expected 2`.
- Rejections carry a reason a human can act on; the TUI shows it as a notice, the CLI prints it and exits 2.
- **`cancelTask`** aborts the in-flight attempt's `AbortController`, settles its open interactions with the existing deny path, and records the attempt as `cancelled`; the task ends `cancelled`, which `restart` already accepts `[D22]`. Cancelling a task in merge-back waits for finalization first and says so.
- After `finalize()` the controller stays alive for **read-only** state and for the actions that start a new runtime (§2.4). A finalized scheduler is never reused.

### 2.3 Request inbox — S0

The cross-process transport for the controller, and the first real use of the reserved run-directory paths `[D38]`.

```
.orchestrator/runs/<run-id>/
  requests/<ULID>-<kind>.json      # ControlRequest, protocol: 1 first
  requests/acks/<ULID>.json        # ControlAck
  requests/rejected/<file>         # unreadable or future-protocol requests, moved not deleted
  stop.json                        # legacy; translated into a stop request internally
```

- **Kinds accepted from disk:** `stop`, `kill`, `restart`, `edit`, `prompt`. `approve`, `reject` and `answer` files are rejected with `permission controls are not accepted from disk until presence gating ships`, matching the trust boundary in docs/desktop.md `[D3]`.
- The owner polls `requests/` on the existing 500 ms stop-watcher tick, processes files in ULID order, writes the ack before deleting the request, and never re-reads an acked id. Sync-conflict filenames are skipped as in the registry reader.
- `expected` fields and dedup work exactly as in §2.2; the inbox is one more `source`.
- `cao stop` keeps writing `stop.json` in this beta so an older `cao` in another terminal still works; the owner turns it into a `stop` request with a synthetic id.
- `wiredCapabilities()` reports `requests`, `stop`, `kill`, `restart` from S0 and adds `edit`, `prompt` when S2 lands, so the registry entry advertises only what the run really accepts.
- CLI callers (`cao task edit|prompt|stop|restart` from a non-owning terminal) write a request and wait for its ack up to `--wait <seconds>` (default 30), then print the outcome. With no live owner: `edit` is saved offline as a revision (§3.4); `prompt`, `stop` and `restart` print "no orchestrator owns this run; use `cao resume`" and exit 2.

### 2.4 Lifecycle: a run ends, the workspace stays — S1

- `finalize()` keeps releasing the lock and writing `report.md` and the registry entry. The workspace receives the terminal event and enters **ended** state; nothing unmounts.
- **Actions in ended state** `[D36]`: Resume run (`cao resume` semantics: failed, blocked and cancelled tasks return to pending), Re-run task (`--task`), Resume from task (`--from`), Answer and resume (`needs_input`, text from the composer), Approve / Reject (paused gates). Each validates first, re-acquires the lock, builds a new runtime through `resumeCommand → reconcileForResume → executeRun`, and mounts the new scheduler into the same workspace. If the lock is held by another live process the workspace flips to observer with a banner naming the pid.
- **Exit code:** quitting returns the latest execution outcome (`exitCodeFor`, `scheduler.ts:229-240`); an inspection-only session that never executed returns 0. `cao ui` on a run that is still running elsewhere returns 0 on quit.
- **Quit during execution** `[D5]`: stay · stop and quit (graceful stop, then exit with the run's code) · continue in plain output (today's minimise, `D` or Enter reopens, auto-reopen on a pending interaction). On an ended run `Q` exits at once.
- **Ctrl+C** in the workspace: graceful stop, the workspace stays open in ended state; a second Ctrl+C within the existing 20 s hard deadline force-kills and exits 130 as today (`signals.ts:28-84`). This is the one place the second-interrupt behaviour is unchanged on purpose.
- **Headless is untouched:** `--no-tui`, non-TTY, `CI`, `TERM=dumb` keep `attachPlainRenderer` and `exitWith` with the documented codes. No workspace timer (quota, spinner, poll) is created on that path.
- **Errors:** operational errors (a rejected control, a failed resume, a provider error) are notices inside the workspace. Uncaught runtime errors go through `installCrashHandlers`, which gains one step: leave the alternate screen and restore raw mode **before** printing and exiting 70, then persist what the scheduler can persist synchronously.

### 2.5 State and stack — S0

| Responsibility | Choice | Decision |
|---|---|---|
| Parsing | `commander ^15` (help groups since 14, `showSuggestionAfterError`) | D18 |
| Processes | `execa` (unchanged) | — |
| Shared contracts | `code-agent-orchestrator-protocol` (minor bump, wire major 1) | D39 |
| Configuration | `yaml` + `zod` (unchanged) | — |
| Terminal UI | `ink ^7.1.1` (>= 7.0.6) + `react ^19.3` + `@types/react ^19` | D7 |
| Lists | in-house windowing keyed to `useWindowSize()` | D9 |
| Links | `ink-link` | D11 |
| Glyphs, durations | `src/util/glyphs.ts`, `src/util/duration.ts` extended | D10 |
| Fuzzy matching | `fuzzysort ^4` | D12 |
| Presentation state | `zustand ^5` vanilla store + `useStore` | D13 |
| Composer | in-house buffer + `$VISUAL`/`$EDITOR` via `suspendTerminal()` | D14 |
| Tests | `ink-testing-library` for components; in-house harness with `rows`/`columns` for the full-screen tree | D17 |

Render options: `{ alternateScreen: <per D4>, incrementalRendering: true, exitOnCtrlC: false, patchConsole: false, kittyKeyboard: { mode: 'auto' } }`. Frames are always sized to `useWindowSize()`; nothing taller than `rows` is ever rendered, which is the condition under which Ink 7 neither wipes scrollback nor tears on Windows (§7.3).

Zustand owns navigation, focus, drafts, selections, notices and the displayed snapshot. The store is fed by the event bus through the same 80 ms coalescing the dashboard uses today (`app.tsx:104-122`); persisted run state remains authoritative and is re-read, never mirrored, after a resume.

### 2.6 Persistence additions — S0 (types), S2/S3 (writers)

All additive; `WorkflowRun.schemaVersion` stays `1`, workflow YAML `version: 1` is untouched.

```ts
interface TaskRevision { number: number; at: IsoDate; source: ControlEnvelope['source']; pid: number;
  changes: Partial<Record<'prompt' | 'agent' | 'model' | 'effort' | 'timeout' | 'retries' | 'maxBudgetUsd', { from: unknown; to: unknown }>>;
  note?: string; appliedToAttempt?: number }
// TaskRunState.revisions?: TaskRevision[]; TaskAttempt.revision?: number

interface PromptDelivery { id: Ulid; at: IsoDate; source; mode: 'steer' | 'followUp' | 'stopAndContinue';
  transport: 'claude-stream' | 'codex-app-server' | 'codex-exec' | 'none';
  state: 'queued' | 'accepted' | 'delivered' | 'rejected' | 'failed'; reason?: string;
  text: string /* redacted */; turnId?: string; carriedByAttempt?: number }
// TaskAttempt.prompts?: PromptDelivery[]; plus a `user` TranscriptEntry in the attempt's events.jsonl

interface QuotaSnapshot { protocol: 1; provider: 'codex' | 'claude'; readAt: IsoDate;
  state: 'ok' | 'stale' | 'unavailable' | 'authRequired' | 'error'; reason?: string; planType?: string;
  estimated?: boolean;
  windows: Array<{ label: string; durationMins: number | null; usedPercent: number | null; usedTokens?: number; resetsAt: IsoDate | null }> }
```

- The run-level `events.jsonl` records `task.edited { taskId, revision, fields }` and `task.prompted { taskId, deliveryId, mode, state }` **without text**, following the existing rule that bulk and sensitive detail stays in the attempt directory.
- New capability tokens: `edit`, `prompt`. New protocol exports: `TaskRevision`, `PromptDelivery`, `ControlAck`, `QuotaSnapshot`, `CONTROL_REQUEST_KINDS` extended.

### 2.7 Compatibility — every stage

- Existing workflow files run unchanged; no YAML key is added, removed or renamed in this beta. `--no-probe`, `stop.json` and `CAO_DEBUG` keep working.
- Documented behaviour changes: persistent interactive outcomes, `Q` semantics, doctor probes opt-in, bare `cao` success, alternate screen default. Each gets a **Changed** line under `[Unreleased]` and a paragraph in docs/capabilities.md.
- `.orchestrator/runs/<id>/` written by 2.0 is readable by `cao status`, `cao task`, `cao logs` of 0.1.x (new fields are ignored).

## 3. REQUIRED product behaviour

### 3.1 Persistent terminal workspace — S1

- `cao ui [run]` opens the repository workspace. With no run: recent runs (from `cao list`'s data, newest first, with state, age, cost) and launch actions (run a workflow file found in the launch directory, or one picked from a path prompt). With a run: owner or observer per §2.1.
- Interactive `cao run` and `cao resume` enter the same workspace and keep the run's exit code for quit.
- The workspace stays open after **success, failure, pause and graceful interruption**. After failure the Overview leads with the failed task, its failure category (`AttemptOutcome`), the latest error line, the attempt count, and the actions available for that task (re-run, edit, prompt, open logs, open diff).
- Logs, earlier attempts, diffs and reports stay reachable in ended state, read from the run directory exactly as `cao logs`, `cao diff` and `cao report` read them.
- Retry and resume from the workspace per §2.4.

### 3.2 Layout, navigation, identity — S1 (shell), S4 (theme)

Layout, sized to the terminal on every frame:

- **Header:** repository, run id, workflow name, run state, elapsed, concurrency `2/3`, owner or observer badge.
- **Sidebar:** run and task navigation, task state glyph, agent and model as reported at session start, attention badges (needs you, failed, editing, prompt pending).
- **Main:** Overview · Session (§3.5) · Logs (§3.7) · Changes (existing review view) · Report (rendered `report.md`) · Diagnostics (§3.7).
- **Footer:** provider quota chips (§3.6), freshness, and the shortcuts that apply to the focused panel.

Navigation (chords verified for Windows Terminal, conhost and mintty in §7.3):

| Input | Behaviour | Note |
|---|---|---|
| Tab / Shift+Tab | Move focus between panels | Shift+Tab arrives as `\x1b[Z`; the `\x1bOZ` variant some Windows terminals send is parsed too |
| Arrow keys, PgUp/PgDn, Home/End | Navigate the focused panel | `key.home`/`key.end` exist since Ink 6.6 |
| Enter | Open or activate | |
| Esc | Close dialog, leave composer, go back | |
| Ctrl+P | Command palette (fuzzysort over actions and tasks) | unbound in Windows Terminal, reaches the app |
| `/` | Search the focused list or transcript | |
| `?` | Contextual help | |
| `Q` | Quit request (§2.4) | not inside a composer |
| Ctrl+C | Graceful stop, stay open | |
| Ctrl+O | In a composer: open in `$VISUAL`/`$EDITOR` through `suspendTerminal()` | mirrors `O` in the review view |
| Ctrl+J or `\`+Enter | Newline in a composer; Enter submits | Shift+Enter works only where the kitty protocol is on |

- While a composer or editor has focus, printable keys are text. Only Esc, Ctrl+P, Ctrl+O, Ctrl+J and Ctrl+C are chords there.
- Resize: `useWindowSize()` drives every panel; the store keeps scroll positions clamped. Compact layout at 80×24 collapses the sidebar to a one-line task strip and drops the footer's freshness column first.
- Separation: the body is a fenced region. A rule under the tab bar and a rule above the footer, joined by a vertical rule down the sidebar/panel seam with `┬`/`┴` where they meet; the Overview labels its task table and its detail block with labelled rules. Every row a rule costs is deducted inside `workspaceLayout()` before any component is sized, so §2.5 holds by construction. Compact spends its single rule under the task strip instead, where the boundary is actually lost; a screen reader gets none, for the reason the header collapses to one line; and the rules are the first rows given up as the terminal shrinks.
- Modes: `--theme cyberpunk|mono`, `CAO_THEME`; `NO_COLOR` forces mono; `CAO_ASCII=1` switches glyphs (already exists); `CAO_REDUCED_MOTION=1`, Ink's screen-reader flag, or `TERM=dumb` disable the spinner and the activity pulse. Every state is readable without colour: glyph plus word `[D35]`.
- The cyberpunk theme (S4) is a token table in `src/tui/theme.ts`: violet and cyan accents, one danger and one warning colour, panel borders in the accent, compact branding in the header. Animations are limited to the running spinner and a two-frame activity pulse, both off under reduced motion.

### 3.3 CLI discovery and help — S1

- `cao` alone prints root help to **stdout** and exits 0. Today it prints to stderr and exits 2 (`program.ts:62`; verified by running `dist/bin.js`).
- Every command and subcommand answers `--help`. Root help uses commander 15 `commandsGroup` for **Run**, **Inspect**, **Task controls**, **Diagnostics**.
- `cao task` becomes a command with subcommands `show` (default), `edit`, `prompt`, `stop`, `restart`. `cao task <refs>` keeps working through the default subcommand; a literal subcommand name wins and `cao task show edit` reaches a task called `edit` `[D6]`. `cao stop [run]` stays run-level.
- Unknown commands use `showSuggestionAfterError` and exit 2 (already remapped from commander's 1).
- Command help explains defaults, examples, run and task references, transport restrictions (which transports can steer, §3.5) and exit codes.
- A test parses every `Examples:` block and every fenced `cao …` line in README.md and docs/capabilities.md and runs it through `buildProgram().parseOptions` with `exitOverride`, failing on an unknown command or option.

### 3.4 Editing unfinished tasks — S2

TUI editor (Session panel → Edit) and CLI:

```
cao task edit [run] <task> [--prompt <text> | --prompt-file <path>] [--agent claude|codex] [--model <id>]
             [--effort <level>] [--timeout <duration>] [--retries <n>] [--budget <usd>] [--restart] [--wait <s>]
```

- **Editable fields:** prompt, agent, model, effort, timeout, retries (`retry.attempts`), budget (`claude.maxBudgetUsd`, Claude only; rejected on a Codex task with "Codex has no budget flag") `[D20]`.
- **What "prompt" means:** the resolved task prompt, with defaults, template and `foreach` already applied (`ResolvedTask.prompt`). The context section is shown read-only below it and keeps being injected at launch `[D19]`.
- **Editable states:** `pending`, `ready`, `failed`, `blocked`, `cancelled`, `needs_input`. **Rejected:** `success`, terminal `skipped`, approval-type tasks. **Running or waiting:** stop → edit → restart as one controller command with `restart: true`; the CLI needs `--restart` explicitly, the TUI asks.
- **Validation first.** The edited task is re-validated with the existing validator before anything is stopped: agent installed, model and effort compatibility (Haiku drops effort, Codex `none`/`minimal`), Codex `exec` cannot ask, timeout format, retries 0–20, budget only on Claude. A failure is a rejection with the validator's message and nothing changes.
- **Descendants and merge-back.** Rejected while the task has a `merge` attempt in flight or finalization pending, and while any transitive dependent is running, waiting, succeeded or skipped-after-success. The rejection explains how to create a revised run (`cao run <workflow> --from <task>`).
- **Preservation.** The old attempt, its `prompt.md`, transcript, usage and diff are untouched. A restart after an edit starts a **fresh session**; a follow-up prompt (§3.5) is what continues a session. Existing worktree and branch are reused as today; if `retry.resetWorkspace` is on the editor says "uncommitted changes in the worktree will be reset" before applying. Nothing is discarded silently.
- **Persistence.** Each edit appends a `TaskRevision` `[D21]` and a `task.edited` event; the next attempt records `revision`. `cao task show` prints the revision history under Attempts. Source YAML is never written by an edit.
- Saving an edit never restarts a failed, paused or interrupted run; restarting is an explicit action (`--restart`, the TUI action, or Resume run).

### 3.5 Agent prompting and follow-ups — S2

The **Session** panel shows the transcript (existing viewer), session identity (agent, model, session or thread id, attempt), pending interactions, prompt deliveries with their state, and a multiline composer.

```
cao task prompt [run] <task> (--message <text> | --file <path>) [--steer | --follow-up | --stop-and-continue] [--fresh-session] [--wait <s>]
```

Without a mode flag the CLI picks the one row below allows and says which it chose.

| Task state | Transport | Mode offered | Mechanism | Delivery states |
|---|---|---|---|---|
| running, turn active | Claude, stdin open (ask mode) | **steer (queued)** | write a stream-json `user` message to the open stdin; Claude queues it and starts a new turn when the current one ends | `queued` → `accepted` when `--replay-user-messages` echoes it, else stays `queued`; `failed` if the process exits first |
| running | Claude, deny mode (stdin closed) | stop and continue | `cancelTask`, then a follow-up attempt with `--resume <session>` | `delivered` when the attempt starts |
| running, turn active | Codex app-server | **steer** | `turn/steer { threadId, input, expectedTurnId }` | `accepted` on result; `rejected` with the server's message (`no active turn to steer`, `expected active turn id`, `cannot steer a review turn`, `active turn uses a different output schema`) |
| running | Codex exec | stop and continue | `cancelTask`, then `codex exec resume <thread>` with the message | `delivered` |
| waiting (blocked on a permission or question) | any | none | answer the interaction; prompts and answers stay separate | — |
| failed, blocked, cancelled, interrupted, needs_input | any | **follow-up** | new attempt `triggeredBy: 'user_input'`, session resumed where `retry.resumeSession` allows and the runner reported one; otherwise a fresh prompt with the message under `# User Input` (the existing `--input` path, generalized) | `delivered`; `failed` if launch fails |
| pending, ready | any | none | edit the prompt instead (§3.4) | — |
| success, skipped | any | none | immutable; add a task or start a new run | — |

- Missing or incompatible session (file gone, provider refuses `--resume`, Codex thread has another writer): actionable error plus the explicit **fresh session** option `[D25]`. Never a silent switch of transport or session.
- Codex: the runner never calls `turn/start` while a turn is active, because the server would treat it as a steer (§7.2). Steer does not change model or effort; the experimental `turn/settings/update` is not used.
- Claude: no interrupt exists in the stream-json protocol; "stop" is the existing SIGTERM path, which leaves the turn resumable (§7.1).
- Every delivery is a `PromptDelivery` on the attempt and a `user` transcript entry `[D26]`; the run log gets the summary event only. The composer shows each delivery's state next to the message.
- Successful tasks are immutable; the composer is disabled with a hint.

Native agent terminal handoff remains a **SUGGESTION**.

### 3.6 Usage footer — S3

- One chip per detected supported agent, including not-installed and authentication states.
- **Codex** `[D28]`: the workspace spawns one `codex app-server --stdio` **quota process** per session (never per attempt), sends `initialize { clientInfo: { name: 'cao', version } }` and `initialized`, then `account/read` for the auth mode and `account/rateLimits/read`. It re-reads on entry, on manual refresh (`R` in the footer, palette action) and every **five minutes**, and merges `account/rateLimits/updated` notifications. Reads are account-scoped, need no thread and start no model turn. Attempt-level app-server processes forward the `account/rateLimits/updated` notifications they receive during turns to the same snapshot, so a busy run refreshes faster than the timer. The process is killed on unmount; closing its stdin makes it exit.
  - Display per window the server reports: label from `windowDurationMins` (`5h`, `7d`, else `Nm`), `usedPercent`, `resetsAt` as local time, plus `planType`. Never assume which windows exist.
  - `authRequired` when `account/read` says `apiKey` or the read fails with the server's "authentication required" message: the server refuses quota reads for API-key auth. Chip text: `codex · sign in with ChatGPT for quotas`.
  - `unavailable` when the CLI is below 0.48.0 (first version with the method) or not installed.
- **Claude** `[D29]`: estimated from the transcripts Claude Code already writes under `~/.claude/projects/`, deduplicated by `message.id`, as rolling 5h and 7d windows of **absolute tokens** — no local file records the plan's limit, so there is no honest percentage and `usedPercent` is null. Marked `est` on the chip, `resetsAt` null, and `unavailable · see /usage in Claude Code` when there are no transcripts to add up. Still no network call of `cao`'s own.
- **Fable** has no meaning here `[D30]`; the footer shows only provider-reported windows under provider labels.
- States: `loading`, `ok` (with age), `stale` (last good reading kept, age shown, reason on hover in help), `unavailable`, `authRequired`, `error`. A failed refresh never blanks a good reading.
- Timers start when the workspace mounts, are `unref`'d, and stop on unmount; headless never starts them `[D31]`. **Per-task** tokens and costs stay in the Usage view; the run's aggregate is a footer cell of its own beside the quota chips and never inside one `[D43]`.

### 3.7 Doctor, debugging, logs — S1 (probe default), S3 (rest)

**Doctor** `[D32]`

- Ordinary `cao doctor` is non-billable: live probes run only with `--probe`. `--no-probe` stays accepted as a no-op alias with a deprecation note. Probe rows print as `- <agent> live start  not probed (pass --probe)`.
- New checks, each with severity, evidence and a remediation line: `terminal` (TTY, raw mode, size, unicode, colour level, `WT_SESSION`, alternate-screen advice), `storage` (`.orchestrator` writable, free space warning under 200 MB), `protocol` (protocol package version; any `requests/` file with a future `protocol` or files in `rejected/`), `sessions` (the latest run's resumable session ids still exist on disk: Claude `~/.claude/projects/<slug>/<id>.jsonl`, Codex `$CODEX_HOME/sessions/**/rollout-*-<id>.jsonl`), `controls` (Claude advertises `--replay-user-messages`; Codex ≥ 0.99.0 for `turn/steer`, ≥ 0.48.0 for quotas), `quota` (Codex auth mode chatgpt vs apiKey), `run state` (a `running` snapshot whose owner pid is dead or whose heartbeat is older than 60 s is reported as abandoned; unacked requests older than one minute).
- Active versus abandoned execution is decided from owner identity, pid liveness and heartbeat, never from the stored `running` label alone. Doctor repairs nothing.

**Logs**

- The **Logs** panel reads the run's `orchestrator.log`, the run `events.jsonl`, and per attempt `stdout.log`, `stderr.log`, `events.jsonl` and `prompt.md`, paged from disk the way the transcript pager works; nothing loads a whole file. Filters: task, attempt, severity, time range, source. Search with `/`. Views: normalized events, stderr, raw output, prompts.
- The **Diagnostics** panel shows transport, CLI versions, effective configuration per task (resolved values plus active revision), retry history, failure metadata (`RunnerFailure`), control history (requests and acks), and quota snapshots.
- `--debug` on `run` and `resume` (same effect as `CAO_DEBUG=1`): debug-level logger to `orchestrator.log`, stack traces on errors, Diagnostics panel unlocked by default `[D34]`.
- `cao diagnostics [run] --out <file> [--include transcripts,prompts,diffs]` writes one JSON bundle `[D33]`: doctor facts (no probes), redacted `workflow.json`, run `events.jsonl`, `live.json`, `orchestrator.log`, every `attempt.json`, the last 200 lines of each `stderr.log`, requests and acks. Transcripts, prompts and diffs only with the flag. Redaction uses the existing `Redactor`. No upload, no telemetry.

## 4. Stages

Each stage is one workflow `.cao-files/v2/<n>-<name>.yaml` with scope files in `.cao-files/v2/scope/<name>/` and a `RULES.md`, in the baseline → feature → iterate → review → fix → gate shape already used by the hardening pass `[D42]`. `.cao-files/` is local working material, ignored by git and never committed. A stage is done when its exit criteria pass on Windows and Linux CI and `main` is green.

| Stage | Owns | Exit criteria |
|---|---|---|
| **S0 Foundations** | Ink 7.1.1 / React 19.3 / commander 15 upgrade with the `key.backspace` and `key.meta` audit; in-house render harness; run controller, `control` wake, `cancelTask`; request inbox with acks and `stop.json` translation; protocol types and capability tokens (§2.2, §2.3, §2.5, §2.6); zustand store fed by the bus | Existing suites green on the new stack with no visible change; controller dedup, staleness and serialization tests; `cao stop` from another terminal produces an ack; `wiredCapabilities()` reports `requests, stop, kill, restart`; protocol package browser-safety test still passes |
| **S1 Persistent workspace** | Lifecycle (§2.4), owner/observer (§2.1), `cao ui`, layout shell with neutral theme, navigation and palette, resize and 80×24, quit prompt, minimise, help and CLI discovery (§3.3), doctor `--probe` default (§3.7) | Acceptance rows 1–5 of §5; bare `cao` exits 0 to stdout; nested `cao task show`; observer banner and read-only interactions; crash handler restores the terminal |
| **S2 Controls** | Editing (§3.4), prompting (§3.5), Session panel, composer with `$EDITOR`, CLI subcommands, Codex `turn/steer`, Claude `--replay-user-messages` ack, follow-ups generalized from `--input`, `edit`/`prompt` capabilities | Acceptance rows 6–9; every matrix row of §3.5 covered against the fakes, including `turn/steer` rejections and the missing-session error |
| **S3 Usage and diagnostics** | Quota process and footer (§3.6), Logs and Diagnostics panels, `--debug`, `cao diagnostics`, new doctor checks (§3.7) | Acceptance rows 10–12; fake `codex app-server` serves `account/rateLimits/read`, `account/read` and `account/rateLimits/updated`; fake-clock five-minute refresh; headless creates no timers |
| **S4 Identity** | Cyberpunk theme tokens, animations, reduced motion, mono and ASCII, screen-reader mode, compact-layout polish, Windows Terminal, conhost and mintty verification | Acceptance rows 13–14; snapshot tests at 80×24 and 120×40 in colour, mono and ASCII; no ANSI colour under `NO_COLOR` |
| **S5 Release validation** | Docs (README, capabilities, configuration, architecture, desktop, agent-cli-integration), CHANGELOG `## [2.0.0-beta.1]`, version bumps, `npm pack` smoke, `test:agents` on a machine with both CLIs | Everything in §5; `prepublishOnly` green; packaged `cao --help`, `cao doctor --json`, `cao ui` against a fixture run |

Order is fixed by dependency: S1 needs S0's controller and stack; S2 needs S1's Session panel and S0's inbox; S3 needs S1's footer slot; S4 is cosmetic over S1–S3; S5 needs everything.

## 5. Test plan and release acceptance

Beta acceptance requires all of:

1. A failed interactive run stays open and shows stderr, earlier attempts, diffs and the report.
2. Success, pause and graceful interruption stay inspectable; Ctrl+C once stops and stays, twice exits 130.
3. Resume, re-run and resume-from succeed from the workspace; quitting returns the latest outcome.
4. Headless `run`, `resume`, `status`, `stop`, `doctor` and `diagnostics` exit with documented codes and leave no timers or listeners (asserted with a fake clock and `process.getActiveResourcesInfo()`).
5. Bare `cao`, nested help, unknown commands and every documented example parse consistently.
6. Editing a running task validates before stopping, preserves the old attempt, starts a fresh session, records a revision.
7. Duplicate, concurrent and stale controls apply once and reject with a reason, in-process and through the inbox.
8. Successful tasks, active or completed descendants and merge-back reject edits with the documented message.
9. Codex steer races (turn ended between read and steer), Claude queued input, Codex exec and deny-mode Claude, missing sessions and another-writer conflicts produce the delivery states in §3.5.
10. Quotas refresh at five-minute intervals under a fake clock and handle resets, missing windows, `authRequired`, stale data and an unavailable provider; Claude shows unavailable.
11. Doctor starts no model call without `--probe`; `--probe` exercises real transport readiness; `--no-probe` still parses.
12. Logs and the diagnostics bundle respect redaction and content-inclusion flags.
13. Keyboard focus, multiline paste (including a 1000-line paste), resize, 80×24, ASCII, mono and reduced motion work on Windows, Linux and macOS; Windows Terminal is primary, conhost and mintty documented as best-effort.
14. Large transcripts stay bounded (`outputBufferLines`) and navigation stays under 50 ms per keypress in the harness.

Fixtures: extend `test/fixtures/fake-claude.mjs` (echo `--replay-user-messages`, refuse a second message after `result`) and `fake-codex.mjs` (`turn/steer` success and each rejection, `account/read`, `account/rateLimits/read`, `account/rateLimits/updated`, "already has an active writer" on resume). Strict vendor fixtures stay the contract; `npm run test:agents` checks the real `--help` surfaces for every new flag. Release requires typecheck, lint, tests, build and the packaged CLI smoke `[D41]`.

## 6. Clearly marked additional suggestions

Excluded from acceptance unless adopted.

| Priority | Suggestion | Benefit |
|---|---|---|
| High | Failure inbox across recent runs | Recurring failure categories and unresolved work in one list |
| High | Workflow initialization wizard (`cao init`) | Valid workflows without learning every YAML option |
| High | DAG view | Explain blocked tasks and downstream impact |
| High | Budget and quota alerts | Warn before expensive execution or near a window's limit |
| Medium | Compare task attempts | Prompts, settings, results and diffs side by side |
| Medium | Native agent terminal handoff | Continue in the vendor CLI under exclusive session ownership |
| Medium | Saved task presets | Reuse agent, model and effort combinations |
| Medium | Completion and input notifications | Surface events when another panel is focused (OSC 9 where supported) |
| Medium | Cross-process approve and answer | Needs presence gating (docs/desktop.md); unlocks the desktop app and observer answers |
| Later | Detached execution and reattachment | Keep workers running after the terminal closes |
| Later | Quota-aware scheduling | Delay work or propose another agent under explicit user control |

## 7. Vendor facts relied on

### 7.1 Claude Code (code.claude.com docs, 2026-09-17)

- Streaming input (`--input-format stream-json`) accepts `user` messages on stdin; a message written while a turn runs is queued and starts a new turn when the current one ends. No interrupt request is documented in the stream-json protocol; SIGINT interrupts, SIGTERM exits 143 and leaves the turn resumable with `--resume`. `--replay-user-messages` re-emits user messages on stdout for acknowledgment and requires stream-json on both sides. Sources: headless, cli-reference, agent-sdk/streaming-vs-single-mode.
- `--permission-prompts none` needs 2.1.259+; `control_request`/`control_response` shapes are not on the public pages (CAO's implementation is verified against 2.1.259 in docs/agent-cli-integration.md).
- Sessions: `--session-id` UUID, `--resume <id|name|path>`, `--fork-session`, `--no-session-persistence`; transcripts at `~/.claude/projects/<slug>/<id>.jsonl`; concurrent resume of one session by two processes is undefined. Source: sessions.
- No programmatic read of the Pro/Max `/usage` bars exists; `/usage` is terminal-only; rate-limit response headers describe API rate limits, not subscription quota. "Fable" is a model family (`claude-fable-5-1`, alias `fable`), not a quota category. Sources: costs, monitoring-usage, model-config.
- `--effort low|medium|high|xhigh|max|ultracode`; `--model` aliases include `fable`, `opus`, `sonnet`, `haiku`, `best`.

### 7.2 Codex CLI 0.154.0 (learn.chatgpt.com docs and `openai/codex` at `7abf2a3`, 2026-09-17)

- `codex app-server` is marked experimental; `--listen stdio://` is the default and `--stdio` is its alias; framing is newline-delimited JSON with the `jsonrpc` field omitted; `initialize { clientInfo }` then the `initialized` notification are required before any other method (-32600 `Not initialized`). Legacy v1 methods were deleted in 0.110.0; the app-server README was removed in 0.154.0 (PR #43421); the protocol crate `codex-rs/app-server-protocol` is authoritative. Source: `learn.chatgpt.com/docs/app-server`, `codex-rs/app-server-transport/src/transport/stdio.rs`.
- `turn/steer { threadId, input, expectedTurnId, clientUserMessageId? }` → `{ turnId }`; added 0.99.0; accepts no overrides; errors are -32600 with `expectedTurnId must not be empty`, `no active turn to steer`, `expected active turn id X but found Y`, `cannot steer a review turn` / `cannot steer a compact turn` (`codexErrorInfo.activeTurnNotSteerable`), `input must not be empty`, `active turn uses a different output schema`. **`turn/start` on a thread with an active turn is routed to steer** (`turn_processor.rs`). Model and effort of a running turn change only through the experimental `turn/settings/update`.
- `turn/interrupt { threadId, turnId }`; `turn/completed { threadId, turn }` carries no usage; usage arrives as `thread/tokenUsage/updated { threadId, turnId, tokenUsage: { total, last, modelContextWindow } }`.
- `account/rateLimits/read` (since 0.48.0) → `{ rateLimits: RateLimitSnapshot, rateLimitsByLimitId, ... }` with `RateLimitSnapshot { primary?, secondary?, credits?, planType?, rateLimitReachedType?, limitId? }` and `RateLimitWindow { usedPercent, windowDurationMins, resetsAt (unix seconds) }`. Account-scoped, no thread needed, a backend usage read and no model call. Refused with -32600 `chatgpt authentication required to read rate limits` for API-key auth. `account/rateLimits/updated { rateLimits }` is sparse, emitted during turns, and is to be merged into the last read. `account/read` → `{ account: { type: 'apiKey' } | { type: 'chatgpt', email, planType } | null }`. Source: `codex-rs/app-server-protocol/src/protocol/v2/account.rs`, `account_processor.rs`.
- One writer per thread: a second process resuming a thread gets `thread <id> already has an active writer` (-32600); the 0.154.0 TUI opens such a thread read-only. The stdio server exits when stdin reaches EOF. `thread/list` hides `exec` and `appServer` threads unless `sourceKinds` is passed.
- `codex exec` cannot take input mid-run: it sends one `turn/start` and exits at `turn/completed`; `codex exec resume <id> [prompt]` continues a thread. Sessions live at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`, possibly zstd-compressed.
- `@openai/codex-sdk` wraps `codex exec`, exposes no steer, interrupt or rate limits; the Python SDK drives app-server. Neither is used here.

### 7.3 Ink and terminals (npm registry and GitHub, 2026-09-17)

- Ink 7.1.1 (2026-07-16) requires Node 22 and React ≥ 19.2; master already requires React 19.3. Ink 6 requires React 19 and is superseded. Ink 7.0.0–7.0.5 rendered garbled output on every Windows terminal (#969); 7.0.6 fixed it by clearing the screen per full-screen frame on Windows (PR #971). `alternateScreen`, `usePaste`, `useWindowSize`, `useFocusManager().activeId`, `suspendTerminal()` (7.1.0) and `incrementalRendering`, synchronized output and `kittyKeyboard` (6.7) are the features this spec uses. Backspace sets `key.backspace` (was `key.delete`) and Escape no longer sets `key.meta` since 7.0.0. Without the alternate screen a frame taller than the viewport wipes scrollback (#935; fix unreleased). Ink 7.1.1 has no `contentOffset` scrolling; the merged PR #988 is unreleased.
- `@inkjs/ui` 2.0.0 has been idle since 2024-05, has no multiline input and an uncontrolled `TextInput`. `ink-scroll-list` 0.5.0 renders all children and offsets with negative margin. No ecosystem multiline editor is mature; Gemini CLI hand-rolls a text buffer with Ctrl+J and backslash-Enter newlines and an `$EDITOR` escape.
- Windows Terminal default bindings consume Ctrl+V, Ctrl+Shift+V, Shift+Insert, Ctrl+Tab, Ctrl+Shift+F and Alt+Enter; Ctrl+P, Ctrl+O, Ctrl+J and Shift+Tab reach the application. Shift+Enter and Ctrl+Enter are indistinguishable from Enter without the kitty keyboard protocol, which stable Windows Terminal (1.24) lacks. OSC 8 hyperlinks work in Windows Terminal (`WT_SESSION`) and VS Code; `is-unicode-supported` returns true on Windows only for Windows Terminal, VS Code, Terminus, Cmder and JetBrains terminals. Bracketed-paste markers can be lost through ConPTY on very large pastes (anthropics/claude-code#50012).
- `ink-testing-library` 4.0.0 fakes stdout at 100 columns with no `rows`; an in-house harness is needed for full-screen layouts.
- commander 15.0.0 (2026-05-29); `.commandsGroup()`/`.optionsGroup()` since 14.0.0; `.showSuggestionAfterError()` since 8.2.0.

## 8. Open items and risks

- **Ink release cadence.** `contentOffsetY` and the scrollback fix are on master. The design does not depend on them; if they ship during S1 the windowing helper can adopt `contentOffsetY` without API change.
- **ConPTY paste loss** on multi-thousand-line pastes is a terminal defect; the `$EDITOR` route is the documented answer.
- **Codex `turn/steer` on `exec`-started threads.** Not applicable: exec has no live channel. A follow-up to an exec attempt always goes through `codex exec resume`.
- **Claude acknowledgment depends on `--replay-user-messages`** being advertised by `claude --help`; without it steering shows `queued` until the turn boundary is observed in the stream.
- **Observer freshness** is bounded by the 500 ms file poll and the 20 s heartbeat; the banner says "observing" so nobody mistakes it for the owner's view.
- **`.orchestrator/tmp/codex-app-schema/`** holds a Codex schema dump that corroborates the shapes above; it is a local artifact and not a build input. Regenerate with `codex app-server generate-json-schema` when the pinned Codex minimum moves.
