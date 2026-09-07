# dashboard-review-view

Research doc section: **P3 Dashboard file view becomes a review view**.

## Deliverables

Put the diff pane in its own module under `src/tui/` rather than growing `app.tsx`.

- The `C` view lists files per task with status letter and `+N -M`; cursor-navigable and
  scrolling instead of truncating at `rows-8`.
- `Enter` opens the selected file's hunks in a scrolling pane that reuses the viewer's keys
  (arrows, PgUp/PgDn, `g`/`G`); `n`/`p` jump between hunks; left/right move between files;
  `Esc` returns to the list.
- `o` opens the file in `$VISUAL` or `$EDITOR` when set; otherwise a one-line hint.
- Running attempts show the live file list; finished attempts read `diff.json` and
  `diff.patch`. Remove the fallback that stamps every `result.filesChanged` path as `edit`.
- Help panel and the README dashboard-keys paragraph updated.

## Tests

`ink-testing-library` tests in `test/unit/dashboard.test.tsx` for the list, the pane and
the key handling.
