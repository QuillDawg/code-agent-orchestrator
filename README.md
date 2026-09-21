<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/QuillDawg/code-agent-orchestrator/main/assets/logo-light.png">
  <img alt="Code Agent Orchestrator" src="https://raw.githubusercontent.com/QuillDawg/code-agent-orchestrator/main/assets/logo-dark.png" width="560">
</picture>

### Run YAML-defined engineering workflows as a DAG of isolated Claude Code and Codex sessions

[![npm version](https://img.shields.io/npm/v/code-agent-orchestrator/beta?label=npm&color=cb3837)](https://www.npmjs.com/package/code-agent-orchestrator)
[![CI](https://github.com/QuillDawg/code-agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/QuillDawg/code-agent-orchestrator/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-3c873a)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](#installation)

**Describe the work. `cao` runs it.**
One fresh agent per task · parallel tasks in their own git worktrees · structured results between them · everything persisted and resumable.

```bash
npm install -g code-agent-orchestrator@beta
```

</div>

---

> **Pre-1.0 beta.** This is the first public release, published under the `beta` npm tag. The workflow YAML
> schema, CLI output and library exports can still change in a minor version. Pin an exact version if you
> depend on them, and read the [CHANGELOG](CHANGELOG.md) before upgrading.

## Table of contents

- [What is this?](#what-is-this)
- [Why you would want it](#why-you-would-want-it)
- [Features at a glance](#features-at-a-glance)
- [Installation](#installation)
  - [Requirements](#requirements)
  - [Install from npm](#install-from-npm)
  - [Check your machine](#check-your-machine)
- [Quick start](#quick-start)
- [Use cases and examples](#use-cases-and-examples)
  - [1. Implement a batch of issues, some in parallel](#1-implement-a-batch-of-issues-some-in-parallel)
  - [2. A review pipeline with a human approval gate](#2-a-review-pipeline-with-a-human-approval-gate)
  - [3. Implement a whole PRD from a list of issues](#3-implement-a-whole-prd-from-a-list-of-issues)
  - [4. Cross-check work with a second agent](#4-cross-check-work-with-a-second-agent)
  - [5. Pass exactly the context a task needs](#5-pass-exactly-the-context-a-task-needs)
  - [6. Spend capability where it matters](#6-spend-capability-where-it-matters)
- [How it works](#how-it-works)
- [Watching a run](#watching-a-run)
- [The desktop app](#the-desktop-app)
- [Workflow file cheat sheet](#workflow-file-cheat-sheet)
- [CLI reference](#cli-reference)
- [Environment variables](#environment-variables)
- [What changed in 2.0](#what-changed-in-20)
- [Troubleshooting and FAQ](#troubleshooting-and-faq)
- [Documentation](#documentation)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## What is this?

`cao` is a command-line orchestrator for coding agents. You write a small YAML file that says *what* should
happen: implement these four issues, run these two reviews at the same time, wait for my approval, then
verify. `cao` turns that into a run: it starts **one fresh Claude Code or Codex process per task**, gives
each one only the context you declared, runs independent tasks side by side in **isolated git worktrees**,
validates the **structured result** every task must return, and persists every step so a crashed or
interrupted run can be **resumed** where it stopped.

> **The orchestrator is the deterministic manager. Agents are disposable workers.**

The orchestrator never talks to a model itself. It launches the agent CLIs you already have installed and
authenticated (`claude`, `codex`), so all traffic runs under your own credentials. It makes no network
calls of its own and sends no telemetry.

## Why you would want it

Long agent sessions drift. Context fills up, early decisions get forgotten, and a mistake in step two quietly
shapes steps three through nine. `cao` fixes that structurally instead of hoping the model stays on track:

| Problem with one long session | What `cao` does instead |
|---|---|
| Context bloats and the agent loses the thread | Every task is a **fresh process** with an empty conversation |
| Two agents editing the same tree collide | Parallel tasks run in **their own git worktrees** and merge back on success |
| "It exited cleanly" is taken as "it worked" | Tasks must return a **validated JSON result**; a clean exit alone is never success |
| A crash or Ctrl+C loses hours of work | State is **persisted after every transition**; `cao resume` picks up where it stopped |
| You cannot see what the agent is doing | A **live dashboard** shows every worker's transcript, cost, context size and changed files |
| The agent needs a permission and hangs | Prompts **surface in the dashboard**; you answer with one key and the worker carries on |
| Which files did the review task touch? | Every attempt captures its own **diff**, and every run writes a **report** you can paste into a PR |

## Features at a glance

- **Sequential by default, parallel when you say so.** Tasks in the same `parallelGroup`, or an explicit
  `dependsOn` graph, run concurrently up to `execution.maxConcurrency`.
- **Git worktree isolation.** Parallel tasks get `orchestrator/<task-id>` branches; merge conflicts are handed
  to a dedicated agent session as a last resort.
- **Explicit context passing.** A task declares `context.from` or `context.fromType`, and the orchestrator
  prepends a rendered `# Previous Task Context` section to its prompt. Nothing else is shared.
- **Two agents, mixed freely.** Claude Code and Codex in the same workflow. Set `agent`, `model` and
  `effort` per workflow, per template or per task. See the
  [Claude-to-Codex](examples/mixed-agents.yaml) and
  [Codex-to-Claude](examples/codex-implementation-claude-review.yaml) review loops.
  Codex support, stated plainly: `codex.transport: exec` is the **stable** default and the unattended
  production path; `codex.transport: appServer` is **experimental** and opt-in per task, and it is what adds
  dashboard-mediated command and file-change approvals; `codex.experimentalUserInput` is experimental,
  app-server only and off by default. **A `codex exec` task cannot be asked anything** — the Codex CLI
  answers approvals and questions itself, with a rejection — and `codex.configMode: isolated` is rejected on
  `appServer` rather than pretended. The full table is in
  [docs/capabilities.md](docs/capabilities.md#choosing-the-agent).
- **Templates, variables and `foreach`.** Reuse a task shape, fan out over a list of issues, interpolate
  `{{variables.*}}` into prompts.
- **Conditions and gates.** `when:` expressions skip tasks; `type: approval` pauses for a human decision.
- **Interactive workers.** Claude Code permission prompts and `AskUserQuestion` questions, and Codex
  app-server approvals, appear in the dashboard. A worker blocked on a human is either `waiting` — the
  dashboard can answer it — or `needs_input`, which pauses the run holding the question for
  `cao resume --input`. It never hangs, and it never fails because nobody was there.
- **Failure handling that costs what you decide.** `retries`, `onFailure: stop | continue | skip_dependents`,
  timeouts, per-task budgets, and previous-failure injection on retry.
- **Transient API errors resume the same session** (5xx, overload, dropped connection) instead of restarting.
- **Everything on disk.** `.orchestrator/runs/<run-id>/` holds every prompt, result, transcript, diff and
  cost figure. Secrets are redacted.
- **Per-task diffs and a run report.** `cao diff`, `cao report`, and `report.md` written at the end of every run.
- **Cross-platform.** Linux, macOS and Windows; CI exercises Linux and Windows.

## Installation

### Requirements

| Requirement | Why |
|---|---|
| **Node.js 22+** | The CLI itself |
| **git** | Worktree isolation, diff capture, merge-back |
| **Claude Code** and/or **Codex CLI**, installed and authenticated | The workers. `claude --version` / `codex --version` should work |

### Install from npm

```bash
npm install -g code-agent-orchestrator@beta
cao --version
```

Use the `@beta` tag until 1.0: every pre-release is published under it, so that is the tag that always
resolves to the newest one.

Two binaries are installed, `cao` and `code-agent-orchestrator`, the same program under both names. `cao` is
a short name that npm does not reserve, so it can lose to a shell alias or another tool on your PATH. If
`cao --version` does not print this package's version, use `code-agent-orchestrator` or alias `cao` to it.
Everything below writes `cao` for brevity.

### Check your machine

```bash
cao doctor
# or check only what one workflow will use
cao doctor workflow.yaml --json
# ...and start each agent mode for real, which costs a small model call
cao doctor --probe
```

`doctor` checks Node, git, each agent CLI's supported version, authentication and automation capabilities,
this terminal, the storage the runs are written to, the sessions a follow-up would resume, stale lock files,
abandoned runs and leftover worktrees, and prints a fix hint under anything that needs one. Run it first
whenever something does not work. `--probe` adds the checks that **start each mode a run can use** — Codex
`exec` and `app-server`, Claude ask-mode and deny-mode — so a green `cao doctor --probe` means more than
"the binary exists"; without it nothing is started and nothing is spent.

## Quick start

Five minutes from install to a running workflow.

`cao run` opens a persistent terminal workspace and keeps it open after the run ends, whether it succeeded,
failed or was interrupted — see [Watching a run](#watching-a-run). `cao ui <run-id>` opens the same
workspace from any other terminal, on a run this one owns or one already finished. In CI, over SSH without
a real terminal, or piped into a log, `cao run --no-tui` skips it and prints plain lines instead; a non-TTY
or `CI` gets the same behaviour automatically, with no flag needed.

**1. Go to the project you want worked on.** The directory you launch from becomes the repository root.

```bash
cd path/to/my-project
```

**2. Write `workflow.yaml`.**

```yaml
version: 1
name: Authentication V2
repository: .

agent: claude
model: opus
effort: high

execution:
  maxConcurrency: 3

templates:
  implementIssue:
    type: implementation
    prompt: "/implement {{issueNumber}}"

tasks:
  - id: implement-101
    template: implementIssue
    issueNumber: 101

  - id: implement-102          # 102 and 103 run together,
    template: implementIssue   # each in its own worktree
    issueNumber: 102
    parallelGroup: core

  - id: implement-103
    template: implementIssue
    issueNumber: 103
    parallelGroup: core

  - id: prd-review
    type: review
    model: sonnet              # a cheaper model is enough to review
    context:
      fromType: implementation # gets every implementation task's result
    prompt: Review the PRD against the implementation summaries in context.
```

**3. Check the plan, then run.**

```bash
cao validate        # schema + semantics + the resolved model for every task
cao run --dry-run   # the execution plan, nothing started
cao run             # go
```

Both accept a path. Without one they look for `workflow.yaml`, `workflow.yml` or `cao.yaml` in the current
directory. The startup header shows which repository the run will operate on; if it is not the one you
expected, stop and fix `repository:` or your current directory. `cao run` opens the workspace once
validation passes and stays there for the life of the run — and after it, whatever the outcome.

**4. While it runs**, everything below is a tab in the workspace itself (Overview, Session, Logs, Changes,
Report), so there is usually nothing else to open. The same questions answered from any other terminal, or
after minimising with `Q`:

```bash
cao status                       # progress table for the latest run
cao peek implement-102           # what is that worker doing right now?
cao logs implement-102 --follow  # its full transcript, live
cao diff implement-102           # what has it changed?
cao stop                         # interrupt the run, as Ctrl+C would
cao report                       # the whole run, ready to paste into a PR
```

**5. If it stops** (Ctrl+C, crash, failure, approval gate), the workspace stays open with the reason and the
resume actions on screen — see
[The workspace stays open when the run ends](#the-workspace-stays-open-when-the-run-ends). To come back to
it later, or from a different terminal:

```bash
cao list
cao ui <run-id>       # reopen the workspace: resume, re-run a task, or just read the report
cao resume <run-id>   # the same resume, headless
```

Prompts are opaque to `cao`. `/implement 101` is only an example; any prompt, slash command or skill works:
reviews, tests, documentation, research, migrations, refactors.

> **Re-running does nothing?** Successful tasks are marked `state: completed` in your workflow file and
> skipped on the next run. That is what makes long workflows resumable across days. Use `--task` or `--from`
> to redo one, or delete the marker.

## Use cases and examples

Every example below is runnable and lives in [`examples/`](examples/). Run any of them from the project you
want worked on:

```bash
cd path/to/my-project
cao run path/to/examples/parallel-issues.yaml
```

To smoke-test the agent integrations with a tiny, bounded documentation edit, run
[`documentation-codex.yaml`](examples/documentation-codex.yaml), then
[`documentation-claude.yaml`](examples/documentation-claude.yaml), and finally the cross-agent
[`documentation-combined.yaml`](examples/documentation-combined.yaml). All three use
[`documentation-smoke-target.md`](examples/documentation-smoke-target.md), so their edits are easy to inspect
or discard.

```bash
cao doctor examples/documentation-combined.yaml
cao run examples/documentation-codex.yaml --no-tui
cao run examples/documentation-claude.yaml --no-tui
cao run examples/documentation-combined.yaml --no-tui
git diff -- examples/documentation-*
```

### 1. Implement a batch of issues, some in parallel

*You have a milestone of issues. Some are independent and could be done at the same time; some must wait
for the others.*

```yaml
version: 1
name: Parallel issues
repository: .

execution:
  maxConcurrency: 3
  worktree:
    mergeBack: true
    mergeConflictStrategy: claude   # a fresh session resolves conflicts as a last resort
    cleanup: onSuccess

templates:
  implementIssue:
    type: implementation
    prompt: "/implement {{issueNumber}}"

tasks:
  - id: issue-101
    template: implementIssue
    issueNumber: 101

  - id: issue-102
    template: implementIssue
    issueNumber: 102
    parallelGroup: group-a        # 102 and 103 run concurrently, each in its own worktree

  - id: issue-103
    template: implementIssue
    issueNumber: 103
    parallelGroup: group-a

  - id: issue-104                 # waits for the group, runs in the shared tree
    template: implementIssue
    issueNumber: 104
```

Full example: [`examples/parallel-issues.yaml`](examples/parallel-issues.yaml) · sequential variant:
[`examples/sequential-issues.yaml`](examples/sequential-issues.yaml)

### 2. A review pipeline with a human approval gate

*Review the current branch, run a security review only if the first review succeeded, fix findings only if
there are any, then stop and ask you before touching the docs.*

```yaml
version: 1
name: Review pipeline
repository: .

hooks:
  afterWorkflow:
    - git status --short

tasks:
  - id: code-review
    type: review
    prompt: Review the current branch against main. Record concrete findings as warnings.

  - id: security-review
    type: security-review
    when:
      task: code-review
      status: success
    context:
      from: [code-review]
    prompt: Perform a security review, focusing on the findings passed in context.

  - id: fix-findings
    type: implementation
    when:
      expr: tasks.code-review.warnings.length > 0 || tasks.security-review.warnings.length > 0
    context:
      from: [code-review, security-review]
    prompt: Address the review findings supplied in context. Do not change unrelated code.

  - id: ship-approval
    type: approval
    prompt: Reviews are complete. Continue to documentation?

  - id: docs
    type: documentation
    context:
      from: ["*-review", fix-findings]
      includeFailed: true
    prompt: Update the documentation to reflect the reviewed changes.
```

In the dashboard you answer the approval inline. Headless, the run exits with code `3` and waits for
`cao resume <run-id> --approve ship-approval`.

Full example: [`examples/reviews.yaml`](examples/reviews.yaml)

### 3. Implement a whole PRD from a list of issues

*Fan out over a list of issues, then run test, PRD review, code review, security review and a final
verification, each seeing exactly the results it needs.*

```yaml
version: 1
name: Authentication V2 Implementation
repository: .

variables:
  prd: docs/prd/authentication-v2.md

defaults:
  timeout: 60m
  retry:
    attempts: 1
    includePreviousFailure: true   # a retry is told what went wrong last time
  onFailure: stop

templates:
  implementIssue:
    type: implementation
    prompt: |
      /implement {{item.number}}

      The PRD is at {{variables.prd}}. Keep changes scoped to the issue.

issues:
  - number: 201
  - number: 202
    parallelGroup: auth-core
  - number: 203
    parallelGroup: auth-core
  - number: 204

tasks:
  - id: implement
    foreach: issues                 # becomes implement-201 … implement-204
    template: implementIssue

  - id: test
    type: test
    context:
      fromType: implementation
    prompt: Run the relevant automated tests. Fix failures caused by the implementation.

  - id: prd-review
    type: review
    context:
      from: ["implement-*", test]
    prompt: Verify the implementation satisfies the PRD at {{variables.prd}}.

  - id: final-review
    type: verification
    context:
      from:
        - task: prd-review
          include: [summary, warnings, followUp]
    prompt: Confirm whether this workflow is complete and list anything unresolved.
```

Full example with code and security review stages: [`examples/prd-implementation.yaml`](examples/prd-implementation.yaml)

### 4. Cross-check work with a second agent

*A different model, and a different vendor, catches more than a second pass by the one that wrote the code.*

```yaml
tasks:
  - id: implement
    type: implementation
    agent: claude
    model: opus
    effort: xhigh
    prompt: "/implement 101"

  - id: review
    type: review
    model: sonnet
    parallelGroup: reviews
    context:
      from: [implement]
    prompt: Review the implementation described in context for correctness and missed edge cases.

  - id: cross-review
    type: review
    agent: codex                    # requires the Codex CLI installed and authenticated
    model: gpt-5.6-terra
    parallelGroup: reviews
    context:
      from: [implement]
    prompt: Independently review the change described in context.
```

### 5. Pass exactly the context a task needs

*Sessions never share a conversation. Downstream tasks receive selected fields from the structured results
of the tasks they name, nothing more.*

```yaml
tasks:
  - id: backend
    type: implementation
    prompt: "/implement 101"

  - id: frontend
    type: implementation
    dependsOn: [backend]
    context:
      from:
        - task: backend
          include: [summary, filesChanged, decisions]   # only these fields
    prompt: Implement the frontend for issue 102 against the backend described in context.

  - id: integration-review
    type: review
    dependsOn: [frontend]
    context:
      fromType: implementation      # every implementation task's result
      maxChars: 40000               # hard cap on the rendered context
    prompt: Verify all components integrate correctly.
```

Full example: [`examples/context-passing.yaml`](examples/context-passing.yaml)

### 6. Spend capability where it matters

`agent`, `model` and `effort` can be set at the workflow level, in `defaults`, in a template, or on an
individual task.

```yaml
agent: claude          # claude | codex
model: opus            # alias (fable / opus / sonnet) or a full id (claude-opus-5)
effort: high           # low | medium | high | xhigh | max

templates:
  quick:
    model: claude-haiku-4-5
    effort: low
    timeout: 10m

tasks:
  - id: implement
    effort: xhigh              # the hardest step gets the most reasoning
    claude:
      maxBudgetUsd: 10         # hard spend ceiling for this task
  - id: changelog
    template: quick            # the trivial step gets the cheapest model
    context:
      from: [implement]
      include: [summary]       # and only the context it needs
```

`cao validate --json` reports the resolved agent, model and effort for every task before you spend anything.

Full example: [`examples/model-selection.yaml`](examples/model-selection.yaml) · reference:
[docs/models.md](docs/models.md)

## How it works

```
Orchestrator (cao)
    ├── task A   → claude -p …    (own process, own session, cwd = repository)
    ├── task B   → claude -p …    (own process, cwd = .orchestrator/worktrees/B, branch orchestrator/B)
    └── task C   → codex exec …   (own process, cwd = .orchestrator/worktrees/C, branch orchestrator/C)
```

- **Isolation.** Each attempt spawns the configured agent in non-interactive, structured-output mode from
  the task's working directory. Claude uses `claude -p`; Codex uses `codex exec --json --output-schema`
  with an explicit sandbox and approval policy.
- **Completion contract.** A worker must finish with a JSON object (`status`, `summary`, `filesChanged`,
  `commits`, `decisions`, `warnings`, `followUp`, `error`, `data`) that validates against a schema. That
  object is protocol, not speech: every surface shows it as a result with its summary, never as agent prose.
- **Scheduling.** The workflow is a DAG. Tasks in the same layer may run together up to
  `execution.maxConcurrency`, in worktrees so no two agents share a working tree.
- **Worktrees.** Created from the run's base commit on `orchestrator/<task-id>` branches and merged back on
  success. A conflict starts a dedicated agent merge session; if that fails the task fails and the branch
  is kept for you.
- **Context passing.** A downstream task declares `context.from` / `context.fromType`. The orchestrator
  renders a `# Previous Task Context` section from stored results and prepends it to the prompt.
- **Failure handling.** `retries`, `onFailure`, timeouts, and previous-failure injection on retry.
- **Persistence.** `.orchestrator/runs/<run-id>/` is immutable history: every prompt, result and cost
  figure. Secrets are redacted. Bulk agent output stays in the per-attempt directory.
- **Per-task diffs.** Every attempt ends with its own `diff.patch` and `diff.json`. Worktree tasks are
  diffed from base commit to branch head; shared-tree tasks from git tree snapshots taken at the start and
  end of the attempt, so shell-driven changes count too. The patch replays with `git apply`.
- **Run report.** Every run writes `report.md` into its run directory when it ends: header, an overview
  table, then per task its summary, changed files with `+`/`-` counts, commits, decisions, warnings,
  follow-ups and, when it needed more than one try, an attempts table.
- **Ctrl+C.** Stops scheduling, terminates worker process trees (POSIX process groups, Windows
  `taskkill /T`), persists `interrupted`, exits `130`. `cao stop` does the same from another terminal.

Deeper reading: [docs/architecture.md](docs/architecture.md) and
[docs/agent-cli-integration.md](docs/agent-cli-integration.md).

## Watching a run

`cao run` opens a persistent terminal workspace: a header (repository, run id, workflow, run state, elapsed,
concurrency, owner/observer badge), a sidebar task list, a tabbed main panel — **Overview · Session · Logs ·
Changes · Report · Diagnostics** — and a footer with the keys of whatever has focus. The Overview leads with
the run's outcome, then a task table (state, elapsed, agent, context size, cost, changed files, and an
**activity column** showing the tool, command or line of prose a worker is on right now — after 30 seconds
of silence the cell gains `… 2m idle`, so a thinking worker is distinguishable from a stuck one), then the
selected task's full detail. `E` on any unfinished task opens the editor described under
[Editing an unfinished task](#editing-an-unfinished-task). **Session** shows the selected task's identity
(agent, model as reported, session id, attempt, revision), its transcript, anything it is waiting on, every
message you have sent it, and the composer described under [Prompting a task](#prompting-a-task). **Logs**
is every file the run wrote — `orchestrator.log`, the run's events, and each attempt's events, `stdout.log`,
`stderr.log` and `prompt.md` — read a page at a time from the end, with `v` for the view, `[`/`]` for the
file, `t`/`k`/`m` for the task, severity and time filters and `/` `n` `N` to search; nothing is loaded whole,
so a 50 MB `stdout.log` opens at once. **Diagnostics** is how the run is executing, read-only: agent
versions and transports, the effective configuration of each task with its active revision, the retry
history, the provider failure metadata, the controls sent and answered, and the quota snapshots.

When a worker needs you, a prompt appears in the workspace (it reopens itself if minimised, and the terminal
bell rings): `Y` allow, `A` allow for the rest of the task, `N` deny, `R` deny with a reason. Questions list
their options; `T` types an answer. The worker continues the moment you answer. Set `hooks.onInputRequired`
to be notified elsewhere.

### How much of your plan is left

The footer carries one chip per provider, showing what that provider says about its own rate-limited
windows — never a number `cao` worked out for itself, and never a category `cao` invented:

```
codex · Pro · 5h 42% · resets 14:05 · 7d 61% · ok · 2m ago      claude · unavailable · see /usage in Claude Code
```

**Codex.** The workspace keeps one `codex app-server` open for the session — never one per attempt — and
asks it for `account/read` and `account/rateLimits/read` when you arrive, every five minutes after that, and
whenever you ask. Both are account reads: no thread is opened, no turn is started and nothing is billed.
Whatever windows the server reports are shown, labelled from their own duration (`5h`, `7d`, else `Nm`) with
the reset time in your time zone — a clock time when it is today, a weekday and a clock time when it is not, a date when it is five or more days out; a window the server does not report is not drawn. While a task is running,
the rate-limit updates its own app-server receives are folded in too, so a busy run refreshes faster than
the timer. The chip says `codex · sign in with ChatGPT for quotas` when Codex is authenticated by API key —
the server refuses quota reads for those — and `unavailable` when the CLI is missing or below 0.48.0, the
first version with the read. A failed refresh never blanks a good reading: it keeps the numbers and says
`stale` with their age.

**Claude.** `claude · unavailable · see /usage in Claude Code`. There is no documented programmatic read of
the Pro/Max usage bars, and `cao` makes no network call of its own to find one.

`Tab` to the footer and press `R` to read them again, or pick *Refresh the provider quotas* from `Ctrl+P`.
The readers start when the workspace opens and stop when it closes; a headless run (`--no-tui`, non-TTY,
`CI`) starts neither the process nor the timer. Per-task tokens and cost are a different question and live
in the usage table (`U`).

### The workspace stays open when the run ends

Success, failure, a pause or a Ctrl+C: the workspace stays. The Overview leads with the outcome, the failed
task and its failure category, the latest error line and how many attempts it took, and the logs, earlier
attempts, diffs and the report stay where they were. Under it are the things you can do next, each of them
a `cao resume` run from inside the workspace:

`S` resume the run · `R` re-run the selected task · `>` resume from the selected task and everything
downstream · `A` answer a task that asked a question, and resume with the answer (`Ctrl+J` for a newline,
`Enter` to send) · `A`/`X` approve or reject a paused approval gate · `Q` leave, returning the latest run's
exit code.

Each action validates first and takes the run lock again. Between them the workspace holds no lock, so
another terminal may take the run; if one has, the workspace follows it instead: the badge says
`observing · owner pid N`, the picture keeps up from `workflow.json` and `live.json`, and `S` stop, `K`
kill and `R` re-run travel to that process as requests whose answers land in the Diagnostics tab.
Approvals and questions are read-only there — *answer in the owning terminal (pid N)*. When that process
goes, the badge says `abandoned · resume?` and the resume actions come back. `cao ui <run>` opens the same
workspace on a run that ended earlier, or on one another terminal is executing.

<details>
<summary><strong>Workspace keys</strong></summary>

`Tab`/`Shift+Tab` cycle the task list, the tab bar, the panel and the footer · arrows, `PgUp`/`PgDn` and
`Home`/`End` navigate whatever has focus · `Enter` opens it · `Esc` closes a dialog or steps back ·
`Ctrl+P` opens a command palette over every action and every task id · `/` searches the focused list or
the report · `?` lists the keys of whatever has focus, plus the ones that work anywhere · `Q` quits ·
`Ctrl+C` stops the run and stays here (again within 20 seconds to force and exit 130).

In the task list: `↑↓` select · `Enter` open the task in the panel · `F`/`L` follow its transcript · `R`
restart a failed, blocked, cancelled or skipped task · `E` edit an unfinished task. In the tab bar: `←→`
choose a tab, `Enter` opens it and focuses its panel. In the Overview: `↑↓` (plus `PgUp`/`PgDn`,
`Home`/`End`) move the task table · `F`/`L` follow the selected task · `R` restart it · `E` edit it · `U`
usage (tokens, context, cost, time in tools; `S` sorts by cost), full-screen · `C` jump to the Changes tab.
In the footer: `R` reads the provider quotas again.

`Q` while the run is going asks first: **stay**, **stop and quit**, or **continue in plain output** — the
old minimise, where the run keeps printing lines and `D` or `Enter` reopens the workspace. On a run that
has ended `Q` leaves at once, with that run's exit code; watching another terminal's run `Q` just closes
the window. See [above](#the-workspace-stays-open-when-the-run-ends) for the ended-run actions (`S` `R`
`>` `A` `X`) and the observer's controls (`S` `K` `R`).

`Ctrl+C`, `Ctrl+P`, `Ctrl+J` for a newline in the answer field, the prompt and the composer, `Ctrl+O` for
any of the three in `$VISUAL`/`$EDITOR`, and `Ctrl+Z`/`Ctrl+W` in the composer are the chords the workspace
reads; the transcript viewer adds `Ctrl+A` to scroll up. Every other `Ctrl`+key is left to the terminal.
Below 100 columns the sidebar collapses to a one-line task strip, and the footer gives up its freshness
chip first, then the quota chips from the right — the providers that will never report a number go before
the ones that did — then the focused panel's own keys; `? help` and the way out survive last. The help screen and the usage table use a compact layout too, so no frame is wider or taller than
the terminal it is drawn in; the usage table drops its cache, turns, time and tools columns there,
`cao task <id>` still reports all of them.

</details>

### Editing an unfinished task

A prompt that was wrong, a model that was too small, a timeout that was too short: change them without
stopping the run and without editing the workflow file.

```bash
cao task edit review --prompt-file better-prompt.md    # the resolved prompt; context is still automatic
cao task edit review --model claude-opus-5 --restart   # stop the worker, apply, start it again
cao task edit 002 review --retries 3 --timeout 90m
cao task prompt review --message "also update the changelog"   # the mode the task allows, printed
cao task prompt review --file notes.md --stop-and-continue     # stop the worker, start again with it
cao task prompt review --message "start over" --fresh-session  # do not continue the old session
```

What is edited is the **resolved** task: the prompt with defaults, templates and `foreach` already applied,
never the YAML behind it, which an edit never writes. The context section a task's `context.from` produces
keeps being prepended at launch, and the editor shows it read-only beneath the prompt.

**Validation comes first.** The edited task goes through the same validator `cao validate` prints — the
agent is installed and capable, the timeout parses, retries are 0-20, a budget is Claude-only — and a
failure is a refusal with that validator's own sentence. Nothing is stopped and nothing is recorded, so a
mistyped model costs a running attempt nothing. Warnings (a model with no effort levels, a permission mode
that will prompt) are printed and the edit is applied.

`pending`, `ready`, `failed`, `blocked`, `cancelled` and `needs_input` tasks are edited in place; the task
runs with the new settings the next time it starts. A **running or waiting** task needs `--restart` (the
workspace asks before it does it), which stops the worker, applies the edit and starts the task again
**from a fresh session** — the previous attempt keeps its `prompt.md`, transcript, usage, diff and session
id, and the worktree and branch are reused. If `retry.resetWorkspace` is on, you are told that uncommitted
changes in the worktree will be reset before it happens.

Refused, each with a sentence saying what to do instead: a task that succeeded or was skipped (immutable —
add a task or start a new run), an approval gate, a task merging its work back, and a task whose dependent
has already run or is running — that last one names `cao run <workflow> --from <task>`, which is the run
that gets the revised task and everything downstream of it.

Every edit appends a **revision** to the run. `cao task <id>` prints the history under **Attempts** —
number, time, source, the fields changed, and the attempt that carried it — and each attempt records the
revision it ran with. The run's `events.jsonl` gets a `task.edited` line naming the fields and never their
values.

With nobody executing the run, the edit is written straight into the run and the resume that picks it up is
named. `--restart` is refused there: a resume is what starts the task.

In the workspace, `E` opens a form over the selected task: one row per field with its current value,
the validator's message inline under the row that caused it, the context section read-only beneath the
prompt, and `Ctrl+O` to write the prompt in `$VISUAL`/`$EDITOR` (the workspace steps off the alternate
screen and waits for it). `Enter` on **Save** sends the edit, asking "restart now?" first when the task is
running or waiting. On a succeeded or skipped task `E` says why there is nothing to edit.

### Prompting a task

```bash
cao task prompt review --message "also update the changelog"     # the mode the task allows, printed
cao task prompt review --file notes.md --steer                   # only where the worker has a live channel
cao task prompt 002 review --message "try -O2" --stop-and-continue
cao task prompt review --message "start over" --fresh-session    # do not continue the old session
```

What "prompt" means depends on the task, and the command prints which of the three it chose:

| The task is | What happens |
|---|---|
| running, with a steerable worker (Claude in `ask` mode, Codex app-server) | **steer** — the message goes into the running session and is taken up at the end of the current turn |
| running, with no live channel (headless Claude, `codex exec`) | **stop and continue** — the attempt is stopped and the task starts again carrying the message |
| `failed`, `blocked`, `cancelled` or `needs_input` | **follow-up** — a new attempt, continuing the session the task reported where it can, else with the message under `# User Input` |
| waiting on a permission prompt or a question | nothing — answer that first; a prompt and an answer are not the same thing |
| `pending` or `ready` | nothing — edit its prompt instead |
| `success` or `skipped` | nothing — immutable; add a task or start a new run |

`--steer`, `--follow-up` and `--stop-and-continue` name a mode and are refused where the task does not offer
it, rather than quietly doing the other thing. If the session a follow-up would continue is no longer on
disk, the command refuses and offers `--fresh-session` instead of resuming into a worker that has silently
forgotten everything. `cao resume --task <id> --input "<answer>"` is the same follow-up path and behaves
exactly as it always has.

Every message is recorded on the run — mode, transport, state and reason — and the run's `events.jsonl`
gets a `task.prompted` line carrying all of that and never the text.

In the workspace the same thing is the **composer** at the bottom of the Session panel:

- `Enter` opens it; `Enter` sends. The header says which mode will be used and, for a follow-up, which
  session it resumes.
- `Ctrl+J`, or a trailing `\` then `Enter`, inserts a newline (`Shift+Enter` too, where the terminal
  supports it).
- `Ctrl+O` opens the draft in `$VISUAL`/`$EDITOR`; `Ctrl+Z` undoes the last edit; `Ctrl+W` deletes the word
  before the cursor; `Esc` closes it and keeps the draft until you quit.
- A paste arrives whole; one over 20 lines is shown as `[pasted N lines]` with every byte kept.
- Inside the composer every printable key is text, so `q` types a `q`.

<details>
<summary><strong>Transcript viewer keys</strong> (<code>F</code> in the workspace, or <code>cao logs --follow</code>)</summary>

`←`/`→` or `Tab` switch tasks · `1`-`9` jump to one · `P` task picker · `[`/`]` switch attempts ·
`↑↓`/`PgUp`/`PgDn` scroll · `g` oldest line · `Shift+G` newest line and follow again · `t` expand tool
output and subagent entries · `T` show thinking · `/` search with `n`/`N` for next and previous match ·
`k` cycle the kind filter (all → text → tools and commands → errors and questions) · `Q`/`Esc` leave.

Scrolling above the oldest line still in memory pages older entries in from the attempt's `events.jsonl`,
so the whole transcript is reachable.

</details>

<details>
<summary><strong>Review keys</strong> (the Changes tab, <code>C</code> from the Overview)</summary>

The list shows every task's files with `A`/`M`/`D`/`R` and `+N -M`. `↑↓`, `PgUp`/`PgDn`, `g`/`G` move ·
`Enter` opens that file's hunks · `O` opens it in `$VISUAL`/`$EDITOR` · `Esc`/`Q` back. In the hunk pane:
`N`/`P` jump between hunks · `←`/`→` previous or next file · `Esc` returns to the list.

</details>

Prefer plain text? `cao run --no-tui` prints a log instead, and `cao run --activity` adds the activity
column to it. Every command has a `--json` counterpart for scripting.

## The desktop app

`cao` stays a standalone CLI — nothing below is required, and a run with no desktop app watching it
behaves exactly as it always has. What `cao` gained is one capability: telling a separate desktop
application, `cao-desktop`, that it exists, so that app can show live runs across several
repositories without either project importing the other.

```bash
cao emit enable                  # announce every run this user starts, from now on
cao run --emit                   # or announce just this one run
cao emit status                  # what is announced, where that decision came from, and who is watching
```

Turning this on writes nothing but a small, user-level heartbeat file under `~/.cao` — no network
port, no telemetry, and no change to how a run behaves when nobody is watching it. See
[docs/desktop.md](docs/desktop.md) for the full contract: what gets written, the trust boundary, and
how to diagnose a desktop app that shows nothing.

## Workflow file cheat sheet

The keys you will use most. The complete schema is in [docs/configuration.md](docs/configuration.md).

```yaml
version: 1                       # required
name: My workflow
repository: .                    # relative to the launch directory

agent: claude                    # claude | codex           (workflow default)
model: opus                      # alias or full model id   (workflow default)
effort: high                     # low | medium | high | xhigh | max

variables:                       # {{variables.key}} in prompts
  prd: docs/prd.md

execution:
  maxConcurrency: 3
  workspaceStrategy:
    sequential: shared           # sequential tasks share the repository
    parallel: worktree           # parallel tasks get their own worktree
  worktree:
    base: runStart               # runStart | headAtStart
    mergeBack: true
    mergeConflictStrategy: agent # agent | claude | codex | fail
    cleanup: onSuccess           # onSuccess | always | never
  interactionTimeout: 30m        # unanswered prompts are denied after this ("never" disables it)

defaults:                        # inherited by every task
  timeout: 60m
  retries: 1
  onFailure: stop                # stop | continue | skip_dependents

hooks:                           # shell commands at lifecycle points
  afterWorkflow: [git status --short]
  onInputRequired: [notify-send "cao needs you"]

templates:
  implementIssue:
    type: implementation
    prompt: "/implement {{issueNumber}}"

tasks:
  - id: implement-101            # required, unique
    name: Implement issue 101    # optional display name
    type: implementation         # free label; used by context.fromType
    template: implementIssue     # inherit a template
    issueNumber: 101             # any extra key becomes a template variable
    prompt: "..."                # any prompt, slash command or skill
    dependsOn: [other-task]      # explicit edges; otherwise file order
    parallelGroup: core          # run concurrently with the same group
    when:                        # skip unless this holds
      expr: tasks.other-task.warnings.length > 0
    context:
      from: [task-a, "impl-*"]   # ids or globs
      fromType: implementation   # or every task of a type
      include: [summary, warnings, followUp]
      includeFailed: true
      maxChars: 40000
    agent: codex                 # per-task overrides
    model: sonnet
    effort: low
    timeout: 20m
    retries: 2
    onFailure: continue
    claude:
      maxBudgetUsd: 10
      permissionMode: acceptEdits
    codex:
      sandbox: workspace-write

  - id: ship-approval
    type: approval               # pauses for a human decision
    prompt: Continue to release?
```

Task-oriented feature tour, one working example per feature: [docs/capabilities.md](docs/capabilities.md).

## CLI reference

Grouped the way `cao --help` groups them.

### Run

| Command | What it does |
|---|---|
| `cao run [workflow]` | Create and execute a run, in the workspace by default. Refuses to start while another orchestrator owns a run in the same repository. `--dry-run`, `--task <id>`, `--from <id>`, `--max-concurrency N`, `--permission-mode M`, `--repository <dir>`, `--claude-command <cmd>`, `--no-tui`, `--no-alt-screen`, `--theme <name>`, `--activity`, `--debug`, `--verbose`, `--emit`/`--no-emit`, `--emit-feed` |
| `cao resume [run]` | Continue an interrupted, failed or paused run, in the workspace by default. `--no-retry-failed`, `--approve <task>`, `--reject <task>`, `--task <id> --input "<text>"`, `--from <id>`, `--debug`, plus the `cao run` overrides |
| `cao ui [run]` | Open the workspace on a run, or choose from the recent runs of this repository. Owner or observer, per [Watching a run](#watching-a-run). With no terminal it prints the list and exits 0. `--limit N`, `--json`, `--no-tui`, `--no-alt-screen`, `--theme <name>`, `--repository <dir>`, `--verbose` |
| `cao stop [run]` | Interrupt a run from another terminal, as Ctrl+C would; twice to kill workers immediately. `--wait <seconds>` |
| `cao validate [workflow]` | Schema and semantic validation plus the execution plan, with the resolved agent, model and effort per task. `--repository <dir>`, `--json` |

### Inspect

| Command | What it does |
|---|---|
| `cao status [run]` | Progress table, run directory and orchestrator pid. `--json` |
| `cao list` | Runs of this repository, newest first. `--limit N`, `--json` |
| `cao logs [run] [task]` | A worker's transcript as one document. `--follow` opens the viewer; `--thinking`, `--raw`, `--stderr`, `--prompt`, `--attempt N`, `-n N`, `--json` |
| `cao peek [run] <task>` | What a worker is doing right now, with context size, cost and files. `--follow`, `--json` |
| `cao diff [run] [task]` | What a task changed, as a unified diff `git apply` accepts. `--stat`, `--name-only`, `--file <path>`, `--attempt N`, `--json` |
| `cao report [run]` | The run as a document to paste into a pull request. `--json`, `--out <file>` |

### Task controls

| Command | What it does |
|---|---|
| `cao task [run] <task>` | Everything recorded about one task: status, model, attempts, PID, cwd, branch, dependencies, usage, changed files, interactions. `--json`. This is `cao task show`, the default subcommand; a task whose own name is a subcommand is reached with `cao task show <name>` |
| `cao task stop\|restart [run] <task>` | Cancel the attempt a task is running, or run a finished, unsuccessful task again. Applied by the process that owns the run: directly when that is this one, otherwise through a request it answers. `--wait <seconds>` (default 30), `--repository <dir>` |
| `cao task prompt [run] <task>` | Say something to a task: steer the worker it is running, stop and continue it, or start a stopped task again carrying the message. Without a mode flag the one the task's state allows is chosen and printed. `--message <text>` or `--file <path>`, `--steer`, `--follow-up`, `--stop-and-continue`, `--fresh-session`, `--wait <seconds>` (default 30), `--no-tui`, `--repository <dir>`. A session that is no longer on disk is refused rather than silently replaced; with nobody executing the run a follow-up resumes it to carry the message |
| `cao task edit [run] <task>` | Change an unfinished task's prompt, agent, model, effort, timeout, retries or budget. Validated before anything stops. `--prompt <text>` or `--prompt-file <path>`, `--agent claude\|codex`, `--model <id>`, `--effort <level>`, `--timeout <duration>`, `--retries <n>`, `--budget <usd>`, `--restart`, `--wait <seconds>` (default 30), `--repository <dir>`. With nobody executing the run the edit is written into it and the resume that applies it is named; `--restart` is refused there |

### Diagnostics

| Command | What it does |
|---|---|
| `cao doctor [workflow]` | Check Node, git, required agent versions/auth/capabilities, the terminal, the storage the runs are written to, the protocol the run directories were written with, the sessions a follow-up would resume, which controls the installed CLIs can carry, the login mode behind the quota chips, stale locks, abandoned runs and leftover worktrees, with a fix hint under each failing check. `--probe` also starts each agent mode a run can use; without it nothing is started and nothing is spent. `--repository <dir>`, `--json` |
| `cao diagnostics [run]` | One JSON file describing a run, to attach to a bug report: doctor facts (no probes), the redacted workflow, the run events, `live.json`, the orchestrator log, every `attempt.json` with the last 200 lines of its `stderr.log`, and the inbox. Transcripts, prompts and diffs only with `--include transcripts,prompts,diffs`, follow-up text included. Everything passes through the run's redactor; nothing is uploaded. `--out <file>` (required), `--repository <dir>` |
| `cao clean [run]` | Remove what a run left on disk. `--worktrees` (default), `--branches`, `--all` |
| `cao emit [action]` | `enable`/`disable`/`status` (default) — turn announcing a run to a desktop app on or off for this user, or show the whole precedence chain. `--emit`/`--no-emit` (with `status`, resolve the chain as if a run had the flag), `--json` |

**Exit codes**

| Code | Meaning |
|---|---|
| `0` | completed |
| `1` | failed |
| `2` | usage or validation error |
| `3` | paused, an approval or input is required |
| `70` | internal error |
| `130` | interrupted by Ctrl+C or `cao stop` |

**References.** Task and run ids match exactly or by a unique prefix, so `cao task implement-1` and
`cao diff 004` work. An ambiguous prefix is refused with the candidates listed.

**Finding your way.** `cao` on its own prints this list, grouped as **Run**, **Inspect**, **Task controls**
and **Diagnostics**, and exits 0. Every command's `--help` ends with worked examples and the exit codes that
command really produces, and a mistyped command is answered with the one it was probably meant to be.

## Environment variables

Read by `cao` itself. Everything else in your environment passes through to the agent processes.

| Variable | Effect |
|---|---|
| `CAO_CLAUDE_COMMAND` | The Claude CLI to launch instead of `claude`. A command line, not only a path, so `node test/fixtures/fake-claude.mjs` works. `--claude-command` overrides it |
| `CAO_CODEX_COMMAND` | The Codex CLI to launch instead of `codex`, same rules |
| `CAO_EMIT` | `1`/`0` to announce this shell's runs to a desktop app on this machine (`~/.cao`), same precedence as `--emit`/`--no-emit` and `cao emit enable`. See [docs/desktop.md](docs/desktop.md) |
| `CAO_HOME` | Use a different directory instead of `~/.cao` for the files above |
| `CAO_DEBUG` | Debug-level logging into `orchestrator.log` (and onto stderr without a workspace), the stack trace when a command fails, and the Diagnostics tab when the workspace opens. `--debug` on `cao run` and `cao resume` sets it |
| `CAO_ASCII` | Draw tables, status marks and the workspace's own glyphs in ASCII. Guessed on a Windows terminal without a UTF-8 code page; `CAO_UNICODE=1` forces glyphs back on |
| `CAO_ALT_SCREEN` | `0` draws the workspace in the normal buffer instead of the alternate screen, like `--no-alt-screen` |
| `CAO_THEME` | `cyberpunk` (the default) or `mono` for the workspace; `--theme` overrides it, a `"theme"` key in `~/.cao/config.json` is read below it, and `NO_COLOR` forces `mono`. `default` is still accepted as the old name of `cyberpunk` |
| `CAO_REDUCED_MOTION` | `1` stops the spinner and the activity pulse; `TERM=dumb` and a screen reader do the same |
| `NO_COLOR` / `FORCE_COLOR` | Disable or force ANSI colour. `--color auto\|always\|never` wins where a command has it |
| `COLUMNS` | Table width when there is no terminal to ask, for piped output and CI logs |

Workflow hooks additionally receive `CAO_RUN_ID`, `CAO_RUN_STATE`, `CAO_TASK_ID`, `CAO_TASK_TYPE`,
`CAO_TASK_STATE`, `CAO_ATTEMPT`, `CAO_ATTEMPT_KIND`, `CAO_BRANCH`, `CAO_WORKDIR`, `CAO_HOOK` and, for
`hooks.onInputRequired`, `CAO_INTERACTION_KIND`, `CAO_INTERACTION_TITLE` and `CAO_INTERACTION_TOOL`.
See [docs/configuration.md](docs/configuration.md#hooks).

## What changed in 2.0

Every item below is a genuine behaviour change, not a new YAML key: no workflow key was added, removed or
renamed, and an existing workflow file runs exactly as it did before.

- **`cao run` and `cao resume` open a persistent workspace that stays open after the run ends** — on
  success, failure, a paused approval gate or a graceful `Ctrl+C` — showing the failed task, its error and
  the resume actions. It used to exit about 50 ms after the run finished, so the screen that showed a
  failure was the screen that disappeared with it.
- **`cao ui [run]` is new.** It opens that same workspace on a run nobody is executing (reading the run
  directory the way `cao status`, `cao logs` and `cao diff` always have), read-only on a run another
  terminal owns, or a picker over the recent runs of this repository when none is named.
- **The dashboard is now a workspace**: a header, a sidebar task list, and a tabbed main panel — Overview,
  Session, Logs, Changes, Report, Diagnostics — with a footer for whatever has focus. The task table, the
  review view, the transcript viewer and the usage table are the same views the old dashboard had, now
  reached as tabs of one shell; **Session, Logs and Diagnostics are new** — there was previously no way to
  see a task's live transcript and composer, page through a run's raw log files, or inspect retry and
  control history without leaving the dashboard for `cao logs`, `cat orchestrator.log` or nothing at all.
- **`cao task edit` and `cao task prompt` are new**, and `cao task stop`/`restart` now reach a run owned by
  another terminal through a request file instead of only the process that started it. There was previously
  no way to change an unfinished task's prompt, agent, model, effort, timeout, retries or budget, or to say
  anything to a running worker, short of stopping the whole run and editing the workflow file.
- **The workspace opens in the alternate screen by default.** It used to draw into the terminal's normal
  buffer, leaving every frame of the run in scrollback. Turn it off with `--no-alt-screen`,
  `CAO_ALT_SCREEN=0`, or the `"altScreen"` key in `~/.cao/config.json`.
- **`Q` asks before it leaves.** It used to minimise immediately; while a run is going it now offers stay,
  stop and quit, or continue in plain output (the old minimise — `D` or `Enter` reopens). `Ctrl+C` used to
  close the workspace; it now asks the run to stop and keeps the workspace open to show the result. A
  second `Ctrl+C` within 20 seconds still force-kills the workers and exits `130`, unchanged.
- **Bare `cao` prints its help to stdout and exits `0`.** It used to print the same text to stderr and exit
  `2`, so `cao | less` showed nothing and a shell read "what is this" as a failure.
- **Root help is grouped into Run, Inspect, Task controls and Diagnostics** (see
  [CLI reference](#cli-reference)) instead of one flat list of commands, and every command's `--help` now
  ends with worked examples and the exit codes that command actually produces.
- **`cao doctor` starts no agent unless you pass `--probe`.** Live probes used to run by default, so an
  ordinary `cao doctor` cost a small model call and up to a minute per agent mode; `--no-probe` is still
  accepted, now as a deprecated no-op, and probe rows print `not probed (pass --probe)` instead of being
  silently skipped.
- **A usage footer with one quota chip per provider is new.** Codex's chip reads its own `codex app-server`
  for `5h`/`7d`-style windows; Claude's reads `unavailable · see /usage in Claude Code`, because no
  programmatic read of it exists. There was no account-quota reporting of any kind before.
- **`cao diagnostics [run] --out <file>` is new**: one redacted JSON bundle — doctor facts, the workflow,
  run events, the orchestrator log, every attempt record and stderr tail — for a bug report, instead of
  gathering those files by hand.
- **`--debug` on `cao run` and `cao resume` is new**, equivalent to setting `CAO_DEBUG=1` for that run.
- **The cyberpunk theme is the workspace's default identity**, chosen with `--theme cyberpunk|mono` or
  `CAO_THEME`, with `CAO_REDUCED_MOTION=1` turning off the spinner and the activity pulse. The old dashboard
  had no theme to choose and painted colour unconditionally.
- **`R` now restarts a skipped task, not only a failed, blocked or cancelled one** — a task skipped because
  its condition was false, or because a dependency it waited on failed, can be restarted once that is
  dealt with, while the run is still active.
- **Backspace and Delete are no longer the same key.** The terminal library CAO draws with was upgraded;
  Backspace now erases the character behind the cursor when typing a denial reason or a `/` search, and
  Delete no longer does. Everything you type still lands the same way; only that one key moved.

## Troubleshooting and FAQ

<details>
<summary><strong>Something does not work. Where do I start?</strong></summary>

`cao doctor`. It checks Node, git, each agent CLI, stale `lock.json` files, leftover worktrees and whether
`.orchestrator/` is git-ignored, and prints the fix under each failing line; `--probe` also starts every
agent mode a run can use. Attach `cao doctor --json` to a bug report — or, when the question is about one
run, `cao diagnostics <run> --out bug.json`, which packs that run's doctor facts, workflow, events,
orchestrator log, attempts and stderr tails into a single redacted file. Re-run with `--debug` first if the
log needs more in it.

</details>

<details>
<summary><strong><code>cao</code> runs some other program.</strong></summary>

Another tool or shell alias owns the name. Use `code-agent-orchestrator` instead, or alias `cao` to it.

</details>

<details>
<summary><strong>I re-ran the workflow and nothing happened.</strong></summary>

Completed tasks are recorded as `state: completed` in the workflow file and skipped. Use
`cao run --task <id>` or `--from <id>` to redo part of it, or remove the `state`/`completion` keys.

</details>

<details>
<summary><strong>The run exited with code 3.</strong></summary>

It is paused on an approval gate or a worker that returned `needs_input`. The block it printed names every
task that is waiting, quotes what it asked and gives the command that answers it; `cao status`, `cao task
<id>` and `report.md` say the same. Answer it:

```bash
cao resume <run-id> --approve <task>
cao resume <run-id> --task <task> --input "Use the v2 endpoint."
```

Your answer goes back to the worker that asked, next to its own question: where the paused attempt left a
session behind it is continued with the answer rather than the task being redone. One `--task` per
`--input` — if several tasks are waiting, answer them one at a time.

</details>

<details>
<summary><strong>Can I try a workflow without spending anything?</strong></summary>

Yes. Point `cao` at the fake agent that ships with the test suite:

```bash
CAO_CLAUDE_COMMAND="node test/fixtures/fake-claude.mjs" cao run workflow.yaml
```

It exercises the structure of the workflow, worktrees and context passing, and returns canned results.
`cao validate --json` also shows the resolved model and effort for every task before a real run.

</details>

<details>
<summary><strong>Does <code>cao</code> send my code anywhere?</strong></summary>

No. It makes no network calls of its own and sends no telemetry, analytics or crash reports. The only
processes it starts are the agent CLIs you configure, `git`, and the hook commands your workflow declares,
so all traffic is theirs, under your own credentials.

</details>

<details>
<summary><strong>I set <code>permissionMode: auto</code> and the dashboard still asks me to approve things.</strong></summary>

`auto` is Claude Code's classifier mode, and it is already the default: it allows what it judges safe and
still asks about the rest. It also only exists for Sonnet 5, Opus 4.7 and later, and Fable. For any other
model, Haiku included, Claude Code accepts the flag and then silently runs the session in its ordinary
prompting mode, which asks before every file write and command; `cao validate` warns about such a task.
Give it `acceptEdits`, `dontAsk` with an `allowedTools` list, or `bypassPermissions` in an isolated
environment; `permissionPrompts: deny` keeps the mode but fails fast instead of waiting for you. The full
table of modes is in [docs/configuration.md](docs/configuration.md#claude-workflow-template-or-task-level).

</details>

<details>
<summary><strong>A task stopped with <code>needs_input</code> and I never saw a prompt.</strong></summary>

Something asked for a human and nobody could answer. `cao status` and `cao task <run> <task>` show what
it was: the command, the file change or the question, quoted. The usual causes are a headless run
(`--no-tui`, CI), a prompt nobody answered within `execution.interactionTimeout`, or a Codex task on the
default `exec` transport — that transport cannot be asked anything at all, which `cao validate` says up
front. Answer it with `cao resume <run> --task <id> --input "..."`, or change the task so it can ask:
`claude.permissionPrompts: ask` with the dashboard attached, or `codex.transport: appServer` with
`codex.approvals: host`.

</details>

<details>
<summary><strong>The worker said it was done, but the task did not complete.</strong></summary>

The contract asks the worker to end with a JSON object; a worker that ends with prose instead ("Success -
implemented the change") has produced no result. `cao` now asks that same session for the object before it
spends a retry (`retry.resultNudges`), and `cao task <run> <task>` shows the `nudge` attempt and, if it still
failed, the exact validation error. Smaller models do this often; see
[docs/models.md](docs/models.md#smaller-models).

</details>

<details>
<summary><strong>A parallel task failed to merge. Where is its work?</strong></summary>

On its `orchestrator/<task-id>` branch, which is kept when a merge fails. `cao diff <task>` shows the
change; `cao clean --branches` removes the branches once you are done with them.

</details>

## Documentation

| Document | What it covers |
|---|---|
| [docs/capabilities.md](docs/capabilities.md) | **What you can express.** Every feature with its smallest working example, task-oriented |
| [docs/models.md](docs/models.md) | **Agents, models and effort.** Catalog, effort levels, resolution order, cost control |
| [docs/configuration.md](docs/configuration.md) | The complete workflow YAML schema reference |
| [docs/agent-cli-integration.md](docs/agent-cli-integration.md) | The exact command line each agent receives and how results are interpreted |
| [docs/architecture.md](docs/architecture.md) | Internals: state machines, scheduler, persistence, isolation |
| [docs/desktop.md](docs/desktop.md) | The `cao`/desktop app contract: the registry, the `emit` switch, presence, the trust boundary |
| [examples/](examples/) | Runnable workflows: sequential, parallel, PRD implementation, reviews, context passing, model selection, agent smoke tests |
| [CHANGELOG.md](CHANGELOG.md) | What changed in each release |

## Development

```bash
git clone https://github.com/QuillDawg/code-agent-orchestrator.git
cd code-agent-orchestrator
npm install
npm run build
npm link            # provides `cao` and `code-agent-orchestrator` from your checkout
```

```bash
npm run typecheck
npm run lint        # eslint (flat config, type-aware) over src and test
npm test            # unit + integration; runs against a fake agent, no API calls
npm run test:agents # checks the argv CAO emits against the installed CLIs' --help; skips if they are absent
npm run build
npm run dev -- run examples/sequential-issues.yaml --dry-run
```

Node 22 is pinned in `.nvmrc`, and `.editorconfig` carries the whitespace conventions. CI runs typecheck,
lint, test and build on Node 22 and 24, on Linux and Windows. It needs a real `git` but never an agent CLI,
because the suites drive the fake agents in `test/fixtures/`.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains the fake agent, the test
layout, the commit style and what a pull request needs. Security issues go to [SECURITY.md](SECURITY.md),
not the issue tracker.

## License

MIT. See [LICENSE](LICENSE).

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/QuillDawg/code-agent-orchestrator/main/assets/logo-chip-dark.png">
  <img alt="cao" src="https://raw.githubusercontent.com/QuillDawg/code-agent-orchestrator/main/assets/logo-chip-light.png" width="96">
</picture>

<sub>Built by <a href="https://github.com/QuillDawg">QuillDawg</a> · <a href="#table-of-contents">Back to top ↑</a></sub>
</div>
