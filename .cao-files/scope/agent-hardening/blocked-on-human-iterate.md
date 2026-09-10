# blocked-on-human-iterate

Spec sections: **H3.5, H3.6, H3.7** - the round trip, the headless contract, and the whole
acceptance matrix end to end.

The previous task built the mechanism. This one makes it usable: drive it as an operator would,
find the rough edges, fix them.

## Deliverables

### The answer round trip (H3.5)

`cao resume <run> --task <id> --input "text"` currently sets `state.userInput`, resets the task
to `pending`, and starts a **fresh attempt** with the answer as a `# User Input` context block
(`src/context/context-builder.ts`, `src/workflow/run-factory.ts`). The worker redoes everything
it had already done, and it is never told what question the answer answers.

- Where the previous attempt has a resumable session (`sessionResumable`; Codex `exec` supports
  `exec resume <id>`, app-server `thread/resume`), continue that session and deliver the answer
  as the next user message instead of restarting. `triggeredBy: 'user_input'` already
  distinguishes the attempt; make sure `cao task` shows it.
- Where it does not, the fresh attempt still receives the original question next to the answer.
- `cao resume --task X --input` on a task that is not in `needs_input` is a `UsageError` naming
  the actual state.
- Several tasks paused on input in one run: either all answerable in one invocation, or the
  command says plainly that they are answered one at a time. Whichever you choose, the
  "Workflow paused" summary printed by `cao run` must match it.

### Headless contract (H3.6)

- Nothing blocks with `--no-tui`, in CI, or on a non-TTY: every interaction is denied within
  `interactionTimeout` at the latest.
- The run ends `paused`; the printed summary, the exit code, `cao status` and `cao report` all
  show which tasks need what, with the question text readable.
- `hooks.onInputRequired` fires for both agents with `CAO_INTERACTION_KIND`,
  `CAO_INTERACTION_TITLE` and `CAO_INTERACTION_TOOL` set, and never delays the answer.

## Iterate checklist (minimum)

Drive real runs against the fakes (`CAO_CLAUDE_COMMAND`, `CAO_CODEX_COMMAND`) and work through:

1. Every row of the H3.7 matrix, attended and headless. Anything that hangs, or ends in a state
   the matrix does not name, is a bug.
2. The dashboard modal: two prompts queued; a prompt withdrawn while on screen; a very long
   question; a question whose text contains ANSI escapes or control characters; a prompt
   arriving while the review or logs view is open; `q` pressed with a prompt open.
3. The messages an operator reads: the "Workflow paused" block from `cao run`, `cao status`,
   `cao task <id>`, `cao report`. Does each say what is needed and the exact command to answer?
4. `cao resume --task <id> --input "..."` for both agents, both transports: does the worker
   continue rather than restart, and does it know what it is answering?
5. Interaction timeout expiring while the dashboard is open, and `interactionTimeout: never`.
6. A task that needs input inside a `foreach`, and one whose dependents must then be skipped -
   check `onFailure` and `runIfDependencyFailed` still behave.
7. Stopping (`cao stop`) and Ctrl-C with a prompt open: no orphan process, no stuck run state.

Write down what you find, fix in order of user impact, add a test per fix, repeat until a pass
finds nothing worth fixing or you have done three passes.

## Tests

Row 11 of the H3.7 matrix, both agents. Regression tests for every rough edge fixed. Keep them
in `test/integration/interactive.test.ts` and the Codex e2e file so the whole "needs a human"
story is readable in one or two places.
