# run-report

Research doc section: **P7 `cao report`**. The diff command and attempt history are in
(summaries in context); reuse their data.

## Deliverables

- `cao report [run] [--md|--json] [--out <file>]` in `src/cli/commands/report.ts`: header
  (workflow, repository, base commit, duration, cost, models used), one section per task
  (summary, decisions, warnings, followUp, files with +/- from `diff.json`, commits, merge
  sha) and an attempts table. Markdown is shaped to paste into a PR description; JSON is the
  same structure.
- Write `report.md` into the run directory at the end of every run and print its path beside
  the existing summary table (`src/cli/render/plain.ts`).
- README CLI table and `docs/capabilities.md` entries.

## Tests

Snapshot-style unit tests for the Markdown renderer using a fixture run.
