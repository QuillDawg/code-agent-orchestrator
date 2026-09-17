# The desktop app, and what `cao` does to be seen by one

`cao` is, and stays, a standalone CLI: nothing in this document requires a desktop app to be
installed, running, or to exist at all. This page describes the one capability `cao` gained so
that a separate desktop application — `cao-desktop`, developed in its own repository with its own
release train — can watch and, later, control a run without `cao` importing it or knowing it is
there.

If you never install the desktop app, nothing here changes how `cao` behaves. Read this page when
you want to know exactly what "announcing a run" means, what it writes to your machine, and how to
tell why a desktop app is not showing a run you expect it to.

## The split

`cao` runs the workflow: it owns the lock file, the heartbeat, the scheduler, every agent process.
The desktop app — when one exists — discovers runs, watches their progress, and (in a later
release) answers prompts and stops or spawns runs. The two communicate through files on disk,
never through a shared library or a network call, and **either can be absent**: a `cao` run with no
desktop app watching behaves exactly as it always has, and a desktop app with no `cao` run to watch
just shows nothing.

The files exchanged this way are versioned. Every one of them carries a `protocol` field — currently
`1` — as its first key. A reader (either side) that sees a higher `protocol` than it understands
degrades or refuses rather than guessing at a shape it has never seen; a `cao` this document
describes moves an unreadable request it finds on disk to a `rejected/` subdirectory rather than
acting on it, and a desktop app is expected to do the analogous thing (show the run read-only with a
banner naming both versions).

## The registry: `~/.cao/`

The one thing `cao` writes to announce itself lives outside your repository, in a small directory
under your home directory:

```
~/.cao/
  config.json           # your per-user opt-in and preferences
  runs/<key>.json        # one file per run this user has started, on this machine
  presence/<pid>.json    # one file per surface (a desktop app, say) that is currently watching
```

`~` is `os.homedir()`. Set `CAO_HOME` to use a different directory instead — the whole tree above
moves there, which is mainly useful for tests or for someone who keeps their dotfiles somewhere
other than their home directory.

### The run entry

While a run is announced (see [The switch](#the-switch-turning-announcing-on) below), `cao` keeps
one file up to date at `~/.cao/runs/<runId>@<repoHash>.json`. The `repoHash` half of the key exists
because run ids are only unique **within one repository's own run history** — two different
repositories can both be on their `2026-09-10-001`, on the same day, and a registry keyed on the run
id alone would silently conflate them. `repoHash` is the first eight hex characters of the SHA-256
of the repository's absolute path (with `\` normalized to `/`, and — on Windows and macOS, whose
filesystems are usually case-insensitive — lower-cased).

The file itself looks like this:

```jsonc
{
  "protocol": 1,
  "key": "2026-09-10-001@a1b2c3d4",
  "runId": "2026-09-10-001",
  "repositoryRoot": "C:/Projects/my-app",
  "orchestratorDir": "C:/Projects/my-app/.orchestrator",
  "workflowName": "authentication-v2",
  "configPath": "C:/Projects/my-app/workflow.yaml",
  "machine": { "hostname": "DESKTOP-K2R9", "platform": "win32", "arch": "x64" },
  "pid": 24188,
  "cliVersion": "0.1.0-beta.3",
  "state": "running",
  "startedAt": "2026-09-10T08:14:02.411Z",
  "heartbeatAt": "2026-09-10T09:02:22.108Z",
  "endedAt": null,
  "exitCode": null,
  "taskCount": 7,
  "capabilities": ["requests", "stop", "kill", "restart"],
  "feedUrl": null
}
```

It is a **pointer plus a heartbeat, never a second copy of run state**. Everything a reader would
want to show — progress, cost, which task is waiting on a human — comes from the run directory
`orchestratorDir` names, the same `.orchestrator/runs/<run-id>/` that `cao status` and `cao task`
already read. That is what keeps a stale entry harmless: even if the entry itself is out of date,
the directory it points at is always the truth.

`capabilities` is the one field worth calling out because it is easy to misread. It is not a
version number and not a fixed list for this release of `cao` — it is exactly what **this run**
wired up when it started. A run started by this release polls its request inbox and acts on `stop`,
`kill` and `restart`, and says so; it does not yet write interaction payloads or check who is
present, so `interactions`, `presence`, `answer` and `approve` are absent and a reader must not
offer them. A reader is expected to enable each affordance (a Stop button, an Answer button, and so
on) only when its token is present, and to ignore any token it does not recognize — so an older
reader talking to a newer `cao` degrades by feature, not by refusing the whole file.

## Asking a run to do something: `requests/`

A surface that wants a run to stop, to be killed, or to restart a task writes a file into that
run's own directory and reads the answer back out of it:

```
.orchestrator/runs/<run-id>/
  requests/<ULID>-<kind>.json    # what is being asked
  requests/acks/<ULID>.json      # the one answer to it
  requests/rejected/<file>       # a request that could not be read, moved rather than deleted
```

A request is `{ "protocol": 1, "id": "<ULID>", "kind": "stop", "requestedAt": "...", "source":
"cao-desktop 0.1.0", "pid": 4188 }`, plus whatever its kind needs — `taskId` for `restart`, and
`expected: { attempt, revision }` when the sender wants the request refused if the task has moved on
since the screen it was built from was drawn. The `id` is a ULID and is also the file's name prefix,
so a plain directory listing is request order.

The owning orchestrator polls the directory every 500 ms, answers each request with
`requests/acks/<ULID>.json` — `{ "protocol": 1, "id", "status": "applied" | "accepted" |
"rejected", "reason": "…", "at": "…" }` — and only then deletes the request. An id is answered once
for the life of the run: resending the same one after a lost ack returns the first answer verbatim
rather than doing the thing twice. `reason` is a sentence written for a person, and is what a
surface should show when a request is refused.

`approve`, `reject` and `answer` are **not** accepted from disk in this release. They are read and
answered with a rejection saying so, because a permission decision is exactly the thing that must
not be grantable by anyone who can write a file in the repository; they are unlocked by the
presence gating described below, not before it.

`machine` matters for the same reason `capabilities` does: a `pid` only means something on the
machine that wrote it. A bare hostname is not enough to tell that on its own — a WSL2 shell takes
its Windows host's hostname by default — so a reader is expected to compare `hostname`, `platform`
**and** `arch` together, and treat a mismatch on any of them as "this run is not one I can check the
liveness of or control", never as "not running".

**Lifecycle.** The entry is written once the run's lock is acquired, rewritten on the same 20-second
tick that already refreshes `lock.json`, rewritten immediately on any state change, and written a
last time when the run ends — with the terminal `state`, `endedAt` and `exitCode` filled in.
Unlike the proposal this replaced, the entry is **not deleted when the run ends**: it stays, so a
desktop app can answer "which repositories do I have runs in at all" the moment it starts, without
keeping a second index of its own in step. `exitCode` is only ever set alongside a non-null
`endedAt` — a resumed run keeps its previous exit code internally until it finishes again, and an
entry that said `state: "running"` next to `exitCode: 3` would read as a contradiction rather than
as "this run was paused before and is going again".

**Retention.** An entry sticks around after its run ends, but not forever. Two independent
conditions decide when one is removed, and they exist for different reasons:

- An entry whose run reached a terminal state (`completed`, `failed`, `paused`, `interrupted`,
  `cancelled`) is removed once its `endedAt` is older than `retainDays` (14 by default,
  configurable in `config.json`).
- An entry that looks `running`, whose `pid` belongs to this machine, but whose heartbeat has gone
  quiet for more than 60 seconds or whose process is no longer running, is shown as **stale** rather
  than running — the orchestrator most likely died without a chance to save. It is removed once that
  stale heartbeat is itself older than `retainDays`.

  The second rule is what keeps a hard-killed orchestrator — `taskkill /F`, a laptop that died on
  battery — from leaving a tombstone forever: without it, such an entry has no terminal `endedAt` to
  age out by the first rule, and would sit there indefinitely offering `cao resume` for a checkout
  that may no longer exist.

Reaping only ever removes the pointer file in `~/.cao/runs/`; it never touches the run directory
itself; an expired run is unlisted, not lost, and `cao status`/`cao list`/`cao resume` still see it
exactly as before. Reaping runs opportunistically on every `cao run` and `cao resume` that writes an
entry, and is best-effort like everything else described here — an error reaping is swallowed, not
raised.

An entry whose `machine` does not match this one is left alone by reaping entirely (nothing here has
any way to know if it is still live) and is expected to be shown, if at all, with an explicit "this
was announced from a different machine" label and no controls.

### Presence: `~/.cao/presence/<pid>.json`

A registry entry says a run *exists and is reachable*; it says nothing about whether anyone is
actually watching it right now. That second fact — **presence** — is a separate, short-lived file
that any surface capable of answering an interaction is meant to write and heartbeat while it runs:

```jsonc
{
  "protocol": 1,
  "pid": 24188,
  "machine": { "hostname": "DESKTOP-K2R9", "platform": "win32", "arch": "x64" },
  "surface": "cao-desktop 0.1.0",
  "startedAt": "2026-09-10T08:02:11.004Z",
  "heartbeatAt": "2026-09-10T09:02:31.660Z",
  "understands": []
}
```

`understands` is the presence side's mirror of a registry entry's `capabilities`: it says what this
particular surface knows how to ask for, so an orchestrator and a surface can agree on what is
possible without either one comparing version numbers. A presence file is considered fresh for 60
seconds after its last heartbeat — the same window used for a stale registry entry — and is ignored
entirely if its `machine` does not match, for the same reason a registry entry's `machine` mismatch
is treated as "unknown" rather than trusted.

Conflating "announced" with "watched" is the mistake this file exists to prevent. Turning on
announcing is a persisted, per-user decision (`cao emit enable`); a surface being open right now is
a fact about this exact minute. If a run's permission handling changed the moment emit was turned
on — rather than the moment a surface was actually present to answer a prompt — then enabling emit
would silently change how every unattended `cao` run on that machine behaves, including ones nobody
is watching. The design keeps the two independent: a run is meant to ask for permission only when
`canInteract` is true, and `canInteract` is meant to become true only when a fresh presence file
exists on this machine **in addition to** emit being on — never from emit alone.

**In this release, that gate is not wired up yet.** `cao` can read `~/.cao/presence/` (the helpers
above exist and are exercised by `cao emit status`, which reports who is present), but nothing
writes a presence file yet — there is no shipped surface that would — and the scheduler's
`canInteract` still means exactly what it always has: whether the interactive dashboard is attached
to this process. Turning emit on today does not change what a worker asks for or waits on; a later
release is what adds the presence check described above. Until then, "a desktop app is running" and
"this run's workers will ask before doing something" are unrelated facts, and the only thing emit
does today is make the run and its progress visible.

## The switch: turning announcing on

Announcing is decided per run, in this order — the first row that has an opinion wins:

| | |
|---|---|
| `cao run --emit` / `--no-emit`, `cao resume --emit` / `--no-emit` | This one invocation only. |
| `CAO_EMIT=1` / `CAO_EMIT=0` | This shell or machine, the same convention as `CAO_ASCII`/`CAO_DEBUG`. |
| `cao emit enable` / `cao emit disable` | The persisted, per-user default, in `~/.cao/config.json`. |
| *(nothing above says anything)* | **Off.** |

`--emit` and `--no-emit` are plain boolean flags — they never take a value. `cao run --emit
workflow.yaml` runs `workflow.yaml`, with announcing on; there is no `--emit <transport>` form to
confuse it with, and `--emit=stdio` is refused outright:

```
$ cao run --emit=stdio workflow.yaml
error: unknown option '--emit=stdio'
(add --help for usage)
```

A **transport** — specifically, the in-process live feed a later release adds — is a separate
concern with its own flag, `--emit-feed` / `CAO_EMIT_FEED=1`, independently defaulted off and never
implied by turning announcing on. Right now it parses and nothing else: a run given it prints a note
that the flag is reserved and does not advertise a feed, because this build serves none.

`cao emit enable` and `cao emit disable` write the persisted opt-in and read it back to confirm the
write actually took (unlike everything else this document describes, they are **not** best-effort —
a command whose only job is to flip that setting failing silently would just move the "why is
nothing announced" question one step earlier):

```
$ cao emit enable
Emit enabled for this user. Runs will announce themselves in ~/.cao/runs — a heartbeat file, and no network port.
Nothing else about how a run behaves changes: with no surface running it is byte-identical to emit off.

Emit:     on  (cao emit enable, in config.json)
Home:     /home/me/.cao  usable
Runs:     0 live, 0 retained
Controls: requests, stop, kill, restart
Surfaces: none present

Runs are announced, but no surface is present to read them.
  A run with nobody listening behaves exactly as it does with emit off, so a prompt is still denied without being asked.
```

```
$ cao emit disable
Emit disabled for this user. Runs already announced keep their entries until they are reaped; nothing new is written.

Emit:     off  (cao emit enable, in config.json)
Home:     /home/me/.cao  usable
Runs:     0 live, 0 retained
Controls: requests, stop, kill, restart
Surfaces: none present

Runs are not announced, so a desktop app on this machine cannot see them.
  Turn it on for this user with: cao emit enable      for one run with: cao run --emit
```

Turning emit on or off never touches runs that are already going, and never deletes an entry a
previous run already wrote — it only decides what the *next* run does.

## The trust boundary

`~/.cao` is created owner-only: `0700` on POSIX, and on Windows the per-user profile ACL it inherits
by being under your home directory — a permission this code never widens. The reason to be careful
here is concrete rather than theoretical: once the parts of this contract that are not built yet
land (a directory where a desktop app asks `cao` to answer a prompt or stop a task on its behalf),
**whatever can write into that directory can approve a tool call in a process that runs arbitrary
commands**. On an ordinary single-user machine that is already true of the repository itself, but it
is exactly the boundary that must never be widened.

Concretely, that means: never point `CAO_HOME` at a network drive, a UNC path, `/tmp`, or any
directory shared between users or machines. `cao` refuses to use one on its own, once, the first
time it would write into it:

```
$ CAO_HOME='//server/share/.cao' cao emit status
Emit:     off  (the default — announcing is opt-in)
Home:     //server/share/.cao  REFUSED: it is a UNC path
Runs:     0 live, 0 retained
Controls: requests, stop, kill, restart
Surfaces: none present

! Nothing is announced: //server/share/.cao cannot be used because it is a UNC path.
  Point CAO_HOME at a local, owner-only directory that nothing syncs, or unset it to fall back to ~/.cao.
```

The same refusal fires for a Windows drive letter mapped to a network share, for a directory inside
a detected OneDrive, Dropbox or Google Drive sync root, and — on POSIX only, where the check means
something — for a directory that is group- or world-writable.

Be honest about what that check is and is not. It is a check on **path shape**, not on access
control lists: `fs.mkdir(mode)` is a no-op on Windows, and a POSIX-style mode bit is a fiction on an
NTFS volume, so neither artifact can rely on the filesystem alone to enforce anything on the
platform most of this project's users are on. What it actually catches is the failure that happens
in practice — a home directory that turns out to be shared or, more commonly, silently synced to a
cloud drive — not a deliberately weakened permission on an otherwise single-user machine, and it is
checked once against the directory itself, not per file written into it. A synced directory that
slips past the check anyway will still produce conflict copies (`*-DESKTOP-*.json` from OneDrive, `*
(*conflicted copy*).json` from Dropbox, `*.sync-conflict-*` from Syncthing); every reader described
in this document skips files matching those names rather than parsing them, so a stray copy cannot
be read as a second, out-of-date pointer to the same run.

`cao` never treats anything it reads from `~/.cao` as a command. Today the only thing it reads back
out of that directory is your own `config.json` and, for `cao emit status`, the presence files
described above — there is no channel yet by which something written into `~/.cao` can change what a
running task does. When that channel exists, the design is that a request must name something
already open (an interaction id, say) and a value that parses as a known answer shape; it is
described as a place `cao` is asked to do something it would already do anyway, never as a way to
introduce a new command or widen a permission a workflow did not already grant.

## Diagnosing an empty window

If a desktop app shows nothing for a run you know is going, or a prompt was denied that you expected
to be asked about, `cao emit status` is the first thing to run. It reports the whole chain that
decides what got announced, one line each, and then says in a sentence what the state it found
means:

```
$ cao emit status
Emit:     off  (the default — announcing is opt-in)
Home:     /home/me/.cao  usable
Runs:     0 live, 0 retained
Controls: requests, stop, kill, restart
Surfaces: none present

Runs are not announced, so a desktop app on this machine cannot see them.
  Turn it on for this user with: cao emit enable      for one run with: cao run --emit
```

- **`Emit`** — whether the *next* run you start would be announced, and which row of the precedence
  table decided it. Pass `--emit` or `--no-emit` to `cao emit status` itself to ask "what would this
  resolve to if a run were given that flag" — useful for checking whether a script's own `--no-emit`
  is the thing quietly keeping it invisible.
- **`Home`** — the resolved `~/.cao` (or wherever `CAO_HOME` points), and whether it passed the
  path-shape check above. A refused home is reported with the reason, and nothing about the counts
  below it is read from a directory `cao` has just refused to trust.
- **`Runs`** — how many announced runs are currently live on this machine versus merely retained,
  plus how many are stale (an orchestrator that likely died without saving) or belong to another
  machine, when either is nonzero.
- **`Controls`** — what a run started by this `cao` wires up and will act on if asked over the
  request inbox described below: the same list it writes into its registry entry's `capabilities`.
  It does not depend on whether a run is currently live — it says what the *next* run would accept.
- **`Surfaces`** — every presence file currently fresh on this machine: who it is, and how long ago
  it last heartbeated. Empty here, with emit on, is the "a run is announced but nothing is present to
  answer it" state described under Presence above — which, until presence gating ships, is also
  simply every run in this release, regardless of what is running.

`--json` prints the same facts as one object, for a desktop app's own onboarding flow to read rather
than parse the sentences above.
