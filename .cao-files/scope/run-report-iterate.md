# run-report-iterate

Make the report from `run-report.md` something a reviewer wants to read.

## Minimum checklist

- Generate the report for the real run under `.orchestrator/runs/` and read it as if you
  were the pull-request reviewer. Cut noise, fix ordering, make the file table scannable.
- Long summaries, empty sections, a task with five attempts, a skipped task, a failed run:
  each renders sensibly with no empty headings.
- Markdown renders correctly on GitHub (tables, nested lists, code fences inside summaries
  that already contain backticks).
- The JSON is stable: keys in a fixed order, no undefined values, dates in ISO 8601.
- Cost and token figures match `cao status` exactly.
