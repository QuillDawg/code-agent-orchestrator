import { Command, InvalidArgumentError } from 'commander';
import { runCommand } from './commands/run.js';
import { validateCommand } from './commands/validate.js';
import { resumeCommand } from './commands/resume.js';
import { statusCommand } from './commands/status.js';
import { listCommand } from './commands/list.js';
import { logsCommand } from './commands/logs.js';
import { peekCommand } from './commands/peek.js';
import { taskCommand } from './commands/task.js';
import { diffCommand } from './commands/diff.js';
import { reportCommand } from './commands/report.js';
import { cleanCommand } from './commands/clean.js';
import { stopCommand } from './commands/stop.js';
import { doctorCommand } from './commands/doctor.js';
import { DEFAULT_WORKFLOW_FILES } from './util.js';
import { OrchestratorError } from '../util/errors.js';
import { packageInfo } from '../util/package-info.js';
import type { PermissionMode } from '../types/workflow.js';

const pkg = packageInfo();

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

function colorMode(value: string): 'auto' | 'always' | 'never' {
  if (!['auto', 'always', 'never'].includes(value)) throw new InvalidArgumentError('must be auto, always, or never');
  return value as 'auto' | 'always' | 'never';
}

const PERMISSION_MODES: PermissionMode[] = ['auto', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan', 'manual'];
function permissionMode(value: string): PermissionMode {
  if (!PERMISSION_MODES.includes(value as PermissionMode)) throw new InvalidArgumentError(`must be one of ${PERMISSION_MODES.join(', ')}`);
  return value as PermissionMode;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('cao')
    .description('Code Agent Orchestrator: run YAML-defined workflows as isolated coding-agent sessions')
    .version(pkg.version)
    .configureOutput({ writeErr: (s) => process.stderr.write(s) })
    // The full help after every mistyped option buries the one line that says what was wrong.
    .showHelpAfterError('(add --help for usage)')
    // Commander exits 1 for an unknown command or a bad option value, contradicting the exit code table
    // below: a usage error is 2 everywhere else in this CLI. `--help` and `--version` arrive here with
    // exit code 0 and stay 0. Set before the subcommands, which inherit it.
    .exitOverride((err) => process.exit(err.exitCode === 1 ? 2 : err.exitCode));

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
    .option('--no-tui', 'disable the interactive dashboard (line output)')
    .option('--activity', 'print agent activity lines in line-output mode')
    .option('-v, --verbose', 'verbose output')
    .action((workflow: string | undefined, opts) => exitWith(() => runCommand(workflow, opts)));

  program
    .command('validate')
    .description('Validate a workflow and print its execution plan')
    .argument('[workflow]', `path to the workflow YAML (default: ${DEFAULT_WORKFLOW_FILES.join(', ')} in this directory)`)
    .option('--repository <dir>', 'override the repository root')
    .option('--json', 'machine-readable output')
    .action((workflow: string | undefined, opts) => exitWith(() => validateCommand(workflow, opts)));

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
    .option('--no-tui', 'disable the interactive dashboard')
    .option('--activity', 'print agent activity lines in line-output mode')
    .option('-v, --verbose', 'verbose output')
    .action((run: string | undefined, opts) => exitWith(() => resumeCommand(run, opts)));

  program
    .command('stop')
    .description('Stop a run from another terminal')
    .argument('[run]', 'run id, or a unique prefix of one (default: latest)')
    .option('--wait <seconds>', 'how long to wait for the orchestrator to stop (0 to return immediately)', nonNegativeInt)
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((run: string | undefined, opts) => exitWith(() => stopCommand(run, opts)));

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
    .command('task')
    .description('Show everything recorded about one task')
    .argument('[refs...]', 'task id, or run id followed by task id (ids may be shortened to a unique prefix)')
    .option('--json', 'machine-readable output')
    .option('--repository <dir>', 'repository containing .orchestrator')
    .action((refs: string[] | undefined, opts) => exitWith(() => taskCommand(refs ?? [], opts)));

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
    .command('doctor')
    .description('Check this machine: Node, git, the agent CLIs, and what past runs left behind')
    .option('--repository <dir>', 'repository to check (default: launch directory / git root)')
    .option('--json', 'machine-readable output')
    .action((opts) => exitWith(() => doctorCommand(opts)));

  // A short description says what a command is for; these say what to type, for the arguments that are not
  // obvious from the usage line alone (which run, which task, what happens when you name neither).
  const EXAMPLES: Record<string, string[]> = {
    run: ['cao run                                 # workflow.yaml in this directory', 'cao run workflows/ship.yaml --dry-run   # the plan, no agents', 'cao run --task implement-api --no-tui'],
    validate: ['cao validate', 'cao validate workflows/ship.yaml --json'],
    resume: ['cao resume                              # the latest run, retrying failures', 'cao resume 2026-09-04-002 --task review', 'cao resume --approve deploy'],
    stop: ['cao stop                                # ask the latest run to stop', 'cao stop 002 --wait 0                   # ask and return immediately'],
    status: ['cao status', 'cao status 002                          # run ids match by prefix', 'cao status --json'],
    list: ['cao list', 'cao list --limit 5'],
    logs: ['cao logs review                         # the latest run, task "review"', 'cao logs 2026-09-04-002 review -a 2', 'cao logs --follow                       # pick a task and switch between them', 'cao logs review --json > review.jsonl'],
    peek: ['cao peek implement-api', 'cao peek implement-api --follow'],
    task: ['cao task review', 'cao task 002 review --json'],
    diff: ['cao diff                                # every task, in execution order', 'cao diff review --stat', 'cao diff review --file src/app.ts'],
    report: ['cao report', 'cao report 002 --out report.md'],
    clean: ['cao clean                               # worktrees of the latest run', 'cao clean 002 --all                     # worktrees and branches'],
    doctor: ['cao doctor', 'cao doctor --json                       # paste this into a bug report'],
  };
  for (const command of program.commands) {
    const lines = EXAMPLES[command.name()];
    if (lines) command.addHelpText('after', ['', 'Examples:', ...lines.map((l) => `  ${l}`), ''].join('\n'));
  }

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
      '  CAO_DEBUG            print stack traces when a command fails',
      '  CAO_ASCII            draw tables and status marks in ASCII (CAO_UNICODE=1 forces glyphs back on)',
      '  NO_COLOR/FORCE_COLOR disable or force ANSI colour (also --color)',
      '  COLUMNS              width to lay tables out in when there is no terminal to ask',
      '',
    ].join('\n'),
  );

  return program;
}
