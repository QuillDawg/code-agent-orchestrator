import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Allocate `YYYY-MM-DD-NNN` run ids, unique within the runs directory. */
export async function allocateRunId(runsDir: string, now = new Date()): Promise<string> {
  const date = now.toISOString().slice(0, 10);
  await fs.mkdir(runsDir, { recursive: true });
  const existing = await fs.readdir(runsDir).catch(() => [] as string[]);
  let max = 0;
  for (const name of existing) {
    const m = new RegExp(`^${date}-(\\d{3,})$`).exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  for (let n = max + 1; n < max + 1000; n++) {
    const candidate = `${date}-${String(n).padStart(3, '0')}`;
    try {
      await fs.mkdir(path.join(runsDir, candidate));
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not allocate a run id');
}

export function shortRunId(runId: string): string {
  // 2026-09-03-001 -> 0903-001
  const m = /^\d{4}-(\d{2})-(\d{2})-(\d+)$/.exec(runId);
  return m ? `${m[1]}${m[2]}-${m[3]}` : runId.replace(/[^A-Za-z0-9]/g, '').slice(-8);
}
