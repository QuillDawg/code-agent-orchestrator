# Feature research: expanding the `cao` user experience

**Date:** 2026-09-03
**Status:** research, not a commitment
**Companion:** [landscape-notes.md](landscape-notes.md) holds the primary-source facts about comparable tools. This document cites them as `[L§n]`, where `n` is the section number in that file; every bullet there carries the URL it was fetched from.
**Visual summary:** the "cao Feature Atlas" artifact (value-versus-effort matrix, filterable catalog, first slice).

## 1. Purpose and method

This document answers one question: *which features would make Code Agent Orchestrator materially more productive and friendlier for the person who writes and runs workflows?*

Method:

1. Read the current product end to end: README, `docs/`, the CLI surface (`src/cli/program.ts`), the scheduler, the Ink dashboard, the runners and the examples.
2. Walk the user journey (author → validate → run → watch → answer → review → ship → repeat) and note where the tool makes the user do work it could do for them.
3. Check comparable tools against primary sources (official docs, changelogs, source repositories) to see which of these gaps the ecosystem has already solved and how. A background research pass produced `landscape-notes.md` with 159 cited facts across seven areas.
4. Score every candidate on user value and implementation effort, and group them into a Now / Next / Later roadmap.

Nothing here changes the product's core stance: the orchestrator stays the deterministic manager, agents stay disposable workers, and the only channel between tasks stays an explicit, inspectable context section. Every proposal was checked against that stance; the two that strain it (session continuation, dynamic sub-tasks) say so.

## 2. Where `cao` stands today

Strengths worth protecting:

- **Correctness core.** Persist-before-act, validated completion contract, monotonic attempts, transient API recovery that resumes the same session. Most orchestration scripts in the wild lose work on a 529.
- **Isolation that is visible.** Worktrees per parallel task, `--dry-run` that shows the plan, `context.md` and `prompt.md` on disk for every attempt.
- **Live human-in-the-loop.** Permission prompts and `AskUserQuestion` calls surface in the dashboard and the worker continues without restarting. Headless runs deny instead of hanging.
- **Model economics per task.** `agent`/`model`/`effort` at five levels, cost recorded per attempt.

Gaps observed in the code and docs (each maps to a feature in §4):

| Observed gap | Where | Feature |
|---|---|---|
| First workflow is written by hand from docs; no scaffolding | no `init` command in `program.ts` | A1 |
| Schema exists as zod and `zod-to-json-schema` is already a dependency, but no JSON Schema is published for editors | `src/config/schema.ts`, `package.json` | A2 |
| Environment problems (missing CLI, unauthenticated, stale lock, orphan worktrees) surface only at run time | `validate` probes CLIs; nothing checks auth, locks, worktrees | A3 |
| Run ids and task ids must be typed exactly | no completion command | A4 |
| Notifications exist only as user-written shell hooks | `hooks.onInputRequired` | D1 |
| A prompt can be answered only inside the in-process dashboard | `scheduler.handleInteraction` races the dashboard handler | D2 |
| No way to change course mid-task other than Ctrl+C | `protocol.ts` speaks the stdin control protocol, so the transport exists | D3, D4 |
| Codex workers can never ask; every approval is rejected by `codex exec` | `docs/configuration.md` "Codex workers never prompt" | D9 |
| Dashboard shows changed-file *counts* and a file list, not the diff | `C` key in `tui/app.tsx` | D6 |
| The run ends with a summary table; the user then assembles a PR description by hand | `render/plain.ts` summary | E1, E2 |
| No cross-run view of cost or outcomes | `cao list` shows a table per run | E5 |
| Every task needs an agent; a deterministic check (`npm test`) can only be a hook, whose exit code is not a task result | `hooks.ts`, `states.ts` | B3 |
| No loop construct; "fix until tests pass" cannot be expressed | `graph.ts` is a pure DAG | B4 |
| `data` is free-form; downstream prompts trust its shape | `contract.ts` | B6 |
| Old runs and worktrees accumulate until `cao clean` is run per run | `clean.ts` | G1 |

### 2.1 What the landscape changes

Four findings from the primary sources reshape the recommendations rather than just supporting them.

1. **Claude Code is growing a first-party multi-session UI.** `claude --bg` dispatches background sessions, and `claude agents` groups them as Pinned / Ready for review / Needs input / Working / Completed with a peek panel where you can type a reply without attaching, plus `Notification` hook events `agent_needs_input` and `agent_completed` [L§1]. `cao`'s differentiation is therefore not "a dashboard for agents" but **workflow shape**: a DAG with a completion contract, typed context between steps, retries and gates. The dashboard features below (D1, D2, D4) should lean on that shape rather than compete on session management.
2. **Headless Claude Code is about to change its defaults.** `--bare` skips discovery of hooks, skills, subagents, plugins, MCP servers and `CLAUDE.md`, and "will become the default for `-p` in a future release"; context is re-added with `--append-system-prompt`, `--settings`, `--mcp-config`, `--agents`, `--plugin-dir` [L§1]. `cao` should decide now whether a worker inherits the repository's Claude configuration, make it explicit in YAML (B8), and have `cao doctor` (A3) warn when the installed CLI flips the default.
3. **The stream carries more than `cao` reads.** `system/init` exposes `plugin_errors`, `mcp_server_errors` and a `capabilities` array "so a CI gate can fail on a non-empty array"; `system/api_retry` events carry attempt, delay and error category; subagent messages carry `parent_tool_use_id` and `--forward-subagent-text` lets a consumer rebuild the subagent tree [L§1]. These are cheap inputs for A3, D8 (nested subagent rows) and the transient-recovery classifier.
4. **Standalone agent UIs are consolidating; deep integration is where the value went.** Vibe Kanban is sunsetting ("we couldn't find a business model"), Crystal is deprecated and Auto-Claude is in maintenance mode, while OpenAI's Symphony (a repo-owned `WORKFLOW.md`, per-issue workspaces, ten concurrent agents) and Anthropic's routines and agent teams are first-party entrants [L§4, L§1]. A local web UI (D7) stays Later and minimal; the report, CI mode and delivery features (E1, F1, E2) matter more.

Two smaller facts that affect specific designs: Microsoft retired Office 365 Connectors, with final disablement in May 2026, so a Teams channel must use the Workflows webhook with an Adaptive Card payload [L§6]; and Codex exposes approvals as JSON-RPC requests in MCP-server / app-server mode, which makes interactive Codex workers possible (D9) [L§2].

## 3. The user journey and its friction

```
author ──► validate ──► run ──► watch ──► answer ──► review ──► ship ──► repeat
  A1-A5      A3,C1,C3    B3-B5    D5,D7,D8   D1-D4,D9   D6,E1,E3   E2,E4     E5,C2,G1
```

- **Author.** The YAML is expressive but the first one is slow to write. Users copy an example and edit blind; a typo in `execution.workspaceStrategy` is caught only by `cao validate`. Editors could catch it as they type.
- **Validate.** `cao validate` reports the plan and resolved models but not what it will cost or how long it will take. Users learn that after the money is spent.
- **Run.** Anything deterministic (install, test, lint, build) is either a hook or an agent prompt. Hooks cannot gate a task's result; agent prompts pay tokens to run `npm test`.
- **Watch.** The dashboard is strong for one run in one terminal. Long runs (hours) push people away from the terminal, and then the only signal is a bell and a hook they wrote themselves.
- **Answer.** "Needs you" is the single most valuable moment in the product and it is reachable only in the dashboard process. Away from the desk the run stalls for `interactionTimeout` and is then denied. Codex workers cannot ask at all.
- **Review.** The result is a merge commit per task and a summary paragraph. Seeing *what changed* means leaving `cao` for `git`.
- **Ship.** `cao` deliberately never pushes or opens PRs. Fine, but the hand-off is entirely manual: no report, no PR body, no link between run and PR.
- **Repeat.** Completion markers make re-runs safe, but there is no memory across runs: no cost trend, no "this template usually fails on review", no harvested follow-ups.

## 4. Feature catalog

Each entry: what it does, why it matters, a UX sketch, what it builds on in the current code, and evidence from the landscape notes. **Value** is user impact (1–5). **Effort** is S (days), M (a week or two), L (multi-week). **Tier** is Now / Next / Later.

### Theme A — Getting started

#### A1 `cao init` — scaffold a workflow interactively
- **What:** An interactive command that asks five questions (repository, agent, model, kind of work: issues / PRD / reviews / custom, parallel or sequential) and writes a commented `workflow.yaml` from the matching example. Detects installed agents and pre-selects one. `--template <name>` and `--yes` for non-interactive use.
- **Value:** Turns a 20-minute copy-and-edit into a 1-minute start. First-run experience is the strongest predictor of adoption for CLI tools.
- **Sketch:** `cao init` → `workflow.yaml` created, then `cao validate workflow.yaml` runs automatically and prints the plan.
- **Builds on:** `examples/*.yaml`, agent detection in `runners/*/detect.ts`, `validateCommand`. Prompt library: `@clack/prompts` or `@inquirer/prompts` [L§6].
- **Evidence:** `npm init` (`-y` skips questions), `uv init --app|--lib`, `cargo init`, `wrangler init`, `vercel init`, `npx ruflo@latest init wizard` all converge on the same pattern [L§6, L§4].
- Value 5 · Effort S · **Now**

#### A2 Published JSON Schema for editor validation and autocomplete
- **What:** `cao schema` prints the JSON Schema for a workflow file; `cao init` writes `# yaml-language-server: $schema=...` at the top of the file. Ship the schema in the npm package.
- **Value:** Errors appear while typing instead of at `cao validate`. Every key, enum and nested block becomes discoverable in VS Code / JetBrains without reading `configuration.md`.
- **Builds on:** `src/config/schema.ts` (zod), `zod-to-json-schema` is already a dependency.
- **Evidence:** YAML-driven tools publish a schema reference (Taskfile's schema page; Goose recipes have a fixed required-key shape) [L§5, L§4].
- Value 4 · Effort S · **Now**

#### A3 `cao doctor` — environment check
- **What:** Checks Node version, git and worktree support, each agent CLI's presence, version and authentication state, stale `lock.json` files, orphaned worktrees and branches, `.git/info/exclude`, whether the installed Claude CLI defaults `-p` to `--bare`, and Windows-specific pitfalls (long paths, CRLF). Prints a fix for every failure and exits non-zero when anything fails.
- **Value:** Most "it doesn't work" reports are environment, not workflow. A doctor command removes a support round-trip and is the natural place for the pre-flight checks the runners already do internally.
- **Builds on:** agent probing in `validate`, `WorkspaceManager.prepareRun` prune logic, `RunStore` lock handling. Feature detection from the stream's `system/init` `capabilities` array and `plugin_errors` / `mcp_server_errors` [L§1]; `codex login status` exits 0 when logged in [L§2].
- **Evidence:** `codex doctor` reports "installation, config, auth, runtime, Git, terminal, app-server, and thread inventory issues" [L§2]; `brew doctor` exits non-zero on problems, `flutter doctor -v`, `npx expo-doctor` [L§6].
- Value 4 · Effort S · **Now**

#### A4 Shell completions
- **What:** `cao completion bash|zsh|fish|pwsh` emits a completion script. Dynamic completion for run ids (from `.orchestrator/runs`) and task ids (from the latest run or the named workflow).
- **Value:** Run ids look like `20260903-123456-abc`; nobody types those twice. Task ids are the argument to eight commands.
- **Builds on:** `commander` has no native completion; a small generator in the `omelette`/`tabtab` style.
- **Evidence:** `gh completion -s bash|zsh|fish|powershell`, `codex completion` for the same four shells, `just --completions SHELL` [L§6, L§2, L§5].
- Value 3 · Effort S · **Now**

#### A5 User-level configuration
- **What:** `~/.cao/config.yaml` for defaults that are about the person, not the workflow: default agent and model, notification channels (D1), dashboard preferences, retention (G1). Workflow YAML still wins.
- **Value:** Stops the same `agent`/`model`/`hooks.onInputRequired` block being pasted into every workflow.
- **Builds on:** `config/loader.ts` merge order.
- **Evidence:** Codex layers CLI flags > project `.codex/config.toml` > profile > `~/.codex/config.toml` > `/etc/codex/config.toml` [L§2]; `gh config` holds per-user keys such as `spinner` and `accessible_colors` [L§6].
- Value 3 · Effort S · **Next**

### Theme B — Authoring power

#### B1 `cao plan` — draft a workflow from a PRD or issue list
- **What:** Run a single agent session whose job is to *write the workflow*: read the PRD (or `gh issue list --label ...` output), propose tasks, dependencies, parallel groups and review stages, and emit `workflow.yaml` for the user to edit. The generated file carries the `$schema` header (A2) and is validated before it is saved.
- **Value:** The hardest part of using `cao` on a real feature is decomposing it into a DAG. This uses the agent for the one thing it is good at (decomposition) and keeps execution deterministic.
- **Sketch:** `cao plan docs/prd/auth-v2.md --issues "label:auth-v2" -o workflow.yaml`
- **Builds on:** `ClaudeRunner` with a fixed system prompt and the workflow JSON Schema as `--json-schema` [L§1]; `validateCommand`.
- **Evidence:** Devin waits on its plan for approval and Jules requires plan approval before acting [L§3]; Kiro specs split work into `requirements.md`, `design.md`, `tasks.md` and run independent tasks in waves [L§4]; Symphony keeps a repo-owned `WORKFLOW.md` [L§4].
- Value 5 · Effort M · **Next**

#### B2 Workflow includes and a shared template library
- **What:** `include: [../shared/templates.yaml]` merges `templates`, `defaults` and collections from other files; `~/.cao/templates/` holds user-level templates addressable as `template: lib/implementIssue`.
- **Value:** Teams converge on a handful of task shapes (implement, review, test, docs). Today each repository copies them.
- **Builds on:** `config/normalize.ts` template merge; path confinement rules from `promptFile`.
- **Evidence:** GitHub Actions reusable workflows (`workflow_call`, up to ten nesting levels) [L§5]; Goose `sub_recipes` run in isolation with no nesting [L§4].
- Value 3 · Effort M · **Later**

#### B3 Command tasks — deterministic steps without an agent
- **What:** A task with `run:` instead of `prompt:` executes a shell command in the task's workspace. Exit code 0 is `success`, non-zero is `failed` with the stdout/stderr tail as the `error` and a `data` block with the exit code. It participates in `dependsOn`, `context`, `when`, retries and `onFailure` exactly like an agent task.
- **Value:** "Run the tests, and only if they pass run the review" is the most common gate in real workflows. Today it costs an agent session or is a hook that cannot fail the task. Command tasks are cheaper, faster, and give `when` a reliable signal.
- **Sketch:**
  ```yaml
  - id: test
    run: npm test
    timeout: 10m
  - id: fix
    when: { task: test, status: failed }
    context: { from: [test], include: [error] }
    prompt: The test run in context failed. Fix it.
  ```
- **Builds on:** `ProcessManager.spawn`, `TaskRunner` interface (a `CommandRunner` registered in `RunnerRegistry`), `hooks.ts` environment variables.
- **Evidence:** Every CI system treats shell steps as first-class; Argo `depends` supports `.Succeeded/.Failed/.Skipped` conditions; GitHub Actions `needs` skips dependents of a failed job unless a conditional says otherwise [L§5]. Aider ships `--auto-test` / `--test-cmd` for the same loop [L§4].
- Value 5 · Effort M · **Now**

#### B4 Loops — `until` with a bounded iteration count
- **What:** A task (or a small group) may declare `until: { task: test, status: success }` and `maxIterations: 5`. The scheduler re-runs the loop body, feeding the previous iteration's results as context, until the condition holds or the budget runs out. Each iteration is a new attempt with its own record.
- **Value:** Implement → test → fix is the canonical agent loop and is impossible to express in a pure DAG. Users currently hand-roll it with retries, which lose the structure.
- **Builds on:** `retry` machinery (attempts are already monotonic), `conditions/evaluator.ts`, `context-builder`. Requires a `loop_iteration` transition in `states.ts` and plan rendering in `--dry-run`.
- **Trade-off:** Keep the DAG acyclic at validation time by modelling the loop as a single node with an iteration counter; never allow arbitrary back-edges.
- **Evidence:** The Ralph pattern (a fresh agent per iteration, `max_iterations` default 10, exit on a completion promise) and Anthropic's `ralph-wiggum` plugin with `--max-iterations` and `--completion-promise` [L§4]; OpenHands `max_iterations` (100) plus a stuck detector that flags a repeating action-observation pair [L§4]; Claude Code `/loop` with a task cap [L§1].
- Value 5 · Effort L · **Next**

#### B5 Dynamic sub-tasks from a planning task
- **What:** A task may declare `expands: true`; its result's `data.tasks` (validated against the task schema) is appended to the run as children that depend on it, then scheduled normally. Children are persisted in `workflow.json` and shown in the dashboard under the parent.
- **Value:** "Read the PRD, split it into issues, implement each in parallel, then review" becomes one workflow instead of B1 followed by a second run.
- **Trade-off:** This strains "the workflow is the plan". Mitigate with a hard cap (`maxExpansions`), an approval gate before the children launch, and the children rendered back into the source YAML so the run is reproducible.
- **Builds on:** B6 (typed results), `run-factory.ts`, `plan.ts`.
- **Evidence:** Claude Code agent teams keep a shared task list with file-locked claiming and dependencies, and cost "approximately 7x more tokens" when teammates plan [L§1]; Symphony spawns one workspace per ticket with a concurrency cap of ten [L§4]. Both argue for a cap and a gate.
- Value 4 · Effort L · **Later**

#### B6 Typed results — `resultSchema` per task
- **What:** A task may declare `resultSchema:` (inline JSON Schema or a file). `cao` merges it into the completion contract's `data` field, passes it to the agent as the structured-output schema, and validates the result; a mismatch is `invalid_result` with a precise message. Downstream `context` and `when` can rely on the shape.
- **Value:** Pipelines that pass data (analysis → action) break silently today when the agent changes the shape. Typed results make `when: { expr: tasks.analyze.data.tables.length > 0 }` safe.
- **Builds on:** `runners/claude/contract.ts` already passes a JSON Schema to `claude --json-schema`; Codex `--output-schema` likewise.
- **Evidence:** Claude Code `--json-schema` returns validated JSON in `structured_output` and rejects an invalid schema at start-up [L§1]; Codex `exec --output-schema` and the SDK's `outputSchema` (JSON Schema or Zod) [L§2]; Goose recipes declare a `response` JSON schema [L§4].
- Value 4 · Effort S · **Now**

#### B7 Inputs — variables from the command line and input tasks
- **What:** `cao run workflow.yaml --var issue=101 --var branch=feat/x` sets `{{variables.*}}`; `variables` may declare `required: true` with a description; `type: input` tasks prompt the user for a value mid-run (dashboard) or pause with exit code 3 (headless, answered via `cao resume --input`).
- **Value:** Makes one workflow reusable across issues without editing YAML, and lets a human supply a fact (an endpoint, a decision) at the point it is needed.
- **Builds on:** `templates/engine.ts`, the `needs_input`/`approval` states and modal.
- **Evidence:** GitHub `workflow_dispatch` typed inputs (`boolean|choice|number|environment|string`, max 25) [L§5]; Buildkite `block` steps with text/select `fields` whose values land in build meta-data for later steps [L§5]; Prefect `pause_flow_run(wait_for_input=...)` with a typed model [L§5]; Goose `--params K=V` [L§4].
- Value 4 · Effort S · **Now**

#### B8 Agent capability passthrough — MCP servers, skills, subagents, settings
- **What:** `claude.mcpConfig`, `claude.plugins`, `claude.agents` (subagent definitions), `claude.settings`, `claude.bare` and the Codex equivalents (`codex.mcpServers`, `codex.profile` exists already) as first-class, validated keys instead of `extraArgs`.
- **Value:** Real work needs tools (issue tracker, database, browser). Users can reach them via `extraArgs` today, but that is undocumented, un-validated and per-task copy-paste. It also makes the coming `--bare` default a non-event: `cao` states explicitly what a worker inherits.
- **Builds on:** `claude-runner.ts` argument builder, `agent-cli-integration.md`.
- **Evidence:** Claude Code `--mcp-config`, `--agents <json>`, `--plugin-dir`, `--settings`, `--bare` (planned default for `-p`), and the rule that `--mcp-config`/`--settings`/`--add-dir` must be passed again on `--resume` [L§1]; Codex `[mcp_servers.<name>]` with per-server timeouts and `default_tools_approval_mode` [L§2].
- Value 3 · Effort S · **Next**

### Theme C — Before you spend

#### C1 Cost and duration estimates
- **What:** `cao validate --estimate` and `--dry-run` print an estimated cost range and wall-clock duration per task and for the run. Sources, in order: history for the same task id / template / model in `.orchestrator/runs`, then the model catalog in `models.ts` with a per-effort token heuristic. Show the basis so nobody mistakes it for a quote.
- **Value:** "How much will this cost?" is asked before every non-trivial run and answered after. An estimate with a visible basis lets users choose models and effort with confidence.
- **Builds on:** `models.ts` pricing, `usage` in every `result.json`, `plan.ts` layers (the critical path gives the duration).
- **Evidence:** Claude Code's own cost figures are "client-side estimates" from a bundled price table, reported per model with a `costBasis` of `list|managed|unknown`, and a managed `modelPricing` setting supplies contracted rates [L§1, L§7]; Cursor and Devin ask for spend limits up front [L§7].
- Value 4 · Effort M · **Next**

#### C2 Run-level budget and cost guard rails
- **What:** `execution.maxBudgetUsd` for the whole run; when actual spend plus the estimate of what is still queued crosses it, the run pauses with exit code 3 and the dashboard shows an approval to continue. `retry.downgradeModel: sonnet` swaps to a cheaper model for retry attempts. A per-task token guard for Codex, which has no budget flag.
- **Value:** Turns cost from something you discover into something you control. Especially important for parallel groups, where three workers spend simultaneously.
- **Builds on:** `task.usage` events, `claude.maxBudgetUsd`, approval gate machinery.
- **Evidence:** Claude Code `--max-budget-usd` counts subagent spend and stops background subagents at the cap; the SDK result subtype is `error_max_budget_usd` [L§7]; `--fallback-model` gives an automatic downgrade when the primary model is overloaded [L§1]; Codex has token limits but "no dollar-budget flag" [L§7]; OpenHands `max_budget_per_task`, GitHub Copilot hard-stop budgets with 75/90/100 % alerts, LiteLLM per-key `max_budget` with `budget_duration` [L§7].
- Value 4 · Effort M · **Next**

#### C3 Prompt preview and edit before launch
- **What:** `cao run --confirm` shows each task's fully rendered prompt (context section included) before it launches, with `e` to open it in `$EDITOR` for this run only. Also `cao validate --render <task>` to print one prompt.
- **Value:** The rendered prompt is the product's real input and it is only visible after the fact (`prompt.md`). Seeing it first catches template mistakes and oversized context before tokens are spent.
- **Builds on:** `context-builder.ts`, `templates/engine.ts`, the launch step in the scheduler (`prompt.md` is already written before spawn).
- **Evidence:** Claude Code's agent view opens the dispatch prompt in `$EDITOR` with `Ctrl+G` [L§1]; Taskfile `--dry` and Just `--dry-run` print what would run [L§5].
- Value 3 · Effort S · **Now**

### Theme D — While it runs

#### D1 Built-in notifications
- **What:** A `notifications:` block (workflow or user config): channels `desktop`, `terminal` (OSC 9 toast and OSC 9;4 progress ring), `slack`, `teams`, `discord`, `ntfy`, `webhook`, `email`; events `needsInput`, `taskFailed`, `runFinished`, `approvalPending`, `budgetWarning`. Messages carry the run id, task id, the question text and a one-line "how to answer" (`cao answer ...`).
- **Value:** Long runs are attended remotely or not at all. A hook that the user has to write for each channel is a barrier; a config line is not.
- **Sketch:**
  ```yaml
  notifications:
    slack: { webhook: env:SLACK_WEBHOOK, on: [needsInput, taskFailed, runFinished] }
    teams: { workflowUrl: env:TEAMS_WEBHOOK }     # Workflows webhook + Adaptive Card
    desktop: { on: [needsInput] }
  ```
- **Builds on:** `hooks.onInputRequired` and the `EventBus`; secrets handling via `env:` references and redaction.
- **Evidence:** Claude Code fires a `Notification` hook with `agent_needs_input` / `agent_completed` and lets hooks emit `terminalSequence` for desktop notifications and bells "without a controlling terminal"; native desktop notifications only in Ghostty, Kitty and iTerm2, otherwise `terminal_bell` [L§1, L§6]. Codex has a `notify` command hook with a JSON payload [L§2]. Slack webhooks accept `{"text"}` or up to 50 Block Kit blocks at one request per second; Teams' Office 365 Connectors are retired (final disablement May 2026) in favour of Workflows webhooks with Adaptive Cards, 28 KB limit; ntfy needs only a `curl -d` with `X-Title`/`X-Priority`/`X-Actions`; iTerm2 `OSC 9` posts a notification and `OSC 9;4` drives a progress bar that Windows Terminal and ConEmu also render as a taskbar ring; `node-notifier` covers macOS, Linux and Windows desktops [L§6]. Prefect automations notify Slack, Teams and email from events [L§5].
- Value 5 · Effort M · **Now**

#### D2 Answer from anywhere
- **What:** Pending interactions (permission prompts, questions, approval gates, `needs_input`) are written to `live.json` / an `interactions/` directory. `cao answer [run] <task> --allow | --allow-task | --deny [--reason] | --choose 2 | --text "..."` from any terminal delivers the answer through a small IPC file (or a local socket) that the owning orchestrator watches. `cao status` already shows what is pending. Later, the same channel powers a Slack action button or a phone-sized web page (D7).
- **Value:** Removes the single biggest stall in unattended runs. Combined with D1 it closes the loop: notified on the phone, answered from the phone.
- **Builds on:** `scheduler.handleInteraction` (currently races only the dashboard handler), `RunStore`, the `FollowTailer` polling pattern for cross-process reads.
- **Evidence:** Claude Code's agent view peek panel lets you "type a reply without attaching"; the Agent SDK's `PreToolUse` hook may return `defer` to let the process exit and resume later, and `--permission-prompt-tool` routes prompts to an MCP tool in non-interactive mode [L§1]. Buildkite `block` steps unblock "via web or API"; Temporal distinguishes Signals (async) from Updates (validated, return a result) [L§5]. Slack interactive buttons need an HTTPS request URL answered within three seconds, which argues for a local answer channel first and chat buttons later [L§6].
- Value 5 · Effort M · **Now**

#### D3 Steer a running worker
- **What:** From the dashboard (`S`) or `cao steer <task> "text"`, send a message to a running Claude worker as a user turn over the stdio control protocol (the same transport the permission answers use). The message is recorded in the transcript and in `events.jsonl`.
- **Value:** "Stop, you're editing the wrong package" currently means Ctrl+C the whole run and re-run one task. A nudge keeps the session and its context.
- **Trade-off:** This is the one place a human and an agent share a conversation. Keep it explicit (recorded, visible, opt-in via `claude.allowSteering`).
- **Builds on:** `runners/claude/protocol.ts`, `ProcessManager.writeStdin`.
- **Evidence:** Claude Code accepts `--input-format stream-json` and queues follow-ups to a cloud session with `claude -p "msg" --cloud <id>` [L§1]; Vibe Kanban batches hover comments on a diff into the next chat message and Conductor sends diff line comments back to the agent [L§4]; Cursor and Copilot accept follow-up instructions mid-task [L§3].
- Value 4 · Effort M · **Next**

#### D4 Per-task controls in the dashboard
- **What:** Cancel one task (`X`), retry now with the prompt edited in `$EDITOR` (`E`), skip a task (`K`, marks `skipped` so dependents continue), pause scheduling of new tasks (`P`) while running ones finish. Headless equivalents: `cao cancel`, `cao skip`, `cao pause`.
- **Value:** Today the only intervention is `R` restart a failed task, and Ctrl+C for everything else. Fine-grained control is what makes people trust a long run.
- **Builds on:** `requestStop`, `states.ts` transitions (`running → cancelled`, `pending → skipped`), the dashboard controller.
- **Evidence:** Claude Code's agent view has stop, pin, rename and reorder keys [L§1]; `gh run rerun --failed|--job`; Temporal's UI offers Cancel, Signal/Update, Reset and Terminate; Prefect separates `Paused` (process alive) from `Suspended` (process exited) [L§5].
- Value 4 · Effort M · **Now**

#### D5 Timeline view
- **What:** `cao timeline [run]` and a `G` view in the dashboard: a Gantt-style chart of tasks by layer, actual start/end per attempt, waiting-for-human intervals highlighted, critical path marked, cost per bar. Static after the run; live while it runs.
- **Value:** Answers "why did this take three hours" at a glance: a serial bottleneck, a merge session, or forty minutes waiting for a permission answer.
- **Builds on:** `events.jsonl` timestamps (`task.started`, `task.finished`, `waiting`), `plan.ts` layers.
- **Evidence:** Dagster's run page leads with a Gantt chart; Temporal offers Timeline and Compact history views; Dagger's TUI draws the DAG "in a style similar to `git log --graph`" with per-step duration; GitHub Actions shows a real-time dependency graph [L§5].
- Value 3 · Effort M · **Next**

#### D6 Diff view and per-task review
- **What:** `cao diff [run] <task>` prints the task's diff (`git diff base..branch` or the captured diff for shared tasks); the dashboard `C` view opens the diff per file with syntax colouring, and `o` opens it in the editor / `git difftool`. Diffs are captured into the run directory so they survive `cao clean`.
- **Value:** Review is the step where trust is built or lost, and the tool currently stops at a file list.
- **Builds on:** `git.captureDiff` (already `true` by default), `WorkspaceManager.finalize` git capture, the transcript renderer.
- **Evidence:** Vibe Kanban reviews with unified or side-by-side diffs; Conductor has a diff viewer with line comments; Claude Squad previews diffs with `tab` [L§4]. Jules shows per-file mini diffs in its activity feed; Copilot, Cursor and Devin make the diff the primary review surface [L§3]; Claude Code on the web has a per-session diff view with inline comments [L§1].
- Value 4 · Effort M · **Now**

#### D7 Local web dashboard
- **What:** `cao ui` starts a local HTTP server over `.orchestrator`: run list, task grid, transcripts, diffs, timeline, pending interactions with answer buttons (via D2), cost. Read-only by default; `--allow-answer` enables answering.
- **Value:** The Ink dashboard is excellent for one person at one terminal. A web view makes a run shareable with a reviewer, viewable on a phone, and survives terminal resizes. It also becomes the natural home for D5 and E5.
- **Trade-off:** A second UI to maintain in a market where standalone agent UIs are folding. Keep both UIs consuming the same `EventBus`/`RunStore` views and render, never compute, in the browser.
- **Builds on:** `RunStore` read side, `live.json`, `FollowTailer`.
- **Evidence:** Vibe Kanban is sunsetting, Crystal is deprecated, Auto-Claude is in maintenance mode; OpenHands repositioned as a "self-hosted developer control center"; Conductor is a paid desktop app [L§4]. Prefect and Dagster ship a web UI as the primary run surface [L§5].
- Value 4 · Effort L · **Later**

#### D8 Dashboard ergonomics
- **What:** `/` filter by task id or state, collapse `foreach` groups into one row with counts, sort by cost or duration, a persistent "Needs you" tray at the top, relative-time columns (`started 12m ago`), a run picker to switch between runs in the same repository, and nested subagent rows under a task.
- **Value:** Runs with 20+ tasks (every `foreach` over an issue list) already overflow the table.
- **Builds on:** `tui/app.tsx`; subagent nesting from `parent_tool_use_id` and `--forward-subagent-text` [L§1]; Ink `<Static>` for a scrolling log above the live table [L§6].
- **Evidence:** Claude Code's agent view groups by state or directory (`Ctrl+S`) and shows a one-line summary per session [L§1].
- Value 3 · Effort S · **Now**

#### D9 Interactive Codex workers
- **What:** Run Codex through its app-server / MCP-server interface instead of `codex exec`, so `applyPatchApproval` and `execCommandApproval` requests reach the dashboard and `cao answer` exactly like Claude permission prompts do. Falls back to `codex exec` with approvals denied when no dashboard is attached.
- **Value:** Today Codex tasks either run with a wide sandbox or fail on the first approval. Parity with Claude removes the biggest reason to avoid `agent: codex` for implementation work.
- **Builds on:** `CodexRunner`, the interaction types in `types/interaction.ts`, the dashboard modal.
- **Evidence:** In MCP-server mode Codex sends `applyPatchApproval { conversationId, callId, fileChanges, reason?, grantRoot? }` and `execCommandApproval { conversationId, callId, command, cwd, reason? }` and the client replies `{ decision: "allow" | "deny" }`; `codex app-server` speaks stdio, WebSocket or a Unix socket; the TypeScript SDK exposes `approvalPolicy` and `runStreamed()` [L§2].
- Value 4 · Effort L · **Next**

### Theme E — After it finishes

#### E1 Run report
- **What:** `cao report [run] --md | --html | --json` produces a document: run header (workflow, repository, base commit, duration, cost), per-task summary, decisions, warnings, follow-ups, files changed, commits, and the attempt history. Markdown is written to fit a PR body; HTML is self-contained for sharing.
- **Value:** The run already has everything a reviewer wants; the user should not assemble it from `result.json` files.
- **Builds on:** `RunStore` read side, `result.json`, `context-builder` rendering.
- **Evidence:** GitHub Actions renders `$GITHUB_STEP_SUMMARY` Markdown on the run page (1 MiB per step) [L§5]; Prefect Markdown artifacts render in its UI with versions [L§5]; Claude Code `/export` writes a readable transcript and `/insights` writes an HTML report [L§1]; Copilot's PR body summarises what the agent did [L§3].
- Value 5 · Effort S · **Now**

#### E2 Opt-in delivery: push and open a PR
- **What:** A `delivery:` block (`push: true`, `pullRequest: { via: gh, draft: true, body: report }`) executed only after `afterWorkflow` succeeds, or on demand with `cao pr [run]`. Uses the E1 report as the body and links the PR back to the run id in `workflow.json`. Never enabled by default; the "never pushes" guarantee becomes "never pushes unless you turn this on".
- **Value:** Closes the last manual hop for teams that already review via PR.
- **Builds on:** `hooks.ts` execution, `git.ts` wrapper, E1.
- **Evidence:** Copilot opens a draft PR immediately and links commits to the session log; Cursor, Devin and Jules all end in a PR [L§3]. Claude Code background sessions "commit and push or open a draft PR to preserve work" before finishing, and routines accept pushes to `claude/`-prefixed branches [L§1]. Vibe Kanban's rule "nothing is pushed to remote until you explicitly create a PR" matches the opt-in stance [L§4].
- Value 4 · Effort M · **Next**

#### E3 Per-task accept and revert
- **What:** `cao revert [run] <task>` reverts that task's merge commit on the base branch (or restores the captured pre-task state for shared tasks), records the reversal in the run, and marks dependents as needing re-run. `cao accept` is the explicit counterpart used by a review flow.
- **Value:** A workflow with one bad task should not require a `git revert` archaeology session.
- **Builds on:** merge-back with `--no-ff` (each task is one merge commit, which makes this feasible), `git.ts`.
- **Evidence:** Claude Code `/rewind` restores code and/or conversation from up to 100 checkpoints, but does not track Bash-made file changes, which is why `cao` should revert at the git level [L§1]; Temporal `Reset` resumes from a history point [L§5].
- Value 3 · Effort M · **Later**

#### E4 Follow-up harvesting
- **What:** `cao followups [run]` lists every `followUp` and `warning` from every result, grouped by task, with `--issues` to create GitHub issues through `gh` (opt-in) or `--md` to write a checklist.
- **Value:** Agents produce good follow-up notes that are read once in the summary and then lost.
- **Builds on:** `result.json`.
- **Evidence:** Conductor's Checks tab surfaces todos and can block merge [L§4]; Codex emits `todo_list` items in its event stream [L§2].
- Value 3 · Effort S · **Next**

#### E5 Cost analytics and run comparison
- **What:** `cao cost` aggregates spend across runs by workflow, template, task id, model and agent, with `--since 30d` and `--json`. `cao compare <run-a> <run-b>` diffs outcomes, cost and duration per task, which is how you evaluate a model change (`opus` → `sonnet` for reviews) with data.
- **Value:** Model selection per task is a headline feature; without a comparison view users cannot tell whether a cheaper model actually held up.
- **Builds on:** `usage` in every result, `list.ts`.
- **Evidence:** Claude Code `/usage` breaks cost down per model and attributes usage to skills, subagents and MCP servers; OpenTelemetry metrics `claude_code.cost.usage` and `claude_code.token.usage` exist for teams that want dashboards [L§1]; `ccusage` reports daily/weekly/session/blocks with `--json` across 18+ CLIs [L§7]; Codex `cloud exec --attempts 1-4` runs best-of-N, the same comparison need [L§2].
- Value 4 · Effort M · **Next**

### Theme F — Automation and integration

#### F1 First-class CI mode
- **What:** `cao run --output json` streams `WorkflowEvent`s as JSON lines to stdout; `--ci github` additionally emits workflow commands (`::error`, `::group`, `::add-mask`) and writes the E1 report to `$GITHUB_STEP_SUMMARY`. Documented CI defaults: `--no-tui`, `permissionPrompts: deny`, explicit `claude.settings`/`mcpConfig` (B8) so the `--bare` default cannot surprise, retention of `.orchestrator/runs` as an artifact, and a non-empty `plugin_errors` / `mcp_server_errors` in `system/init` failing the task.
- **Value:** Running `cao` on a schedule or on issue label is the obvious next step for teams, and the tool is nearly there.
- **Builds on:** `render/plain.ts`, `EventBus`.
- **Evidence:** GitHub workflow commands and step summaries; `gh run watch --exit-status` [L§5]. clig.dev: `--json` output, `NO_COLOR`, no animations when stdout is not a TTY; Vercel makes non-interactive mode the default when it "detects that it is running under an agent" [L§6]. Claude Code documents the `system/init` error arrays for exactly this CI gate [L§1].
- Value 4 · Effort S · **Now**

#### F2 Triggered and scheduled runs
- **What:** `cao watch workflow.yaml --items "<command>" --every 15m` polls a command whose output is the `foreach` list, de-duplicates by item key, and starts a run per new batch; documentation for running `cao` under cron, GitHub `schedule` and Claude Code routines.
- **Value:** Turns `cao` from a tool you run into a queue you feed.
- **Trade-off:** Keep the trigger source a plain command whose output is the foreach list, so no integration code lives in `cao`. Treat fetched item text as untrusted data in the prompt.
- **Builds on:** `foreach`, run factory.
- **Evidence:** Symphony polls a Linear board and creates per-issue workspaces; OpenHands starts on an `openhands` label or `@openhands` comment; Goose has `schedule add --cron` [L§4]. Claude Code routines run on a schedule (one-hour minimum), an API trigger or GitHub events, and wrap API-supplied text in a block "that labels it as untrusted data" [L§1]. Dagster sensors use cursors and `run_key` de-duplication; Temporal schedules define overlap policies [L§5].
- Value 3 · Effort M · **Later**

#### F3 More agents behind the same contract
- **What:** Runners for Gemini CLI, Amp, Goose, OpenHands and Aider behind `agent: gemini | amp | goose | openhands | aider`, plus a documented runner plugin API (`runners:` in user config pointing at a module) so third parties can add one without a fork.
- **Value:** Cross-agent review is one of the product's best ideas; more agents means more useful pairs, and reduces lock-in risk for teams.
- **Builds on:** `TaskRunner`, `RunnerRegistry`, `CodexRunner` as the template.
- **Evidence:** Gemini CLI `-p --output-format stream-json` with documented exit codes (42 input error, 53 turn limit); Amp `-x --stream-json`; Goose `run --output-format stream-json` with a `response` schema; OpenHands `--headless --json`; Aider `--message` [L§4]. Vibe Kanban supported ten agents, which shows the demand [L§4].
- Value 3 · Effort M each · **Later**

#### F4 Library and event API
- **What:** Document `src/index.ts` as a supported API: create a run, subscribe to the `EventBus`, answer interactions, read the store. Ship typings and a small example (a Slack bot that answers permission prompts).
- **Value:** Lets teams build their own front-ends (D7 alternatives, chat bots) without waiting for the project.
- **Builds on:** `index.ts` already exports the pieces.
- **Evidence:** The Claude Agent SDK's `query()` options (`canUseTool`, `hooks`, `resume`, `maxBudgetUsd`, `outputFormat`), the Codex TypeScript SDK's `startThread`/`runStreamed`, and the OpenHands SDK's `Conversation` with an append-only typed event log are the shapes users will expect [L§1, L§2, L§4].
- Value 2 · Effort S · **Later**

### Theme G — Housekeeping and polish

#### G1 Retention and `cao gc`
- **What:** `cao gc` removes runs older than `retention.runs` (default 30 days or 50 runs), prunes their worktrees and branches, and reports reclaimed space. A warning in the startup header when `.orchestrator` exceeds a size threshold.
- **Value:** Every run keeps full stdout logs; a busy repository accumulates gigabytes.
- **Builds on:** `clean.ts`, `paths.ts`.
- **Evidence:** Claude Code keeps transcripts for `cleanupPeriodDays` (30 by default) and sweeps subagent worktrees on the same period unless they hold changes or unpushed commits; Codex keeps the 15 most recent managed worktrees [L§1, L§2]; GitHub retains logs and artifacts 90 days by default [L§5].
- Value 3 · Effort S · **Now**

#### G2 Friendlier errors
- **What:** "Did you mean" for task and run ids, a doc link on every validation error code, and `cao explain <code>` for the failure outcomes (`invalid_result`, `merge_conflict`, `api_error`) with the usual causes and fixes. `cao explain <run> <task>` reads the attempt's events and summarises what went wrong (tool errors, denials, the final result).
- **Value:** Reduces time-to-fix for the errors people actually hit.
- **Builds on:** `util/errors.ts`, `validator.ts`, `events.jsonl`.
- **Evidence:** Claude Code's `/schedule why did my nightly review do nothing this morning?` reads a run's log and explains tool errors, permission denials and the final result [L§1]; `gh` uses `--template` helpers such as `hyperlink` for clickable output [L§6].
- Value 3 · Effort S · **Now**

#### G3 Session continuation for follow-up tasks (deliberately deferred)
- **What:** `continueSession: <task>` would resume a previous task's Claude session for a follow-up ("address the review comments") instead of starting fresh with context.
- **Why deferred:** It breaks the isolation principle that makes runs reproducible and inspectable, and the transient-recovery path already covers the case where continuation is clearly right. Claude Code's own docs note that a resume after an hour of idleness reprocesses the full history anyway because the prompt cache has expired, which removes most of the cost argument [L§1]. Revisit only if typed context (B6) proves insufficient for fix-after-review flows.
- Value 3 · Effort M · **Not planned**

## 5. Prioritisation

Scoring: **Value** = how much it changes what a user can do or how often it removes friction. **Effort** = S/M/L as above. Tier = value per effort, adjusted for dependencies (D1 before D2, B6 before B5, E1 before E2).

| Tier | Features | Why this order |
|---|---|---|
| **Now** (next release) | A1 init · A2 schema · A3 doctor · A4 completions · B3 command tasks · B6 typed results · B7 inputs · C3 prompt preview · D1 notifications · D2 answer from anywhere · D4 per-task controls · D6 diff view · D8 dashboard ergonomics · E1 report · F1 CI mode · G1 gc · G2 errors | Mostly S/M effort, each closes a gap visible in the first week of use, and D1+D2 together remove the largest stall in unattended runs. |
| **Next** | A5 user config · B1 plan · B4 loops · B8 capability passthrough · C1 estimates · C2 budgets · D3 steer · D5 timeline · D9 interactive Codex · E2 delivery · E4 follow-ups · E5 cost analytics | Higher effort or dependent on Now items (C1 needs history, E2 needs E1, B4 needs states work). B8 moves up if the Claude CLI ships the `--bare` default. |
| **Later** | B2 includes · B5 dynamic sub-tasks · D7 web UI · E3 revert · F2 triggers · F3 more agents · F4 API | Valuable but large, or they change the product's shape enough to deserve their own design round. |

A value-versus-effort view of the same list is in the companion artifact.

## 6. Suggested first slice

If one release had to prove the direction, ship these six together. They touch different subsystems so they can proceed in parallel, and together they cover author → run → answer → review:

1. **A1 + A2** — `cao init` writing a schema-annotated workflow.
2. **B3** — command tasks, so the examples can gate on `npm test`.
3. **D1 + D2** — notifications with a `cao answer` line in every message.
4. **D6** — diff view in the dashboard and `cao diff`.
5. **E1** — `cao report --md`.
6. **F1** — JSON event output and the GitHub step summary.

Each of these has a test story against the existing fake agent (`test/fixtures/fake-claude.mjs`), so none of them needs API spend to verify.

## 7. Non-goals confirmed by this research

- **Shared conversation between tasks.** Context passing stays explicit (see G3).
- **Pushing by default.** Delivery (E2) is opt-in and lives in its own block.
- **A hosted service.** The web UI (D7) is local; everything reads `.orchestrator`.
- **Running arbitrary code from YAML beyond hooks and command tasks.** `when` and templates stay closed grammars.
- **Competing with `claude agents` on session management.** `cao` is workflow-shaped; the session view is Claude Code's job.

## 8. Sources

Primary sources for every landscape claim are listed in [landscape-notes.md](landscape-notes.md), one URL per fact, gathered on 2026-09-03; its closing "Gaps / could not verify" section lists what had no reachable primary source. Vendor names, prices and dates there reflect the pages on that date and should be re-checked before being quoted externally. Codebase observations reference files under `src/` as of the working tree on that date (commit `4d9c433` plus uncommitted dashboard and interaction work).
