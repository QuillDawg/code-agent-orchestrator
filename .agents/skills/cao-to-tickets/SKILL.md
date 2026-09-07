---
name: cao-to-tickets
description: Author a single CAO workflow that turns an approved PRD or spec into approved, dependency-aware GitHub tickets. Use only when explicitly invoked.
---

# CAO ticket workflow author

Create one dated CAO workflow that converts an approved PRD/spec into vertical-slice tickets with explicit blocking relationships. Do not implement those tickets in this stage.

Read [the shared CAO authoring rules](../cao-yaml/references/cao-workflow-authoring.md) and the locally installed `/to-tickets` skill before authoring.

## Required workflow shape

- Accept a PRD/spec path, GitHub issue URL/number, or explicit agreed plan. Retrieve referenced GitHub material live.
- Write `.cao-files/YYMMDD--tickets--<slug>.yaml`, validate it, and do not run it.
- Use `git.enabled: false` and three sequential tasks:
  1. draft tracer-bullet vertical slices, acceptance criteria, and the explicit blocker graph without changing GitHub;
  2. pause for human approval of ticket granularity and every dependency edge;
  3. invoke `/to-tickets` after approval to create the approved tickets in blocker-first order, wire their native GitHub blocking/sub-issue relationships when supported, and apply the project's ready-for-agent convention when present.
- Preserve the parent spec reference, use domain language from the source/repository, and keep tickets implementation-neutral: no stale file-path lists or code snippets.
- Pass the approved draft through CAO `context` to publication. The publication task must not close or modify its parent issue.
