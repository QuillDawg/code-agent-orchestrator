# cli-consistency-iterate

Use the CLI as a first-time user would and fix what is awkward.

## Minimum checklist

- Run every command (`run --dry-run`, `validate`, `status`, `list`, `task`, `peek`, `logs`,
  `diff`, `report`, `clean`, `stop`, `doctor` if present) with no arguments, with wrong
  arguments, with `--json`, with `NO_COLOR=1`, piped to a file, and at 80 columns. Read every
  error message: does it say what to do next?
- `--help` for every command: descriptions consistent in tone and length, examples where an
  argument is not obvious, exit codes and `CAO_*` variables documented once.
- Relative times and durations agree across `list`, `status` and `task`.
- A run directory with no runs, a corrupt `live.json`, a `latest` pointer to a deleted run.
- Unicode glyphs on a terminal that cannot render them: check `src/cli/util.ts` and add an
  ASCII fallback if none exists.
