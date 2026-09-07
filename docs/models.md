# Agents, models and effort

Every task in a workflow runs in its own agent process. Three keys decide which brain does the work:

| Key | Meaning | Where it can appear |
|---|---|---|
| `agent` | which CLI to launch: `claude` or `codex` | workflow, `defaults`, template, task, foreach item |
| `model` | which model that CLI should use | workflow, `defaults`, template, task, foreach item |
| `effort` | how much reasoning to spend | workflow, `defaults`, template, task, foreach item |

All three are optional. With none of them set, `cao` launches Claude Code with whatever model and effort your CLI is already configured to use.

```yaml
agent: claude
model: opus
effort: high
```

> Setting `model`/`effort` at any level applies to whichever agent that task uses. They are agent-neutral keys — see [Resolution order](#resolution-order) for exactly which value wins.

## Quick answers

**Set one model for the whole workflow:**

```yaml
agent: claude
model: opus
```

**Use a cheaper model for one task:**

```yaml
tasks:
  - id: implement
    prompt: "/implement 101"        # inherits the workflow model
  - id: changelog
    model: claude-haiku-4-5         # this task only
    prompt: Summarize the change in one paragraph.
```

**Check what will actually be used, before spending anything:**

```bash
cao validate workflow.yaml --json    # each task reports its resolved agent/model/effort
cao run workflow.yaml --dry-run
```

`cao task <run> <task>` shows the same three values for a task that already ran, and `cao logs <task> --raw` contains the model the CLI reported back at session start.

**Check that the agents a workflow needs are actually installed.** `cao validate` probes every agent the workflow references and prints their versions:

```
Agents:      claude: 2.1.259 (Claude Code) (claude)  codex: NOT FOUND (codex): ...
```

A missing CLI is reported here but does not fail validation — detection happens again when the task launches, so you can validate a mixed-agent workflow on a machine that only has one of them.

## Available Claude models

`cao` passes `model` straight through to `claude --model`, so anything that CLI accepts works here. Two forms are valid.

**Aliases** — always resolve to the current model in that family. Best default: your workflows keep working as models are released.

| Alias | Resolves to |
|---|---|
| `fable` | the latest Claude Fable |
| `opus` | the latest Claude Opus |
| `sonnet` | the latest Claude Sonnet |

**Full model IDs** — pin an exact model when you need reproducibility across a long-lived workflow.

| Model | Model ID | Context | Input $/1M | Output $/1M |
|---|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 1M | $10.00 | $50.00 |
| Claude Fable 5 | `claude-fable-5` | 1M | $10.00 | $50.00 |
| Claude Opus 5 | `claude-opus-5` | 1M | $5.00 | $25.00 |
| Claude Opus 4.8 | `claude-opus-4-8` | 1M | $5.00 | $25.00 |
| Claude Opus 4.7 | `claude-opus-4-7` | 1M | $5.00 | $25.00 |
| Claude Opus 4.6 | `claude-opus-4-6` | 1M | $5.00 | $25.00 |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | $2.00 | $10.00 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | $3.00 | $15.00 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | $1.00 | $5.00 |

Model IDs are complete as written — never append a date suffix. Prices are Anthropic first-party API rates and are a snapshot; treat the [pricing page](https://claude.com/pricing) as authoritative. `cao` records the real cost of every Claude attempt in `result.json` (`usage.costUsd`), so the run history tells you what a workflow actually cost.

If a model name above is unfamiliar, it was released after your Claude Code CLI was built — run `claude --help` to see what your installed version documents.

## Available Codex models

`cao` passes `model` through to `codex --model` verbatim and does not validate it. There is no bundled catalog, because the valid set depends on your Codex install and account:

```bash
codex --help          # what your CLI accepts
```

The examples in this repository use `gpt-5.6-terra` (implementation) and `gpt-5.6-sol` (lighter review passes). Substitute whatever your Codex account offers.

## Effort levels

`effort` controls how much reasoning the model spends before answering. Higher effort costs more tokens and takes longer; it pays off most on hard implementation and long-horizon agentic work, and barely at all on mechanical tasks.

The schema accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.

**Claude Code accepts `low`, `medium`, `high`, `xhigh` and `max`** (confirmed by `claude --help` on 2.1.259). `none` and `minimal` exist for Codex; if you set either on a Claude task, `cao validate` warns and the flag is dropped rather than passed to a CLI that would reject it. Haiku has no effort levels at all, so a Haiku task drops whatever `effort` it inherits, again with a warning, instead of passing `--effort` for the CLI to ignore.

| Level | Use for |
|---|---|
| `none` / `minimal` | mechanical edits (Codex only) |
| `low` | summaries, formatting, changelog entries |
| `medium` | routine implementation |
| `high` | most real work — the usual default |
| `xhigh` | hard implementation, tricky debugging |
| `max` | correctness matters more than cost |

For Claude the value becomes `claude --effort <level>`. For Codex it becomes `codex -c model_reasoning_effort="<level>"` — `cao` passes it through without validating it, so check `codex --help` for the levels your Codex build accepts.

## Resolution order

`model` and `effort` are resolved per task, highest priority first:

1. `foreach` item override
2. task
3. template
4. `defaults`
5. workflow top level
6. `claude.model` / `claude.effort` — **Claude only**, legacy fallback

`agent` follows the same order (`runner:` is accepted as a legacy alias for `agent:`), falling back to `claude`.

Two consequences worth knowing:

- **`defaults` beats the workflow top level.** `defaults` is merged into every task body, and task-level values outrank the workflow level. If you set both, `defaults.model` wins.
- **`claude.model` is the lowest priority, not the highest.** It stays supported for older workflows, but a top-level `model:` overrides it.

```yaml
model: sonnet          # workflow level
defaults:
  model: opus          # wins for every task — defaults is a task layer
tasks:
  - id: cheap
    model: claude-haiku-4-5  # wins for this task only
    prompt: ...
```

Codex has no `codex.model` key. For `agent: codex`, use the top-level/task-level `model:` — it is the only way to set a Codex model.

## Choosing per task

The point of per-task models is spending capability where it changes the outcome. A typical split:

```yaml
version: 1
name: Feature with tiered models
repository: .

agent: claude
model: opus            # the default for real work
effort: high

templates:
  quick:               # cheap, shallow tasks
    model: claude-haiku-4-5
    effort: low

tasks:
  - id: implement
    prompt: "/implement 101"
    effort: xhigh      # hardest step gets the most reasoning

  - id: review
    type: review
    model: sonnet      # good enough to review, much cheaper
    context:
      from: [implement]
    prompt: Review the implementation described in context.

  - id: changelog
    template: quick
    context:
      from: [implement]
      include: [summary]
    prompt: Write a one-line changelog entry.
```

Rules of thumb:

- **Implementation and debugging** — the strongest model you are willing to pay for, `effort: high` or `xhigh`.
- **Review** — a mid-tier model is usually enough, and a *different* model from the implementer catches more than a second pass by the same one.
- **Summaries, changelogs, formatting, file shuffling** — the cheapest model at `low` effort.
- **Approval gates** — no agent runs at all, so `model` is irrelevant.

## Mixing agents in one workflow

`agent` is per task, so a single workflow can use both CLIs — for example, implement with one and have the other review it independently:

```yaml
agent: claude
model: opus

tasks:
  - id: implement
    prompt: "/implement 101"

  - id: cross-review
    agent: codex
    model: gpt-5.6-terra
    context:
      from: [implement]
    prompt: Independently review the change described in context.
```

Both agents must be installed and authenticated for a workflow that mixes them (`claude --version`, `codex --version`).

## Cost controls

- **`claude.maxBudgetUsd`** caps spend for a Claude task; the CLI stops when the cap is hit. Claude-only — Codex has no equivalent flag.
- **`timeout`** bounds wall-clock time per attempt (default `60m`).
- **`retries`** multiplies cost — each retry is a fresh session paying full input cost again.
- **Context size** is real input cost. `context.include` and `context.maxChars` trim what gets prepended; `context: false` sends none.

```yaml
tasks:
  - id: bounded
    model: opus
    effort: high
    timeout: 30m
    claude:
      maxBudgetUsd: 5
    prompt: ...
```

Per-attempt cost, duration and turn count are stored in `result.json` under `usage`, so `cao status --json` and the run history let you see where a workflow actually spends.

## Overriding at the command line

There is no `--model` flag. Models are workflow configuration, so a run is reproducible from its YAML. To try a different model, either edit the workflow or point `cao` at a different one.

The CLI overrides that do exist are `--permission-mode`, `--max-concurrency`, `--repository`, and `--claude-command`. `CAO_CLAUDE_COMMAND` and `CAO_CODEX_COMMAND` replace the binary itself, which is how the test suite runs whole workflows against a fake agent with no API calls.

## Smaller models

Nothing in `cao` treats one model differently from another, but a smaller model such as Haiku changes what the same workflow does:

- **`effort` is dropped.** Claude Code has no effort levels for Haiku, so a workflow-level `effort: high` is not passed to a Haiku task; `cao validate` says so.
- **No auto mode, so every tool call prompts.** Claude Code runs its permission classifier only for Sonnet 5, Opus 4.7 and later, and Fable. A Haiku task asked for the default `permissionMode: auto` is silently started in the ordinary prompting mode and asks before every file write and command; `cao validate` warns. Give such tasks `acceptEdits`, `dontAsk` with `allowedTools`, or `bypassPermissions` ([configuration.md](configuration.md#claude-workflow-template-or-task-level)).
- **Prose instead of the result.** A session that ends with "Done!" instead of the JSON completion object is asked for just the object, in the same session, before a retry is spent (`retry.resultNudges`, default 1). See [configuration.md](configuration.md#a-worker-that-ends-without-the-completion-object).

## Related

- [configuration.md](configuration.md) — the full YAML schema
- [capabilities.md](capabilities.md) — what a workflow can express
- [agent-cli-integration.md](agent-cli-integration.md) — the exact command line each agent receives
