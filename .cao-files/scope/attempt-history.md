# attempt-history

Research doc section: **P4 Show the attempt and interaction history**.

## Deliverables

- `cao task` and the dashboard detail view gain an **Attempts** block: number, kind,
  `triggeredBy`, started, duration, outcome, exit code or signal, cost, retry reason.
- An **Interactions** block: kind, title, requested at, how long the task waited, how it was
  answered (dashboard, timeout, headless deny).
- The table row shows total elapsed across attempts, with the current attempt in
  parentheses when there is more than one.
- The detail view shows the result's `decisions`, `warnings` and `followUp`.
- The usage view shows `cacheCreationTokens` and `durationMs`.
- `cao task --json` includes the attempt and interaction records.

## Tests

Formatting helpers and the JSON shape.
