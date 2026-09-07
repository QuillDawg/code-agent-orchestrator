# activity-column

Research doc section: **P5 Make the activity column tell the truth**.

## Deliverables

- The dashboard table's activity cell shows the last action entry (tool, command or text),
  never a `tool_result`.
- After 30 seconds without a new entry the cell appends an idle marker such as
  `… 2m idle`. The threshold is a constant, not configuration.
- `task.retrying` events (`src/types/events.ts`) show in the table as `api retry 2/5 in 12s`
  for the affected row while the delay runs.
- Fix the help panel (missing viewer keys, the `g`/`G` description) and wire `[`/`]` attempt
  switching in the dashboard follow view exactly as `cao logs --follow` does.

## Tests

`test/unit/dashboard.test.tsx`.
