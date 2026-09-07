import { execa, type Options as ExecaOptions } from 'execa';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { GitInfo } from '../types/result.js';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** stdout was cut short because it exceeded `maxBuffer`. */
  truncated: boolean;
}

export interface GitRunOptions {
  reject?: boolean;
  cwd?: string;
  /** Extra environment for this call only (e.g. `GIT_INDEX_FILE` for a throwaway index). */
  env?: Record<string, string>;
  /** Stop reading stdout after this many characters and report `truncated`. */
  maxBuffer?: number;
  /**
   * Return stdout byte-for-byte instead of trimmed, including git's final newline (patches and `-z` output).
   * A patch that loses its last newline no longer parses: `git apply` stops at the truncated last line.
   */
  raw?: boolean;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Thin git wrapper. Every command is explicit; nothing here is driven by worker output. */
export class Git {
  constructor(
    readonly cwd: string,
    private readonly command = 'git',
  ) {}

  async run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const execaOpts: ExecaOptions = {
      cwd: opts.cwd ?? this.cwd,
      reject: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...opts.env },
      // execa drops the trailing newline by default, which corrupts the last hunk of a patch.
      stripFinalNewline: !opts.raw,
      ...(opts.maxBuffer === undefined ? {} : { maxBuffer: Math.max(opts.maxBuffer, 1) }),
    };
    const res = await execa(this.command, ['-c', 'core.longpaths=true', ...args], execaOpts);
    const stdout = String(res.stdout ?? '');
    const result: GitResult = {
      stdout: opts.raw ? stdout : stdout.trim(),
      stderr: String(res.stderr ?? '').trim(),
      exitCode: res.exitCode ?? -1,
      truncated: res.isMaxBuffer === true,
    };
    if (result.truncated) {
      // Hitting a cap the caller set is not a failure: the capped read is exactly what it asked for.
      if (opts.maxBuffer !== undefined) return result;
      // Otherwise git overran execa's default buffer. It may well have exited 0 before the read was cut, so
      // the overrun itself has to be the failure — half a `-z` list or half a patch parses as cleanly as a
      // whole one, and every caller here would take it for complete output.
      result.exitCode = result.exitCode === 0 ? -1 : result.exitCode;
      if (opts.reject === false) return result;
      throw new GitError(`git ${args.join(' ')} produced more output than could be read`, args, result);
    }
    if (result.exitCode !== 0 && opts.reject !== false) {
      throw new GitError(
        `git ${args.join(' ')} failed (exit ${result.exitCode}): ${result.stderr || result.stdout}`,
        args,
        result,
      );
    }
    return result;
  }

  static async isAvailable(command = 'git'): Promise<boolean> {
    try {
      await execa(command, ['--version'], { windowsHide: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Top-level directory of the repository containing `dir`, or null. */
  static async topLevel(dir: string, command = 'git'): Promise<string | null> {
    try {
      const res = await execa(command, ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        windowsHide: true,
        reject: false,
      });
      if (res.exitCode !== 0) return null;
      return path.resolve(String(res.stdout).trim());
    } catch {
      return null;
    }
  }

  async currentBranch(): Promise<string | undefined> {
    const res = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { reject: false });
    if (res.exitCode !== 0) return undefined;
    return res.stdout === 'HEAD' ? undefined : res.stdout;
  }

  async headSha(cwd?: string): Promise<string | undefined> {
    const res = await this.run(['rev-parse', 'HEAD'], { reject: false, cwd });
    return res.exitCode === 0 ? res.stdout : undefined;
  }

  async hasCommits(): Promise<boolean> {
    return (await this.headSha()) !== undefined;
  }

  async statusPorcelain(cwd?: string): Promise<string[]> {
    const res = await this.run(['status', '--porcelain', '--untracked-files=all'], { cwd });
    return res.stdout ? res.stdout.split(/\r?\n/).filter(Boolean) : [];
  }

  async isDirty(cwd?: string): Promise<boolean> {
    return (await this.statusPorcelain(cwd)).length > 0;
  }

  async branchExists(branch: string): Promise<boolean> {
    const res = await this.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { reject: false });
    return res.exitCode === 0;
  }

  /** Local branch names, optionally restricted to a glob git understands (`orchestrator/*`). */
  async listBranches(pattern?: string): Promise<string[]> {
    const ref = `refs/heads/${pattern ?? '*'}`;
    const res = await this.run(['for-each-ref', '--format=%(refname:short)', ref], { reject: false });
    if (res.exitCode !== 0 || !res.stdout) return [];
    return res.stdout.split(/\r?\n/).filter(Boolean);
  }

  async worktreeList(): Promise<Array<{ path: string; branch?: string; head?: string }>> {
    const res = await this.run(['worktree', 'list', '--porcelain']);
    const entries: Array<{ path: string; branch?: string; head?: string }> = [];
    let current: { path: string; branch?: string; head?: string } | null = null;
    for (const line of res.stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        if (current) entries.push(current);
        current = { path: path.resolve(line.slice('worktree '.length)) };
      } else if (current && line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
      } else if (current && line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length);
      }
    }
    if (current) entries.push(current);
    return entries;
  }

  async worktreeAdd(dir: string, opts: { newBranch?: string; commitish: string }): Promise<void> {
    const args = ['worktree', 'add'];
    if (opts.newBranch) args.push('-b', opts.newBranch);
    args.push(dir, opts.commitish);
    await this.run(args);
  }

  async worktreeRemove(dir: string): Promise<void> {
    await this.run(['worktree', 'remove', '--force', dir]);
  }

  async worktreePrune(): Promise<void> {
    await this.run(['worktree', 'prune'], { reject: false });
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.run(['branch', '-D', branch], { reject: false });
  }

  async diffStat(from: string, to = 'HEAD', cwd?: string): Promise<string> {
    const res = await this.run(['diff', '--stat', `${from}..${to}`], { reject: false, cwd });
    return res.exitCode === 0 ? res.stdout : '';
  }

  async changedFiles(from: string, to = 'HEAD', cwd?: string): Promise<string[]> {
    const res = await this.run(['diff', '--name-only', `${from}..${to}`], { reject: false, cwd });
    return res.exitCode === 0 && res.stdout ? res.stdout.split(/\r?\n/).filter(Boolean) : [];
  }

  async commitAll(message: string, cwd?: string): Promise<string | undefined> {
    await this.run(['add', '-A'], { cwd });
    const res = await this.run(
      ['-c', 'user.name=code-agent-orchestrator', '-c', 'user.email=orchestrator@localhost', 'commit', '-m', message, '--no-verify'],
      { reject: false, cwd },
    );
    if (res.exitCode !== 0) return undefined;
    return this.headSha(cwd);
  }

  async merge(branch: string, message: string): Promise<{ ok: boolean; conflicts: string[]; output: string }> {
    const res = await this.run(
      [
        '-c',
        'user.name=code-agent-orchestrator',
        '-c',
        'user.email=orchestrator@localhost',
        'merge',
        '--no-ff',
        '--no-edit',
        '-m',
        message,
        branch,
      ],
      { reject: false },
    );
    if (res.exitCode === 0) return { ok: true, conflicts: [], output: res.stdout };
    const conflicts = (await this.run(['diff', '--name-only', '--diff-filter=U'], { reject: false })).stdout
      .split(/\r?\n/)
      .filter(Boolean);
    return { ok: false, conflicts, output: `${res.stdout}\n${res.stderr}`.trim() };
  }

  async mergeAbort(): Promise<void> {
    await this.run(['merge', '--abort'], { reject: false });
  }

  async mergeInProgress(): Promise<boolean> {
    const gitDir = (await this.run(['rev-parse', '--git-dir'], { reject: false })).stdout;
    if (!gitDir) return false;
    try {
      await fs.access(path.resolve(this.cwd, gitDir, 'MERGE_HEAD'));
      return true;
    } catch {
      return false;
    }
  }

  async isIgnored(relPath: string): Promise<boolean> {
    const res = await this.run(['check-ignore', '-q', relPath], { reject: false });
    return res.exitCode === 0;
  }

  /** Add a pattern to .git/info/exclude (never touches the tracked .gitignore). */
  async ensureExcluded(pattern: string): Promise<boolean> {
    if (await this.isIgnored(pattern.replace(/\/$/, ''))) return false;
    const gitDir = (await this.run(['rev-parse', '--git-common-dir'])).stdout;
    const excludeFile = path.resolve(this.cwd, gitDir, 'info', 'exclude');
    await fs.mkdir(path.dirname(excludeFile), { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(excludeFile, 'utf8');
    } catch {
      /* new file */
    }
    if (existing.split(/\r?\n/).includes(pattern)) return false;
    await fs.writeFile(excludeFile, `${existing.trimEnd()}\n${pattern}\n`, 'utf8');
    return true;
  }

  /** Absolute path of the repository's `.git` directory (per-worktree, not the common dir). */
  async gitDir(cwd?: string): Promise<string | undefined> {
    const res = await this.run(['rev-parse', '--absolute-git-dir'], { reject: false, cwd });
    return res.exitCode === 0 ? res.stdout : undefined;
  }

  async captureInfo(baseSha?: string, cwd?: string, opts: { diffStat?: boolean } = {}): Promise<GitInfo> {
    const info: GitInfo = { uncommittedFiles: [] };
    const branchRes = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { reject: false, cwd });
    if (branchRes.exitCode === 0 && branchRes.stdout !== 'HEAD') info.branch = branchRes.stdout;
    info.headSha = await this.headSha(cwd);
    info.uncommittedFiles = await this.statusPorcelain(cwd).catch(() => []);
    if (baseSha && info.headSha && baseSha !== info.headSha) {
      info.baseSha = baseSha;
      if (opts.diffStat !== false) info.diffStat = await this.diffStat(baseSha, info.headSha, cwd);
    } else if (baseSha) {
      info.baseSha = baseSha;
    }
    return info;
  }
}
