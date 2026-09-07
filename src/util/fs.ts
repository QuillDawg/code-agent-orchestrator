import { promises as fs, mkdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const RETRIES = 6;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Atomically write a file (tmp + rename) with retries for transient Windows EPERM/EBUSY errors. */
export async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  let lastErr: unknown;
  for (let i = 0; i < RETRIES; i++) {
    try {
      await fs.rename(tmp, filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break;
      await sleep(25 * (i + 1));
    }
  }
  try {
    await fs.unlink(tmp);
  } catch {
    /* ignore */
  }
  throw lastErr;
}

/** Synchronous variant used from exit handlers where async work cannot complete. */
export function writeFileAtomicSync(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  for (let i = 0; i < RETRIES; i++) {
    try {
      renameSync(tmp, filePath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw err;
      const until = Date.now() + 25 * (i + 1);
      while (Date.now() < until) {
        /* busy wait: only used on exit path */
      }
    }
  }
  writeFileSync(filePath, content, 'utf8');
}

export async function readJson<T>(filePath: string): Promise<T> {
  const text = await fs.readFile(filePath, 'utf8');
  return JSON.parse(text) as T;
}

export async function readJsonIfExists<T>(filePath: string): Promise<T | null> {
  try {
    return await readJson<T>(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function appendLine(filePath: string, line: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export function pathExistsSync(p: string): boolean {
  return existsSync(p);
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function removeDir(p: string): Promise<void> {
  for (let i = 0; i < RETRIES; i++) {
    try {
      await fs.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') throw err;
      await sleep(100 * (i + 1));
    }
  }
}

/** True when `child` is inside (or equal to) `parent`, comparing normalized absolute paths. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}
