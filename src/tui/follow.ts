/** Offset-based file tailer (polling). Used by `cao logs --follow` and cross-process `peek`. */
import { promises as fs } from 'node:fs';

export interface TailOptions {
  intervalMs?: number;
  fromStart?: boolean;
  /** Number of trailing lines to emit initially when not reading from the start. */
  initialLines?: number;
  /**
   * Receives the initial tail as one batch instead of line by line. A transcript is worth more read whole
   * (a tool call can be paired with its result) than as a sequence of unrelated lines.
   */
  onInitial?: (lines: string[]) => void;
  signal?: AbortSignal;
  /** Return true to stop following (e.g. run finished and file is quiet). */
  shouldStop?: () => Promise<boolean> | boolean;
}

export async function readTail(filePath: string, lines: number): Promise<string[]> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const all = text.split(/\r?\n/);
    if (all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/** Follow a file, invoking onLine for each newly appended line until aborted. */
export async function followFile(filePath: string, onLine: (line: string) => void, opts: TailOptions = {}): Promise<void> {
  const interval = opts.intervalMs ?? 250;
  let offset = 0;
  let pending = '';
  let quietRounds = 0;

  if (!opts.fromStart) {
    try {
      const stat = await fs.stat(filePath);
      offset = stat.size;
      if (opts.initialLines) {
        const tail = await readTail(filePath, opts.initialLines);
        if (opts.onInitial) opts.onInitial(tail);
        else for (const l of tail) onLine(l);
      }
    } catch {
      offset = 0;
    }
  }

  const readNew = async (): Promise<boolean> => {
    let handle: fs.FileHandle | undefined;
    try {
      const stat = await fs.stat(filePath);
      if (stat.size < offset) offset = 0; // truncated/rotated
      if (stat.size === offset) return false;
      handle = await fs.open(filePath, 'r');
      const length = stat.size - offset;
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, offset);
      offset = stat.size;
      pending += buf.toString('utf8');
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const p of parts) onLine(p);
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close();
    }
  };

  while (!opts.signal?.aborted) {
    const got = await readNew();
    quietRounds = got ? 0 : quietRounds + 1;
    if (quietRounds >= 4 && opts.shouldStop && (await opts.shouldStop())) {
      await readNew();
      if (pending) onLine(pending);
      return;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, interval);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
  if (pending) onLine(pending);
}
