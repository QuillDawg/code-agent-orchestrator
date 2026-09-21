# code-agent-orchestrator-protocol

The contract between the [`code-agent-orchestrator`](https://www.npmjs.com/package/code-agent-orchestrator)
CLI and CAO Desktop: the run-directory layout, the workflow, run, result, event, interaction and transcript
types, the pure logic that turns a flat transcript into the tree every surface renders, and the schemas of
the files the two artifacts exchange.

**Zero runtime dependencies, no Node builtins, browser-safe.** It is published from the `cao` repository and
consumed by both artifacts.

```
npm install code-agent-orchestrator-protocol
```

## Why it exists

Without it the desktop app has two bad choices: re-declare every type in a second place, which guarantees
drift, or bundle `code-agent-orchestrator`, whose entry point reaches `node:fs` through `FileRunStore` and
dies in a browser build.

The failure it prevents is quiet. A hand-rolled copy of `planTranscript` is correct on the day it is written
and wrong the first time `cao` changes how a subagent nests — and the symptom is not a crash, it is a
transcript that renders the wrong tree while both sides believe they agree. One implementation is what makes
that agreement true.

The same holds for the run-directory layout. A consumer is handed `createRunPaths`; it does not concatenate
`.orchestrator` with a run id.

```ts
import { createRunPaths, parseTranscriptLine, planTranscript } from 'code-agent-orchestrator-protocol';

const paths = createRunPaths('/work/my-repo');
paths.eventsFile('2026-09-10-001');
// → /work/my-repo/.orchestrator/runs/2026-09-10-001/events.jsonl

const entries = lines.map(parseTranscriptLine).filter((e) => e !== null);
for (const item of planTranscript(entries)) render(item); // subagents nested, tools paired with their results
```

`planTranscript` is one-shot and global: it reads the whole array, because whether a call went unanswered is
decided by the *last* entry in it. That is the right shape for `cao logs`, for `cao peek`, and for a test.
It is the wrong shape behind a tailer, where an attempt of tens of thousands of entries would be re-planned
several times a second into an entirely new tree, handing a renderer fresh objects for rows that did not
move. So the same algorithm is also available incrementally:

```ts
import { createTranscriptPlan } from 'code-agent-orchestrator-protocol';

const planner = createTranscriptPlan();

onTailLines((lines) => {
  const { added, changed } = planner.append(lines.map(parseTranscriptLine).filter((e) => e !== null));
  // Update those rows, or take the whole tree — it is reference-equal to the last one until something moves,
  // and a node that did not change is the same object it was.
  render(planner.plan());
});

onAttemptEnded(() => planner.end());    // marks every call nobody answered
onNextAttempt(() => planner.reset());   // tool ids do not pair across attempts
```

The two are tied together by a property, not by sharing code: for every fixture and every split point,
`incremental(a).append(b).plan()` equals `planTranscript([...a, ...b])`. Change one and the other's test
tells you.

Paths are joined with `/`, because the package carries no `node:path`. Every platform CAO runs on accepts
`/` in a filesystem call; a caller that wants the native separator normalises the string it was handed.

## Versioning

Two numbers, and they answer different questions.

| | |
|---|---|
| **This package's semver** | Is the shared code you compiled against still the shared code that is installed? It moves only when the contract moves, so most `cao` releases do not bump it. Both artifacts depend on a caret range. |
| **`PROTOCOL_VERSION`** | Can this artifact read this file at all? Every file either side writes across the boundary carries `"protocol"` as its first field. A reader that sees a higher major degrades or refuses explicitly, and says so on screen. |

Missing features are not version mismatches. What a particular run can do is its registry entry's
`capabilities` list, and what a surface knows how to ask for is its presence file's `understands` list. Each
side gates on the other's list and ignores tokens it does not know; neither compares versions to decide what
a button does.

Enums that cross the boundary are **open**. `cao` may add a `TaskState`, an `AttemptOutcome`, a `TaskReason`
or an event type in a patch release, and by construction new ones land in `cao` first. A reader renders an
unknown member as its raw string — never dropped, never coerced:

```ts
import type { TaskState } from 'code-agent-orchestrator-protocol';

type WireTaskState = TaskState | (string & {});
const STYLE: Partial<Record<TaskState, Style>> = { running: /* … */ };

const styleFor = (state: WireTaskState): Style => STYLE[state as TaskState] ?? neutral(state);
```

## Consuming it while both sides are still moving

Two release trains have to meet somewhere, and the failure that happens when they do not is quiet: an app
bundling `planTranscript` at one version while the installed `cao` writes `events.jsonl` at another, so two
renderers disagree about structure while their tests claim they cannot. The tests are only right about the
pair they ran against.

So: **a caret range in `dependencies`, always.** `code-agent-orchestrator` depends on `^0.2.0`; the app
should depend on the same range. Inside this repository the npm workspace resolves that range to
`packages/protocol` and `npm install` builds it, so nothing extra is needed to work on the CLI.

From a checkout of `cao-desktop`, take the workspace itself — **never a copy of the files.** Either:

```bash
# in code-agent-orchestrator/packages/protocol
npm link
# in cao-desktop
npm link code-agent-orchestrator-protocol
```

or publish a prerelease (`npm publish --tag next` from this directory) and depend on that tag. Both keep one
declaration of every shared type. Copying `src/` into the app produces two, and the day they differ is the
day the two renderers start disagreeing without anything failing.

CI runs against one pair — the package in `packages/protocol` and the `cao` in the same commit — so it
proves the two agree here, not that they agree with whatever the app has installed. What closes the rest of
the gap is the corpus: the fixtures are recorded attempt logs in `test/fixtures/transcripts/`, written by
`scripts/record-transcripts.ts` in the repository above, and `planTranscript` is checked against them at
every split point. A surface reads that corpus rather than copying it, so the two renderers cannot be shown
different input.

## Contributing

The package lives at `packages/protocol/` in the
[`code-agent-orchestrator`](https://github.com/QuillDawg/code-agent-orchestrator) repository and is built and
tested from there. Two rules govern what may be added:

- **Nothing that needs a Node builtin, a DOM API or a dependency.** A test in the repository bundles the
  built package for a browser target with no externals allowed, and fails on any import that is not relative.
- **Nothing that is presentation.** Structure and shared shapes live here; ANSI, glyphs and the DOM do not.

## License

MIT
