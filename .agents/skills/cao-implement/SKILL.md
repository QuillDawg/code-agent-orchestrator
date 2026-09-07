---
name: cao-implement
description: Author a single CAO workflow that implements ready GitHub tickets or a small decided PRD with reviews and verification. Use only when explicitly invoked.
---

# CAO implementation workflow author

Create one dated CAO workflow that builds already-decided work. It accepts ready GitHub tickets or a small, implementation-ready PRD; it does not reopen planning.

Read [the shared CAO authoring rules](../cao-yaml/references/cao-workflow-authoring.md) and the locally installed `/implement` skill before authoring.

## Inputs and boundaries

- Retrieve every named ticket, its comments, labels, parent spec, blocking links, and relevant linked artifacts through `gh` before building the DAG.
- A Wayfinder map is not implementation input. Route it to `/cao-to-spec` unless the user explicitly declares it small and fully decided.
- Write `.cao-files/YYMMDD--implement--<slug>.yaml`, validate it, and do not run it.

## Required workflow shape

- Build explicit `execution.mode: dag` dependencies from ticket blockers. Include only ready tickets and requested dependencies; explain any ticket excluded because it is blocked or not ready.
- Use `execution.maxConcurrency: 3` and worktrees for independent implementation tasks. Keep dependent tasks ordered and never permit shared-workspace parallel code changes.
- Each implementation task invokes `/implement` for one vertical slice, supplies its issue URL and source PRD context, keeps scope to that ticket, drives `/tdd` at the agreed seams, runs targeted typechecks/tests, and commits its own worktree result.
- Add downstream test, code-review, and final-verification tasks with scoped `context` from implementation results. Do not combine unrelated tickets into a review/fix task.
- Add a final approval task before any worker closes, comments on, labels, or otherwise updates GitHub tickets. The post-approval tracker task updates only tickets whose implementation and verification actually succeeded.
