#!/usr/bin/env node
/**
 * The packaged smoke: does the tarball npm would publish actually install and run?
 *
 * `npm test` exercises the source tree, where every import resolves through the repository's own
 * node_modules and every file is on disk whether `files` lists it or not. None of that is true for the
 * artifact a user installs. This script closes that gap: it packs the tarball, installs it into a scratch
 * global prefix, and drives the installed `cao` through the commands §5 of the beta spec accepts a release
 * on, against the fake agents. A `files`, `bin`, `exports` or `dependencies` mistake fails here rather than
 * on somebody's machine after `npm publish`.
 *
 * Two tarballs are installed, not one. `code-agent-orchestrator-protocol` is a workspace package that tsup
 * leaves external in the bundle, so the published CLI needs it installed beside it. Packing and installing
 * both together is the post-publish world in miniature — and it is why this smoke would have caught the
 * protocol package never being published at all.
 *
 * Everything lives under one temp directory and is removed on the way out, including after a failure.
 *
 * Usage: `npm run smoke:pack` (builds first), or `node scripts/smoke-packaged.mjs` against an existing
 * `dist/`. Needs the network: the install resolves the CLI's production dependencies from the registry.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

/** cmd.exe eats bare spaces and metacharacters; every argument that reaches a shell goes through this. */
const quote = (s) => (/[\s"&|<>^()%!]/.test(s) ? `"${s}"` : s);

/**
 * `.cmd` shims (npm's own, and `cao.cmd`) cannot be spawned without a shell on Node 22+, so those go
 * through one with their arguments quoted. Real binaries — `git`, `node` — are spawned directly.
 */
function run(command, args, options = {}) {
  const shell = isWindows && /\.(cmd|bat)$/i.test(command);
  // Node deprecates handing an argument array to a shell (DEP0190): it concatenates without escaping. Do
  // the concatenation here instead, quoting each argument, and give spawnSync nothing left to mangle.
  const result = spawnSync(shell ? [command, ...args].map(quote).join(' ') : command, shell ? [] : args, {
    encoding: 'utf8',
    windowsHide: true,
    shell,
    ...options,
  });
  if (result.error) throw result.error;
  return { code: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/**
 * npm re-reads its configuration from the environment, and `npm run smoke:pack` fills it with the outer
 * project's settings — a workspace selection or an inherited prefix would silently change what is packed
 * and where it lands. Drop the lot and let the child npm read the registry config off disk.
 */
function npmEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('npm_config_') || key.startsWith('npm_package_')) continue;
    if (key.startsWith('CAO_')) continue;
    env[key] = value;
  }
  return env;
}

const npm = isWindows ? 'npm.cmd' : 'npm';

const failures = [];
let checked = 0;

function check(name, assertion) {
  checked += 1;
  try {
    assertion();
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

function step(message) {
  process.stdout.write(`\n${message}\n`);
}

// ---------------------------------------------------------------------------------------------- preflight

for (const required of ['dist/bin.js', 'packages/protocol/dist/index.js']) {
  if (!existsSync(path.join(root, required))) {
    process.stderr.write(`smoke:pack needs a build: ${required} is missing. Run \`npm run build\` first.\n`);
    process.exit(1);
  }
}

const temp = mkdtempSync(path.join(tmpdir(), 'cao-smoke-'));

try {
  // ------------------------------------------------------------------------------------------------ pack

  step(`Packing into ${temp}`);
  const packed = (workspaceArgs) => {
    const result = run(npm, ['pack', '--json', '--pack-destination', temp, ...workspaceArgs], {
      cwd: root,
      env: npmEnv(),
    });
    if (result.code !== 0) throw new Error(`npm pack failed (${result.code}):\n${result.stderr}`);
    // npm prints its own notices on stderr, but older npm has been known to prefix stdout; take the array.
    const json = JSON.parse(result.stdout.slice(result.stdout.indexOf('[')));
    return json[0];
  };

  const cli = packed([]);
  const protocol = packed(['--workspace', 'code-agent-orchestrator-protocol']);
  const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;
  process.stdout.write(
    `  ${cli.filename}\n    ${cli.files.length} files, ${kB(cli.size)} packed, ${kB(cli.unpackedSize)} unpacked\n` +
      `  ${protocol.filename}\n    ${protocol.files.length} files, ${kB(protocol.size)} packed\n`,
  );

  step('The tarball holds the published surface and nothing else');
  const paths = cli.files.map((f) => f.path.replace(/\\/g, '/'));
  check('every file is dist/, examples/, a top-level doc or a docs/*.md', () =>
    expect(
      paths.every((p) => /^(dist|examples)\//.test(p) || /^docs\/[^/]+\.md$/.test(p) || ['README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'].includes(p)),
      `unexpected entries: ${paths.filter((p) => !/^(dist|examples)\//.test(p) && !/^docs\/[^/]+\.md$/.test(p) && !['README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'].includes(p)).join(', ')}`,
    ),
  );
  // `files` excludes these three by glob and by negation; only a real `npm pack` says whether npm agreed.
  const internal = (p) => p.startsWith('docs/research/') || p.startsWith('.cao-files/') || /^docs\/cao-v2-beta-/.test(p);
  check('no internal research notes, planning documents or .cao-files', () =>
    expect(!paths.some(internal), `leaked: ${paths.filter(internal).join(', ')}`),
  );
  check('the bin the manifest names is in it', () => expect(paths.includes('dist/bin.js'), 'dist/bin.js is not packed'));

  // --------------------------------------------------------------------------------------------- install

  const prefix = path.join(temp, 'prefix');
  mkdirSync(prefix, { recursive: true });
  step(`Installing globally into ${prefix}`);
  // `--ignore-scripts`: a tarball ships its own `dist/`, so the protocol package's `prepare` has nothing to
  // do, and a global smoke should not run a lifecycle script from any transitive dependency.
  const install = run(npm, ['install', '--global', '--ignore-scripts', '--prefix', prefix, path.join(temp, protocol.filename), path.join(temp, cli.filename)], {
    cwd: temp,
    env: npmEnv(),
  });
  if (install.code !== 0) throw new Error(`npm install -g failed (${install.code}):\n${install.stdout}\n${install.stderr}`);
  process.stdout.write(`  ${install.stdout.trim().split('\n')[0] ?? 'installed'}\n`);

  // npm puts the shims beside the prefix on Windows and under prefix/bin everywhere else.
  const shim = isWindows ? path.join(prefix, 'cao.cmd') : path.join(prefix, 'bin', 'cao');
  check('npm installed a cao shim for this platform', () => expect(existsSync(shim), `no shim at ${shim}`));
  if (!existsSync(shim)) throw new Error('nothing to smoke: the install produced no cao shim');

  // ------------------------------------------------------------------------------------------- the fakes

  const repo = path.join(temp, 'repo');
  mkdirSync(repo, { recursive: true });
  const git = (...args) => {
    const result = run('git', args, { cwd: repo });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'user.name', 'Packaged smoke');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  writeFileSync(path.join(repo, 'smoke.yaml'), ['name: packaged-smoke', 'tasks:', '  - id: smoke', '    agent: claude', '    prompt: Say hello.', ''].join('\n'));

  // `splitCommand` honours double quotes, which is what makes a temp path with a space in it survivable.
  const fake = (name) => `node "${path.join(root, 'test', 'fixtures', name).replace(/\\/g, '/')}"`;
  const env = {
    ...npmEnv(),
    CAO_CLAUDE_COMMAND: fake('fake-claude.mjs'),
    CAO_CODEX_COMMAND: fake('fake-codex.mjs'),
    // A smoke must not announce runs into the real ~/.cao or read the developer's own state.
    CAO_HOME: path.join(temp, 'home'),
    CAO_EMIT: '0',
    NO_COLOR: '1',
    CAO_UNICODE: '1',
    COLUMNS: '100',
  };
  const cao = (...args) => run(shim, args, { cwd: repo, env });

  // ------------------------------------------------------------------------------------- the smoke itself

  step('Driving the packaged CLI');

  const version = cao('--version');
  check('cao --version reports the packed version', () => {
    expect(version.code === 0, `exit ${version.code}`);
    expect(version.stdout.trim() === cli.version, `printed ${version.stdout.trim()}, packed ${cli.version}`);
  });

  const help = cao('--help');
  check('cao --help exits 0 and documents the exit codes', () => {
    expect(help.code === 0, `exit ${help.code}: ${help.stderr}`);
    expect(help.stdout.includes('Usage: cao'), 'no usage line');
    expect(help.stdout.includes('Exit codes:'), 'no exit-code section');
  });

  const bare = cao();
  check('bare cao exits 0 with help on stdout', () => {
    expect(bare.code === 0, `exit ${bare.code}: ${bare.stderr}`);
    expect(bare.stdout.includes('Usage: cao [options] [command]'), 'no usage line on stdout');
    expect(bare.stderr === '', `wrote to stderr: ${bare.stderr}`);
  });

  const unknown = cao('nope');
  check('cao nope exits 2 and points at --help', () => {
    expect(unknown.code === 2, `exit ${unknown.code}`);
    expect(unknown.stderr.includes("unknown command 'nope'"), `stderr was: ${unknown.stderr}`);
    expect(unknown.stderr.includes('--help'), 'no pointer to --help');
  });

  const mistyped = cao('stauts');
  check('a near miss gets the suggestion', () => {
    expect(mistyped.code === 2, `exit ${mistyped.code}`);
    expect(mistyped.stderr.includes('Did you mean status?'), `stderr was: ${mistyped.stderr}`);
  });

  const doctor = cao('doctor', '--json');
  check('cao doctor --json is valid JSON, exits 0 or 1, and probes nothing', () => {
    expect(doctor.code === 0 || doctor.code === 1, `exit ${doctor.code}: ${doctor.stderr}`);
    const report = JSON.parse(doctor.stdout);
    expect(typeof report.ok === 'boolean', 'no ok field');
    expect(Array.isArray(report.checks) && report.checks.length > 0, 'no checks');
    expect(Array.isArray(report.facts?.probes), 'no probe facts');
    expect(report.facts.probes.every((p) => p.status === 'skip'), `a probe ran: ${JSON.stringify(report.facts.probes)}`);
  });

  const runResult = cao('run', 'smoke.yaml', '--no-tui');
  check('cao run --no-tui completes the fixture run and exits 0', () => {
    expect(runResult.code === 0, `exit ${runResult.code}:\n${runResult.stdout}\n${runResult.stderr}`);
    expect(runResult.stdout.includes('Completed: 1'), `no completion summary:\n${runResult.stdout}`);
  });

  const ui = cao('ui');
  check('cao ui in a non-TTY prints the run list and exits 0', () => {
    expect(ui.code === 0, `exit ${ui.code}: ${ui.stderr}`);
    expect(ui.stdout.includes('packaged-smoke'), `no run listed:\n${ui.stdout}`);
    expect(ui.stdout.includes('cao ui <run>'), 'no hint about opening one on a terminal');
  });

  const bundle = path.join(temp, 'bundle.json');
  const diagnostics = cao('diagnostics', '--out', bundle);
  check('cao diagnostics --out writes a bundle that parses', () => {
    expect(diagnostics.code === 0, `exit ${diagnostics.code}: ${diagnostics.stderr}`);
    expect(existsSync(bundle), `no file at ${bundle}`);
    const parsed = JSON.parse(readFileSync(bundle, 'utf8'));
    expect(typeof parsed.protocol === 'number', 'no protocol version in the bundle');
    expect(parsed.doctor !== undefined, 'no doctor facts in the bundle');
  });

  // ------------------------------------------------------------------------------------------------ done

  process.stdout.write(`\n${checked - failures.length}/${checked} checks passed\n`);
  if (failures.length > 0) {
    process.stdout.write(`Failed: ${failures.join(', ')}\n`);
    process.exitCode = 1;
  }
} finally {
  // Windows holds handles open for a moment after a child exits; retry rather than leave the prefix behind.
  rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}
