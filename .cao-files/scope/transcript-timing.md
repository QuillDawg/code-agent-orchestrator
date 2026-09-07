# transcript-timing

Research doc section: **P6 A deeper transcript**, first two bullets only: tool timing and
subagent nesting.

## Deliverables

- Keep `toolUseId` on `tool_result` entries (`src/runners/claude/claude-runner.ts` drops it),
  pair results with calls, and render the elapsed time on the call line once the result
  arrives. Expose per-attempt time-in-tools in the usage view.
- Parse `parent_tool_use_id` on Claude stream events; entries produced by a subagent nest
  under the `Agent:` line that spawned them, collapsed by default, expanded with the existing
  `t` key. Pass `--forward-subagent-text` when the installed CLI supports it (probe once,
  like the runner's other capability checks).

## Tests

Extend `test/fixtures/fake-claude.mjs` to emit a subagent sequence; cover pairing and
nesting in `test/unit/transcript.test.ts` and `test/unit/claude-runner.test.ts`.
