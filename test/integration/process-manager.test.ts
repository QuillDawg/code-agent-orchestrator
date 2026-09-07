import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ProcessManager } from '../../src/execution/process-manager.js';
import { isProcessAlive } from '../../src/util/misc.js';
import { tmpDir } from '../helpers/index.js';

const NODE = process.execPath;

describe('ProcessManager', () => {
  it('captures output into logs and the ring buffer', async () => {
    const dir = await tmpDir();
    const pm = new ProcessManager();
    const lines: string[] = [];
    const proc = pm.spawn({
      taskId: 't',
      attempt: 1,
      command: NODE,
      args: ['-e', 'for (let i=0;i<20;i++) console.log("line"+i); console.error("err1");'],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 10_000,
      logDir: dir,
      bufferLines: 5,
      onStdoutLine: (l) => lines.push(l),
    });
    expect(pm.list()).toHaveLength(1);
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
    expect(lines).toHaveLength(20);
    expect(proc.buffer.toArray().length).toBeLessThanOrEqual(5);
    expect(await fs.readFile(path.join(dir, 'stdout.log'), 'utf8')).toContain('line19');
    expect(await fs.readFile(path.join(dir, 'stderr.log'), 'utf8')).toContain('err1');
    expect(pm.list()).toHaveLength(0);
  });

  it('passes stdin text and cwd', async () => {
    const dir = await tmpDir();
    const pm = new ProcessManager();
    let out = '';
    const proc = pm.spawn({
      taskId: 't',
      attempt: 1,
      command: NODE,
      args: ['-e', 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.stringify({d,cwd:process.cwd()})))'],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 10_000,
      stdinText: 'hello prompt',
      onStdoutLine: (l) => (out += l),
    });
    await proc.exited;
    const parsed = JSON.parse(out) as { d: string; cwd: string };
    expect(parsed.d).toBe('hello prompt');
    expect(path.resolve(parsed.cwd)).toBe(path.resolve(dir));
  });

  it('kills a hanging process tree on timeout', async () => {
    const dir = await tmpDir();
    const pm = new ProcessManager({ killGraceMs: 300 });
    let childPid = 0;
    const proc = pm.spawn({
      taskId: 't',
      attempt: 1,
      command: NODE,
      args: ['-e', 'const {spawn}=require("child_process");const c=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log("child:"+c.pid);setInterval(()=>{},1000)'],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 800,
      onStdoutLine: (l) => {
        if (l.startsWith('child:')) childPid = Number(l.slice(6));
      },
    });
    const exit = await proc.exited;
    expect(exit.timedOut).toBe(true);
    expect(isProcessAlive(proc.pid)).toBe(false);
    // give the OS a moment to reap the grandchild
    await new Promise((r) => setTimeout(r, 500));
    expect(childPid).toBeGreaterThan(0);
    expect(isProcessAlive(childPid)).toBe(false);
  }, 20_000);

  it('shutdown terminates all active processes', async () => {
    const dir = await tmpDir();
    const pm = new ProcessManager({ killGraceMs: 200 });
    const procs = [1, 2, 3].map((i) =>
      pm.spawn({ taskId: `t${i}`, attempt: 1, command: NODE, args: ['-e', 'setInterval(()=>{},1000)'], cwd: dir, env: { ...process.env } as Record<string, string>, timeoutMs: 60_000 }),
    );
    expect(pm.size).toBe(3);
    const started = Date.now();
    await pm.shutdown('graceful');
    await Promise.all(procs.map((p) => p.exited));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(pm.size).toBe(0);
    for (const p of procs) expect(isProcessAlive(p.pid)).toBe(false);
  }, 20_000);

  it('reports spawn failures instead of throwing', async () => {
    const pm = new ProcessManager();
    const proc = pm.spawn({ taskId: 't', attempt: 1, command: 'definitely-not-a-real-binary-xyz', args: [], cwd: process.cwd(), env: {}, timeoutMs: 5000 });
    const exit = await proc.exited;
    expect(exit.spawnError ?? exit.code).toBeTruthy();
  });
});

describe('ProcessManager: interactive stdin', () => {
  it('keeps stdin open for later writes and reports a closed stdin without throwing', async () => {
    const dir = await tmpDir();
    const pm = new ProcessManager();
    const lines: string[] = [];
    const proc = pm.spawn({
      taskId: 't',
      attempt: 1,
      command: NODE,
      args: ['-e', 'const rl=require("readline").createInterface({input:process.stdin});rl.on("line",l=>console.log("got:"+l));rl.on("close",()=>{console.log("closed");process.exit(0)})'],
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      timeoutMs: 10_000,
      stdinText: 'first\n',
      stdin: 'keep-open',
      onStdoutLine: (l) => lines.push(l),
    });
    expect(proc.writeStdin('second\n')).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(lines).toEqual(['got:first', 'got:second']);
    proc.endStdin();
    proc.endStdin();
    const exit = await proc.exited;
    expect(exit.code).toBe(0);
    expect(lines).toContain('closed');
    expect(proc.writeStdin('late\n')).toBe(false);
  });
});
