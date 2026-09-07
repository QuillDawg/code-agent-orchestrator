---
name: cao-to-spec
description: Author a single CAO workflow that turns a cleared Wayfinder map or agreed context into an approved GitHub spec/PRD. Use only when explicitly invoked.
---

# CAO spec workflow author

Create one dated CAO workflow that synthesizes an already-decided Wayfinder map or agreed context into a spec/PRD. Do not use this skill to rediscover fog or to implement code.

Read [the shared CAO authoring rules](../cao-yaml/references/cao-workflow-authoring.md) and the locally installed `/to-spec` skill before authoring.

## Required workflow shape

- Accept a cleared Wayfinder map, a source issue, or explicit agreed conversation context. Retrieve referenced GitHub material live.
- Write `.cao-files/YYMMDD--spec--<slug>.yaml`, validate it, and do not run it.
- Use `git.enabled: false` and three sequential tasks:
  1. draft the spec after targeted repository exploration; do not publish or modify the tracker;
  2. pause for human approval of the spec and testing seams;
  3. invoke `/to-spec` after approval to publish the approved spec/PRD to GitHub, preserving the source map/issue link and applying the project's ready-for-agent convention when present.
- The draft/published spec must cover problem, user-facing solution, user stories, implementation and testing decisions, out-of-scope work, and links to map decisions. Keep file paths and code snippets out unless a linked prototype is the only precise expression of an agreed decision.
- Pass the draft task result into the approval and publishing task with CAO `context`.
