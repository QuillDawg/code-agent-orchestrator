# blocked-on-human

Spec sections: **H3.1 - H3.4** (the mechanism). H3.5 - H3.7 are the next task's, but read all
of H3 before starting: the acceptance matrix in H3.7 is what this work is measured against.

This is the most important task in the run. A worker blocked on a human must always end up in
one of two documented states, on either agent, attended or headless:

- `waiting` - the process is alive and the dashboard can answer it;
- `needs_input` - the attempt is over and the run is paused holding a question.

Never a silent hang. Never `crash`/`failed` when the real cause was an unanswered question.

## Deliverables

### Claude (H3.2)

Mostly hardening and proof rather than new code:

- Two concurrent requests answered out of order: the task leaves `waiting` only when the last
  one is answered.
- `control_cancel_request` for a request that is on screen, and for one already answered.
- `execution.interactionTimeout`, including `never`, and the interaction budget being bounded
  by the task's own `timeout`.
- Every deny message tells the worker to finish with `needs_input`, and the resulting
  `TaskResult` carries the question or permission text - not a generic "denied".
- `permissionPrompts: deny` and `--no-tui` reach `needs_input`, not `failed`.
- "Allow for the rest of this task" appears only when the CLI supplied a suggestion
  (`canAllowAlways`), and the rule never outlives the session.

### Codex app-server (H3.3)

- Command and file-change approvals: allow-once, allow-always (via
  `proposedExecpolicyAmendment` / `grantRoot`) and decline all round-trip correctly.
- `item/tool/requestUserInput` with `experimentalUserInput: true`: verify the request and
  response shapes against the app-server protocol (the current mapping hard-codes
  `multiSelect: false` and answers as `{[id]: {answers: [value]}}`). Cover a multi-question
  payload and an option list with descriptions.
- With `experimentalUserInput` disabled, stop killing the process. Decline through the protocol
  and let the worker finish its own turn. Only if it cannot does the attempt end as
  `needs_input`, and that result must **quote the question Codex asked** instead of the current
  fixed sentence. If the process still has to be killed, the transcript says so explicitly.
- Unknown server requests keep failing closed (`-32601`); permission-affecting requests are
  never auto-allowed.

### Codex exec (H3.4)

`codex exec` has no channel for approvals or user input; it rejects them itself and the
rejection arrives as an `error` item, which today falls through to `invalid_result` or `crash`.

- Recognise those rejections in the JSONL stream and end the attempt as `needs_input` carrying
  the text of what Codex wanted.
- The result must name the transport limitation and the option that would have allowed an
  answer (`codex.transport: appServer`, `codex.approvals: host`), so the operator can fix the
  workflow rather than guess.
- The run log records once per Codex `exec` task that no human can be reached during it.
  Extend `cao validate` output in the same spirit where it can be known statically.

## Design constraints

- Everything new crosses the runner boundary through the existing runner-neutral types
  (`Interaction`, `InteractionAnswer`, `RunnerOutcome`, `TaskResult`). No agent name checks in
  `src/workflow/`, the TUI or the CLI.
- `src/workflow/scheduler.ts` already owns the `waiting` transition, the interaction timeout,
  `hooks.onInputRequired` and the persisted `InteractionRecord`. Route new paths through it
  rather than duplicating the logic in a runner.
- Tool input is model-controlled text. Anything new that reaches a terminal goes through
  `sanitizeText` first, and the run-level event log keeps carrying only the interaction summary,
  never the raw input.

## Tests

Cover rows 1-10 and 12 of the H3.7 matrix through the scheduler against the fakes, in both the
attended (an interaction handler is registered) and headless (none is) configurations. Extend
`test/integration/interactive.test.ts` and the Codex e2e file from the harness task. Each test
asserts the task state timeline, the stored `TaskResult` (including that the question text
survives into it) and the attempt's `events.jsonl`.

Row 11 belongs to the iterate task.
