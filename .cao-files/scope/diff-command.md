# diff-command

Research doc section: **P2 `cao diff` and a run-level review**. Builds on the diff capture
whose summary is in context.

## Deliverables

- `cao diff [run] [task]` in `src/cli/commands/diff.ts`, registered in `src/cli/program.ts`,
  with `--stat`, `--name-only`, `--file <path>`, `--attempt <n>`, `--json`, `--color`.
  Without a task: every task's patch in execution order, each under a header.
- Colour `+`, `-` and `@@` lines on a TTY through `src/cli/color.ts`. Plain output must be
  a valid unified diff that `git apply --check` accepts.
- `cao task` prints the +/- stat table from `diff.json` for finished attempts and keeps the
  live `W/M/D ×N` list only while the task is running.
- README CLI table and `docs/capabilities.md` entries.

## Tests

Unit tests for the renderer; an e2e assertion that `cao diff --json` returns the captured
records.
