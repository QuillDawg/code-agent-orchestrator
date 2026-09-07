# Baseline

Establish the baseline for this run. Do not change any file.

- Run `npm run typecheck`, `npm run lint`, `npm test` and `npm run build`.
- Report the outcome of each in `summary`; put the passing test count in `data.tests`.
- Record `git rev-parse HEAD` in `data.baseCommit`.
- If `git status --porcelain` is not empty, list the files in `warnings`. The run should
  start from a clean tree; the maintainer decides whether to continue.
