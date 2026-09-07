---
name: cao-wayfinder
description: Author a single CAO workflow for a Matt Pocock Wayfinder map or one decision-ticket resolution. Use only when explicitly invoked.
---

# CAO Wayfinder workflow author

Create one dated CAO workflow for one Wayfinder stage: either chart a new map from a foggy destination, or resolve exactly one named/frontier decision ticket from an existing map. This plans the route; it does not implement the destination.

Read [the shared CAO authoring rules](../cao-yaml/references/cao-workflow-authoring.md) and the locally installed `/wayfinder` skill before authoring.

## Inputs and output

- Accept a loose destination, a map URL/number, or a map plus one named ticket. Load map/ticket details live through `gh` when referenced.
- Reject a request to implement a Wayfinder map directly. Route it to `/cao-to-spec` once the map is clear, unless the user explicitly says the effort is small and fully decided.
- Write `.cao-files/YYMMDD--wayfinder--<slug>.yaml`, validate it, and do not run it.

## Required workflow shape

- Set `git.enabled: false` and keep the stage sequential (`maxConcurrency: 1`).
- First task: prepare a read-only map chart or ticket-resolution proposal. It must retain the Wayfinder boundary: one map is an index, decision tickets resolve questions rather than implementation mechanisms, and a resolution run handles no more than one non-research ticket.
- Second task: an approval gate that states which map, tickets, labels, comments, assignments, blocking relationships, or closures will be changed.
- Final task: after that approval, invoke `/wayfinder` with the destination/map/ticket and publish only the approved tracker updates. Include draft context from the preparation task.
- Never schedule implementation, test, or code-review tasks in this workflow. Research tickets may be represented as explicitly scoped research tasks only when the user asks to resolve them.
