# dashboard-review-view-iterate

Exercise and polish the review view from `dashboard-review-view.md`.

## Minimum checklist

- Drive the dashboard with `ink-testing-library` against a run with several tasks, one of
  them still running, one with a large patch (hundreds of hunks) and one with no changes.
- Narrow terminals (80 columns, 24 rows): nothing overflows, long paths are shortened
  sensibly, the footer still fits.
- Long lines in hunks wrap or clip predictably; tabs and ANSI escapes inside a diff line
  are neutralised before rendering (see `src/util/text.ts`).
- Keys behave the same in the file list, the pane and the transcript viewer; the help
  panel matches the code.
- Re-render cost: the pane must not rebuild the whole patch on every spinner tick
  (compare with the follow view's memoisation).
- Empty states read well: task with no diff, attempt not finished, capture disabled.
