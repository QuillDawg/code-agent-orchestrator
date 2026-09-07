# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0 a minor version may change the
workflow YAML schema, the CLI output or the library exports; when it does, this file says so.

## [Unreleased]

Nothing yet.

## [0.1.0-beta.2] - 2026-09-07

What a smaller model such as Haiku 4.5 does to a workflow, and what `cao` now does about it.

### Added

- A session that ends its turn without the JSON completion object (prose such as "Done, all tests pass.", or
  JSON the contract rejects) is asked for just the object before a retry is spent: the scheduler resumes the
  same session with a prompt that quotes what was wrong, the attempt shows as `nudge` in `cao task`, and the
  dashboard row says `asking for the result`. `retry.resultNudges` (default 1) bounds it; a nudge that produces
  a valid result does not count against `retry.attempts`. Smaller models end this way often.
- The dashboard shows what the orchestrator is doing for a task before its worker says anything
  (`preparing worktree`, `running beforeTask hook`, `starting claude`) instead of a bare idle timer, and a
  workspace that takes more than 30 seconds to prepare is reported as a warning.
- `cao validate` warns when a Haiku task inherits an `effort`, which Claude Code has no levels for; the flag
  is dropped instead of being passed for the CLI to ignore.
- Claude Code runs its auto permission mode only for Sonnet 5, Opus 4.7 and later, and Fable; for any other
  model it accepts `--permission-mode auto` and silently starts the session in its ordinary prompting mode,
  which asks before every file write and command. That is why a Haiku task under the default mode kept asking
  for approval. `cao validate` now warns about such a task, and the runner compares the mode the worker
  reports at start-up with the one requested and raises a run warning plus a transcript line when they differ.

### Changed

- Results are read the way a careful reader would: `null` for a field that does not apply is treated as
  omitted, `status` is matched case-insensitively and with the usual synonyms (`completed`, `done`, `ok`,
  `failure`, `error`, `needs input`), a missing `summary` is filled from `error` and noted in `warnings`,
  and the object taken from prose is the fenced block or trailing object that carries a `status`, not merely
  the last JSON block in the message.
- The documentation now says what `permissionMode: auto` is (Claude Code's classifier, which allows what it
  judges safe and still asks for the rest, is already the default, and only exists for some models), what
  the other modes do, and which to pick for an unattended run or a Haiku task.

### Fixed

- Two tasks of one layer that both resolve to the shared working tree (`git.enabled: false`, an explicit
  `workspace: shared`, `allowUnsafeSharedParallel`) deadlocked the run: the second task waited for the
  shared-tree lock inside the scheduler loop that the first task needed in order to release it, so the first
  task's result was never processed and the second sat `running` and idle forever. The lock is now only
  taken when it is free; a task whose tree is busy stays `ready` until the holder finishes. The same applied
  to a merge-resolution session started while a shared-tree task was running.

## [0.1.0-beta.1] - 2026-09-07

The first public release, published under the `beta` tag
(`npm install -g code-agent-orchestrator@beta`). Everything below is new to anyone installing it; the
Changed and Fixed sections record how the behaviour got there during development, and are worth reading
because they describe what the software does now and why, not because an earlier version behaved otherwise.

### Added

- `cao doctor` answers the environment questions every "it does not work" report comes down to, one line per
  check: Node against `engines.node`, git and whether it can do worktrees, each agent CLI with its version,
  `lock.json` files left behind by an orchestrator that is gone, worktrees and `orchestrator/*` branches a
  finished run left on disk, and whether `.orchestrator/` is ignored by git. A failing check carries the line
  that fixes it — the `cao clean` invocation naming the run responsible, the environment variable that points
  at a missing CLI — and the command exits 1 only for the three things that stop a run outright (Node, git,
  having no agent CLI at all). It changes nothing itself. `--json` adds the raw facts behind the checks, to
  attach to a bug report.
- An ASCII fallback for every glyph the text surfaces draw. `CAO_ASCII=1` prints `-` for the rules, `v`/`x`
  for the status marks and `...` for a truncation, so a Windows console on a legacy code page or a
  `TERM=dumb` log viewer shows a table rather than mojibake; it is also the default guess on a Windows
  terminal that does not identify itself as UTF-8 capable, and `CAO_UNICODE=1` forces the glyphs back on.
  Every ASCII status mark is one column wide, so the columns line up either way.
- `$COLUMNS` is used to lay tables out when there is no terminal to ask, so piped output and CI logs can be
  given a width instead of always getting 120 columns.
- Every command's `--help` ends with worked examples, and `cao --help` lists `CAO_ASCII` and `COLUMNS`
  alongside the other environment variables. Command descriptions no longer repeat the usage line.

- `cao stop [run]` interrupts a run from another terminal, exactly as Ctrl+C does in the terminal that owns
  it: the orchestrator stops scheduling, terminates its workers, persists `interrupted` and exits 130. The
  request is a `stop.json` in the run directory rather than a signal, so it works the same on Windows, and a
  second `cao stop` forces the kill like a second Ctrl+C.
- `cao report [run]` renders a run as one document from what the run directory already holds: header
  (workflow, repository, base commit, duration, cost, tokens, models, tasks never reached), an overview table
  whose rows link to the sections below, then one section per task with its summary, error, files changed
  largest first with `+`/`-` counts, commits, git shas, decisions, warnings, follow-ups and — only once a
  task needed more than one try — an attempts table. The file counts fall back from the attempt's
  `diff.json` to the per-file records on the result, to the recorded `git diff --stat`, to the agent's own
  list, and the report says which one it used, so a run whose attempts captured no diff no longer reads as
  having changed nothing. Agent prose is made safe for the document around it: an unclosed code fence is
  closed and a heading is demoted under the task's own. The Markdown is shaped to paste into a pull request;
  `--json` is the same structure and `--out <file>` writes it out. Every run also writes `report.md` into its
  run directory when it ends and prints the path beside the summary table.
- The transcript viewer can be navigated: `/` searches it and `n`/`N` step through the matches, `k` cycles a
  kind filter (all, text, tools and commands, errors and questions), and scrolling above the oldest entry
  still in memory pages older ones in from the attempt's `events.jsonl`, so the whole transcript is reachable
  from the dashboard. Timestamps now fall back to `MM:SS` below 100 columns instead of disappearing, and the
  detail view shows them too. The task picker moved from `T` to `P`.
- Thinking blocks are parsed into a `thinking` transcript entry and written to the attempt's `events.jsonl`.
  They are hidden by default everywhere — the activity column, `live.json` and the run-level `events.jsonl`
  never carry them — and shown with `T` in the viewer or `cao logs --thinking`.
- The transcript pairs each tool call with its result and prints how long the tool took on the call line
  (`▸ Grep: TODO in src · 0.4s`). The time an attempt spent inside tool calls is summed into its usage, shown
  as a `Tools` column in the dashboard's usage view (`U`) and on each line of the attempt history.
- Entries a subagent produced are nested in the transcript under the `Agent:` call that spawned them,
  collapsed to a `… 3 subagent entries` line until `t` expands them (the same key as tool output). The runner
  probes `claude --help` once per configured command and passes `--forward-subagent-text` when the installed
  CLI advertises it, so a subagent's prose arrives as well as its tool calls.
- `cao task` and the dashboard's detail view render the attempt and interaction history a run already
  persists: every attempt with its kind, what triggered it, duration, outcome, exit code or signal, cost and
  the reason it was retried, and every permission prompt or question with how long the worker waited and how
  it was answered. The elapsed cell of a table row is now the total across attempts, with the current attempt
  in parentheses; the detail view also shows the result's decisions, warnings and follow-ups; the usage view
  shows cache writes and the duration the agent reported; and `cao task --json` carries the same records with
  a `durationMs`, a `reason` and a `waitedMs`.
- The dashboard's activity column now shows the worker's last *action* (tool, command or prose) instead of
  whatever entry arrived last, so a long tool result no longer masks the tool that is running. After 30
  seconds of silence the cell appends `… 2m idle`, and a task waiting out a retry reads `api retry 2/5 in 12s`
  (transient API error) or `retry 1/2 in 30s` — the same counters the scheduler is spending.
- `[` and `]` switch attempts in the dashboard's follow view, as they already did in `cao logs --follow`.
  An earlier attempt is read from its `events.jsonl`; the newest one goes back to following the live worker.
- The dashboard's help panel (`?`) lists the transcript viewer's own keys.
- The dashboard's `C` view is a review view. Files are listed per task with the status letter and `+N -M`
  from the attempt's `diff.json`, cursor-navigable and scrolling instead of truncating; `Enter` opens that
  file's hunks from its `diff.patch` in a pane with the transcript viewer's scrolling keys, `N`/`P` between
  hunks and `←`/`→` between files; `O` opens the file in `$VISUAL`/`$EDITOR`. A running task still shows its
  live tool-stream list. It lives in `src/tui/dashboard/`.
- `cao logs` and `cao peek` render the transcript as one document instead of one isolated line per event: a
  tool call carries how long it took, a subagent's entries are indented under the `Agent:` call that spawned
  them, and a call the attempt never answered reads `· no result` — the tool a crashed or timed-out worker
  stopped in. Under `--follow` the lines that arrive later are paired against the calls the tail established,
  so the time lands on the result line and a subagent's report is indented the same way as when the whole
  log is read at once.
- `cao diff [run] [task]`: the patch an attempt captured, read from the run directory without touching git or
  the working tree. `--stat` and `--name-only` from `diff.json`, `--file <path>`, `--attempt N`, `--json`, and
  `+`/`-`/`@@` colour on a TTY (`--color auto|always|never`, `NO_COLOR`). Without a task it prints every task
  in execution order under a `#` header, and the plain output stays a unified diff `git apply` accepts. A
  merge-resolution attempt is only shown when named with `--attempt`, since its patch spans the whole merge.
- `cao task` now shows the captured per-file `+`/`-` stat table for a finished attempt, and keeps the live
  tool-stream file list only while the task is running.
- A real per-task diff at the end of every attempt: `diff.patch` and `diff.json` (path, status `A`/`M`/`D`/`R`,
  added/deleted lines, binary flag) in the attempt directory, and the same per-file records in the result's
  `git.files`. Worktree attempts are diffed from the base commit to the branch head after the checkpoint
  commit; shared-tree attempts from git tree snapshots taken at acquire and at finalize through a throwaway
  index, so changes made through the shell are captured as accurately as tool-driven edits; merge-resolution
  attempts get a patch of their own, whether the resolution session succeeded or not.
  `diff.patch` is complete enough for `git apply` to replay the attempt on a checkout of its base: it carries
  binary file contents (`--binary`), full blob ids (`--full-index`) and git's final newline.
- `git.maxDiffBytes` (default 2 MB): past it the patch is truncated on a line boundary with a trailing note
  while `diff.json` stays complete. `git.captureDiff` (already documented, previously read by nothing) now
  switches the whole capture off.
- Human-in-the-loop interaction. A worker's permission prompts and `AskUserQuestion` calls are routed to the
  dashboard over Claude Code's stdio control protocol; the task shows as **Needs you** until it is answered,
  the timeout expires, or the worker withdraws the request.
- Live usage per attempt (tokens, context window, cost), file-change tracking, and a shared transcript viewer
  used by both the dashboard follow view and `cao logs --follow`.
- New library exports: `resolveClaudeOptions`, `parseClaudeEvents`, `describeToolUse`, the Claude stdio
  protocol helpers (`encodeUserMessage`, `encodeControlResponse`, `encodeErrorResponse`, `toInteraction`,
  `permissionResult`, `PendingInteractions`), `renderTranscript`, `renderEntry` and `renderMarkdown`.
- `execution.interactionTimeout` (default `30m`, `never` to disable): how long a worker may wait for a human
  answer before the prompt is denied.
- `hooks.onInputRequired`, run when a worker starts waiting for a human, with `CAO_INTERACTION_KIND`,
  `CAO_INTERACTION_TITLE` and `CAO_INTERACTION_TOOL` in its environment.
- `npm run lint` — an ESLint 10 flat config (`eslint.config.js`) covering `src` and `test`.
- Release packaging: a `LICENSE` file (MIT), `repository`, `homepage`, `bugs`, `keywords`, `author` and
  `publishConfig` in `package.json`, and a `prepublishOnly` that runs typecheck, lint, test and build so a
  publish can never ship a stale `dist/`. An `exports` map limits the public surface to the package root and
  `./package.json`, and `files` publishes `docs/*.md` rather than `docs`, keeping `docs/research/` out of the
  tarball. `.editorconfig` and `.nvmrc` (22) pin the conventions; `.github/` carries a CI workflow (typecheck,
  lint, test, build on Node 22 and 24, on `ubuntu-latest` and `windows-latest`), a "workflow fails" issue
  form that asks for `cao validate --json` and the run directory listing, and a pull request template.
- `CONTRIBUTING.md` (how to drive the fake agent through a whole workflow for free, what each test directory
  is for, commit style, what a pull request needs) and `SECURITY.md` (private reporting, and an explicit
  statement of what the orchestrator runs and what it refuses to run). The README documents installing from
  npm under the `beta` tag, the `cao` bin-name collision, that the CLI makes no network calls of its own and
  sends no telemetry, and every `CAO_*` variable it reads in one table.

### Changed

- The published build carries no sourcemaps. They were the largest thing in the tarball and the bundle is not
  what anyone debugs — `npm run dev` runs tsx straight over `src/`.
- An `uncaughtException` in the CLI is reported like an unhandled rejection already was: one message on stderr
  and exit `70`, instead of Node's default stack dump and exit `1`.
- The worktree and end-to-end test suites skip themselves with a message when there is no usable `git` on
  PATH, instead of failing inside `git init`.
- `cao run` and `cao validate` take the workflow path as an optional argument: with none they use
  `workflow.yaml`, `workflow.yml` or `cao.yaml` from the current directory instead of failing with a
  commander error.
- Task references match like run ids do — exactly, or by a prefix that names one task. An ambiguous prefix is
  refused with the candidates listed. `cao peek` and `cao task` take their references as optional arguments,
  so calling them bare gives the same usage error (listing the run's tasks) that `cao logs` already gave.
- "Run not found" and "no runs found" are usage errors and exit `2` instead of `70`, and both name what to do
  next (`cao list`, `cao run <workflow.yaml>`).
- `cao run` checks the lock it acquires and refuses to start while another orchestrator process is running a
  run in the same repository, naming that run, its pid and how to watch or stop it. Two concurrent runs used
  to go undetected and share the working tree.
- `cao resume` accepts `--max-concurrency`, `--permission-mode` and `--claude-command`, the same overrides
  `cao run` takes.
- `--json` on `cao logs` and `cao peek` writes JSON Lines: one normalized transcript entry per line, no
  header, streaming under `--follow`. `cao peek --json` prints a `{"kind":"peek", ...}` status object first.
  `cao logs --events` is now read rather than declared and ignored: it names the default source explicitly
  and wins over `--raw`/`--stderr`/`--prompt`.
- `cao list` sorts by creation time (newest first) and has an `Age` column; `cao status` and `cao task` print
  one time format, local date and time with the age beside it (`2026-09-04 14:03  (7m ago)`), instead of ISO
  UTC in one and a bare clock in the other.
- Tables pad by printable width and clamp to the terminal, narrowing their widest column until the row fits,
  so `cao status` no longer slices its detail column at a fixed 70 characters and a coloured cell no longer
  shifts the row.
- `cao status` prints the run directory and the orchestrator's pid in its text output, not only in `--json`.
- `run`, `resume` and `validate` mark advisories the same way: `!` for a warning, `✗` for an error, `✓` for
  success. The `WARNING:`/`ERROR:` prefix on diagnostics is gone; the glyph carries it.
- `cao --help` ends with the exit codes and the `CAO_*` environment variables, which were only in the README.
- The dashboard's changed-file counts come from the records the attempt captured (`git.files`) when it has
  them, and from the tool stream otherwise. It no longer stamps every path in `result.filesChanged` as an
  edit, which listed files a worker never touched and showed every one of them as `M`.
- **Behaviour:** with a dashboard attached, Claude workers now default to `permissionPrompts: ask`. A prompt
  that used to be denied immediately now waits for a human for up to `execution.interactionTimeout`
  (default 30 minutes), bounded by the task timeout. Unattended runs should set `permissionPrompts: deny`
  or use `--no-tui` to keep the previous fail-fast behaviour.
- "Allow for the rest of this task" is offered only when the CLI supplied a rule scoped to the request. The
  orchestrator no longer falls back to a blanket allow for the whole tool, which had made a single `A` on one
  `Bash` prompt authorize every later shell command in the session.
- Agent-controlled text is stripped of escape sequences and control characters at every render boundary, so a
  worker cannot repaint the permission prompt an operator is reading. The raw bytes are unchanged in the
  attempt's `events.jsonl`. The same cleaning applies to the `CAO_INTERACTION_*` hook variables, which are
  additionally collapsed to a single line of at most 200 characters — quote them in hook commands anyway.
  File names count as agent-controlled text: every list of them is cleaned too, in `cao task`, in the
  dashboard's task detail and in the review view. The one boundary that stays byte-exact is an uncoloured
  `cao diff`, which has to keep being a patch a pipe can consume; a coloured one — the rendering a human
  reads — cleans its patch text and its `--stat` and `--name-only` paths, as git's pager does for `git diff`.
- The run-level `events.jsonl` records an interaction's summary instead of its raw tool input; file contents
  and full shell commands stay in the attempt directory, as worker output and transcripts already did.
- `FORCE_COLOR=0` (and `false`/`off`/empty) now disables forced colour instead of enabling it.
- Diff snapshot index files live under `.orchestrator/tmp/<run-id>/` instead of `.orchestrator/tmp/`, so two
  runs in one repository cannot collide. The directory is removed when the run ends (including when it was
  interrupted) and by `cao clean`. `snapshotIndexPath()` therefore takes the run id as its second argument,
  and `snapshotIndexDir()` / `removeSnapshotIndexDir()` are new exports.
- `WorkspaceManager` gained `captureMergeAttempt()`, the diff-only counterpart of `completeMerge()` used when
  a merge-resolution session did not succeed.

### Fixed

- `cao logs` and `cao peek` timestamped every transcript entry in UTC while `cao status`, `cao task` and
  `cao list` printed local time, so on any machine off UTC the transcript looked hours away from the run it
  belonged to. All of them now print the local wall clock.
- An unknown command or a bad option value exited 1, contradicting the exit code table `cao --help` prints;
  commander's usage errors now exit 2 like every other usage error, and the full help no longer follows every
  mistyped flag.
- A corrupt `workflow.json` surfaced as a bare `Expected property name or '}'` and exit 70, naming neither
  the run nor the file. It now names both, says what to do about it and exits 2 — and `cao list`, which
  skips run directories it cannot read, names them on stderr instead of reporting an empty directory.
- `cao task` built its log paths by appending `/name` to a Windows directory, producing paths with mixed
  separators; it now joins them properly, and no longer offers a finished attempt's pid as if it were a live
  worker (both `cao task` and `cao peek` mark it `(exited)`).
- A third reference (`cao task <run> <task> <extra>`) was silently ignored rather than refused.
- `cao stop` on a run whose orchestrator was killed said "Run X is not running (state: running)". It now
  reports the process rather than the record.
- Whether an orchestrator is running was read from `lock.json` alone, so a run whose lock file went missing
  under a live orchestrator looked idle to every command that asks: `cao stop` printed "nothing to stop" and
  recommended `cao resume`, which would have started a second orchestrator in the same working tree, and
  `cao run` would have allowed one; `cao logs --follow` and `cao peek --follow` stopped following a task that
  was still going. All of them now fall back to `live.json`, which the orchestrator rewrites on the same
  heartbeat and which carries the same pid (a stale heartbeat or a dead pid still counts as not running), and
  `cao status` says when it had to. The heartbeat also writes the lock file back when it finds it gone, so
  the state repairs itself within twenty seconds.
- `cao logs --raw --json`, `--stderr --json` and `--prompt --json` silently ignored the source flag and
  printed normalized entries instead. `--json` only has entries to print for `events.jsonl`, so the
  combination is now refused with a message that says why (exit 2); `--events` still wins, as its help says.
- The dashboard's live follow view stopped being able to page older entries in from disk on any task that
  had been retried. Its buffer spans every attempt while each `events.jsonl` covers one, so the oldest entry
  on screen usually belonged to an earlier attempt, where the current attempt's file could not find it — and
  the empty answer was taken for "you are at the beginning" and remembered for the rest of the session, with
  nothing on screen to say so. Paging now walks back through the attempt files and carries on into the
  attempt before when it reaches a beginning, "nothing older" is remembered against the entry it was said
  about rather than the whole task, and `start of the transcript` is shown whenever the transcript really
  has none.
- The dashboard task table appended the current attempt's elapsed time after the padded total without
  counting it, so one retried task shifted every cell after Duration — agent, ctx, cost, ±files, activity —
  about ten columns right on that row alone. It is now a column of its own, as wide as the widest one on
  screen and zero wide when no task was retried.
- `cao task` and the dashboard detail view printed `undefined` in the trigger, outcome, answer or source cell
  of a record written by a build with a name they have no label for; they now show the raw value, as
  `report.md` already did.
- `cao run nosuch.yaml` repeated the path and the raw errno text; the message now says what is missing.
- The end-of-run summary table padded to fixed widths, so a long task id or failure message ran past the
  terminal, and it labelled states differently from `cao status`. It uses the same column machinery and the
  same labels, and no table row ends in trailing whitespace.
- `cao logs --stderr` on an empty file printed a header and nothing else.
- The execution plan listed a task the workflow file already records as completed exactly like one that
  would run, so `cao validate` and `cao run --dry-run` on a finished workflow described work that would not
  happen and the run then reported every task "Completed" in no time at all. The plan now marks them
  `already done in run <id>, will not run`, and the `Agents:` line says there is nothing to launch instead of
  `not detected`.
- The transcript renderer dropped every entry of a subagent that itself delegated, and left them out of the
  collapsed `… n subagent entries` count as well.
- A delegating call now keeps its own report with it, so two subagents running at once no longer leave both
  reports in a heap at the end of the transcript with nothing saying which call each one answers.
- The viewer's `/` search counts the matches hidden inside collapsed tool output and collapsed subagent
  entries (`+5 in collapsed output (t to expand)`) instead of answering `no matches` about text that is there.
- The viewer stays on the lines you are reading when a running worker appends new ones; the view used to
  scroll out from under you, and the "n lines above the end" counter went stale with it. `t`, `T` and `k`
  keep your place too, instead of leaving the offset pointing at whatever is now that far from the end.
- Below 100 columns the viewer's meta line and key list use a short form. Truncation used to cut off exactly
  the two things a narrow terminal needs: how far up you have scrolled, and which key leaves.
- Rendering a long transcript no longer redraws every entry from scratch on each new one, so `T` on a long
  attempt stays responsive.
- `cao diff --file` and the review view's hunk pane now find the section of a file whose path contains a space
  or a non-ASCII character. Git disambiguates the first with a trailing tab and C-quotes the second with octal
  UTF-8 bytes, neither of which the section matcher undid, so those files silently showed an empty patch.
- A git read that outgrows its buffer is only treated as a short read when the caller asked for a cap. An
  uncapped command that overran the default now fails instead of handing back partial output that the caller
  would parse as complete.
- A task whose merge-back conflicted and was resolved by a merge-resolution attempt keeps the git block of its
  own attempt — branch, head and per-file stat — instead of ending with none, which left downstream context
  without a diff summary.
- The review view now fits the terminal it was given: a path too long for a row is shortened from the left so
  its `+N -M` survives, the pane's title bar keeps the attempt and the file position, and both footers drop
  their least important hints instead of running off the edge at 80 columns.
- Escape sequences a worker wrote into a file no longer reach the terminal through the hunk pane, and tabs are
  expanded to the terminal's stops so a diff line measures the width it draws at.
- The hunk pane no longer rebuilds and re-colours the whole patch on every spinner tick, and holding `n` or `p`
  now moves one hunk per keystroke instead of one per frame.
- A task that ran and changed nothing, or whose attempt captured no diff, keeps its line in the list and says
  which of the two it is, instead of disappearing.
- The pane leaves out the `diff --git`, `index` and `---`/`+++` header lines that only repeat its own title
  bar, giving four more rows to the diff on a 24-row terminal.
- A withdrawn or timed-out permission prompt is now taken off the dashboard queue. Previously the modal stayed
  on screen for a request the scheduler had already answered, and a genuinely new prompt queued behind it.
- A task stays `waiting` until every concurrent request is answered. A worker making parallel tool calls can
  have two prompts open at once; answering the second used to report the task as running while the first was
  still blocking the worker.
- An attempt's `events.jsonl` now ends with its outcome. The final `result`/`error` entry was written after the
  stream was closed, so `cao logs` and `cao peek` showed the work but never how it finished.
- Wrapped transcript lines keep their styling: the opening colour code no longer bleeds into everything printed
  after it while the continuation lines render unstyled.
- The transcript viewer's footer described the wrong keys (`g` jumps to the oldest line, `Shift+G` follows).
- `stripAnsi` had lost a backslash in its pattern, so it only matched real SGR codes by coincidence and also
  swallowed malformed sequences. It now strips CSI, OSC and two-character escapes deliberately.
- The dashboard's follow view no longer re-renders the whole transcript buffer on every spinner tick.

### Initial public API

The supported surface is exactly what `src/index.ts` re-exports, reached through the package root
(`import { ... } from 'code-agent-orchestrator'`). The `exports` map admits only `"."` and
`"./package.json"`: `dist/bin.js` and any other file in `dist/` are internals and may move without notice.
It covers what a host needs to embed a run — the config loader, `normalizeWorkflow`, `validateWorkflow` and
`TaskGraph`, `WorkflowScheduler` with `createRun`/`reconcileForResume` and `exitCodeFor`, `FileRunStore`,
the workspace managers with `Git` and the diff-capture helpers, `ProcessManager`, `RunnerRegistry` and
`ClaudeRunner` with `buildClaudeArgs`, `resolveClaudeOptions`, `parseClaudeEvents`, `describeToolUse` and
the stdio protocol helpers (`encodeUserMessage`, `encodeControlResponse`, `encodeErrorResponse`,
`toInteraction`, `permissionResult`, `PendingInteractions`), the completion contract, the transcript and
Markdown renderers (`renderTranscript`, `renderEntry`, `planTranscript`, `renderMarkdown`), `Redactor`,
`prepareWorkflow`/`createRuntime` and the shared types.

Anything not on that list is internal, including several things that existed in pre-release builds and are
now gone: `ProcessManager.peek()` (read the attempt's `events.jsonl`, or use
`WorkflowScheduler.peek(taskId, n)`), `FileRunStore.lastLiveWrite` (write throttling, now owned by the
scheduler), `attemptLogPaths()` from `workflow/scheduler.js` (use `RunPaths.attemptDir(runId, taskId,
attempt)`) and `PendingInteractions.has()`. `PendingInteractions.abortAll()` returns nothing: each handler
settles through its own abort signal. `snapshotIndexPath()` takes the run id as its second argument,
alongside the new `snapshotIndexDir()` and `removeSnapshotIndexDir()`.

Pre-1.0, this surface can still change in a minor version.
