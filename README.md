<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/QuillDawg/code-agent-orchestrator/main/assets/logo-light.png">
  <img alt="Code Agent Orchestrator" src="https://raw.githubusercontent.com/QuillDawg/code-agent-orchestrator/main/assets/logo-dark.png" width="560">
</picture>

# Code Agent Orchestrator

### Run YAML-defined engineering workflows as a DAG of isolated Claude Code and Codex sessions

[![npm version](https://img.shields.io/npm/v/code-agent-orchestrator/beta?label=npm&color=cb3837)](https://www.npmjs.com/package/code-agent-orchestrator)
[![CI](https://github.com/QuillDawg/code-agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/QuillDawg/code-agent-orchestrator/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-3c873a)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-lightgrey)](#installation)

**Describe the work. `cao` runs it.**
One fresh agent per task · parallel tasks in their own git worktrees · structured results between them · everything persisted and resumable.

```bash
npm install -g code-agent-orchestrator@beta
```

</div>

---

> **Pre-1.0 beta.** This is the first release of the **2.0 line**, published under the `beta` npm tag. It is
> not the package's first release: `0.1.0-beta.1` through `0.1.0-beta.3` went out under the same tag in
> September. The number jumped because 2.0 is the second-generation orchestrator rather than a patch on the
> 0.1 line — a persistent workspace you can reopen on any run, `cao ui`, task editing and prompting, a
> `cao doctor` that spends nothing unless you ask it to, and a second published package,
> `code-agent-orchestrator-protocol`, for surfaces that read run directories. **No workflow YAML key was
> added, removed or renamed**, so a 0.1 workflow file runs unchanged. Versioning is still pre-1.0: the
> schema, the CLI output and the library exports can change in a minor version, so pin an exact version if
> you depend on them and read the [CHANGELOG](CHANGELOG.md) before upgrading.


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
- [How it works](#how-it-works)
- [Watching a run](#watching-a-run)
- [The desktop app](#the-desktop-app)
- [Workflow file cheat sheet](#workflow-file-cheat-sheet)
- [CLI reference](#cli-reference)
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
  [Codex-to-Claude](examples/codex-implementation-claude-review.yaml) review loops. Codex's default
  `exec` transport is the stable, unattended path and **cannot be asked anything**; the experimental
  `appServer` transport is what adds dashboard-mediated approvals. Which transport can do what is stated
  plainly in [docs/capabilities.md](docs/capabilities.md#choosing-the-agent).
- **Templates, variables and `foreach`.** Reuse a task shape, fan out over a list of issues, interpolate
  `{{variables.*}}` into prompts.
- **Conditions and gates.** `when:` expressions skip tasks; `type: approval` pauses for a human decision.
- **Interactive workers.** Claude Code permission prompts and `AskUserQuestion` questions, and Codex
  app-server approvals, appear in the dashboard. A worker blocked on a human is either `waiting` — the
  dashboard can answer it — or `needs_input`, which pauses the run holding the question for
  `cao resume --input`. It never hangs, and it never fails because nobody was there.
- **Failure handling that costs what you decide.** `retries`, `onFailure: stop | continue | skip_dependents`,
  timeouts, per-task budgets, and previous-failure injection on retry.
- **Transient API errors resume the same session** (HTTP 5xx and 429, overload, and connection, stream or
  network failures) instead of restarting.
- **Everything on disk.** `.orchestrator/runs/<run-id>/` holds every prompt, result, transcript, diff and
  cost figure. Secrets are redacted.
- **Per-task diffs and a run report.** `cao diff`, `cao report`, and `report.md` written at the end of every run.
- **Cross-platform.** Linux, macOS and Windows; CI exercises Linux and Windows.

## Installation

### Requirements

| Requirement | Why |
|---|---|
| **Node.js 22.12+** | The CLI itself (commander 15 sets the floor; `cao doctor` checks it) |
| **git** | Worktree isolation, diff capture, merge-back |
| **Claude Code 2.1.259+** and/or **Codex CLI 0.153.0+**, installed and authenticated | The workers. These are hard floors: below them every task fails at run start as a `config_error`. `cao doctor` checks the version, the authentication and the automation capabilities of each |

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
[The run ends and the workspace stays](docs/capabilities.md#the-run-ends-and-the-workspace-stays). To come
back to it later, or from a different terminal:

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

The three `documentation-*.yaml` examples are a cheap, bounded way to smoke-test the agent integrations
against a real CLI; the procedure is in
[docs/agent-cli-integration.md](docs/agent-cli-integration.md#smoke-testing-an-integration).

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
- **Persistence.** `.orchestrator/runs/<run-id>/` is immutable history: every prompt, result, transcript,
  diff and cost figure, with secrets redacted. It is what makes `cao resume` and `cao ui` work on a run that
  ended days ago. The layout is in
  [docs/configuration.md](docs/configuration.md#persisted-state).
- **Per-task diffs and a run report.** Every attempt ends with its own patch, replayable with `git apply`,
  and every run writes `report.md` when it ends.
- **Ctrl+C.** Stops scheduling, terminates worker process trees, persists `interrupted`, exits `130`.
  `cao stop` does the same from another terminal.

Deeper reading: [docs/capabilities.md](docs/capabilities.md) for what you can express,
[docs/agent-cli-integration.md](docs/agent-cli-integration.md) for the exact argv each agent receives, and
[docs/architecture.md](docs/architecture.md) for the internals.

## Watching a run

`cao run` opens a persistent terminal workspace: a header (repository, run id, workflow, run state, elapsed,
concurrency, owner/observer badge), a sidebar task list, a tabbed main panel — **Overview · Session · Logs ·
Changes · Report · Diagnostics** — and a footer with the keys of whatever has focus. The Overview leads with
the run's outcome and a task table: state, elapsed, agent, context size, cost, changed files, and the tool,
command or line of prose each worker is on right now. From there you read any worker's transcript a page at
a time, answer a permission prompt or a question, edit an unfinished task, say something to a running one,
review what a task changed, and stop or re-run a task.

When a worker needs you, a prompt appears in the workspace — it reopens itself if minimised, and the
terminal bell rings — and the worker continues the moment you answer. Set `hooks.onInputRequired` to be
notified elsewhere.

**The workspace stays open when the run ends**, whether it succeeded, failed or was interrupted, with the
reason and the resume actions on screen. `cao ui <run-id>` reopens it later from any terminal, on a run this
one owns or one that finished days ago; a second terminal attaches as a read-only observer.

The full tour — every tab, every key, the composer, the task editor, the ended-run actions and the quota
footer — is [docs/capabilities.md § The workspace](docs/capabilities.md#the-workspace).

Prefer plain text? `cao run --no-tui` prints a log instead, and `cao run --activity` adds the activity
column to it; a non-TTY or `CI` gets that automatically, with no flag needed. Every command has a `--json`
counterpart for scripting.


## The desktop app

`cao` stays a standalone CLI — nothing here is required, and a run with no desktop app watching it behaves
exactly as it always has. What it gained is one capability: telling a separate desktop application,
`cao-desktop`, that a run exists, so that app can show live runs across several repositories without either
project importing the other.

```bash
cao emit enable                  # announce every run this user starts, from now on
cao run --emit                   # or announce just this one run
cao emit status                  # what is announced, where that decision came from, and who is watching
```

Turning it on writes nothing but a small, user-level heartbeat file under `~/.cao` — no network port, no
telemetry, and no change to how a run behaves when nobody is watching it.
[docs/desktop.md](docs/desktop.md) has the full contract: what gets written, the trust boundary, and how to
diagnose a desktop app that shows nothing.


## Workflow file cheat sheet

The keys you will use most. The complete schema is in [docs/configuration.md](docs/configuration.md).

```yaml
version: 1                       # required
name: My workflow
repository: .                    # relative to the launch directory

agent: claude                    # claude | codex           (workflow default)
model: opus                      # alias or full model id   (workflow default)
effort: high                     # none | minimal | low | medium | high | xhigh | max

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

The map, not the manual. Every command's own `--help` carries its full option list, worked examples and the
exit codes that command really produces; `cao` on its own prints this list, grouped the same way, and exits
`0`. A mistyped command is answered with the one it was probably meant to be.

### Run

| Command | What it does |
|---|---|
| `cao run [workflow]` | Create and execute a run, in the workspace by default. Refuses to start while another orchestrator owns a run in the same repository |
| `cao resume [run]` | Continue an interrupted, failed or paused run: retry what failed, approve or reject a gate, or carry an answer to a task that asked for one |
| `cao ui [run]` | Open the workspace on a run, or choose from the recent runs of this repository. Owner or observer, per [Watching a run](#watching-a-run). With no terminal it prints the list and exits `0` |
| `cao stop [run]` | Interrupt a run from another terminal, as Ctrl+C would; twice to kill workers immediately |
| `cao validate [workflow]` | Schema and semantic validation plus the execution plan, with the resolved agent, model and effort for every task |

### Inspect

| Command | What it does |
|---|---|
| `cao status [run]` | Progress table, run directory and orchestrator pid |
| `cao list` | Runs of this repository, newest first |
| `cao logs [run] [task]` | A worker's transcript as one document, or the live viewer |
| `cao peek [run] <task>` | What a worker is doing right now, with context size, cost and files |
| `cao diff [run] [task]` | What a task changed, as a unified diff `git apply` accepts |
| `cao report [run]` | The run as a document to paste into a pull request |

### Task controls

| Command | What it does |
|---|---|
| `cao task [run] <task>` | Everything recorded about one task: status, model, attempts, pid, cwd, branch, dependencies, usage, changed files, interactions. This is `cao task show`, the default subcommand; a task whose own name is a subcommand is reached with `cao task show <name>` |
| `cao task stop\|restart [run] <task>` | Cancel the attempt a task is running, or run a finished, unsuccessful task again. Applied by the process that owns the run: directly when that is this one, otherwise through a request it answers |
| `cao task prompt [run] <task>` | Say something to a task: steer the worker it is running, stop and continue it, or start a stopped task again carrying the message. Without a mode flag the one the task's state allows is chosen and printed |
| `cao task edit [run] <task>` | Change an unfinished task's prompt, agent, model, effort, timeout, retries or budget. Validated before anything is stopped |

### Diagnostics

| Command | What it does |
|---|---|
| `cao doctor [workflow]` | Check Node, git, the agent CLI versions a run requires, authentication and automation capabilities, the terminal, the storage the runs are written to, the protocol the run directories were written with, the sessions a follow-up would resume, which controls the installed CLIs can carry, the login mode behind the quota chips, stale locks, abandoned runs and leftover worktrees — with a fix hint under each failing check. `--probe` additionally starts each agent mode a run can use, which costs a small model call; without it nothing is started and nothing is spent |
| `cao diagnostics [run]` | One JSON file describing a run, to attach to a bug report: doctor facts, the redacted workflow, the run events, the orchestrator log and every attempt record. Everything passes through the run's redactor and nothing is uploaded. `--out <file>` is required |
| `cao clean [run]` | Remove what a run left on disk: worktrees, branches, or both |
| `cao emit [action]` | `enable`/`disable`/`status` — turn announcing a run to a desktop app on or off for this user, or show the whole precedence chain |

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

**Environment variables.** `cao` reads a dozen of its own, from `CAO_CLAUDE_COMMAND` to `CAO_THEME`, and
everything else in your environment passes through to the agent processes. The table is in
[docs/configuration.md](docs/configuration.md#environment-variables); `cao --help` prints the same list.


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
| [docs/capabilities.md](docs/capabilities.md) | **What you can express.** Every feature with its smallest working example, task-oriented, and the full workspace tour |
| [docs/models.md](docs/models.md) | **Agents, models and effort.** Catalog, effort levels, resolution order, cost control |
| [docs/configuration.md](docs/configuration.md) | The complete workflow YAML schema, the `.orchestrator/` layout and the environment variables |
| [docs/agent-cli-integration.md](docs/agent-cli-integration.md) | The exact command line each agent receives and how results are interpreted |
| [docs/desktop.md](docs/desktop.md) | The `cao`/desktop app contract: the registry, the `emit` switch, presence, the trust boundary |
| [docs/architecture.md](docs/architecture.md) | **For contributors.** Internals: module layout, state machines, scheduler, persistence, isolation |
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
npm run test:agents # checks the argv `cao` emits against the installed CLIs' --help; skips if they are absent
npm run build
npm run dev -- run examples/sequential-issues.yaml --dry-run
```

The Node 22 line is pinned in `.nvmrc` and `engines.node` is `>=22.12.0`, the floor commander 15 sets;
`.editorconfig` carries the whitespace conventions. CI runs two jobs, both on Linux and Windows: `check`
(typecheck, lint, test and build, on Node 22 and 24) and `package` (a smoke test of the packed tarball, the
Ink >= 7.0.6 assertion, and `npm audit --omit=dev --audit-level=high`). It needs a real `git` but never an
agent CLI, because the suites drive the fake agents in `test/fixtures/` — which is also why
`npm run test:agents` is not part of it.


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