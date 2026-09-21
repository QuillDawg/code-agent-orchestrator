import { Command, InvalidArgumentError, type HelpContext } from 'commander';
import { runCommand } from './commands/run.js';
import { validateCommand } from './commands/validate.js';
import { resumeCommand } from './commands/resume.js';
import { uiCommand } from './commands/ui.js';
import { statusCommand } from './commands/status.js';
import { listCommand } from './commands/list.js';
import { logsCommand } from './commands/logs.js';
import { peekCommand } from './commands/peek.js';
import { taskCommand } from './commands/task.js';
import { taskControlCommand } from './commands/task-control.js';
import { taskEditCommand } from './commands/task-edit.js';
import { taskPromptCommand } from './commands/task-prompt.js';
import { diffCommand } from './commands/diff.js';
import { reportCommand } from './commands/report.js';
import { cleanCommand } from './commands/clean.js';
import { stopCommand } from './commands/stop.js';
import { doctorCommand } from './commands/doctor.js';
import { diagnosticsCommand, DIAGNOSTICS_INCLUDES } from './commands/diagnostics.js';
import { emitCommand, EMIT_ACTIONS } from './commands/emit.js';
import { DEFAULT_ACK_WAIT_SECONDS } from '../persistence/requests.js';
import { DEFAULT_WORKFLOW_FILES, terminalWidth } from './util.js';
import { OrchestratorError } from '../util/errors.js';
import { packageInfo } from '../util/package-info.js';
import { themeNameOf, THEME_NAMES, type ThemeName } from '../tui/theme.js';
import type { PermissionMode } from 'code-agent-orchestrator-protocol';

const pkg = packageInfo();

/** The four headings root help groups its commands under (§3.3). */
export const COMMAND_GROUPS = {
  run: 'Run:',
  inspect: 'Inspect:',
  task: 'Task controls:',
  diagnostics: 'Diagnostics:',
} as const;

function positiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

function nonNegativeInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new InvalidArgumentError('must be zero or a positive integer');
  return n;
}

/** A budget in dollars: not an integer, and zero would mean "stop before the first token" (§3.4). */
function positiveNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be an amount above zero');
  return n;
}

function colorMode(value: string): 'auto' | 'always' | 'never' {
  if (!['auto', 'always', 'never'].includes(value)) throw new InvalidArgumentError('must be auto, always, or never');
  return value as 'auto' | 'always' | 'never';
}

const PERMISSION_MODES: PermissionMode[] = ['auto', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan', 'manual'];
function permissionMode(value: string): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new InvalidArgumentError(`must be one of ${PERMISSION_MODES.join(', ')}`);
  return value as PermissionMode;
}

function themeName(value: string): ThemeName {
  // `default` is still taken, silently: it was the name of this palette before stage 4 gave it one, and a
  // script or an alias that still passes it should keep opening the workspace it always did.
  const name = themeNameOf(value);
  if (name !== undefined) return name;
  throw new InvalidArgumentError(`must be one of ${THEME_NAMES.join(', ')}`);
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * What every command's help ends with: worked examples, and the exit codes that command really produces.
 *
 * Keyed by the path a user types, so a subcommand (`task show`) gets its own block. The examples are
 * executable: `test/unit/cli-consistency.test.ts` parses every one of them back out of the rendered help
 * and puts it through the parser, so an option renamed here and forgotten there fails the suite (§3.3).
 */
interface CommandHelp {
  examples: string[];
  /** One line, in the same words as the root help's exit-code table. */
  exits: string;
}

export const COMMAND_HELP: Record<string, CommandHelp> = {
  run: {
    examples: [
      'cao run                                 # workflow.yaml in this directory',
      'cao run workflows/ship.yaml --dry-run   # the plan, no agents',
      'cao run --task implement-api --no-tui',
    ],
    exits: '0 completed  1 a task failed  2 usage or validation error  3 paused for you  130 interrupted',
  },
  validate: {
    examples: ['cao validate', 'cao validate workflows/ship.yaml --json'],
    exits: '0 valid  2 invalid workflow, or usage error',
  },
  resume: {
    examples: [
      'cao resume                              # the latest run, retrying failures',
      'cao resume 2026-09-04-002 --task review',
      'cao resume --approve deploy',
    ],
    exits: '0 completed  1 a task failed  2 usage error  3 paused for you  130 interrupted',
  },
  ui: {
    examples: [
      'cao ui                                  # pick a recent run, or start a workflow file',
      'cao ui 002                              # open that run (observer if another terminal owns it)',
      'cao ui --json                           # the same list, for a script',
    ],
    exits: '0 quit, or the code of a run executed from inside the workspace  2 usage error',
  },
  stop: {
    examples: [
      'cao stop                                # ask the latest run to stop',
      'cao stop 002 --wait 0                   # ask and return immediately',
    ],
    exits: '0 asked (also when the wait elapses)  2 usage error',
  },
  status: {
    examples: ['cao status', 'cao status 002                          # run ids match by prefix', 'cao status --json'],
    exits: '0 shown  2 no such run, or usage error',
  },
  list: {
    examples: ['cao list', 'cao list --limit 5'],
    exits: '0 listed (also when there are no runs)  2 usage error',
  },
  logs: {
    examples: [
      'cao logs review                         # the latest run, task "review"',
      'cao logs 2026-09-04-002 review -a 2',
      'cao logs --follow                       # pick a task and switch between them',
      'cao logs review --json',
    ],
    exits: '0 shown  2 no such run or task, or usage error',
  },
  peek: {
    examples: ['cao peek implement-api', 'cao peek implement-api --follow'],
    exits: '0 shown  2 no such run or task, or usage error',
  },
  task: {
    examples: [
      'cao task review                         # show, the default subcommand',
      'cao task show edit                      # the task called "edit", not a subcommand',
      'cao task stop review                    # cancel the attempt it is running',
      'cao task restart review                 # run a finished, unsuccessful task again',
      'cao task edit review --model claude-opus-5   # change what it will run with',
      'cao task prompt review --message "also update the changelog"  # say something to it',
    ],
    exits: '0 done  2 usage error, or a control the run refused',
  },
  'task show': {
    examples: ['cao task review', 'cao task show 002 review --json'],
    exits: '0 shown  2 no such run or task, or usage error',
  },
  'task stop': {
    examples: [
      'cao task stop review                    # wait up to 30s for the owner to answer',
      'cao task stop 002 review --wait 0       # write the request and return',
    ],
    exits: '0 applied, accepted, or still queued when the wait elapsed  2 refused, no owner, or usage error',
  },
  'task edit': {
    examples: [
      'cao task edit review --prompt-file new-prompt.md   # the resolved prompt, context still automatic',
      'cao task edit review --retries 3 --timeout 90m',
      'cao task edit 002 review --model claude-opus-5 --restart   # stop it, apply, start it again',
    ],
    exits: '0 applied  2 rejected, no such run or task, or usage error',
  },
  'task prompt': {
    examples: [
      'cao task prompt review --message "also update the changelog"   # the run picks the mode and says which',
      'cao task prompt review --file notes.md --steer',
      'cao task prompt 002 review --message "try again with -O2" --stop-and-continue',
      'cao task prompt review --message "start over from the spec" --fresh-session',
    ],
    exits: '0 delivered, queued or started  2 refused, no such run or task, or usage error',
  },
  'task restart': {
    examples: ['cao task restart review', 'cao task restart 002 review --wait 60'],
    exits: '0 applied, accepted, or still queued when the wait elapsed  2 refused, no owner, or usage error',
  },
  diff: {
    examples: ['cao diff                                # every task, in execution order', 'cao diff review --stat', 'cao diff review --file src/app.ts'],
    exits: '0 shown  2 no such run or task, or usage error',
  },
  report: {
    examples: ['cao report', 'cao report 002 --out report.md'],
    exits: '0 written  2 no such run, or usage error',
  },
  clean: {
    examples: ['cao clean                               # worktrees of the latest run', 'cao clean 002 --all                     # worktrees and branches'],
    exits: '0 cleaned  2 no such run, or usage error',
  },
  doctor: {
    examples: [
      'cao doctor                              # no agent is started, nothing is spent',
      'cao doctor --probe                      # start every agent mode for real',
      'cao doctor --json                       # paste this into a bug report',
    ],
    exits: '0 every required check passed  1 a check failed  2 usage error',
  },
  diagnostics: {
    examples: [
      'cao diagnostics --out cao-bug.json      # the latest run, without transcripts or diffs',
      'cao diagnostics 002 --out bug.json --include transcripts,prompts',
    ],
    exits: '0 written  2 no such run, or usage error',
  },
  emit: {
    examples: [
      'cao emit status                         # the setting, where it came from, and who is listening',
      'cao emit enable                         # announce every run this user starts, from now on',
      'cao run --emit                          # announce this one run only',
    ],
    exits: '0 shown or changed  2 usage error',
  },
};

/** `cao <path>` for a command, whatever depth it sits at. */
function commandPath(command: Command): string {
  const names: string[] = [];
  for (let c: Command | null = command; c?.parent; c = c.parent) names.unshift(c.name());
  return names.join(' ');
}

/** Attach the Examples and Exit blocks to every command and subcommand that has one. */
function attachCommandHelp(parent: Command): void {
  for (const command of parent.commands) {
    const help = COMMAND_HELP[commandPath(command)];
    if (help) {
      command.addHelpText('after', ['', 'Examples:', ...help.examples.map((l) => `  ${l}`), '', `Exit codes: ${help.exits}`, ''].join('\n'));
    }
    attachCommandHelp(command);
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('cao')
    .description('Code Agent Orchestrator: run YAML-defined engineering workflows as a DAG of isolated Claude Code and Codex sessions')
    .version(pkg.version)
    // `terminalWidth()`, not commander's own: it reads `$COLUMNS` when there is no TTY, which is how every
    // table in this CLI is laid out, so `COLUMNS=100 cao --help | ...` wraps where a 100-column terminal
    // would rather than at commander's fixed 80.
    .configureOutput({ writeErr: (s) => process.stderr.write(s), getOutHelpWidth: terminalWidth, getErrHelpWidth: terminalWidth })
    // The full help after every mistyped option buries the one line that says what was wrong.
    .showHelpAfterError('(add --help for usage)')
    // "unknown command 'stauts'" and nothing else is a worse answer than the one letter that was wrong.
    .showSuggestionAfterError()
    // Commander exits 1 for an unknown command or a bad option value, contradicting the exit code table
    // below: a usage error is 2 everywhere else in this CLI. `--help` and `--version` arrive here with
    // exit code 0 and stay 0. Set before the subcommands, which inherit it.
    .exitOverride((err) => process.exit(err.exitCode === 1 ? 2 : err.exitCode));

  // `cao` alone is someone finding out what this is, not a mistake: help on **stdout**, exit 0 (§3.3).
  // Commander writes that help to stderr and exits 1 instead. An action handler on the root would fix the
  // exit code and cost the unknown-command error, which is dispatched only when the root has none - so the
  // one call that reaches here with nothing parsed is intercepted rather than the parse rearranged.
  const commanderHelp = program.help.bind(program) as (context?: HelpContext) => never;
  program.help = ((context?: HelpContext) => commanderHelp(program.args.length === 0 ? { error: false } : context)) as Command['help'];

  const exitWith = async (fn: () => Promise<number>): Promise<void> => {
    try {
      const code = await fn();
      process.exitCode = code;
      if (code !== 0) setImmediate(() => process.exit(code));
      else setTimeout(() => process.exit(0), 50).unref();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`\nError: ${message}\n`);
      if (process.env.CAO_DEBUG && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
      process.exit(err instanceof OrchestratorError ? err.exitCode : 70);
    }
  };

  // --------------------------------------------------------------------------------------------- Run
  program.commandsGroup(COMMAND_GROUPS.run);

  program
    .command('run')
    .description('Run a workflow')
    .argument('[workflow]', `path to the workflow YAML (default: ${DEFAULT_WORKFLOW_FILES.join(', ')} in this directory)`)
    .option('--dry-run', 'show the execution plan without starting agents')
    .option('-t, --task <id>', 'run only this task (repeatable)', collect)
    .option('--from <id>', 'run this task and everything downstream of it (repeatable)', collect)
    .option('--max-concurrency <n>', 'override execution.maxConcurrency', positiveInt)
    .option('--permission-mode <mode>', `override the Claude permission mode (${PERMISSION_MODES.join('|')})`, permissionMode)
    .option('--repository <dir>', 'override the repository root (default: launch directory / git root)')
    .option('--claude-command <cmd>', 'override the Claude CLI command')
    .option('--emit', 'announce this run to a desktop app on this machine (~/.cao); see cao emit status')
    .option('--no-emit', 'do not announce this run, whatever cao emit and CAO_EMIT say')
    .option('--emit-feed', 'reserved for the per-run live feed; it is not served yet')
    .option('--no-tui', 'disable the interactive workspace (line output)')
    .option('--no-alt-screen', 'draw the workspace in the normal buffer instead of the alternate screen')
    .option('--theme <name>', `workspace theme: ${THEME_NAMES.join('|')} (NO_COLOR forces mono)`, themeName)
    .option('--activity', 'print agent activity lines in line-output mode')
    .option('--debug', 'debug logging into orchestrator.log, stack traces, and open the workspace on the Diagnostics tab (CAO_DEBUG=1)')
    .option('-v, --verbose', 'verbose output')
    .action((workflow: string | undefined, opts) => exitWith(() => runCommand(workflow, opts)));

  program
    .command('resume')
    .description('Resume an interrupted, failed or paused run')
    .argument('[run]', 'run id, or a unique prefix of one (default: latest)')
    .option('--no-retry-failed', 'keep failed tasks failed instead of retrying them')
    .option('--approve <task>', 'approve a pending approval gate (repeatable)', collect)
    .option('--reject <task>', 'reject a pending approval gate (repeatable)', collect)
    .option('--input <text>', 'answer for a task in needs_input state (use with --task)')
    .option('-t, --task <id>', 're-run this task (repeatable)', collect)
    .option('--from <id>', 're-run this task and everything downstream (repeatable)', collect)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .option('--max-concurrency <n>', 'override execution.maxConcurrency for this run', positiveInt)
    .option('--permission-mode <mode>', `override the Claude permission mode (${PERMISSION_MODES.join('|')})`, permissionMode)
    .option('--claude-command <cmd>', 'override the Claude CLI command')
    .option('--emit', 'announce this run to a desktop app on this machine (~/.cao); see cao emit status')
    .option('--no-emit', 'do not announce this run, whatever cao emit and CAO_EMIT say')
    .option('--emit-feed', 'reserved for the per-run live feed; it is not served yet')
    .option('--no-tui', 'disable the interactive workspace')
    .option('--no-alt-screen', 'draw the workspace in the normal buffer instead of the alternate screen')
    .option('--theme <name>', `workspace theme: ${THEME_NAMES.join('|')} (NO_COLOR forces mono)`, themeName)
    .option('--activity', 'print agent activity lines in line-output mode')
    .option('--debug', 'debug logging into orchestrator.log, stack traces, and open the workspace on the Diagnostics tab (CAO_DEBUG=1)')
    .option('-v, --verbose', 'verbose output')
    .action((run: string | undefined, opts) => exitWith(() => resumeCommand(run, opts)));

  program
    .command('ui')
    .description('Open the workspace on a run, or pick one')
    .argument('[run]', 'run id, or a unique prefix of one (default: choose from the recent runs)')
    .option('--repository <dir>', 'repository containing .orchestrator')
    .option('--limit <n>', 'how many recent runs to offer', positiveInt)
    .option('--json', 'the runs and the workflow files as JSON, without opening anything')
    .option('--no-tui', 'print the list instead of opening the workspace')
    .option('--no-alt-screen', 'draw the workspace in the normal buffer instead of the alternate screen')
    .option('--theme <name>', `workspace theme: ${THEME_NAMES.join('|')} (NO_COLOR forces mono)`, themeName)
    .option('-v, --verbose', 'verbose output')
    .action((run: string | undefined, opts) => exitWith(() => uiCommand(run, opts)));

  program
    .command('stop')
    .description('Stop a run from another terminal')
    .argument('[run]', 'run id, or a unique prefix of one (default: latest)')
    .option('--wait <seconds>', 'how long to wait for the orchestrator to stop (0 to return immediately)', nonNegativeInt)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((run: string | undefined, opts) => exitWith(() => stopCommand(run, opts)));

  program
    .command('validate')
    .description('Validate a workflow and print its execution plan')
    .argument('[workflow]', `path to the workflow YAML (default: ${DEFAULT_WORKFLOW_FILES.join(', ')} in this directory)`)
    .option('--repository <dir>', 'override the repository root')
    .option('--json', 'machine-readable output')
    .action((workflow: string | undefined, opts) => exitWith(() => validateCommand(workflow, opts)));

  // ----------------------------------------------------------------------------------------- Inspect
  program.commandsGroup(COMMAND_GROUPS.inspect);

  program
    .command('status')
    .description('Show a run and its tasks')
    .argument('[run]', 'run id, or a unique prefix of one (default: latest)')
    .option('--repository <dir>', 'repository containing .orchestrator')
    .option('--json', 'machine-readable output')
    .action((run: string | undefined, opts) => exitWith(() => statusCommand(run, opts)));

  program
    .command('list')
    .description('List the runs of this repository')
    .option('--repository <dir>', 'repository containing .orchestrator')
    .option('--limit <n>', 'maximum runs to show', positiveInt)
    .option('--json', 'machine-readable output')
    .action((opts) => exitWith(() => listCommand(opts)));

  program
    .command('logs')
    .description('Show or follow a task transcript')
    .argument('[refs...]', 'task id, or run id followed by task id (ids may be shortened to a unique prefix)')
    .option('-a, --attempt <n>', 'attempt number (default: latest)', positiveInt)
    .option('--stderr', 'show stderr.log instead of events')
    .option('--raw', 'show raw stdout.log (stream-json) instead of normalized events')
    .option('--events', 'show normalized events.jsonl (the default; wins over --raw/--stderr/--prompt)')
    .option('--prompt', 'show the prompt that was sent')
    .option('--thinking', 'include thinking blocks (hidden by default)')
    .option('--json', 'normalized entries as JSON, one per line (events only; not with --raw/--stderr/--prompt)')
    .option('-n, --lines <n>', 'number of trailing entries (raw lines for --raw/--stderr/--prompt)', positiveInt)
    .option('-f, --follow', 'follow live output (with no task id, choose one and switch between them)')
    .option('--color <mode>', 'color mode: auto|always|never', colorMode)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((refs: string[] | undefined, opts) => exitWith(() => logsCommand(refs ?? [], opts)));

  program
    .command('peek')
    .description('Peek into a running worker')
    .argument('[refs...]', 'task id, or run id followed by task id (ids may be shortened to a unique prefix)')
    .option('-n, --lines <n>', 'number of recent lines', positiveInt)
    .option('-f, --follow', 'keep following live output (q to quit)')
    .option('--json', 'the status object then the entries, one JSON object per line')
    .option('--color <mode>', 'color mode: auto|always|never', colorMode)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((refs: string[] | undefined, opts) => exitWith(() => peekCommand(refs ?? [], opts)));

  program
    .command('diff')
    .description('Show what a task changed')
    .argument('[refs...]', 'task id, or run id followed by task id (ids may be shortened to a unique prefix)')
    .option('--stat', 'per-file +/- summary instead of the patch')
    .option('--name-only', 'changed paths only')
    .option('--file <path>', 'restrict the output to one file')
    .option('-a, --attempt <n>', 'attempt number (default: the newest task attempt with a diff; merge attempts only on request)', positiveInt)
    .option('--json', 'the captured diff.json records')
    .option('--color <mode>', 'color mode: auto|always|never', colorMode)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((refs: string[] | undefined, opts) => exitWith(() => diffCommand(refs ?? [], opts)));

  program
    .command('report')
    .description('Render a run as a document to paste into a pull request')
    .argument('[run]', 'run id, or a unique prefix of one (default: latest)')
    .option('--md', 'Markdown output (default)')
    .option('--json', 'the same structure as JSON')
    .option('-o, --out <file>', 'write to a file instead of stdout and print its path')
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((run: string | undefined, opts) => exitWith(() => reportCommand(run, opts)));

  // ----------------------------------------------------------------------------------- Task controls
  program.commandsGroup(COMMAND_GROUPS.task);

  // `cao task <refs>` has always meant "show me this task", and it still does: `show` is the default
  // subcommand [D6]. A literal subcommand name wins, so a task that happens to be called `show` or `stop`
  // is reached through `cao task show <name>` - which the help below says in as many words.
  const task = program
    .command('task')
    .description('Show a task, or steer it: show | stop | restart | edit | prompt')
    .addHelpText(
      'after',
      [
        '',
        'A literal subcommand name wins: "cao task stop" stops a task, and a task actually named "stop"',
        'is reached with "cao task show stop". Everything else is the task reference itself, so',
        '"cao task review" and "cao task 2026-09-04-002 review" keep working.',
        '',
        'stop and restart reach the orchestrator that owns the run: in this process when it owns it,',
        'otherwise through a request file that process answers. With no owner they are a usage error',
        'naming "cao resume". edit takes the same three routes and adds a fourth: with no owner it writes',
        'the revision into the run and tells you which resume picks it up.',
      ].join('\n'),
    );

  task
    .command('show', { isDefault: true })
    .description('Everything recorded about one task (the default)')
    .argument('[refs...]', 'task id, or run id followed by task id (ids may be shortened to a unique prefix)')
    .option('--json', 'machine-readable output')
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((refs: string[] | undefined, opts) => exitWith(() => taskCommand(refs ?? [], opts)));

  task
    .command('stop')
    .description('Cancel the attempt a task is running; the task ends cancelled')
    .argument('[refs...]', 'task id, or run id followed by task id (ids may be shortened to a unique prefix)')
    .option('--wait <seconds>', `how long to wait for the owning process to answer (default: ${DEFAULT_ACK_WAIT_SECONDS}; 0 returns as soon as the request is written)`, nonNegativeInt)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((refs: string[] | undefined, opts) => exitWith(() => taskControlCommand('stop', refs ?? [], opts)));

  task
    .command('restart')
    .description('Run a finished, unsuccessful task again in the run that owns it')
    .argument('[refs...]', 'task id, or run id followed by task id (ids may be shortened to a unique prefix)')
    .option('--wait <seconds>', `how long to wait for the owning process to answer (default: ${DEFAULT_ACK_WAIT_SECONDS}; 0 returns as soon as the request is written)`, nonNegativeInt)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((refs: string[] | undefined, opts) => exitWith(() => taskControlCommand('restart', refs ?? [], opts)));

  task
    .command('prompt')
    .description('Send a task a message: steer the worker it is running, or start it again carrying the text')
    .argument('[refs...]', 'task id, or run id followed by task id (ids may be shortened to a unique prefix)')
    .option('-m, --message <text>', 'the message to send')
    .option('--file <path>', 'read the message from a file instead')
    .option('--steer', 'speak to the worker running now; refused when its transport has no live channel')
    .option('--follow-up', 'start a stopped task again carrying the message')
    .option('--stop-and-continue', 'stop the worker, then start the task again carrying the message')
    .option('--fresh-session', 'start from a new session instead of continuing the one the task reported')
    .option('--wait <seconds>', `how long to wait for the owning process to answer (default: ${DEFAULT_ACK_WAIT_SECONDS}; 0 returns as soon as the request is written)`, nonNegativeInt)
    .option('--no-tui', 'plain output when the message has to resume the run to reach the task')
    .option('--repository <dir>', 'repository containing .orchestrator')
    // Three mode flags read like a choice that has to be made before anything can be sent; it is the
    // opposite. Said here rather than three times over in the option list.
    .addHelpText(
      'after',
      [
        '',
        'The three mode flags are optional. With none of them the run picks the one the task allows -',
        'steer a worker with a live channel, stop and continue one without, start a stopped task again -',
        'and the answer names it: "Steer: ...", "Stop and continue: ...", "Follow-up: ...". Naming a mode',
        'the task does not allow is refused rather than quietly turned into the other one.',
      ].join('\n'),
    )
    .action((refs: string[] | undefined, opts) => exitWith(() => taskPromptCommand(refs ?? [], opts)));

  task
    .command('edit')
    .description("Change an unfinished task's prompt, agent, model, effort, timeout, retries or budget")
    .argument('[refs...]', 'task id, or run id followed by task id (ids may be shortened to a unique prefix)')
    .option('--prompt <text>', 'the resolved prompt; the context section is still added automatically')
    .option('--prompt-file <path>', 'read the prompt from a file instead')
    .option('--agent <name>', 'claude or codex')
    .option('--model <id>', 'model id for this task')
    .option('--effort <level>', 'none, minimal, low, medium, high, xhigh or max')
    .option('--timeout <duration>', 'per-attempt timeout, e.g. 90m or 1h30m')
    .option('--retries <n>', 'retries after the first attempt (0-20)', nonNegativeInt)
    .option('--budget <usd>', 'claude.maxBudgetUsd for this task (Claude only)', positiveNumber)
    .option('--restart', 'stop the task if it is running, apply the edit, then start it again')
    .option('--wait <seconds>', `how long to wait for the owning process to answer (default: ${DEFAULT_ACK_WAIT_SECONDS}; 0 returns as soon as the request is written)`, nonNegativeInt)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((refs: string[] | undefined, opts) => exitWith(() => taskEditCommand(refs ?? [], opts)));

  // ------------------------------------------------------------------------------------ Diagnostics
  program.commandsGroup(COMMAND_GROUPS.diagnostics);

  program
    .command('doctor [config]')
    .description('Check this machine: Node, git, the agent CLIs, the terminal, storage and what past runs left behind')
    .option('--repository <dir>', 'repository to check (default: launch directory / git root)')
    .option('--json', 'machine-readable output')
    .option('--probe', 'also start each agent mode for real (a small model call and up to a minute per mode)')
    .option('--no-probe', 'deprecated: the probes are off unless --probe is given; accepted and ignored')
    .action((config: string | undefined, opts) => exitWith(() => doctorCommand({ ...opts, config })));

  program
    .command('diagnostics')
    .description('Write one JSON file describing a run, to attach to a bug report')
    .argument('[run]', 'run id, or a unique prefix of one (default: latest)')
    .requiredOption('-o, --out <file>', 'where to write the bundle')
    .option('--include <what>', `also include ${DIAGNOSTICS_INCLUDES.join(', ')} (comma-separated, repeatable)`, collect)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .addHelpText(
      'after',
      [
        '',
        'The bundle holds the doctor facts, the redacted workflow, the run events, live.json, the',
        'orchestrator log, every attempt.json and the last 200 lines of each stderr.log, plus the requests',
        'and acknowledgments. Transcripts, prompts and diffs are left out unless --include asks for them.',
        'Everything goes through the same redactor the run wrote with. Nothing is uploaded.',
      ].join('\n'),
    )
    .action((run: string | undefined, opts) => exitWith(() => diagnosticsCommand(run, opts)));

  program
    .command('clean')
    .description('Remove the worktrees and branches a run created')
    .argument('[run]', 'run id, or a unique prefix of one (default: latest)')
    .option('--worktrees', 'remove worktrees (default)')
    .option('--branches', 'delete orchestrator branches')
    .option('--all', 'remove worktrees and branches')
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((run: string | undefined, opts) => exitWith(() => cleanCommand(run, opts)));

  program
    .command('emit')
    .description('Turn announcing runs to the desktop app on or off, and show what it is doing')
    .argument('[action]', `${EMIT_ACTIONS.join('|')} (default: status)`)
    .option('--emit', 'with status: resolve the chain as if a run were given --emit')
    .option('--no-emit', 'with status: resolve the chain as if a run were given --no-emit')
    .option('--json', 'machine-readable output')
    .action((action: string | undefined, opts) => exitWith(() => emitCommand(action, opts)));

  // A short description says what a command is for; the examples say what to type, for the arguments that
  // are not obvious from the usage line alone (which run, which task, what happens when you name neither).
  attachCommandHelp(program);

  // What a script needs to know and could otherwise only find in the README.
  program.addHelpText(
    'after',
    [
      '',
      'Exit codes:',
      '  0    completed                     1    failed',
      '  2    usage or validation error     3    paused (approval or input required)',
      '  70   internal error                130  interrupted (Ctrl+C or cao stop)',
      '',
      'Environment:',
      '  CAO_CLAUDE_COMMAND   Claude CLI to launch instead of `claude`',
      '  CAO_CODEX_COMMAND    Codex CLI to launch instead of `codex`',
      '  CAO_EMIT             announce runs to a desktop app on this machine (1/0); see cao emit status',
      '  CAO_HOME             override ~/.cao, the directory cao announces runs into (docs/desktop.md)',
      '  CAO_EMIT_FEED        reserved for the per-run live feed; this build serves none (also --emit-feed)',
      '  CAO_DEBUG            debug logging, stack traces, and open the workspace on Diagnostics (--debug)',
      '  CAO_ASCII            draw tables and status marks in ASCII (CAO_UNICODE=1 forces glyphs back on)',
      '  CAO_ALT_SCREEN       0 draws the workspace in the normal buffer (also --no-alt-screen)',
      `  CAO_THEME            workspace theme: ${THEME_NAMES.join('|')} (also --theme)`,
      '  CAO_REDUCED_MOTION   1 stops the spinner and the activity pulse',
      '  NO_COLOR/FORCE_COLOR disable or force ANSI colour (also --color)',
      '  COLUMNS              width to lay tables out in when there is no terminal to ask',
      '',
    ].join('\n'),
  );

  return program;
}
