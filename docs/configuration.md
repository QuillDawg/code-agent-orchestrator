# Workflow configuration

A workflow is a YAML file validated with a strict schema (`cao validate`). It can run Claude Code or Codex tasks; unknown keys under `execution`, `git`, `hooks`, `claude`, `codex`, `retry` and `context` are errors.

## Top level

```yaml
version: 1                       # optional, only 1 is accepted
name: Authentication V2          # required
description: optional text
repository: .                    # resolved relative to the directory you launched cao from (NOT the YAML file)
variables:                       # {{variables.key}} / {{vars.key}}
  prd: docs/prd.md
environment:                     # passed to every worker; keys that look secret are redacted from logs
  NODE_ENV: development
envFile: .env.orchestrator       # KEY=value lines; every value is treated as a secret
agent: claude                    # default agent: claude (compatibility default) | codex
model: gpt-5.6-terra             # optional agent model default
effort: high                     # optional reasoning effort default
claude: { ... }                  # Claude-specific options
codex: { ... }                   # Codex-specific options
execution: { ... }
git: { ... }
defaults: { ... }                # task fields applied to every task
templates: { name: { ... } }     # reusable task bodies
hooks: { ... }
<any list key>: [...]            # collections for foreach, e.g. issues: [101, 102]
tasks: [ ... ]                   # required, at least one
```

### Repository and working directory rules

1. `--repository <dir>` on the command line wins.
2. Otherwise `repository:` in the YAML, resolved against the **launch directory** (`process.cwd()` when `cao` started), never against the YAML file's location.
3. Otherwise, with `execution.workingDirectoryStrategy: repositoryRoot` (default), the git top-level of the launch directory; with `launchDirectory`, the launch directory itself.

The resolved repository, the launch directory and the config path are printed in the startup header and stored in the run so `cao resume` always uses the original locations. Per-task `workingDirectory` is relative to the repository root and must stay inside it.

## `execution`

```yaml
execution:
  mode: sequential               # sequential (default) | dag
  maxConcurrency: 1              # >= 1
  workingDirectoryStrategy: repositoryRoot   # | launchDirectory
  workspaceStrategy:             # or a single string: shared | worktree
    sequential: shared           # workspace for tasks that run alone
    parallel: worktree           # workspace for tasks that may run concurrently
  allowUnsafeSharedParallel: false
  stopMode: wait                 # wait | cancel: what happens to running tasks when onFailure: stop fires
  killGrace: 5s                  # grace period before force-killing a worker (default 3s on Windows)
  outputBufferLines: 500         # in-memory rolling transcript entries per worker (scrolling past the top pages the rest in from disk)
  interactionTimeout: 30m        # how long a worker may wait for a human answer; "never" disables the limit
  worktree:
    directory: .orchestrator/worktrees   # relative to the repository root (may point outside it)
    branchPrefix: orchestrator/
    base: runStart               # runStart | headAtStart
    branchConflict: suffix       # suffix | reuse | fail   (when orchestrator/<id> already exists)
    mergeBack: true              # merge the task branch into the base branch on success
    mergeConflictStrategy: agent    # agent (default) | claude | codex | fail
    autoCommit: true             # checkpoint-commit uncommitted worktree changes before merging
    cleanup: onSuccess           # onSuccess | always | never   (branches are always kept; see `cao clean`)
    copyIgnored: []              # gitignored paths to copy into each worktree, e.g. [.env, .claude/settings.local.json]
```

### Execution order

The workflow is a DAG. In `sequential` mode (default) the following rules add implicit edges, walking tasks in document order with a "frontier":

1. A task with neither `dependsOn` nor `parallelGroup` depends on the frontier (initially nothing); it then becomes the frontier.
2. Tasks sharing a `parallelGroup` must be listed contiguously. Each member depends on the frontier as it was before the group; there are no edges between members; after the group the frontier is all members.
3. Explicit `dependsOn` replaces the implicit dependencies for that task (`dependsOn: []` makes a root). The task still becomes the frontier, so the next unadorned task runs after it. `cao validate` shows implicit edges so this is never a surprise.
4. `foreach` children chain sequentially unless the task or the items set `parallelGroup`.
5. `mode: dag` disables rules 1–3: only explicit `dependsOn` edges exist and `parallelGroup` is an error.

Tasks that can run concurrently (same layer of the plan with `maxConcurrency > 1`) use the `parallel` workspace; everything else uses the `sequential` workspace. Two tasks that could run concurrently in the same shared working tree are rejected unless `allowUnsafeSharedParallel: true`.

### Worktree base

`runStart` (default): every worktree branches from the commit recorded when the run started. A later parallel group therefore does not see an earlier group's merged work inside its worktree, although the merge-back still performs a proper three-way merge. Use `headAtStart` if later groups must build on earlier merged work.

## `git`

```yaml
git:
  enabled: true                  # false: no capture, no worktrees, everything shared
  requireCleanWorkingTree: false # true: refuse to start if the shared tree is dirty
  captureDiff: true              # write diff.patch / diff.json for every attempt
  maxDiffBytes: 2097152          # 2 MB cap on diff.patch; diff.json is never truncated
```

With `captureDiff` on, every attempt ends with its own `diff.patch` and `diff.json` in the attempt directory
(see [capabilities.md](capabilities.md#where-the-truth-lives)). A worktree task is diffed from its base commit
to its branch head; a shared-tree task from a snapshot of the working tree taken when the attempt started to
one taken when it ended, so changes the agent made through the shell — and files it created and deleted again
— are captured just as accurately as tool-driven edits. Snapshots are written to a throwaway git index and
never touch your index or working tree. A merge-resolution attempt gets its own patch, separate from the
task's work, whether or not that session succeeded.

`diff.patch` is a complete patch: it carries binary file contents and full blob ids, so
`git apply` (and `git apply -3`) accepts it on a checkout of `base`. For a worktree attempt `base` is a
commit you can check out; for a shared-tree attempt it is a tree object, which `git read-tree` and
`git archive` take but `git checkout` does not.

Past `maxDiffBytes` the patch is cut on a line boundary and ends with a note — a truncated patch no longer
applies — while `diff.json` still lists every file. Repositories with large binary assets reach the limit
sooner than the line counts in `diff.json` suggest, because the patch embeds those bytes. Secrets are
redacted from both, which can also make a patch containing one no longer apply cleanly.

The orchestrator never pushes, merges to remotes, opens PRs or closes issues. It adds `.orchestrator/` to `.git/info/exclude` on first use (it never edits your tracked `.gitignore`).

## Agents, models, effort, and permissions

> Full catalog, effort levels and cost guidance: **[models.md](models.md)**.

`agent`, `model` and `effort` may appear at workflow, `defaults`, template, task and `foreach` item level. They are agent-neutral: whichever agent the task uses receives them. Resolution per task, highest priority first:

1. `foreach` item override
2. task
3. template
4. `defaults`
5. workflow top level
6. `claude.model` / `claude.effort` — Claude only, legacy fallback

Two things that surprise people: `defaults` is a task layer, so `defaults.model` beats a workflow-level `model:`; and `claude.model` is the *lowest* priority, not the highest. `runner:` is a legacy alias for `agent:`; Claude is used when no agent is specified.

Codex has no `codex.model` key — for `agent: codex` the top-level/task-level `model:` is the only way to set a model.

Effort values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Claude accepts `low`–`max`; `none` and `minimal` are Codex-only, and `cao validate` warns if you set them on a Claude task (the flag is dropped rather than passed to a CLI that would reject it).

`cao validate --json` prints the resolved `agent`, `model` and `effort` for every task, and `cao task <run> <task>` shows them for a task that already ran.

```yaml
agent: codex
model: gpt-5.6-terra
effort: high
codex:
  permissionMode: auto           # auto | readOnly | fullAccess
  # Optional raw overrides; these win over the preset:
  sandbox: workspace-write       # read-only | workspace-write | danger-full-access
  approvalPolicy: on-request     # on-request | never
  command: codex
  addDirs: [../shared-lib]
  profile: team-default
```

`auto` maps to Codex's workspace-write sandbox with on-request approvals. `fullAccess` uses danger-full-access with approvals disabled; use it only in an appropriately isolated environment.

## `claude` (workflow, template or task level)

```yaml
claude:
  command: claude                # binary or "node path/to/script.mjs"; env CAO_CLAUDE_COMMAND overrides
  permissionMode: auto           # auto | acceptEdits | dontAsk | bypassPermissions | plan | manual
  model: sonnet
  effort: high                   # low | medium | high | xhigh | max
  maxBudgetUsd: 5
  allowedTools: ["Bash(git *)", "Edit"]
  disallowedTools: ["WebFetch"]
  addDirs: ["../shared-lib"]
  sessionPersistence: true       # false adds --no-session-persistence
  appendSystemPrompt: "Project conventions: ..."
  permissionPrompts: ask         # ask | deny (see below)
  extraArgs: []                  # passed verbatim to claude
```

**Permission modes.** `permissionMode` is handed to `claude --permission-mode` unchanged, and `auto` is what a task gets when nothing is set, so writing `permissionMode: auto` changes nothing. What each mode does to a worker:

| Mode | What Claude Code does |
|---|---|
| `auto` (default) | Auto mode: a classifier reviews every tool call, allows what it judges safe and **still asks** for the rest: destructive or broad shell commands, work outside the repository, anything it cannot classify. With a dashboard attached those are the prompts you answer; headless they are denied. |
| `acceptEdits` | File edits are allowed without asking; shell commands and everything else prompt as in `manual`. |
| `dontAsk` | Nothing prompts. Whatever is not allowed by `allowedTools` or your settings' allow rules is denied, `AskUserQuestion` included. |
| `bypassPermissions` | Every tool call is allowed. Only for an isolated environment. |
| `plan` | Read-only: the worker may not edit files or run commands. |
| `manual` | The CLI's ordinary interactive mode: it asks before most edits, commands and network access. |

**`auto` depends on the model.** Auto mode exists only for Sonnet 5, Opus 4.7 and later, and Fable. For any other model, Haiku included, Claude Code accepts `--permission-mode auto` and then silently starts the session in its ordinary prompting mode, which asks before every file write and command (the worker's init event reports `default`). `cao validate` warns about such a task, and the run log reports the mode a worker actually started in. On a model that does have auto mode, how often it asks depends on what the worker does: coarse shell commands (`rm -rf`, `git checkout --`, `sed -i`), work outside the repository or malformed tool input trip the classifier more often. For an unattended run, or any Haiku task, choose `bypassPermissions` in a sandbox, or `dontAsk` with an `allowedTools` list, or `acceptEdits` to at least stop the prompts for file edits; `permissionPrompts: deny` keeps the mode but fails fast instead of waiting for a human.

The worker also inherits your Claude Code settings (`~/.claude/settings.json`, the repository's `.claude/settings.json` and `settings.local.json`): `ask` rules and `PreToolUse` / `PermissionRequest` hooks there are evaluated before the permission mode and can prompt under any mode. `cao` does not pass `--bare`.

**Permission prompts and questions.** With `permissionPrompts: ask` (the default whenever a dashboard is attached) a worker's permission prompts and `AskUserQuestion` calls are routed to the dashboard over Claude Code's stdio control protocol: the task shows as **Needs you**, you answer with a key, the worker continues. Without a dashboard (`--no-tui`, CI, non-TTY) the worker runs with `--permission-prompts none` and everything that would prompt is denied, exactly as with `permissionPrompts: deny`. A denied worker is told to finish with `status: needs_input`, which pauses the run for `cao resume --input`. `execution.interactionTimeout` bounds how long a worker waits for you; `hooks.onInputRequired` lets you get notified.

**Subagent transcripts.** Everything a worker's subagents produce is nested in the transcript under the `Agent:` call that spawned it, collapsed until you press `t`. The runner probes `claude --help` once per configured command and adds `--forward-subagent-text` when the installed CLI advertises it, so a subagent's prose arrives too; on an older CLI only its tool calls do. There is nothing to configure.

> This changes what an *unattended* run with the dashboard open does. Where a prompt used to be denied immediately and the task moved on to `needs_input`, the worker now waits for a human for up to `execution.interactionTimeout` (default 30 minutes) per prompt, bounded by the task's own `timeout`. If you leave a run going with nobody watching, set `permissionPrompts: deny` (or run with `--no-tui`) to keep the old fail-fast behaviour, or shorten `interactionTimeout`.

## `defaults`, `templates` and tasks

Task fields (all optional unless noted):

```yaml
- id: implement-101              # required; letters, digits, . _ - (max 80)
  name: Implement issue 101
  type: implementation           # free metadata; "approval" makes an approval gate
  template: implementIssue       # merge order: defaults < template < task < foreach item overrides
  prompt: "/implement {{issueNumber}}"   # required after merging (or promptFile)
  promptFile: prompts/review.md  # relative to the workflow file
  agent: codex                   # optional task override: claude | codex
  model: gpt-5.6-sol             # optional task override
  effort: xhigh                  # optional task override
  dependsOn: [implement-100]
  parallelGroup: core
  workingDirectory: ./apps/api
  timeout: 60m                   # 90s, 10m, 1h30m, or milliseconds
  retries: 1                     # shorthand for retry.attempts
  retry:
    attempts: 1                  # retries after the first attempt
    includePreviousFailure: true # inject a "# Previous Attempt" section into the retry prompt
    resetWorkspace: false        # git reset --hard the reused worktree before retrying
    delay: 30s
    transientAttempts: 3         # automatic recoveries from API 5xx/overloaded/network errors (not counted in attempts)
    transientDelay: 30s          # wait before the first recovery; doubles each consecutive transient failure
    transientMaxDelay: 5m        # cap for that backoff
    resumeSession: true          # continue the same Claude session (--resume) instead of starting over
    resultNudges: 1              # times a session that ended without the JSON result is asked for just that (not counted in attempts)
  onFailure: stop                # stop | continue | skip_dependents
  runIfDependencyFailed: false
  context: { ... }               # see below; `context: false` disables
  when: { ... }                  # see below
  env: { FEATURE_FLAG: "1" }
  codex: { permissionMode: auto }
  workspace: worktree            # force shared | worktree for this task
  approval: true                 # alternative to type: approval
  foreach: issues                # expand over a top-level list or variables.<name>
  as: item                       # variable name for the current item (default item); {{index}} is also set
  foreachSequential: true        # ignore item-level parallelGroup
  issueNumber: 101               # any other key becomes {{issueNumber}}
```

### Template variables

`{{task.id}}`, `{{task.name}}`, `{{task.type}}`, `{{workflow.name}}`, `{{repository}}`, `{{launchDirectory}}`, `{{variables.x}}`, `{{env.X}}`, `{{item}}` / `{{item.field}}`, `{{index}}`, plus any custom scalar task field. Substitution is a plain dotted-path lookup: no helpers, no expressions, no code execution. Unknown placeholders are validation errors.

### `foreach`

```yaml
templates:
  implementIssue:
    type: implementation
    prompt: "/implement {{item.number}}"

issues:
  - number: 101
  - number: 102
    parallelGroup: auth
  - number: 103
    parallelGroup: auth

tasks:
  - id: implement
    foreach: issues
    template: implementIssue
```

Expands to `implement-101`, `implement-102`, `implement-103`.

**An item is either a scalar or an object, and the prompt must match.** A scalar item (`- 101`) is reachable only as `{{item}}`; an object item exposes its keys as `{{item.number}}`. Mixing the two under one prompt fails validation for whichever items lack the field, so keep a collection uniform. Object keys are *not* promoted to bare placeholders — `{{issueNumber}}` only resolves if `issueNumber` is a field on the task itself. Object items may override `name`, `type`, `parallelGroup`, `dependsOn`, `workingDirectory`, `timeout`, `retries`, `retry`, `onFailure`, `when`, `context`, `env`, `claude`, `workspace`, `prompt`, `template`. The id suffix comes from `id`, `key`, `number`, `issue` or `name`, otherwise the 1-based index. Referencing the source id (`dependsOn: [implement]`, `context.from: [implement]`) expands to all children.

### `context`

```yaml
context:
  from:
    - implement-101                       # exact id
    - "implement-*"                       # glob over task ids
    - task: prd-review
      include: [summary, warnings]        # field selector
  fromType: implementation                # all tasks of this type (string or list)
  include: [summary, filesChanged]        # default fields for sources without their own selector
  includeFailed: false                    # include failed/blocked sources (with their last summary/error)
  maxChars: 60000                         # truncation budget
```

Fields: `summary`, `filesChanged`, `commits`, `decisions`, `warnings`, `followUp`, `error`, `data`, `git`. The default set is everything except `data`. Sources must be (transitive) dependencies so their results are guaranteed to exist. The rendered markdown is stored as `context.md` and prepended to the prompt:

```
# Previous Task Context

## implement-101 — Implement issue 101 (status: success)
**Summary:** ...
**Files changed:**
- src/...
**Git:** branch `orchestrator/implement-101` @ abc1234567 (base def4567890)

---

# Task

<your prompt>
```

### `when`

```yaml
when:
  task: code-review
  status: success              # or a list
# or
when:
  expr: tasks.code-review.warnings.length > 0 && tasks["security-review"].status != "failed"
```

Grammar: comparisons (`==`, `!=`, `<`, `<=`, `>`, `>=`), `in`, `contains`, `&&`, `||`, `!`, parentheses, string/number/boolean/null literals, lists, and paths over `tasks.<id>.<status|state|summary|warnings|...>`, `variables`, `env`, `item`, `index`. No function calls, no arithmetic, no code evaluation. Referenced tasks must be (transitive) dependencies. A false condition skips the task; skipped tasks satisfy their dependents.

### Approval gates

```yaml
- id: production-ready
  type: approval
  prompt: Continue to final verification?
```

In the interactive dashboard the question is answered inline (`Y`/`N`/`D`efer, `M`/`R` with a note). Otherwise the run pauses with exit code 3 and continues with `cao resume <run> --approve production-ready` (or `--reject`).

### Live prompts from a worker

A Claude Code worker that hits a permission prompt or asks a question (`AskUserQuestion`) does not stop: the task enters the `waiting` state (**Needs you** in the dashboard), the dashboard shows the prompt, and the worker continues as soon as you answer. This needs no configuration. Relevant knobs:

```yaml
execution:
  interactionTimeout: 30m        # how long a worker may wait for you; "never" disables the limit
claude:
  permissionPrompts: ask         # ask (default with a dashboard) | deny (never prompt; headless behaviour)
hooks:
  onInputRequired: [ "..." ]    # notify yourself
```

When nobody answers in time, or no dashboard is attached, the prompt is denied with a message telling the worker to finish with `status: needs_input`. Codex workers never prompt: `codex exec` rejects approvals itself.

## `hooks`

```yaml
hooks:
  beforeWorkflow: npm install        # string or list
  beforeTask: [ "git status --short" ]
  afterTask: [ "git status --short" ]
  onTaskFailure: [ "echo failed $CAO_TASK_ID" ]
  afterWorkflow: [ "npm test" ]
  onInputRequired: [ "notify-send \"cao: $CAO_TASK_ID needs you\" \"$CAO_INTERACTION_TITLE\"" ]
```

Hooks are shell commands run from the repository root with `CAO_RUN_ID`, `CAO_TASK_ID`, `CAO_TASK_STATE`, `CAO_TASK_TYPE`, `CAO_WORKDIR`, `CAO_BRANCH` and `CAO_HOOK` in the environment. `onInputRequired` runs when a worker is waiting for a human answer (permission prompt or question) and additionally receives `CAO_INTERACTION_KIND` (`permission` | `question`), `CAO_INTERACTION_TITLE` and `CAO_INTERACTION_TOOL`; it never blocks the answer. Only commands written in the YAML ever run; nothing a worker prints is executed. `beforeWorkflow`/`beforeTask` failures abort; other hook failures are warnings.

> `CAO_INTERACTION_TITLE` and `CAO_INTERACTION_TOOL` are the only hook variables carrying agent-written text — for a `Bash` prompt the title is the first line of the command the agent wants to run. They are collapsed to a single line of at most 200 characters with control characters removed before being exported, but **always quote them** in a hook command (`"$CAO_INTERACTION_TITLE"`, as in the example above) and never pass them to `eval`.

## Failure and retry behaviour

| Outcome | Meaning | Retryable |
|---|---|---|
| `success` | validated result with status success | – |
| `failed` | worker reported failure, or exit without a valid result (`invalid_result`, after the session was asked for it, see below), non-zero exit (`crash`), `timeout` | yes |
| `api_error` | Claude Code exited because of a transient API/network problem (HTTP 5xx, overloaded, rate limit, connection reset) | yes, by resuming the session |
| `blocked` | worker reported it cannot proceed | no |
| `needs_input` | worker asked a question: run pauses; answer with `cao resume --task <id> --input "..."` | after input |
| `skipped` | worker reported nothing to do; dependents still run | – |
| `merge_conflict` | merge-back failed and the Claude resolution session could not fix it | no |

Retries start a brand-new session with the previous failure summarized in the prompt. When retries are exhausted `onFailure` applies: `stop` (default) launches nothing new and cancels the remaining tasks after in-flight tasks finish (`stopMode: cancel` aborts them); `continue` lets dependents run and shows the failure in their context; `skip_dependents` blocks descendants but keeps independent branches running.

### Transient API errors

Claude Code in print mode exits when the API keeps returning a server-side error (for example `API Error: 500 Internal server error` or `529 overloaded`) or the connection drops. The worker process is gone, but nothing is wrong with the task and the session transcript is still on disk, so the orchestrator treats this separately from a real failure:

1. The attempt ends with outcome `api_error` (the Attempts block of `cao task <id>` shows it as `transient API error`, and the next attempt says which session it continued; the dashboard logs `transient API error; resuming session`).
2. The task goes back to `ready` with a backoff delay: `transientDelay`, doubling on each consecutive transient failure up to `transientMaxDelay` (defaults 30s → 1m → 2m, capped at 5m).
3. The next attempt runs `claude -p --resume <session id>` with a short "# Session Resumed" prompt, so all the turns, tool results and edits from the interrupted session are kept. The worktree is reused as-is (`resetWorkspace` is ignored for a resumed session).
4. Up to `transientAttempts` consecutive recoveries are free; they do not consume `retry.attempts`. The failure that exceeds the transient budget counts as one regular failed attempt, and a regular retry (fresh session, previous failure injected) follows if `attempts` allows.

Set `resumeSession: false` (or `claude.sessionPersistence: false`, which makes resuming impossible) to recover with a fresh session instead; the previous failure is then injected like a normal retry. Set `transientAttempts: 0` to disable transient recovery entirely. Authentication, billing, context-length and max-turn/budget errors are never classified as transient.

### A worker that ends without the completion object

A session sometimes finishes its turn with prose ("Done, all tests pass.") instead of the JSON object the contract asks for, or with JSON the contract rejects. Smaller models do this often. The work is done and sits in that session, so throwing it away for a fresh attempt is the expensive answer:

1. The attempt ends with outcome `invalid_result`, as before.
2. If `retry.resultNudges` allows (default 1) and the session can be resumed (`resumeSession`, `claude.sessionPersistence`), the task goes straight back to `ready` and the next attempt runs `claude -p --resume <session id>` with a prompt that asks for only the JSON object, quoting what was wrong with the previous ending. `cao task` shows that attempt as `nudge`; the dashboard row says `asking for the result`.
3. A nudge that produces a valid result finishes the task as if the first attempt had; the `invalid_result` attempt is not counted against `retry.attempts`. A nudge that fails again counts as one regular failure, and `retry.attempts` decides what happens next: a fresh session with the failure injected, or `onFailure`.

Set `resultNudges: 0` to fail the attempt at once instead. Before the validator gets that far, results are read generously: `null` for a field that does not apply is treated as omitted, `status` is matched case-insensitively with the usual synonyms (`completed`, `done`, `ok`, `failure`, `error`, `needs input`), a missing `summary` is filled from `error` and noted in `warnings`, and the JSON object is the fenced block or trailing object that carries a `status`, not merely the last block in the message.

## Persisted state

After a task succeeds CAO updates the source workflow atomically, preserving comments and unrelated YAML content:

```yaml
- id: implement-101
  state: completed
  completion:
    completedAt: 2026-09-03T12:34:56.000Z
    runId: 20260903-123456-abc
```

A fresh `cao run` skips marked tasks. Selecting a task with `--task` or `--from` clears its marker before rerunning it. `foreach` tasks store child completion under `completion.tasks` so a partially completed collection can continue safely. The per-run snapshot below remains the authoritative execution history and recovery record.

```
.orchestrator/
  latest                        # id of the most recent run
  runs/<run-id>/
    workflow.json               # full run snapshot (resolved workflow, task states, attempts)
    events.jsonl                # append-only event log
    live.json                   # throttled live status for status/peek from other terminals
    lock.json                   # owning orchestrator pid + heartbeat
    orchestrator.log
    tasks/<task-id>/
      result.json               # final structured result (+ git info, usage)
      context.md                # what was injected into the prompt
      attempts/<n>/
        attempt.json
        prompt.md
        stdout.log              # raw stream-json from Claude
        stderr.log
        events.jsonl            # normalized activity/text/result events
  worktrees/<task-id>/          # parallel task worktrees
```

Secret values (from `envFile`, secret-looking `environment` keys and common token patterns) are redacted from everything persisted.

Redaction matches key names and known token shapes, so it cannot vet free-form content. Two kinds of bulk agent output are therefore kept out of the run-level `events.jsonl` entirely and live only under `attempts/<n>/`: worker output/transcripts, and the raw tool input of a permission prompt (whole file contents, complete shell commands) — the run log records just the interaction's id, kind, tool and title.
