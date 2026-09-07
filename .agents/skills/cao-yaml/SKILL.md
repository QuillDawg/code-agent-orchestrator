---
name: cao-yaml
description: Create a validated Code Agent Orchestrator workflow YAML from a normal-language request. Use only when explicitly invoked.
---

# CAO YAML author

Turn the user's request into one runnable Code Agent Orchestrator (CAO) workflow. This is an authoring skill: create and validate the YAML, but never start `cao run`.

## Required outcome

1. Identify the target project: use its Git root, or the current directory if it is not a Git repository.
2. Read enough of that project and its CAO installation/docs to make a valid, scoped workflow. Preserve explicit user choices for agent, model, effort, concurrency, source material, and approvals.
3. When the user names a GitHub issue URL or number, retrieve its current details with `gh issue view` (including comments, labels, and linked material). If that cannot be read, use supplied content and state the missing context.
4. Create `.cao-files` in the target project if needed. Save exactly one file named `YYMMDD--<stage>--<slug>.yaml`; use `--02`, `--03`, and so on when that filename already exists. Use the machine's current local date, not a date supplied in examples.
5. Run `cao validate <saved-path>` from the target-project root. Correct YAML/schema errors and report the final path and validation result. Do not dry-run or execute the workflow.

Read [the CAO workflow authoring reference](references/cao-workflow-authoring.md) before writing the workflow.

## Boundaries

- This skill may read GitHub to understand input, but it must not create, edit, close, or comment on issues itself.
- A generated workflow that later changes GitHub must contain an explicit CAO approval task immediately before its first tracker-mutating worker task.
- Match `agent:` to the client running this skill (`codex` or `claude`) unless the user explicitly selects an agent. Do not invent a model or effort level.
- Choose the smallest workflow that satisfies the request. Use explicit dependencies for a real DAG; do not manufacture parallelism.
- If the request clearly belongs to a Matt Pocock stage, direct the user to the matching explicit skill rather than silently substituting it: `/cao-wayfinder`, `/cao-to-spec`, `/cao-to-tickets`, or `/cao-implement`.
