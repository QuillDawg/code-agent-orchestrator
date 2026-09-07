# transcript-iterate

Exercise and polish the transcript work from `transcript-timing.md` and
`transcript-navigation.md` together.

## Minimum checklist

- Replay the real attempt logs under `.orchestrator/runs/*/tasks/*/attempts/*/events.jsonl`
  through `cao logs` and the viewer (via `ink-testing-library`) and read the output end to
  end. Note anything that is harder to follow than the raw log.
- A subagent that itself calls tools; two subagents running concurrently; a tool call whose
  result never arrives (crash) must not leave a dangling timer.
- Search hits inside collapsed tool output and inside nested subagent entries.
- Paging: an attempt with more entries than `outputBufferLines`, scrolled to the very top and
  back down while the task is still producing output.
- Thinking toggled on for a long attempt: rendering stays responsive.
- Keys are consistent between `cao logs --follow`, the dashboard follow view and the help.
