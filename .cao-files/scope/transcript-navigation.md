# transcript-navigation

Research doc section: **P6 A deeper transcript**, remaining bullets: thinking (opt-in),
search and filter, timestamps on narrow terminals, paging beyond the in-memory buffer.
The tool-timing and nesting work is already in (summary in context); build on its entry kinds.

## Deliverables

- A `thinking` entry kind parsed from thinking blocks, written to the attempt's
  `events.jsonl` only, hidden by default, toggled with `T` in the viewer and `--thinking` in
  `cao logs`. Never written to the run-level `events.jsonl`.
- `/` searches the transcript buffer, `n`/`N` step through matches; `k` cycles a kind filter
  (all; text; tools and commands; errors and questions).
- Timestamps render as `MM:SS` below 100 columns instead of disappearing; the detail view
  passes timestamps too.
- Scrolling above the oldest buffered entry pages older entries from the attempt's
  `events.jsonl`, so the whole transcript is reachable from the dashboard.
- Viewer footer, help panel, README and `docs/capabilities.md` key lists updated.

## Tests

Parser, search, filter and paging.
