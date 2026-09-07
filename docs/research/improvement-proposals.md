# Improving what `cao` already does, and getting it ready for a public beta

**Date:** 2026-09-04
**Status:** research and proposals, not a commitment
**Scope:** only features that exist today. Three questions: what would make day-to-day use smoother, what would make it clearer where agents are and what they did, and how does "files changed" grow into a way to review the code. A final section lists what stands between the current tree and an `npm publish --tag beta`.
**Companion:** [feature-research.md](feature-research.md) is the wider catalog of *new* features. Where a proposal here overlaps an entry there it is cited as `[F:D6]` etc. Everything below was checked against the code on 2026-09-04; line numbers refer to that tree.

## 1. Summary

The product is in better shape than most beta CLIs: typecheck, lint and 183 tests are green, the CLI makes no network calls of its own, secrets are redacted on the way to disk, and there is no debugging residue in `src/`. The dashboard, `cao status`, `cao task` and `cao logs` already answer most "what is happening" questions.

The gaps cluster in three places:

1. **File changes stop at a list of paths.** Nothing captures a diff, so "review what task X did" means leaving `cao` for `git`, and for sequential tasks in the shared tree it is often impossible even there. The `git.captureDiff` option exists in the schema and defaults to `true` but is never read.
2. **A lot of what is persisted is never shown.** Attempt history, interaction history, exit codes, retry reasons, result `decisions`/`warnings`/`followUp`, thinking, subagent work and per-tool timing are all on disk or in the stream and absent from every view.
3. **Small inconsistencies that a first-time user hits in the first ten minutes.** No default workflow file, exact-only task ids, two different exit codes for "run not found", a dead `--events` flag, timestamps that vanish on narrow terminals.

Eight proposals follow, ordered by value. The first three form the code-review capability. Then the release checklist.

## 2. Where the code stands today

| Area | What exists | Evidence |
|---|---|---|
| Live file tracking | Claude `Write`/`Edit`/`MultiEdit`/`NotebookEdit` tool calls become `{ops, lastOp}` per relative path on the attempt. Bash-driven edits, `rm`, `git mv` and generated files are invisible; no `delete` op on the Claude path. Codex `file_change` items do include deletes. | `src/runners/claude/event-parser.ts:95,193-203`, `src/runners/codex/codex-runner.ts:140-144`, `src/workflow/scheduler.ts:605-616`, `src/types/run.ts:79-82` |
| Git capture | At attempt end: branch, head sha, `git status --porcelain` lines, base sha, and a `git diff --stat` string. No patch. Stored in `result.json` as `git`, never printed by any command. | `src/workspace/git.ts:223-236`, `src/workspace/workspace-manager.ts:198-207`, `src/context/context-builder.ts:54-61` |
| Dead knob | `git.captureDiff` is normalised, typed and documented, but no code reads it. | `src/config/normalize.ts:234`, `src/types/workflow.ts:93`, `docs/configuration.md:88` |
| Worktrees | Branch `orchestrator/<id>` from the run's base commit; on success a checkpoint commit then `git merge --no-ff` into the base branch; worktree directory removed, **branch kept** until `cao clean --branches`. So `git diff <baseSha>..<branch>` stays computable after the run. | `src/workspace/workspace-manager.ts:120-158,216-276,311-321`, `src/workspace/git.ts:163-184`, `src/cli/commands/clean.ts:38-42` |
| Shared tree | `baseSha` is HEAD at acquire time; agents rarely commit, so `headSha == baseSha` and the task's work is only "the tree is dirty". The next task overwrites the evidence. Sequential tasks default to shared. | `src/workspace/workspace-manager.ts:115-116`, `src/types/workflow.ts:80` |
| Agent claims | `filesChanged` and `commits` in the result are free-text arrays, never reconciled with observed edits or git. `commits` may contain prose. | `src/runners/claude/contract.ts:13-14,30,59-70` |
| Dashboard `C` view | Per task: path, one letter from `lastOp`, `×N` count. After a run with no live data every path is stamped `edit`. No line counts, no diff, no action, no scrolling past `rows-8`. | `src/tui/app.tsx:69-74,372-403` |
| Transcript | Text (markdown), commands, one-line tool summaries, tool results collapsed to 3 lines, questions, permissions, result, errors. Thinking blocks are dropped by the parser; subagents are one `Agent: <description>` line plus a truncated result; `tool_result` loses its `toolUseId` so call and result cannot be paired. | `src/tui/transcript.ts`, `src/runners/claude/event-parser.ts:117-119,189-208,230`, `src/runners/claude/claude-runner.ts:189-190` |
| Persisted, never shown | `attempt.interactions[]`, `exitCode`/`signal`/`outcome`, `triggeredBy`, `resumedSessionId`, `workspace.{baseSha,headSha,mergedSha,dirtyAtEnd}`, result `decisions`/`data`, `cacheCreationTokens`, `durationMs`, retry events with their reason. | `src/types/run.ts`, `src/types/result.ts:29-43`, `src/types/events.ts:43` |
| CLI | Nine commands. `--json` on `validate`/`status`/`list`/`task` only. Run ids match by prefix or suffix, task ids exactly. No default workflow filename. `cao peek` and `cao task` require refs while `cao logs` does not. | `src/cli/program.ts:73-170`, `src/cli/util.ts:30-47`, `src/persistence/run-store.ts:90-133` |

A real run in this repository (`2026-09-03-001`, five tasks, $40) shows the practical effect: the largest task touched 38 files in the shared tree, committed nothing, and its file list still includes `tmp-bell.mjs` and `tmp-verify.mts`, which the agent deleted with `rm` before finishing. There is no way to see what it changed from `cao`.

## 3. Proposals

Value is user impact (1–5). Effort is S (a day or two), M (about a week), L (more).

### P1 Capture a real per-task diff at attempt end · Value 5 · Effort M

**What.** When an attempt finishes, write the task's own changes as a patch into the run directory, so every later view and command can read it without touching git or the working tree again:

```
runs/<id>/tasks/<taskId>/attempts/<n>/
  diff.patch        # unified diff of this attempt's changes
  diff.json         # per file: path, status A/M/D/R, +lines, -lines, binary flag
```

Honour the existing `git.captureDiff` option (default `true`, already documented) and add `git.maxDiffBytes` (default 2 MB) beyond which only `diff.json` is written and the patch is truncated with a note.

**How, per workspace kind.**

- *Worktree tasks.* `finalize` already has `baseSha`, the worktree path and the branch head before the merge (`workspace-manager.ts:203-207`). `git diff <baseSha> HEAD` plus `--numstat` there is one extra process. Do it after the checkpoint commit so uncommitted work is included.
- *Shared-tree tasks.* The base sha is useless because the agent does not commit. Instead snapshot the working tree as a git tree object at acquire and at finalize, without touching the index or the tree: run `git add -A` and `git write-tree` against a temporary index (`GIT_INDEX_FILE` pointing into `.orchestrator/`), then `git diff-tree -p --numstat <treeBefore> <treeAfter>`. The two tree objects cost a few milliseconds on a normal repository, survive in the object store, and isolate the task's changes even when the tree was already dirty at start (the run already warns about that case, `workspace-manager.ts:85-111`). Record both tree ids on `attempt.workspace` so the diff can be recomputed later.
- *Merge-resolution attempts* (`kind: 'merge'`) get their own patch, which finally distinguishes a merge fix-up from the task's own work.

**Why.** Everything in the rest of this section depends on it. It also fixes the lossy live tracking as a side effect: the snapshot diff sees Bash-driven edits, deletions and renames that the tool stream misses, and it ignores the temp files the agent cleaned up. Downstream tasks get a better `git` block in their context, too.

**Builds on.** `git.captureInfo` (`git.ts:223-236`), `WorkspaceManager.finalize`, `RunPaths.attemptDir`. `[F:D6]`

### P2 `cao diff` and a run-level review · Value 5 · Effort S once P1 exists

**What.** One command that prints what P1 captured:

```
cao diff [run] <task>              # the task's patch, coloured on a TTY
cao diff [run] <task> --stat       # files with +/- counts
cao diff [run] <task> --name-only
cao diff [run] <task> --file src/x.ts
cao diff [run] <task> --attempt 2
cao diff [run]                     # every task in execution order, each under a header
cao diff [run] --json              # the diff.json records
```

`--stat` output should reuse the numbers from `diff.json`; the patch itself gets colour through the existing colour helpers (`src/cli/color.ts`) with the standard `+`/`-`/`@@` scheme, and `--no-color` / `NO_COLOR` fall back to a plain patch that pipes into `git apply --check`, `delta` or an editor unchanged.

Make `cao task` print the `--stat` view in place of today's `W/M/D ×N` list, and keep the live list only while the task is running. Print the captured `diffStat` from `result.git` while P1 is not yet done; it is already on disk and currently rendered nowhere.

**Why.** "Show me what task X changed" is the review question, and the answer is already one git command away for worktree tasks. Making it a `cao` command keeps the user inside the tool at the moment trust is decided.

**Builds on.** `resolveRunAndTask` (`util.ts:30-40`), `renderTranscript` colour plumbing, the `task.ts` files block. `[F:D6]`

### P3 Dashboard file view becomes a review view · Value 4 · Effort M

**What.** Turn the `C` view into a two-level review:

1. *File list per task* with status letter, `+N −M`, and the file's op count while the task is still running. Cursor-navigable and scrollable; today it truncates silently at `rows-8` (`app.tsx:398-399`).
2. *Enter* opens the selected file's hunks in the transcript viewer's scrolling pane, with the same keys users already know (`↑↓`, `PgUp/PgDn`, `g`/`G`). Lines coloured by `+`/`-`. `n`/`p` jump between hunks, `←`/`→` move to the previous or next file.
3. `o` opens the file in `$VISUAL`/`$EDITOR`, or runs `git difftool --no-index` on the before/after blobs when configured. Both are opt-in through a small `review:` block in the workflow or a future user config.

While a task is running the view reads P1's live list. Once an attempt finishes it swaps to the captured `diff.json`/`diff.patch`, which fixes the "everything is `M`" fallback (`app.tsx:72`).

**Why.** The dashboard is where the user is when the task turns green. Reviewing there, before the next task starts on top of the change, is worth more than the same view an hour later.

**Builds on.** `TranscriptViewer` scrolling and key handling (`viewer.tsx:83-123`), the `files` view. `[F:D6, F:D8]`

### P4 Show the attempt and interaction history · Value 4 · Effort S

**What.** Everything here is already persisted; it needs rendering.

- `cao task` and the dashboard detail view gain an **Attempts** block: number, kind (task / merge), `triggeredBy` (initial, retry, resume, restart), started, duration, outcome, exit code or signal, cost, and for a retry the reason (transient API error with its category, invalid result, timeout). Total elapsed across attempts on the table row, with the current attempt in parentheses.
- An **Interactions** block: every permission prompt and question the task raised, when, how long it waited, and how it was answered (dashboard, timeout, headless deny). Waiting time is the number that explains "why did this take three hours".
- The result's `decisions`, `warnings` and `followUp` in the detail view, not only in `cao task`. These are the parts of a result a reviewer actually reads.
- `cacheCreationTokens` and `durationMs` in the usage view.

**Why.** After a retry or a resume, users today cannot tell from any view what happened on attempt 1, and the interaction wait time is the single biggest hidden cost in a run. `[F:D5]`

**Builds on.** `attempt.interactions`, `attempt.outcome`, `task.retrying` events (`events.ts:43`), `TaskAttempt` (`run.ts`).

### P5 Make the activity column tell the truth · Value 4 · Effort S

**What.** Three small changes to the table's activity cell (`app.tsx:497-508`):

1. Show the last *action* (tool, command or text), not the last entry of any kind. Today a long tool result masks the tool that is running.
2. Append a quiet-time indicator when nothing has arrived for more than 30 s: `… 2m idle`. Long silences are either thinking, a hung tool, or a stalled API call, and the operator cannot currently tell a working agent from a stuck one.
3. Show API retries in the TUI. `task.retrying` carries the category and the delay but is rendered only by the plain renderer; the table should show `api retry 2/5 in 12s` for the affected row.

Also fix the help panel, which omits every viewer key and describes `g`/`G` the wrong way round (`app.tsx:321-333`, `viewer.tsx:111-113`), and wire `[`/`]` attempt switching in the dashboard follow view, which today works only in `cao logs --follow` (`app.tsx:299-312`, `logs.tsx:117`).

### P6 A deeper transcript · Value 4 · Effort M

**What.** The stream carries more than the viewer shows.

- **Tool timing.** Keep `toolUseId` on the `tool_result` entry (it is dropped at `claude-runner.ts:189-190`), pair it with the call, and render `▸ Grep pattern in src  · 0.4s` on the call line once the result arrives. Slow tools and the total time spent in tools per attempt fall out of this for free.
- **Subagent nesting.** Claude Code stream events carry `parent_tool_use_id` for subagent messages, and `--forward-subagent-text` exposes their text. Indent entries under the `Agent:` line that spawned them, collapsed by default, `t` expands as it does for tool results.
- **Thinking, opt-in.** Parse `thinking` blocks into a `thinking` entry kind, hidden by default, toggled with `T` in the viewer or `--thinking` in `cao logs`. Store them in the attempt's `events.jsonl` like everything else; never in the run-level log.
- **Search and filter.** `/` searches the buffer, `n`/`N` step through matches; `k` cycles a kind filter (all, text only, tools and commands, errors and questions).
- **Timestamps always.** Below 100 columns the viewer silently drops them (`viewer.tsx:70`); use a short `MM:SS` form instead. The detail view never passes them at all (`app.tsx:412`).
- **Reach the whole transcript.** The follow view is capped at `outputBufferLines` (default 500) in memory; scrolling past the top should page older entries from the attempt's `events.jsonl` rather than stop.

**Why.** "What is the agent actually doing" is answered by the transcript, and today it hides the two most expensive things an agent does: thinking and delegating.

**Builds on.** `parseClaudeEvents`, `TranscriptEntry` (`types/transcript.ts:9-26`), `TranscriptViewer`. `[F:D8]`

### P7 `cao report` · Value 4 · Effort S

**What.** `cao report [run] [--md|--json]` renders a document from what is already in the run directory: header (workflow, repository, base commit, duration, cost, model mix), one section per task with summary, decisions, warnings, follow-ups, files with `+/-` counts (P1), commits and merge sha, and an attempts table (P4). Markdown output is shaped to paste into a PR description; `--json` is the same structure for tooling. Print the path to it at the end of every run next to the existing summary table.

**Why.** Every run ends with the user assembling this by hand from `result.json` files. It is also the artefact that makes the tool's value visible to people who never see the dashboard. `[F:E1]`

### P8 CLI consistency pass · Value 3 · Effort S

Small, independent, and each one is something a first-time user hits.

| Change | Today | Where |
|---|---|---|
| `cao run` / `cao validate` default to `workflow.yaml` (then `workflow.yml`, `cao.yaml`) in the cwd | required argument, commander error | `program.ts:76,92` |
| Task ids match by unique prefix, like run ids | exact only | `util.ts:42-47` vs `run-store.ts:90-108` |
| `cao peek` and `cao task` accept `[refs...]` | required, so `cao peek` alone is a commander error while `cao logs` alone gives a usage error | `program.ts:146,156` |
| "run not found" and "no runs" exit 2 | plain `Error`, exit 70 | `run-store.ts:99,107` |
| Remove or implement `logs --events` | declared, never read | `program.ts:136`, `logs.ts:18,67` |
| `--json` on `logs` and `peek` (one entry per line) | absent | `program.ts:131-150` |
| `list` sorts newest first and shows a relative age column | directory order, ISO timestamps | `run-store.ts:110-133`, `list.ts:23` |
| `status` and `task` agree on one time format (local date and time, plus `Nm ago`) | ISO UTC in one, `HH:MM:SS` in the other | `status.ts:39`, `util/duration.ts:45-49` |
| Tables clamp to terminal width and pad by visible width | pad by string length, detail sliced at 70 characters | `util.ts:62-71`, `status.ts:62` |
| `status` prints the orchestrator pid and the run directory path | pid only in `--json`, path only in the end summary | `status.ts:28-36` |
| `cao stop [run]` sends the interrupt from another terminal | only Ctrl+C in the owning process | `signals.ts:56-58` |
| `cao run` checks the lock it acquires | result ignored, so two concurrent runs in one repository go undetected | `run.ts:66` |
| One warning prefix across `run`, `resume`, `validate` | `! WARNING:`, `! <note>`, `✗/!` | `run.ts:42`, `resume.ts`, `validate.ts` |
| `resume` accepts `--claude-command`, `--max-concurrency`, `--permission-mode` | `run` only | `program.ts:100-112` |
| `cao --help` lists exit codes and the `CAO_*` environment variables | README only | `program.ts:57` |

## 4. Suggested order

1. **P1 + P2** together: capture the patch, print it. This is the code-review feature and it unblocks P3 and P7.
2. **P5 + P8**: two days of small fixes that change the first impression.
3. **P4 + P7**: render what is already persisted; the report is the shareable output.
4. **P3**: the in-dashboard review pane.
5. **P6**: the transcript work, in the order listed; tool timing first because it is the smallest and most useful.

## 5. Public beta checklist

Verified on 2026-09-04: `npm run typecheck`, `npm run lint` and `npm test` (183 tests, about 40 s) are clean; `npm run build` produces `dist/bin.js`, `dist/index.js`, `dist/index.d.ts`; `npm pack --dry-run` lists 22 files, 529 kB packed, 2.4 MB unpacked. The package name `code-agent-orchestrator` is free on npm. An unrelated package named `cao` exists on npm, which does not block the `cao` bin name but means a user with that package installed globally gets a collision; the README should mention `code-agent-orchestrator` as the fallback command.

**Blockers.**

- [ ] Add a `LICENSE` file. `package.json` says MIT; GitHub will show "no license" without the file.
- [ ] Add `"prepublishOnly": "npm run typecheck && npm run lint && npm test && npm run build"`. `dist/` is gitignored and is the whole payload; without this a publish can ship a stale or missing build.
- [ ] Commit the untracked files that are published or referenced: `CHANGELOG.md`, `docs/capabilities.md`, `docs/models.md`, the new `src/` and `test/` files. A fresh clone cannot currently reproduce the package.
- [ ] Cut `## Unreleased` to `## [0.1.0] - <date>` and add the Keep a Changelog preamble. The "Removed (breaking, library API)" section describes removals against a version that was never published; fold it into the release notes as "initial public API".
- [ ] README install: replace clone + `npm link` with `npm install -g code-agent-orchestrator@beta`, keep the clone instructions under Development.
- [ ] Add `repository`, `homepage`, `bugs`, `keywords`, `author` to `package.json`. npm and GitHub both render these on the front page.
- [ ] Exclude `docs/research/` from `files` (129 kB, a quarter of the tarball, and internal notes). Either narrow `files` to the five reference docs or move research out of `docs/`.
- [ ] Add `.github/workflows/ci.yml` running typecheck, lint and test on Node 22 and 24, on `ubuntu-latest` and `windows-latest`. The integration suites need a real `git` on the runner; they do not need Claude or Codex.
- [ ] Decide on `.agents/` and `scripts/install-cao-skills.ps1`: they are untracked and not ignored, one `git add -A` from being committed. Track and document, or ignore.

**Strongly recommended.**

- [ ] A stability notice near the top of the README: pre-1.0, the YAML schema and library API may change between minors, `CHANGELOG.md` records every breaking change. Publish with `--tag beta` so `npm install -g code-agent-orchestrator` does not resolve to it until 1.0.
- [ ] An `exports` map (`"."`, `"./package.json"`) so deep imports of `dist/*` are not part of the public surface.
- [ ] Drop sourcemaps from the published build or keep them and accept 1.2 MB; either is fine, but decide.
- [ ] Document `CAO_CODEX_COMMAND` and `CAO_DEBUG` next to `CAO_CLAUDE_COMMAND`; all three are read but only one is documented.
- [ ] State in the README that the CLI makes no network calls of its own and sends no telemetry. It is true today and it is what a security-conscious user looks for first.
- [ ] `CONTRIBUTING.md` (how to run the fake agent, where tests live), `SECURITY.md` (private disclosure address), issue templates for "workflow fails" that ask for `cao validate --json` and the run directory listing.
- [ ] Guard the worktree and e2e suites with a skip when `git` is missing so a contributor without git gets a clear message instead of a stack trace.
- [ ] Neutral path in the README quick start (`cd ~/projects/my-project`) instead of a Windows drive path inside a bash fence.
- [ ] A `cao doctor` command is the cheapest support tool for a public beta: Node version, git, each agent CLI found and its version, stale locks, orphaned worktrees and branches. Most "it does not work" reports are environment. `[F:A3]`
- [ ] An `uncaughtException` handler in `bin.ts` next to the existing `unhandledRejection` one, exiting 70 with the same message shape.

## 6. Out of scope here

Everything that adds a new workflow construct or channel is deliberately left to [feature-research.md](feature-research.md): command tasks, loops, notifications, answering prompts from outside the dashboard, cost estimates, a web UI. The proposals above only deepen what ships today.
