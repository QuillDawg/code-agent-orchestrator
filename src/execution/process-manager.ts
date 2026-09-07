/**
 * Owns every child process the orchestrator spawns: registry, output capture, timeouts and
 * cross-platform process-tree termination. Nothing here scans the OS for state; we know what we started.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execa } from 'execa';
import { RingBuffer } from '../util/async-queue.js';
import { isProcessAlive, nowIso, sleep, type Clock, systemClock } from '../util/misc.js';
import type { ActiveProcess } from '../types/run.js';
import type { Logger } from '../logging/logger.js';
import { silentLogger } from '../logging/logger.js';

export interface SpawnOptions {
  taskId: string;
  attempt: number;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Text written to the child's stdin first. With `stdin: 'close'` (default) stdin is closed right after. */
  stdinText?: string;
  /** `keep-open`: stdin stays writable (`writeStdin`) until `endStdin()` or the process is killed. */
  stdin?: 'close' | 'keep-open';
  /** Directory where stdout.log / stderr.log are written. */
  logDir?: string;
  bufferLines?: number;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
}

export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  killed: boolean;
  spawnError?: string;
}

export interface ManagedProcess {
  readonly pid: number;
  readonly taskId: string;
  readonly attempt: number;
  readonly startedAt: string;
  readonly cwd: string;
  readonly exited: Promise<ExitInfo>;
  readonly buffer: RingBuffer<string>;
  /** Write to an open stdin (`stdin: 'keep-open'`). Returns false, never throws, once stdin is closed or the process is gone. */
  writeStdin(text: string): boolean;
  /** Close stdin; idempotent. For stream-json workers this is the "no more input" signal. */
  endStdin(): void;
  kill(mode: 'graceful' | 'force'): Promise<void>;
}

export interface ProcessManagerOptions {
  killGraceMs?: number;
  clock?: Clock;
  logger?: Logger;
  /** Override for tests; defaults to the platform-appropriate tree kill. */
  treeKill?: (pid: number, force: boolean) => Promise<void>;
}

export class ProcessManager {
  private readonly active = new Map<string, { info: ActiveProcess; proc: ManagedProcess }>();
  private readonly killGraceMs: number;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly treeKill: (pid: number, force: boolean) => Promise<void>;

  constructor(opts: ProcessManagerOptions = {}) {
    this.killGraceMs = opts.killGraceMs ?? (process.platform === 'win32' ? 3000 : 5000);
    this.clock = opts.clock ?? systemClock;
    this.logger = opts.logger ?? silentLogger;
    this.treeKill = opts.treeKill ?? killTree;
  }

  list(): ActiveProcess[] {
    return [...this.active.values()].map((a) => ({ ...a.info }));
  }

  get(taskId: string): ManagedProcess | undefined {
    for (const entry of this.active.values()) if (entry.info.taskId === taskId) return entry.proc;
    return undefined;
  }

  get size(): number {
    return this.active.size;
  }

  spawn(opts: SpawnOptions): ManagedProcess {
    const key = `${opts.taskId}:${opts.attempt}`;
    if (this.active.has(key)) throw new Error(`Process for ${key} is already running`);

    const buffer = new RingBuffer<string>(opts.bufferLines ?? 500);
    const startedAt = nowIso();
    const isWin = process.platform === 'win32';

    let child: ChildProcess;
    let spawnError: string | undefined;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: !isWin,
        shell: false,
      });
    } catch (err) {
      spawnError = (err as Error).message;
      child = spawn(process.execPath, ['-e', 'process.exit(127)'], { stdio: 'ignore' });
    }

    const stdoutLog: WriteStream | null = opts.logDir ? createWriteStream(path.join(opts.logDir, 'stdout.log'), { flags: 'a' }) : null;
    const stderrLog: WriteStream | null = opts.logDir ? createWriteStream(path.join(opts.logDir, 'stderr.log'), { flags: 'a' }) : null;

    let timedOut = false;
    let killed = false;
    let exitResolved = false;
    let stdinOpen = Boolean(child.stdin);
    const streamsDone: Promise<void>[] = [];

    const wire = (stream: NodeJS.ReadableStream | null | undefined, log: WriteStream | null, onLine?: (l: string) => void, tag = ''): void => {
      if (!stream) return;
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      streamsDone.push(
        new Promise<void>((resolve) => {
          rl.on('line', (line) => {
            if (log) log.write(`${line}\n`);
            buffer.push(tag ? `${tag}${line}` : line);
            onLine?.(line);
          });
          rl.on('close', () => resolve());
        }),
      );
    };
    wire(child.stdout, stdoutLog, opts.onStdoutLine);
    wire(child.stderr, stderrLog, opts.onStderrLine, '[stderr] ');

    child.on('error', (err) => {
      spawnError = spawnError ?? err.message;
      buffer.push(`[orchestrator] spawn error: ${err.message}`);
    });

    const endStdin = (): void => {
      if (!stdinOpen) return;
      stdinOpen = false;
      try {
        child.stdin?.end();
      } catch {
        /* ignore */
      }
    };
    if (child.stdin) {
      // A worker that exits while we write (EPIPE) must never take the orchestrator down.
      child.stdin.on('error', () => {
        stdinOpen = false;
      });
      if (opts.stdinText !== undefined) child.stdin.write(opts.stdinText);
      if (opts.stdin !== 'keep-open') endStdin();
    }

    const exited = new Promise<ExitInfo>((resolve) => {
      child.on('close', async (code, signal) => {
        exitResolved = true;
        stdinOpen = false;
        this.clock.clearTimeout(timeoutHandle);
        await Promise.all(streamsDone).catch(() => undefined);
        await Promise.all([closeStream(stdoutLog), closeStream(stderrLog)]);
        this.active.delete(key);
        resolve({ code, signal, timedOut, killed, spawnError });
      });
    });

    const pid = child.pid ?? -1;
    const self = this;
    const managed: ManagedProcess = {
      pid,
      taskId: opts.taskId,
      attempt: opts.attempt,
      startedAt,
      cwd: opts.cwd,
      exited,
      buffer,
      writeStdin(text) {
        if (!stdinOpen || exitResolved || !child.stdin) return false;
        try {
          child.stdin.write(text);
          return true;
        } catch {
          stdinOpen = false;
          return false;
        }
      },
      endStdin,
      async kill(mode) {
        if (exitResolved) return;
        killed = true;
        const entry = self.active.get(key);
        if (entry) entry.info.status = 'terminating';
        buffer.push(`[orchestrator] terminating process ${pid} (${mode})`);
        if (mode === 'graceful') {
          endStdin();
          await self.treeKill(pid, false);
          const deadline = Date.now() + self.killGraceMs;
          while (!exitResolved && Date.now() < deadline) await sleep(50);
        }
        if (!exitResolved) await self.treeKill(pid, true);
        const hardDeadline = Date.now() + 5000;
        while (!exitResolved && Date.now() < hardDeadline) await sleep(50);
        if (!exitResolved) {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      },
    };

    const timeoutHandle = this.clock.setTimeout(() => {
      if (exitResolved) return;
      timedOut = true;
      buffer.push(`[orchestrator] timeout after ${opts.timeoutMs}ms`);
      void managed.kill('graceful');
    }, opts.timeoutMs);

    this.active.set(key, {
      info: { taskId: opts.taskId, attempt: opts.attempt, pid, startedAt, workingDirectory: opts.cwd, status: 'running' },
      proc: managed,
    });
    this.logger.debug(`spawned pid ${pid} for ${key} in ${opts.cwd}`);
    return managed;
  }

  /** Terminate every active process. Used by signal handling and the exit sweep. */
  async shutdown(mode: 'graceful' | 'force' = 'graceful'): Promise<void> {
    const procs = [...this.active.values()].map((a) => a.proc);
    await Promise.all(procs.map((p) => p.kill(mode).catch(() => undefined)));
  }

  /** Best-effort synchronous sweep for process.on('exit'): kills the whole tree on both platforms. */
  killAllSync(): void {
    for (const { info } of this.active.values()) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(info.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
          if (isProcessAlive(info.pid)) process.kill(info.pid, 'SIGKILL');
        } else {
          process.kill(-info.pid, 'SIGKILL');
        }
      } catch {
        /* ignore */
      }
    }
  }
}

async function closeStream(stream: WriteStream | null): Promise<void> {
  if (!stream) return;
  await new Promise<void>((resolve) => stream.end(() => resolve()));
}

/** Kill a process tree. POSIX uses the process group (children are spawned detached); Windows uses taskkill /T. */
export async function killTree(pid: number, force: boolean): Promise<void> {
  if (pid <= 0) return;
  if (process.platform === 'win32') {
    if (!force) {
      // Windows has no portable graceful signal for console children; the caller closes stdin first.
      return;
    }
    try {
      await execa('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, reject: false });
    } catch {
      /* taskkill missing: fall through */
    }
    if (isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* ignore */
      }
    }
    return;
  }
  const sig: NodeJS.Signals = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      process.kill(pid, sig);
    } catch {
      /* already gone */
    }
  }
}

export async function ensureLogDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
