<div align="center">

# Code Agent Orchestrator

### `cao` — run YAML-defined engineering workflows as a DAG of isolated Claude Code and Codex sessions

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
- [Workflow file cheat sheet](#workflow-file-cheat-sheet)
- [CLI reference](#cli-reference)
- [Environment variables](#environment-variables)
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
  `effort` per workflow, per template or per task.
- **Templates, variables and `foreach`.** Reuse a task shape, fan out over a list of issues, interpolate
  `{{variables.*}}` into prompts.
- **Conditions and gates.** `when:` expressions skip tasks; `type: approval` pauses for a human decision.
- **Interactive workers.** Claude Code permission prompts and `AskUserQuestion` questions appear in the
  dashboard. Headless runs deny them instead of hanging.
- **Failure handling that costs what you decide.** `retries`, `onFailure: stop | continue | skip_dependents`,
  timeouts, per-task budgets, and previous-failure injection on retry.
- **Transient API errors resume the same session** (5xx, overload, dropped connection) instead of restarting.
- **Everything on disk.** `.orchestrator/runs/<run-id>/` holds every prompt, result, transcript, diff and
  cost figure. Secrets are redacted.
- **Per-task diffs and a run report.** `cao diff`, `cao report`, and `report.md` written at the end of every run.
- **Cross-platform.** Linux, macOS and Windows; CI runs on all of them.

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

The `@beta` tag is required until 1.0. A bare `npm install -g code-agent-orchestrator` will not resolve a
version yet.

Two binaries are installed, `cao` and `code-agent-orchestrator`, the same program under both names. `cao` is
a short name that npm does not reserve, so it can lose to a shell alias or another tool on your PATH. If
`cao --version` does not print this package's version, use `code-agent-orchestrator` or alias `cao` to it.
Everything below writes `cao` for brevity.

### Check your machine

```bash
cao doctor
```

`doctor` checks Node, git, each agent CLI, stale lock files and leftover worktrees, and prints a fix hint
under anything that needs one. Run it first whenever something does not work.

## Quick start

Five minutes from install to a running workflow.

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
expected, stop and fix `repository:` or your current directory.

**4. While it runs**, from any other terminal:

```bash
cao status                       # progress table for the latest run
cao peek implement-102           # what is that worker doing right now?
cao logs implement-102 --follow  # its full transcript, live
cao diff implement-102           # what has it changed?
cao stop                         # interrupt the run, as Ctrl+C would
cao report                       # the whole run, ready to paste into a PR
```

**5. If it stops** (Ctrl+C, crash, failure, approval gate):

```bash
cao list
cao resume <run-id>
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
  `commits`, `decisions`, `warnings`, `followUp`, `error`, `data`) that validates against a schema.
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

`cao run` opens a live terminal dashboard. Every row is a worker: its state, agent and model, elapsed time,
cost, context size, and an **activity column** showing the tool, command or line of prose it is on right
now. After 30 seconds of silence the cell gains `… 2m idle`, so a thinking worker is distinguishable from a
stuck one.

When a worker needs you, a prompt appears in the dashboard (it reopens itself if minimised, and the terminal
bell rings): `Y` allow, `A` allow for the rest of the task, `N` deny, `R` deny with a reason. Questions list
their options; `T` types an answer. The worker continues the moment you answer. Set `hooks.onInputRequired`
to be notified elsewhere.

<details>
<summary><strong>Dashboard keys</strong></summary>

`↑↓` select · `Enter` details · `F`/`L` follow a worker's transcript · `U` usage (tokens, context, cost,
time in tools; `S` sorts by cost) · `C` review what each task changed · `R` restart a failed, blocked or
cancelled task · `?`/`H` help · `Esc` back · `Q` minimise (the run continues; `D` reopens it) ·
`Ctrl+C` stop (twice to force).

</details>

<details>
<summary><strong>Transcript viewer keys</strong> (<code>F</code> in the dashboard, or <code>cao logs --follow</code>)</summary>

`←`/`→` or `Tab` switch tasks · `1`-`9` jump to one · `P` task picker · `[`/`]` switch attempts ·
`↑↓`/`PgUp`/`PgDn` scroll · `g` oldest line · `Shift+G` newest line and follow again · `t` expand tool
output and subagent entries · `T` show thinking · `/` search with `n`/`N` for next and previous match ·
`k` cycle the kind filter (all → text → tools and commands → errors and questions) · `Q`/`Esc` leave.

Scrolling above the oldest line still in memory pages older entries in from the attempt's `events.jsonl`,
so the whole transcript is reachable.

</details>

<details>
<summary><strong>Review keys</strong> (<code>C</code> in the dashboard)</summary>

The list shows every task's files with `A`/`M`/`D`/`R` and `+N -M`. `↑↓`, `PgUp`/`PgDn`, `g`/`G` move ·
`Enter` opens that file's hunks · `O` opens it in `$VISUAL`/`$EDITOR` · `Esc`/`Q` back. In the hunk pane:
`N`/`P` jump between hunks · `←`/`→` previous or next file · `Esc` returns to the list.

</details>

Prefer plain text? `cao run --no-tui` prints a log instead, and `cao run --activity` adds the activity
column to it. Every command has a `--json` counterpart for scripting.

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
  interactionTimeout: 30m        # unanswered prompts are denied after this

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

| Command | What it does |
|---|---|
| `cao run [workflow]` | Create and execute a run. Refuses to start while another orchestrator owns a run in the same repository. `--dry-run`, `--task <id>`, `--from <id>`, `--max-concurrency N`, `--permission-mode M`, `--repository <dir>`, `--claude-command <cmd>`, `--no-tui`, `--activity`, `--verbose` |
| `cao validate [workflow]` | Schema and semantic validation plus the execution plan, with the resolved agent, model and effort per task. `--repository <dir>`, `--json` |
| `cao resume [run]` | Continue an interrupted, failed or paused run. `--no-retry-failed`, `--approve <task>`, `--reject <task>`, `--task <id> --input "<text>"`, `--from <id>`, plus the `cao run` overrides |
| `cao status [run]` | Progress table, run directory and orchestrator pid. `--json` |
| `cao list` | Runs of this repository, newest first. `--limit N`, `--json` |
| `cao logs [run] [task]` | A worker's transcript as one document. `--follow` opens the viewer; `--thinking`, `--raw`, `--stderr`, `--prompt`, `--attempt N`, `-n N`, `--json` |
| `cao peek [run] <task>` | What a worker is doing right now, with context size, cost and files. `--follow`, `--json` |
| `cao task [run] <task>` | Everything recorded about one task: status, model, attempts, PID, cwd, branch, dependencies, usage, changed files, interactions. `--json` |
| `cao diff [run] [task]` | What a task changed, as a unified diff `git apply` accepts. `--stat`, `--name-only`, `--file <path>`, `--attempt N`, `--json` |
| `cao report [run]` | The run as a document to paste into a pull request. `--json`, `--out <file>` |
| `cao stop [run]` | Interrupt a run from another terminal, as Ctrl+C would; twice to kill workers immediately. `--wait <seconds>` |
| `cao clean [run]` | Remove what a run left on disk. `--worktrees` (default), `--branches`, `--all` |
| `cao doctor` | Check Node, git, the agent CLIs, stale locks and leftover worktrees, with a fix hint under each failing check. `--repository <dir>`, `--json` |

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
`cao diff 004` work. An ambiguous prefix is refused with the candidates listed. Every command's `--help`
ends with worked examples.

## Environment variables

Read by `cao` itself. Everything else in your environment passes through to the agent processes.

| Variable | Effect |
|---|---|
| `CAO_CLAUDE_COMMAND` | The Claude CLI to launch instead of `claude`. A command line, not only a path, so `node test/fixtures/fake-claude.mjs` works. `--claude-command` overrides it |
| `CAO_CODEX_COMMAND` | The Codex CLI to launch instead of `codex`, same rules |
| `CAO_DEBUG` | Print the stack trace when a command fails |
| `CAO_ASCII` | Draw tables and status marks in ASCII. Guessed on a Windows terminal without a UTF-8 code page; `CAO_UNICODE=1` forces glyphs back on |
| `NO_COLOR` / `FORCE_COLOR` | Disable or force ANSI colour. `--color auto\|always\|never` wins where a command has it |
| `COLUMNS` | Table width when there is no terminal to ask, for piped output and CI logs |

Workflow hooks additionally receive `CAO_RUN_ID`, `CAO_RUN_STATE`, `CAO_TASK_ID`, `CAO_TASK_TYPE`,
`CAO_TASK_STATE`, `CAO_ATTEMPT`, `CAO_ATTEMPT_KIND`, `CAO_BRANCH`, `CAO_WORKDIR`, `CAO_HOOK` and, for
`hooks.onInputRequired`, `CAO_INTERACTION_KIND`, `CAO_INTERACTION_TITLE` and `CAO_INTERACTION_TOOL`.
See [docs/configuration.md](docs/configuration.md#hooks).

## Troubleshooting and FAQ

<details>
<summary><strong>Something does not work. Where do I start?</strong></summary>

`cao doctor`. It checks Node, git, each agent CLI, stale `lock.json` files, leftover worktrees and whether
`.orchestrator/` is git-ignored, and prints the fix under each failing line. Attach `cao doctor --json` to a
bug report.

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

It is paused on an approval gate or a worker that returned `needs_input`. Answer it:

```bash
cao resume <run-id> --approve <task>
cao resume <run-id> --task <task> --input "Use the v2 endpoint."
```

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
| [examples/](examples/) | Runnable workflows: sequential, parallel, PRD implementation, reviews, context passing, model selection |
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
npm run build
npm run dev -- run examples/sequential-issues.yaml --dry-run
```

Node 22 is pinned in `.nvmrc`, and `.editorconfig` carries the whitespace conventions. CI runs typecheck,
lint, test and build on Node 22 and 24, on Linux and Windows. It needs a real `git` but never an agent CLI,
because the suites drive the fake Claude in `test/fixtures/`.

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains the fake agent, the test
layout, the commit style and what a pull request needs. Security issues go to [SECURITY.md](SECURITY.md),
not the issue tracker.

## License

MIT. See [LICENSE](LICENSE).

<div align="center">
<sub>Built by <a href="https://github.com/QuillDawg">QuillDawg</a> · <a href="#table-of-contents">Back to top ↑</a></sub>
</div>
