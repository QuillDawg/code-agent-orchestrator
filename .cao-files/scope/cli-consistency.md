# cli-consistency

Research doc section: **P8 CLI consistency pass**. Implement every row of its table, in
order; each is small and independent, so commit them in a few logical groups.

- Where a row changes an exit code or a default, update the README CLI reference and
  `docs/capabilities.md`.
- `cao stop [run]` is a new command file.

## Tests

Task-id prefix matching, the exit-code changes, table width clamping, and the lock check in
`cao run`.
