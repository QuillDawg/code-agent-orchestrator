# What you can express in a workflow

A task-oriented tour of everything `cao` can do. Each entry is the smallest YAML that demonstrates the feature, with a pointer to the full reference in [configuration.md](configuration.md).

The mental model: **`cao` is a deterministic manager; agents are disposable workers.** The orchestrator owns all state, ordering and retries. A worker gets a prompt, does work in a directory, and returns a structured result. Nothing else crosses the boundary.

---

## Structuring work

### Run tasks in order

Tasks run top to bottom by default. No wiring needed.

```yaml
tasks:
  - id: implement
    prompt: "/implement 101"
  - id: test           # runs after implement
    prompt: Run the test suite and fix failures.
```

### Run tasks in parallel

Give tasks the same `parallelGroup`. They must be listed together, and each gets its own git worktree so no two agents share a working tree.

```yaml
execution:
  maxConcurrency: 3

tasks:
  - id: impl-102
    parallelGroup: core
    prompt: "/implement 102"
  - id: impl-103
    parallelGroup: core
    prompt: "/implement 103"
```

Branches are merged back into your base branch on success. `maxConcurrency` must be raised above `1` or the group still runs one at a time.

### Express an explicit dependency graph

`dependsOn` replaces the implicit ordering for that task. `dependsOn: []` makes a root.

```yaml
execution:
  mode: dag          # only explicit edges; parallelGroup becomes an error

tasks:
  - id: api
    dependsOn: []
    prompt: Build the API.
  - id: ui
    dependsOn: []
    prompt: Build the UI.
  - id: integrate
    dependsOn: [api, ui]
    prompt: Wire them together.
```

### Fan out over a list

`foreach` expands one task definition into many, taking the id suffix from `id`/`key`/`number`/`issue`/`name`.

```yaml
issues:
  - number: 101
  - number: 102
    parallelGroup: auth      # items may override task fields
  - number: 103
    parallelGroup: auth

tasks:
  - id: implement
    foreach: issues
    prompt: "/implement {{item.number}}"
```

Produces `implement-101`, `implement-102`, `implement-103`. Referring to `implement` in `dependsOn` or `context.from` expands to all children.

Keep a collection uniform: scalar items (`- 101`) are reachable only as `{{item}}`, object items as `{{item.number}}`. A prompt that reads `{{item.number}}` fails validation on a scalar item.

### Reuse a task shape

`templates` are named task bodies; `defaults` apply to every task. Merge order is `defaults` < template < task < foreach item.

```yaml
defaults:
  timeout: 60m
  retry: { attempts: 1 }

templates:
  implementIssue:
    type: implementation
    prompt: "/implement {{issueNumber}}"

tasks:
  - id: implement-101
    template: implementIssue
    issueNumber: 101      # any unknown key becomes a {{variable}}
```

---

## Passing information between tasks

### Give a task the results of earlier tasks

Workers share no conversation. The only channel is the structured result of a previous task, rendered into a `# Previous Task Context` section and prepended to the prompt.

```yaml
- id: review
  context:
    from: [implement-101, "implement-1*"]   # ids or globs
    fromType: implementation                 # or every task of a type
    include: [summary, filesChanged]         # trim what gets injected
    maxChars: 60000
  prompt: Review the work described in context.
```

Available fields: `summary`, `filesChanged`, `commits`, `decisions`, `warnings`, `followUp`, `error`, `data`, `git`. Context sources must be dependencies, so their results are guaranteed to exist. `context: false` sends none.

The exact text injected is saved as `context.md` in the run directory — nothing is hidden.

### Return machine-readable data

Every worker must finish with a JSON object matching the completion contract. The free-form `data` field carries anything you want downstream.

```yaml
- id: analyze
  prompt: |
    Analyze the schema and report findings.
    Put a {"tables": [...]} object in the result's data field.
- id: act
  context:
    from:
      - task: analyze
        include: [data]
  prompt: Act on the tables listed in context.
```

---

## Controlling what runs

### Skip a task unless a condition holds

```yaml
- id: fix
  when:
    task: review
    status: failed
# or an expression
- id: escalate
  when:
    expr: tasks.review.warnings.length > 0 && tasks.review.status != "failed"
```

The grammar is closed — comparisons, `in`, `contains`, `&&`, `||`, `!`, literals and paths. No function calls, no arithmetic, no code execution. A skipped task satisfies its dependents.

### Pause for a human decision

```yaml
- id: production-ready
  type: approval
  prompt: Continue to final verification?
```

In the dashboard you answer inline. Headless, the run exits with code `3` and waits:

```bash
cao resume <run-id> --approve production-ready
```

### Answer a worker while it runs

A Claude Code worker that needs a permission you have not granted, or that calls `AskUserQuestion`, shows up in the dashboard as **Needs you** with a prompt:

```
? implement-102 wants to use Bash
Bash: npm publish
┌──────────────────────────┐
│ npm publish              │
└──────────────────────────┘
Y/Enter allow once   A allow for the rest of this task   N deny   R deny with reason
```

`A` appears only when the CLI offered a rule scoped to this request; the orchestrator will not turn one approval into a blanket allow for the whole tool, so on a prompt without a suggestion you get `Y`/`N`/`R` only. Whatever a rule covers, it is session-scoped and nothing is written to a settings file.

Questions list their options (`1-9` or `↑↓` + `Enter`, `T` to type an answer). The worker continues the moment you answer; nothing is restarted. If the dashboard is minimised it reopens itself, the terminal bell rings, and `hooks.onInputRequired` runs so you can be notified anywhere. `cao status` from another terminal shows the task as `Needs you` with what it is waiting for.

What the box shows is what you are deciding about: the command and description are stripped of escape sequences and carriage returns first, so a worker cannot make a dangerous command display as a harmless one.

Without a dashboard (`--no-tui`, CI) or after `execution.interactionTimeout` (default 30 minutes, `never` to disable it) the prompt is denied and the worker is told to finish with `status: needs_input`. The denial names what was refused, so the paused task tells you which command or question is waiting rather than just "denied".

A worker that needs a human always ends in one of two states — `waiting` while the request can still be answered, or `needs_input` once the attempt is over — on either agent, attended or not. It never fails or crashes because nobody was there. Codex adds one caveat: on the default `exec` transport the Codex CLI refuses approvals and questions itself, so an `exec` task cannot be asked anything. `cao validate` says which tasks those are, and if one does need a decision it pauses with `needs_input` quoting what Codex wanted. Use `codex.transport: appServer` for a Codex task that should be able to ask.

### Let a worker ask a question after it stopped

A worker that returns `status: needs_input` pauses the run instead of guessing. The run's exit code is `3`,
and the block it prints - like `cao status`, `cao task <id>` and `report.md` - names every task that is
waiting, quotes what it asked, and gives the command that answers it:

```
Workflow paused.
  Input required for "investigate":
    | Which endpoint should the client call, v1 or v2?
    cao resume 2026-09-10-001 --task investigate --input "<your answer>"
```

```bash
cao resume <run-id> --task investigate --input "Use the v2 endpoint."
```

Your answer goes back to the worker that asked, next to its own question. Where the previous attempt left a
session behind (the usual case on both agents), that session is **continued** with the answer as its next
message: the work it already did is not repeated. Where it did not, the task starts again and the fresh
prompt carries the question and the answer together, so it still knows what it is answering. `cao task <id>`
says which happened.

One answer per invocation: `--input` names a single `--task`, because the answer belongs to the question one
worker asked. Other tasks waiting for you keep waiting - resume again for each. Naming a task that is not
waiting for an answer is an error that says what state it is actually in, rather than quietly re-running it.

### Run only part of a workflow

```bash
cao run workflow.yaml --task implement-102        # just this task
cao run workflow.yaml --from implement-102        # this task and everything downstream
```

---

## Handling failure

### Retry with knowledge of the previous attempt

```yaml
- id: flaky
  retries: 2
  retry:
    includePreviousFailure: true    # inject "# Previous Attempt" into the retry prompt
    resetWorkspace: true            # git reset --hard the worktree first
    delay: 30s
```

### Decide what a failure costs

```yaml
- id: optional-lint
  onFailure: continue          # stop (default) | continue | skip_dependents
```

`stop` cancels remaining work, `continue` lets dependents run with the failure visible in their context, `skip_dependents` blocks only that subtree.

### Survive transient API errors for free

When an agent reports a retryable 408/409/429/5xx, overload, or connection/stream failure, `cao` waits with
exponential backoff (never shorter than the provider's retry delay) and relaunches with the same session when
that provider says continuation is safe. These recoveries do not consume `retry.attempts`.

```yaml
retry:
  transientAttempts: 3      # consecutive free recoveries
  transientDelay: 30s       # doubles each time
  transientMaxDelay: 5m
```

Auth, billing, context-length and budget errors are never treated as transient.

### Resume after a crash or Ctrl+C

State is persisted after every transition, so a run is always recoverable.

```bash
cao list
cao resume <run-id>
```

Ctrl+C stops scheduling, kills worker process trees, persists `interrupted` and exits `130`.

`cao stop [run]` does the same from another terminal — the terminal that owns the run does not have to be the
one you are sitting at. The request is a `stop.json` in the run directory that the running orchestrator picks
up within a second (a file rather than a signal, so it behaves the same on Windows); stop a second time and
the workers are killed immediately, exactly like pressing Ctrl+C twice. Resume it afterwards like any other
interrupted run.

Underneath, that stop is now one of a general set of **control requests** the run accepts from any other
process. The owner polls `requests/` in its run directory on the same 500 ms tick, applies each request
inside its own scheduler loop — so a request can never land halfway through a task finishing — and writes
the answer to `requests/acks/<id>.json` before it deletes the request that asked. Every request gets an
answer: one that arrives after the run has ended is told so, and one that lands in the half second after
the last poll is answered by the orchestrator on its way out rather than left in the directory. `stop.json` is translated
into one of these on arrival, which is why `cao stop` keeps working unchanged and a second one is still the
kill. A request that cannot be read, or that was written by a newer `cao` than this one, is moved to
`requests/rejected/` with a `.reason.txt` beside it rather than being guessed at or thrown away. Permission
decisions — approving a gate, answering a worker's question — are deliberately **not** taken from a file:
they are refused with a reason, and stay something you do in the terminal that owns the run.

`cao task stop <task>` and `cao task restart <task>` are the same mechanism aimed at one task rather than the
whole run: the first cancels the attempt a task is running and ends it as `cancelled`, the second sends a
task that finished without succeeding back to `pending`. Both go to whichever process owns the run — a call
into the run controller when that is this process, a request file when it is another one — and both print
what came back, exiting `2` on a refusal with the owner's own sentence (`Task "review" is still running.
Cancel it first, then restart it.`). `--wait <seconds>` (default 30) is how long to wait for that answer; an
elapsed wait is not a refusal, and says so, because the request is still in `requests/` and is applied when
the owner next reads it. With nobody executing the run there is nothing to ask, and both say so and name
`cao resume`.

`cao task edit <task>` takes the same three routes and adds a fourth. It changes an unfinished task's
prompt, agent, model, effort, timeout, retries or budget (`claude.maxBudgetUsd`, Claude only; a Codex task
is told "Codex has no budget flag") in the run, never in the workflow file. What it edits is the *resolved*
task: `ResolvedTask.prompt`, with defaults, templates and `foreach` already applied, and the context section
a task's `context.from` produces is still prepended at launch — the editor shows it read-only underneath.
**The edited task is validated before anything is stopped**, with the same validator `cao validate` prints,
so a mistyped model is a refusal that costs a running attempt nothing; its warnings are printed and the edit
goes through. A `pending`, `ready`, `failed`, `blocked`, `cancelled` or `needs_input` task is edited where it
stands and runs with the new settings the next time it starts; a running or waiting one needs `--restart`
(the workspace asks), which stops the worker, applies the edit and starts the task again from a **fresh
session** — the previous attempt keeps its `prompt.md`, transcript, usage, diff and session id, and the
worktree and branch are reused. With `retry.resetWorkspace` on, the ack carries a note that uncommitted work
in the worktree will be reset. A succeeded or skipped task, an approval gate, a task merging back and a task
whose dependent has already run are refused, the last of them naming `cao run <workflow> --from <task>`.
Each edit appends a revision to `workflow.json` and a `task.edited` line to the run's `events.jsonl` naming
the fields and never their values; `cao task <id>` prints the history under **Attempts**, and each attempt
records the revision it ran. The fourth route is **no owner**: with nothing executing the run, the edit is
written straight into it and the resume that applies it is named, and `--restart` is refused there because a
resume is what starts the task.

`cao task prompt <task>` says something to a task. Which of three things that means is decided from the
task's state and from whether its worker has a live channel, and the command prints the one it chose:

- **steer** — a running Claude worker in `ask` mode, or a Codex app-server turn. The message goes into the
  session that is running now and the worker takes it up at the end of its current turn. Its state is shown
  as it moves: `queued`, then `accepted` once the CLI acknowledges it, or the server's own refusal.
- **stop and continue** — a running worker with no channel: headless Claude, or `codex exec`. One command
  and one answer: the attempt is stopped and the task starts again carrying your message.
- **follow-up** — a task that has stopped (`failed`, `blocked`, `cancelled` or `needs_input`). A new attempt
  is started, continuing the session the task last reported where `retry.resumeSession` allows and the agent
  gave one, and otherwise with your message in the fresh prompt under `# User Input`. This is the path
  `cao resume --task <id> --input "<answer>"` has always taken, and that command still does exactly what it
  documents.

A task that has not started is refused with a pointer to `cao task edit`, one that is waiting on a
permission prompt or a question is told to answer that first (a prompt and an answer are not the same
thing), and a succeeded or skipped task is immutable. `--steer`, `--follow-up` and `--stop-and-continue`
name a mode explicitly and are refused where the task's state does not offer it, rather than quietly doing
the other thing.

**The session is checked before anything is stopped.** If the transcript a follow-up would continue is no
longer on disk, the command refuses and offers `--fresh-session` instead of resuming into a worker that has
silently forgotten everything. `--fresh-session` starts the task from the top with your message in its
prompt.

Every message is recorded: a `PromptDelivery` on the attempt (steer) or on the task (follow-up) with its
mode, transport, state and reason, and a `task.prompted` line in the run's `events.jsonl` carrying all of
that and **never the text**. `cao task <id>` and the workspace's Session panel show the list.

The routes are the same three as `cao task stop`, plus the fourth: with nobody executing the run, a
follow-up resumes it to carry the message — the workspace when the terminal is interactive, plain output
otherwise — because a resume is the only thing that can start an attempt.

In the workspace the same thing is the **composer** at the bottom of the Session panel. `Enter` opens it and
`Enter` sends; its header says which of the three modes the message will use and, for a follow-up, which
session it will resume. `Ctrl+J` (or a trailing `\` then `Enter`) is a newline, `Ctrl+O` opens the draft in
`$VISUAL`/`$EDITOR`, `Ctrl+Z` undoes the last edit, and `Esc` closes it keeping the draft. A paste arrives
whole; one over 20 lines is shown as `[pasted N lines]` with every byte kept. Inside the composer every
printable key is text, so `q` types a `q`.

`cao emit status` prints what a run started by this `cao` will accept, on its `Controls:` row.

`cao resume` takes the same overrides as `cao run`: `--max-concurrency`, `--permission-mode` and
`--claude-command`, so a run interrupted because it was too parallel or too restricted can be continued with
different settings instead of started again.

Only one run at a time per repository: `cao run` refuses to start while another orchestrator process holds a
run there (they would share the working tree and the `orchestrator/<task>` branch names), and names the run,
its pid, and the commands to watch or stop it.

---

## Isolation and git

### Keep parallel agents out of each other's way

Concurrent tasks get a git worktree on an `orchestrator/<task-id>` branch, created from the run's base commit, merged back with `--no-ff` on success.

```yaml
execution:
  workspaceStrategy:
    sequential: shared
    parallel: worktree
  worktree:
    base: runStart              # or headAtStart to build on earlier merged work
    mergeBack: true
    mergeConflictStrategy: agent   # agent | claude | codex | fail
    cleanup: onSuccess
    copyIgnored: [.env]         # gitignored files each worktree needs
```

A merge conflict starts a fresh agent session dedicated to resolving it. If that fails the task fails and the branch is kept for you.

### Work in a subdirectory

```yaml
- id: api-work
  workingDirectory: ./apps/api     # relative to the repo root, must stay inside it
```

### Opt out of git entirely

```yaml
git:
  enabled: false      # no capture, no worktrees, everything shared
```

`cao` never pushes, opens PRs, or touches remotes.

---

## Choosing the agent

Per task, pick the CLI, the model and the reasoning effort:

```yaml
agent: claude
model: opus
effort: high

tasks:
  - id: implement
    effort: xhigh
  - id: cross-review
    agent: codex           # a different agent reviews the work
    model: gpt-5.6-terra
```

See [models.md](models.md) for the model catalog, effort levels and resolution order.

### Constrain what an agent may do

```yaml
claude:
  permissionMode: dontAsk           # auto | acceptEdits | dontAsk | bypassPermissions | plan | manual
  allowedTools: ["Bash(git *)", "Edit"]
  disallowedTools: ["WebFetch"]
  maxBudgetUsd: 5
  addDirs: ["../shared-lib"]
  appendSystemPrompt: "Follow the conventions in CONTRIBUTING.md."
```

With a dashboard attached, anything needing a human decision is shown to you and the worker waits (see *Answer a worker while it runs*). Headless, workers run with `--permission-prompts none` and every prompt is denied rather than hanging forever.

`permissionMode` is passed to the CLI unchanged and defaults to `auto`, which is Claude Code's classifier: it allows what it judges safe and asks for the rest, so `auto` does not mean "never ask". It also exists only for Sonnet 5, Opus 4.7 and later, and Fable: a Haiku task asked for `auto` is silently run in the ordinary prompting mode and asks before every file write and command. Use `bypassPermissions` in an isolated environment, `dontAsk` with `allowedTools`, or at least `acceptEdits` for such tasks; the full table is in [configuration.md](configuration.md#claude-workflow-template-or-task-level).

Both agents can explicitly ignore ambient customization:

```yaml
claude:
  configMode: isolated       # --safe-mode; inherit is the default
codex:
  transport: exec            # stable default; appServer is experimental
  approvals: auto            # automatic review headlessly, dashboard review on appServer
  configMode: isolated       # exec only: --ignore-user-config --ignore-rules
```

**The Codex support level, plainly.**

| | Status |
|---|---|
| `transport: exec` (the default) | **Stable.** The unattended production path: one `codex exec` process per attempt, a schema-validated `final.json`, JSONL activity in the transcript, retries, resume and diff capture exactly as for Claude. It never waits on a terminal — read-only denies approvals, the default workspace-write mode uses Codex automatic review. |
| `transport: appServer` | **Experimental**, and Codex labels the protocol that way too. Opt in per task. It adds typed turn failures, token usage, interruption, and command/file-change approvals routed to the same dashboard Claude uses. |
| `experimentalUserInput: true` | **Experimental**, `appServer` only, off by default. Without it a free-form Codex question is declined through the protocol instead of being asked. |

Not supported, deliberately:

- **A human during a `codex exec` task.** The Codex CLI answers approvals and questions itself, with a
  rejection; no configuration changes that. Use `appServer` for a task that must be able to ask.
- **`configMode: isolated` on `appServer`.** That protocol has no isolation switch which preserves saved
  authentication, so the combination is a validation error rather than isolation CAO cannot provide.
- **`codex.model`.** For `agent: codex` the top-level or task-level `model:` is the only way to set a model.
- **Falling back between transports.** `exec` never becomes `appServer` under load or on error, or the
  reverse: whichever you asked for is what runs.

See [configuration.md](configuration.md#codex-workflow-template-or-task-level) for the keys and
[agent-cli-integration.md](agent-cli-integration.md#codex) for the command lines.

---

## Running your own commands

Hooks are shell commands from the workflow — never anything a worker printed.

```yaml
hooks:
  beforeWorkflow: npm install
  beforeTask: ["git status --short"]
  afterTask: ["npm run lint"]
  onTaskFailure: ["echo failed $CAO_TASK_ID"]
  afterWorkflow: ["npm test"]
```

Each hook sees `CAO_RUN_ID`, `CAO_TASK_ID`, `CAO_TASK_STATE`, `CAO_TASK_TYPE`, `CAO_WORKDIR`, `CAO_BRANCH` and `CAO_HOOK`. `beforeWorkflow`/`beforeTask` failures abort the run; the rest are warnings.

---

## Watching a run

```bash
cao status                      # progress, context size, cost and files per task
cao peek implement-102          # what is that worker doing right now
cao logs --follow               # transcript viewer: ←/→ switch tasks, [ ] switch attempts, finished tasks too
cao logs implement-102          # the transcript as a plain log: timed calls, nested subagents, no keys
cao logs implement-102 --raw    # raw stream-json from the CLI
cao logs implement-102 --thinking  # include the thinking blocks, hidden by default
cao task <run-id> implement-102 # status, PID, cwd, branch, deps, usage, changes, attempts, interactions
cao task implement-1            # any unique prefix names the task, as it does for a run id
cao logs implement-102 --json   # the normalized entries, one JSON object per line, for jq
cao diff implement-102          # what that task changed
cao report                      # the whole run as a document you can paste into a PR
```

A task reference matches like a run id does: exactly, or by a prefix that names one task. An ambiguous prefix
is refused with the candidates listed; an unknown one lists the run's tasks. `cao peek` and `cao task` with no
reference at all say which task ids they were expecting rather than printing a parser error.

`--json` on `cao logs` and `cao peek` writes JSON Lines: one normalized transcript entry per line, no header,
so `cao logs implement-102 --json | jq 'select(.kind == "command")'` works and `--follow` keeps streaming
them. Those entries only exist in `events.jsonl`, so `--json` beside `--raw`, `--stderr` or `--prompt` is
refused rather than silently overriding them. The completion object a worker ends on is one of those
entries: it is recorded as `kind: "result"`, never as agent text, so no surface prints
`{"status":"success",…}` where the agent's own words belong. One the worker emitted mid-run and then kept
working past carries `intermediate: true` and reads `intermediate result: …`; the one an attempt ends on is
the outcome and is written once, without the flag, so a successful attempt does not print its summary twice.
Either way `raw` holds the object exactly as the worker wrote it ([agent-cli-integration.md](agent-cli-integration.md#the-completion-object-is-protocol-not-prose)). `cao peek --json` puts one `{"kind":"peek", …}` status object first, with the state, agent, pid,
attempt, usage, working directory and branch the text output shows.

`cao status` prints where the run lives (`Directory:`) and who owns it (`Orchestrator: pid 1234 running`), so
the answers to "where are the logs" and "is anything still running" are on the screen rather than in
`--json`. That question is answered from `lock.json` when it is there and from `live.json` when it is not —
both carry the orchestrator's pid and its heartbeat — so a run that has lost its lock file is still reported
as running, and `cao run`, `cao stop` and the `--follow` views still treat it as owned. `cao status` adds
`(lock.json is missing)` when it had to fall back; the running orchestrator restores the file on its next
heartbeat. Times are the same everywhere: local date and time with the age beside them
(`2026-09-04 14:03  (7m ago)`), in `cao status`, `cao task` and the `Age` column of `cao list`, which is
sorted newest first.

Tables clamp to the terminal: columns are padded by printable width and the widest column is narrowed until
the row fits, so a long detail line is cut with `…` rather than wrapped into fragments by the terminal. When
there is no terminal to ask — output piped into a file, a CI log, a harness — `$COLUMNS` is used, and 120
columns if that is unset too. A column no row filled is dropped rather than left as a heading over blank
space, which is why `cao status` shows `Context` only while something is running.

Every glyph the text surfaces draw has an ASCII form: `CAO_ASCII=1` prints `-` for the rules, `v`/`x`/`o` for
the status marks and `...` for a truncation, so a Windows console on a legacy code page or a `TERM=dumb` log
viewer shows a table instead of mojibake. That is also the default guess on a Windows terminal that does not
identify itself as UTF-8 capable; `CAO_UNICODE=1` forces the glyphs back on. Every ASCII status mark is one
column wide, so the columns line up either way.

The interactive workspace is live by default (`--no-tui` for line output), and it is one screen rather than a stack of them. A **header** carries the workflow name, the run id, the repository, a progress bar, the run state, elapsed, concurrency and an owner badge. A **sidebar** down the left is the task list, with each task's state glyph, its agent and model, and a badge when it needs you (`?`) or went wrong (`!`). The **main panel** has six tabs — Overview, Session, Logs, Changes, Report, Diagnostics — and a **footer** carries the keys of whatever has focus, provider quota chips and how old the picture on screen is.

**Overview** is what the dashboard used to be, plus what it used to make you press Enter for. After a failure it leads with the failed task, the kind of failure (`crashed`, `timed out`, `transient API error`), the latest error line, how many attempts it took, and the keys that act on it. Then the task table: running rows spin, each row shows the agent and the model it actually reported at session start (`claude|opus-5`), the worker's current context size against that model's window (`ctx 42k/1.0M`), cost, changed-file count and what the worker is doing. Below it is everything about the selected task — status, attempt, agent, session, working directory, branch, usage, changed files, the attempt and interaction history, the result notes and the tail of the transcript — cut from the middle with `… cao task <id> for the rest` when the terminal is too short for all of it. **Changes** is the review view of what each task changed; `Esc` goes back to the task list there and `Q` means what it means in every other panel. **Report** renders the run's own `report.md`, which exists once the run has ended, exactly as `cao report` prints it. **Session** shows the selected task's identity (agent, model as reported, session or thread id, attempt,
revision), its transcript in the same renderer `cao logs` uses, anything it is waiting on, the list of
messages already sent to it with each one's state, and a composer at the bottom for [prompting the
task](#prompting-a-task). `E` on any unfinished task opens the [task editor](#editing-an-unfinished-task)
as a form over the panel — one row per editable field, the validator's message inline under the row that
caused it, the automatic context section read-only beneath the prompt, `Ctrl+O` to write the prompt in
`$VISUAL`/`$EDITOR`, and a "restart now?" question before Save stops a running worker. **Logs** and
**Diagnostics** are not filled in yet; each says which release fills it and what answers the same question
today (`F` for the transcript, `cao logs`).

`Tab` and `Shift+Tab` move between the task list, the tabs and the panel; the arrows, `PgUp`/`PgDn` and `Home`/`End` move inside whichever has focus; `Enter` opens and `Esc` backs out. `Ctrl+P` opens a command palette over every action and every task id, matched loosely, so `ovrvw` finds Overview and a task is two keystrokes away in a run of two hundred. `/` narrows the focused list. `?` lists the keys of the focused panel, the chords that work everywhere and the transcript viewer's own — and it is the same table the footer draws from, so the two cannot disagree. `F` opens the transcript viewer that `cao logs --follow` shares, `U` the usage table, `C` the Changes tab, and `R` restarts the selected task — any task that finished without succeeding, so failed, blocked, cancelled and skipped alike, goes back to `pending` and is picked up again; the notice is the run controller's own answer, so a task that is still running is told to be cancelled first. `Q` asks what you meant while the run is still going: **stay**, **stop and quit** (a graceful stop, then leave with the run's exit code), or **continue in plain output** — the old minimise, where the orchestrator keeps going, line output takes over, and `D` (or anything that needs you) brings the workspace back. On a run that has ended `Q` leaves at once. `Ctrl+C` stops the run and leaves the workspace on screen to read the result; a second one inside the twenty-second hard deadline kills the workers and exits 130. Those two, `Ctrl+P`, and `Ctrl+J` for a newline in the answer field are the chords the workspace reads, and the transcript viewer adds `Ctrl+A` to scroll up a page; every other `Ctrl`+key is left to the terminal, so `Ctrl+L` or `Ctrl+R` out of habit does not change what is on screen.

### The run ends and the workspace stays

Success, failure, a pause and a graceful interruption all leave the workspace on screen. The Overview leads with the outcome — the run's state, how many tasks are done, how long it took and the exit code quitting will return — then the task the outcome is about — the failed one, or the one waiting for a person and what it asked — its failure category, the latest error line and the attempt count. The selection moves to that task when the run ends, so the lead block, the table, the detail below it and the actions are all about the same thing. Everything else stays reachable: the logs, the earlier attempts, the diffs and `report.md` are read from the run directory exactly as `cao logs`, `cao diff` and `cao report` read them.

Under that are the actions, each of them a `cao resume` run from inside the workspace: `S` resume the run (failed, blocked and cancelled tasks go back to `pending`), `R` re-run the selected task, `>` resume from it and everything downstream, `A` answer a task that ended asking a question and resume with the answer, `A`/`X` approve or reject a paused approval gate. Each one validates first — a mistyped id, a missing agent CLI or a repository that has moved is a notice in the workspace, not a lost session — then takes `lock.json` again and builds a new scheduler into the same screen, keeping the tab, the cursor and anything half-typed. The answer field is deliberately plain for now: type, `Ctrl+J` for a newline, `Enter` to send, `Esc` to cancel.

Between executions the workspace holds **no lock**: the run is unowned, exactly as it is between two `cao resume` invocations. If another terminal takes it in the meantime the workspace says which pid has it and the actions are disabled until it lets go.

Quitting returns the exit code of the **latest** execution, so a run that failed and then succeeded from here exits 0. A session that only looked at a run and never executed anything exits 0.

`cao ui <run>` opens the same workspace on a run that ended earlier, reading it from the run directory; `cao ui` with no run lists the recent runs of the repository with their state, age and cost and offers the workflow files beside them. Without a terminal — piped, in CI, with `--no-tui` — it prints that list and exits 0, and `--json` prints it as JSON.

### Watching a run another terminal owns

Open `cao ui <run>` on a run somebody else is executing — or lose the run to another terminal while the workspace is idle — and the window becomes an **observer**. It never takes the lock. `workflow.json` and `live.json` are re-read every 500 ms and folded together the way `cao status` reads the pair, so the task states, the activity, the usage and the cost keep moving; transcripts, earlier attempts and diffs come from the run directory through the same tailer `cao logs --follow` uses, so this window and the owner's show the same thing.

The header badge says which it is: `owner`, `observing · owner pid N`, or `abandoned · resume?` once the process that had the run stops existing — at which point nothing is executing the run, the window is an owner candidate again, and the resume actions come back. The same four states answer `cao status`, and `cao status --json` reports them as `ownership`.

Three keys cross the process boundary, each of them a request file the owner picks up on its own tick: `S` stops the run, `K` kills it, `R` re-runs the selected task. What comes back is shown as it comes back — `stop sent → applied`, `restart <id> sent → rejected: <reason>`, or "no answer yet" when the wait elapses, which means nobody has read the request rather than that it was refused — and every control sent from the window is kept in the **Diagnostics** tab, so the answer outlives the four-second notice. `Ctrl+C` sends the stop and a second one sends the kill, exactly as a second `cao stop` always has. Only the controls the run advertises in its registry entry are offered; a run started without `--emit` has no entry, and is assumed to accept what an owner of this `cao` accepts.

Approvals and questions are shown read-only with **"answer in the owning terminal (pid N)"**, and no key answers them. That is the trust boundary, not a gap: a permission decision must not be grantable by anyone who can write a file in the repository, so `approve`, `reject` and `answer` stay in the terminal that owns the run until presence gating ships.

The workspace takes the **alternate screen**, so the run's frames do not end up in the scrollback and the shell comes back as it was on quit, with the run summary printed into it. `--no-alt-screen`, `CAO_ALT_SCREEN=0` or `"altScreen": false` in `~/.cao/config.json` keeps it in the normal buffer; the file is read only if it is already there, so a `cao` with emit off still never touches `~/.cao`. Every frame is sized to the terminal on every render and each panel slices itself to the rows it was given, so nothing is ever drawn past the bottom of the screen: at 80x24 the sidebar collapses to a one-line task strip and the footer drops its freshness column first, and a two-hundred-task run scrolls inside its window rather than being drawn in full. Resizing re-lays the frame out on the resize itself rather than whenever the workspace next happens to redraw.

`--theme mono` (or `CAO_THEME=mono`, or `NO_COLOR`) paints nothing at all, which is the check that every state is readable as a glyph plus a word rather than as a colour. `CAO_ASCII=1` draws the whole workspace in ASCII: the state marks, the spinner, the progress bars, the cursor and the tab separators, and also the parts that used to be spelled out in Unicode wherever they were written — the arrows a key is named after (`^v` for `↑↓`, `<>` for `←→`), the header's separator, the `->` notes under an attempt, the `+/-` file counter, and the bullets and rules of the rendered report. `CAO_REDUCED_MOTION=1`, a screen reader, or `TERM=dumb` stop the spinner and mark a running task with its own glyph instead.

The footer is cut to the terminal by dropping whole cells rather than the end of the line, least important first: how old the picture is, then the quota chips, then the focused panel's keys from the right, then `Ctrl+P`. `? help` and the key that leaves are the last two standing, so however narrow the terminal the footer still says how to get out and where the rest of the keys are.

The last cell of a row is what the worker is doing: its last *action* — the tool, the command or the line of prose it is on, never the tool output that came back and would otherwise mask it. Nothing for 30 seconds and the cell gains `… 2m idle`, which is how you tell a thinking worker from a hung tool or a stalled API call. A task waiting out a retry says which one it is spending: `api retry 2/5 in 12s` while a transient API error backs off (`retry.transientAttempts`), `retry 1/2 in 30s` for an ordinary one (`retry.attempts`). `?` shows every key, including the viewer's.

Inside the viewer (both from `F` and from `cao logs --follow`): `←`/`→` or `Tab` switch tasks, `1`-`9` jump straight to one, `P` opens a task picker, `[`/`]` switch attempts, `↑↓`/`PgUp`/`PgDn` scroll, `g` jumps to the oldest line and `Shift+G` returns to the end and resumes auto-following, `t` expands tool output and subagent entries (and keeps you on the line you were reading rather than jumping, as `T` and `k` do too), `Q`/`Esc` leaves. Entries a subagent produced are nested under the `Agent:` call that spawned them and collapsed to a `… 3 subagent entries` line until `t` expands them, so delegating a task no longer floods the parent's transcript. Scrolling up pauses auto-follow and shows how many lines are below you, and stays on the lines you are reading while the worker keeps writing below them; the worker keeps running either way. An earlier attempt is read from that attempt's `events.jsonl`, so both surfaces show the same thing; picking the newest attempt again returns the dashboard to the live worker. Every entry is timestamped: `HH:MM:SS`, or `MM:SS` below 100 columns, where the column used to disappear altogether. Below 100 columns the meta line and the key list shorten too, rather than being truncated at the point where they say where you are and how to leave.

`cao logs` without `--follow` prints the same transcript as a plain log rather than a screenful of keys, and prints it *as a transcript*: the tail is read whole, so each call is paired with its result and carries its time, and a subagent's entries are indented under the `Agent:` call that spawned them (a subagent that delegates again nests one level deeper). With `--follow` on a non-interactive stdout the lines that arrive afterwards are paired against the calls the tail established, and the time lands on the result line, which by then is the only place left for it. `cao peek` prints the same way.

### Finding things in a long transcript

Three keys turn the transcript from a stream into a document you can read:

- `/` searches everything on screen, `Enter` jumps to the first match, and `n`/`N` step forward and backward through the rest. The mode line counts them (`/auth 3/12`) and says `no matches` rather than doing nothing. It also counts what the collapsed lines are hiding — the tail of a long tool result, the entries of a subagent — as `/auth 3/12 +5 in collapsed output (t to expand)`, so a search never reports nothing about text that is really there.
- `k` cycles a kind filter: everything, text only, tools and commands, then errors and questions (an errored tool result counts as an error). The current filter is named on the mode line, and `k` again returns to everything.
- `T` shows the agent's **thinking**, which is hidden everywhere by default. Thinking blocks are parsed into their own entry kind and written to the attempt's `events.jsonl` like everything else, but they never reach the activity column, `live.json` or the run-level `events.jsonl`, and no surface shows them unless asked: `T` here, `--thinking` for `cao logs`.

Only `execution.outputBufferLines` (500 by default) entries of a task are kept in memory, so scrolling above the oldest one pages older entries in from the attempt's `events.jsonl` a screenful at a time — the whole transcript is reachable from the dashboard, and the mode line says `start of the transcript` when there is nothing older left.

### Attempt and interaction history

`cao task` and the dashboard's detail view (`Enter` on a row) render what every attempt of a task did and every time it stopped to ask a human. Nothing new is recorded for this: it is what the attempt already carries.

The **Attempts** block is one line per attempt — number, kind (`task` or `merge resolution`), what triggered it (`initial`, `retry`, `resume`, `user input`), start and end clock times, how long it ran, its outcome, the exit code or the signal that ended it, and its cost:

```
  #1  task  initial  10:11:12 → 10:13:44  02m 32s  transient API error  exit 1  $0.10
      ↳ API Error: 500 Internal server error
  #2  task  retry  10:14:04 → 10:19:00  04m 56s  success  exit 0  $1.20
      ↳ retried after attempt 1 transient API error, continuing session 8f2a1c34
```

The `↳` under a retry says why that attempt exists; under a failed attempt it is the first line of its error.

The **Interactions** block is one line per permission prompt or question — which attempt asked, the kind, the title, when it was asked, how long the worker stood still, and how it was answered: `allowed (in the dashboard)`, `denied (timed out)`, `denied (no dashboard attached)` in a headless run, or `still waiting for you`. It ends with the total waited, which is usually the answer to "why did this take three hours".

The elapsed cell of a table row is the total across attempts, with the current attempt in parentheses once there is more than one (`07m 58s (04m 30s)`). The gaps between attempts — retry backoff, or waiting for a free concurrency slot — belong to the run rather than to the task, so they are not counted. The detail view also shows the result's decisions, warnings and follow-ups, and the usage view (`U`) shows cache reads and writes per task, the duration the agent reported for itself, and the time it spent inside tool calls.

`cao task --json` carries the same records: `attempts`, each with the `durationMs` it ran and the `reason` it was started, and `interactions`, each with the `waitedMs` it cost.

---

## Reviewing what a task changed

`cao diff` prints the patch each attempt captured when it finished. It reads `diff.patch` and `diff.json`
from the run directory and never touches git or the working tree, so the answer is the same an hour later,
after ten more tasks have run on top of it.

```bash
cao diff implement-102               # the task's patch, coloured on a TTY
cao diff implement-102 --stat        # A/M/D/R per file with +/- counts, straight from diff.json
cao diff implement-102 --name-only   # changed paths only
cao diff implement-102 --file src/x.ts
cao diff implement-102 --attempt 2   # a retry, or the merge-resolution attempt
cao diff                             # every task of the latest run, in execution order
cao diff <run-id> implement-102      # a run other than the latest
cao diff --json                      # the diff.json records
```

Without a task, each task's patch comes under a `# <task>  attempt N  3 files changed, +12 -4` header. The
headers start with `#`, which `git apply` skips along with anything else that is not patch text, so the whole
run still pipes into git as one patch. Colour (`+` green, `-` red, `@@` cyan) is on for a terminal and off
for a pipe; `--color always|never` and `NO_COLOR` override that, and without colour the output is the
captured patch byte for byte — `git apply`, `delta` and an editor all take it unchanged.

Colour is also what decides whether an escape sequence a worker wrote into a source file (or into a file
name) survives. A coloured rendering is the one a human reads and is already not the captured patch, so the
patch text, the `--stat` paths and the `--name-only` paths are cleaned of escape sequences and control
characters first — `git diff` on a terminal gets the same protection from its pager. Without colour nothing
is touched, because a patch altered to be safe to look at is no longer a patch: `cao diff | git apply` and
`cao diff --name-only | xargs` get exactly what git wrote. `cao task` draws rather than pipes, so its file
lists and its result block are always cleaned, as is the dashboard's review view.

By default `cao diff` shows the newest ordinary attempt. A merge-resolution attempt is only shown when asked
for by number: its patch spans the whole merge, every other task's work included, which is never the answer
to "what did this task change".

`cao task` shows the same per-file stat table once an attempt has finished; while the task is still running
it shows the live list the tool stream produces instead.

### In the dashboard

`C` opens the same material as a two-level review, while the run is still going — before the next task starts
on top of the change.

The **list** groups files by task: the status letter, the path, and `+N -M` from the attempt's `diff.json`.
A task that is still running shows the files its tool stream has touched so far (`×3 edits`) and no line
counts, because nobody has diffed anything yet. Every task that has started keeps its line even with nothing
under it — `changed no files`, or `no diff captured` when `git.captureDiff` is off — so a task is never
missing from the list for two different reasons. The list scrolls: `↑↓`, `PgUp`/`PgDn`, `g`/`G` for the first
and last file.

`Enter` opens the selected file's **hunks**, read from that attempt's `diff.patch` and coloured like
`cao diff`. It scrolls with the transcript viewer's keys (`↑↓`, `PgUp`/`PgDn`, `g` to the top, `G` to the
bottom), `N`/`P` jump between hunks, `←`/`→` move to the previous or next file across every task, and `Esc`
returns to the list. The `diff --git`, `index` and `---`/`+++` lines are left out: the title bar above the
pane already names the file, and those four rows are better spent on the diff. Escape sequences a worker
wrote into a file are stripped and tabs are expanded before anything is drawn, and long lines are clipped at
the right edge rather than wrapped, so the `+`/`-` column stays where the eye expects it.

Both levels fit themselves to the terminal: a path too long for the row is shortened from the left
(`…/tree/component.tsx`), so the counts beside it survive, and the footer drops its least important hints
before it would run off the edge.

`O` hands the file to `$VISUAL` or `$EDITOR`. The dashboard keeps this terminal for as long as the run lasts,
so the editor is started detached: point `$VISUAL` at a windowed editor (`code -g`, `subl`, `idea`). A
terminal editor (`vim`, `nano`, …) is named in a hint instead of being started where it could not draw.

The editor is chosen by the environment alone. Handing the before/after blobs to `git difftool --no-index`,
and configuring either opener from a `review:` block in the workflow, are out of scope for the beta: there is
no `review:` key in the schema, and `$VISUAL`/`$EDITOR` are what `O` looks at.

---

## Reporting a run

Every run writes `report.md` into its run directory when it ends — completed, failed, paused or interrupted
— and the end-of-run summary table prints the path to it. `cao report` renders the same document on demand:

```bash
cao report                           # the latest run, as Markdown on stdout
cao report <run-id>                  # a run other than the latest
cao report --json                    # the same structure for tooling
cao report --out pr-body.md          # write it to a file and print the path
```

The document is shaped to paste straight into a pull request. It opens with the facts a reviewer asks for
first — result, repository and base commit, duration, cost and tokens, the models the tasks actually ran on,
the total files changed, and the ids of any tasks the run never reached — then an overview table whose rows
link to the sections below, then one section per task in the order the run executed them:

- the task's summary, error, decisions, warnings and follow-ups, exactly as the worker reported them;
- the files it changed, largest first, with `+`/`-` counts;
- its commits, branch, base and head commits and merge sha;
- an attempts table — number, kind, trigger, start, duration, outcome, exit code or signal, cost — with the
  retry reasons and attempt errors listed under it, and a line saying how long the task stood still waiting
  for a human. A task that succeeded on its first attempt has no table: the head line already said so.

A task the run never reached is named in the header rather than given a section of its own, so a report of a
half-finished run is not mostly empty headings.

The file counts come from the best source the run directory holds, and the report says which one it used:
the attempt's captured `diff.json`, the per-file records folded into the result's git block, the recorded
`git diff --stat` (whose totals are exact but whose per-file split git scales into a graph — those files
read `±42` rather than `+40 -2`), and last the file list the agent claimed for itself, which has no counts
at all. The run-level total is the sum over tasks, so a line one task wrote and a later one rewrote counts
twice; the header says how many tasks it is summing.

Nothing is recomputed and nothing touches git: it is all read back out of the run directory, so a report
built a week later says exactly what `report.md` said on the day. Times are in UTC, because a report is
written to be read somewhere else.

Agent prose is dropped into the document as the worker wrote it, but made safe for the document around it:
an unclosed code fence is closed, and a Markdown heading is demoted two levels so it lands underneath the
task's own heading instead of inside the report's outline.

`--json` is the same structure as the Markdown, so a script can pick out `tasks[].changes` or
`tasks[].attempts` without parsing prose. Its keys are always in the same order, its dates are ISO 8601, and
an absent value is an absent key rather than a null.

---

## Reusing results across runs

After a task succeeds, `cao` marks it in the source workflow, preserving your comments and formatting:

```yaml
- id: implement-101
  state: completed
  completion:
    completedAt: 2026-09-03T12:34:56.000Z
    runId: 2026-09-03-001
```

A later `cao run` **skips tasks marked this way**. This is what makes a long workflow resumable across days — but it also means re-running a finished workflow appears to do nothing. The execution plan says so before it happens: `cao validate` and `cao run --dry-run` mark each such task `already done in run <id>, will not run`, and the `Agents:` line reads `none to launch (every task is already completed)`. To redo a completed task, select it explicitly (`--task` / `--from`, which clear the marker) or delete the `state: completed` block.

---

## Secrets

```yaml
environment:
  NODE_ENV: development
envFile: .env.orchestrator     # every value treated as a secret
```

Values from `envFile`, secret-looking `environment` keys and token-shaped strings are redacted from prompts, logs, results and events before anything is written to disk.

---

## Checking the installation

Most "it does not work" is the environment. `cao doctor` reads what the orchestrator reads when it starts
and says what it found, one line per check:

```
$ cao doctor
cao 0.1.0-beta.3
Repository: /home/me/projects/api
Run state:  /home/me/projects/api/.orchestrator/runs

✓ Node.js            v22.11.0 (requires >=22)
✓ git                2.47.0, worktrees supported
✓ claude             2.1.267 (Claude Code) [streamJson, structuredOutput, isolatedConfig]  (claude)
! codex              not found  (codex): spawn codex ENOENT
                     → install the Codex CLI and check `codex --version`, or point CAO_CODEX_COMMAND at the binary
- claude live start  not probed (pass --probe)
! run locks          1 stale lock(s); the orchestrator that held them is gone
                     · 2026-09-03-002  pid 41208  last heartbeat 2026-09-03T09:14:02.511Z
                     → resume the run, or delete /home/me/projects/api/.orchestrator/runs/2026-09-03-002/lock.json
! worktrees          1 left over from a finished run
                     · /home/me/projects/api/.orchestrator/worktrees/implement-102  (run 2026-09-03-002)
                     → cao clean 2026-09-03-002 --all
✓ branches           no orchestrator/* branches left over
✓ git ignore         .orchestrator/ is ignored (.git/info/exclude)

! All required checks passed, 3 warning(s).
```

What it checks, and how it grades what it finds:

| Check | Fails when | Warns when |
|---|---|---|
| `node` | the running Node is below `engines.node` | — |
| `git` | `git` is not on PATH | it is too old for `git worktree`, or this repository cannot use it |
| `claude`, `codex` | an installed CLI is logged out, below its minimum version, or lacks a required workflow capability; without a workflow, **neither** CLI was found | without a workflow, one CLI was not found while the other was usable |
| `run locks` | — | a `lock.json` names a process that is gone; `cao clean` refuses to touch such a run |
| `worktrees` | — | a worktree of a finished run is still on disk |
| `branches` | — | an `orchestrator/*` branch has no worktree holding it |
| `git ignore` | — | `.orchestrator/` is not ignored, so run state shows up in `git status` |
| `<agent> <mode>` (only with `--probe`) | a mode a workflow can select would not start: the CLI refused the argv, the API refused the output schema, or the transport is not there | — |

### `--probe` starts the modes for real

The agent lines above say whether the binary is there and new enough. `cao doctor --probe` adds the lines
that say whether the thing a run will actually do works: each mode a workflow can select is started,
briefly, and killed as soon as it has answered.

- **Codex `exec`** runs one trivial turn with a minimal OpenAI-strict output schema, in a temporary
  read-only directory. This is the shortest path through everything that has broken real runs: the flag
  combination, the schema the API validates, and authentication. It costs one very small model call.
- **Codex `app-server`** is taken through `initialize` and `thread/start` with the read-only envelope and
  then interrupted, which proves the transport without spending a turn.
- **Claude ask-mode and deny-mode** are started with the exact argv a run would send, and stopped the moment
  the session reports that it has started - before it calls the model, so they cost nothing but a process.

Nothing is written into your repository, nothing survives the command (every probe kills its own child and
`cao doctor` sweeps the rest), and an agent that is not installed, or not authenticated, is not probed at
all: it has already said so on its own line.

**Ordinary `cao doctor` starts nothing.** The probes are the one part of this command that costs money and
time, so they are opt-in: without `--probe` no agent is started, nothing is spent, and no check waits up to
a minute. The rows are still printed, as `- <agent> live start  not probed (pass --probe)`, so a report
never looks like the probes passed. `--no-probe`, which used to be how you asked for this, is still accepted
and still means no probes; it is deprecated and its help text says so.

Only the agent and environment checks can stop a run, so only those exit `1`; a warning is something to tidy up, and the exit
code stays `0`. A check that cannot be answered here — the run checks outside a repository that has never run
anything — is printed with a `-` and grades nothing. `--json` carries the same checks plus the raw facts
behind them (versions, lock files, worktree paths, branch names), which is what a bug report should have
attached to it.

Pass a workflow path (`cao doctor workflow.yaml --json`) to probe only its referenced providers and required
transports/configuration. Doctor also uses `workflow.yaml`, `workflow.yml`, or `cao.yaml` automatically when
one exists in the launch directory; with no workflow, it checks both installed CLIs. It never changes
anything: it will tell you to run `cao clean` but never runs it for you.

---

## Where the truth lives

```
.orchestrator/
  latest                        # id of the most recent run
  runs/<run-id>/
    workflow.json               # full run snapshot, rewritten atomically after every transition
                                #   (including run.controls.seen: the answered control commands, last 1000)
    events.jsonl                # append-only run log: state changes and summaries
    live.json                   # current progress, usage, file counts, pending interaction
    lock.json                   # owning pid + heartbeat
    stop.json                   # a pending `cao stop` request, consumed by the running orchestrator
    report.md                   # the run's own report, rewritten whenever the run ends
    requests/<ULID>-<kind>.json # control requests from another process: stop, kill, restart
      acks/<ULID>.json          #   the one answer to each, written before the request is deleted
      rejected/                 #   a request that could not be read, moved rather than deleted
    interactions/               # reserved: pending-interaction payloads for a desktop app to render
    tasks/<task-id>/
      result.json               # structured result + git info + cost/usage
      context.md                # exactly what was injected
      attempts/<n>/
        prompt.md               # exactly what was sent
        attempt.json            # outcome, timings, session id, usage
        diff.patch              # unified diff of this attempt's own changes
        diff.json               # per file: path, status A/M/D/R, +/- lines, binary flag
        stdout.log              # raw agent output
        stderr.log
        events.jsonl            # the attempt's transcript, ending with its outcome
```

Every prompt, every result and every cost figure for every attempt is on disk and inspectable.

The two diff files are the attempt's own work, isolated from whatever else the repository was doing. A
worktree task is diffed from its base commit to its branch head (after the checkpoint commit, so uncommitted
work counts); a shared-tree task from a git tree snapshot taken when the attempt started to one taken when it
ended, which is the only way to see what a task changed in a tree several tasks share. A merge-resolution
attempt gets a patch of its own, succeed or fail. Because both sides are real git objects, the diff sees
shell-driven edits, deletions and renames that the tool stream misses, and ignores temp files the agent
cleaned up again. `diff.patch` is a real patch — binary contents and full blob ids included — so `git apply`
replays the attempt on a checkout of its base. The same per-file records ride along in the result's
`git.files`, and `cao diff` prints all of it. See
[`git.captureDiff` and `git.maxDiffBytes`](configuration.md#git).

The two `events.jsonl` files serve different purposes. The **attempt** log is the verbatim transcript — every agent message, command, tool result and permission prompt exactly as the worker produced it, ending with a `result` or `error` entry recording how the attempt finished. A completion object the worker emitted is stored as a `result` entry too (with `intermediate: true` and the object itself in `raw`) rather than as agent text. The **run** log is the summary the orchestrator keeps: state transitions, and for an interaction only its id, kind, tool and title. Bulk and sensitive agent detail — worker output, transcripts, usage and raw tool input (whole file contents, complete shell commands) — deliberately stays in the per-attempt directory rather than the run log.

### Beyond the repository: `~/.cao/`

Everything above lives inside the repository, under `.orchestrator/`. When [announcing is turned
on](configuration.md#user-level-configuration-caoconfigjson), `cao` additionally keeps one small,
user-level directory outside any repository, so a desktop app can find your runs without already
knowing which checkouts to look in:

```
~/.cao/
  config.json           # your per-user opt-in and preferences (cao emit enable/disable)
  runs/<key>.json        # one pointer + heartbeat per announced run, on this machine
  presence/<pid>.json    # one file per surface (a desktop app) currently watching
```

Every field of a run's pointer file is itself read from the repository's own `.orchestrator/`
directory above — nothing here is a second copy of run state, and a `cao` with no desktop app
watching never touches this directory at all. See [docs/desktop.md](desktop.md) for the full
contract, what triggers the directory being refused, and `cao emit status` for diagnosing an empty
desktop window.
