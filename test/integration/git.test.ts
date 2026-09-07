/** The git wrapper itself: how a read that outgrows its buffer is reported. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { Git } from '../../src/workspace/git.js';
import { tmpGitRepo, gitOut } from '../helpers/index.js';

/**
 * A blob just over execa's default 100 MB buffer, written straight into the object database. The content is
 * one repeated byte, so the object on disk is a few kilobytes however large the blob reads back.
 */
async function fatBlob(repo: string): Promise<string> {
  const file = path.join(repo, 'big.txt');
  const chunk = Buffer.alloc(1024 * 1024, 'x'.charCodeAt(0));
  const fh = await fs.open(file, 'w');
  try {
    for (let i = 0; i < 101; i++) await fh.write(chunk);
  } finally {
    await fh.close();
  }
  const sha = await gitOut(repo, 'hash-object', '-w', file);
  await fs.rm(file);
  return sha;
}

describe('Git.run buffer limits', () => {
  it('fails an uncapped read that outgrew its buffer instead of returning a partial answer', async () => {
    const repo = await tmpGitRepo();
    const sha = await fatBlob(repo);
    const git = new Git(repo);

    // Nobody asked for a cap here, so the short read is a failure: half a `-z` list parses like a whole one.
    // The result is dropped rather than asserted on, so a regression reports the message and not 100 MB of x.
    const failure = await git.run(['cat-file', 'blob', sha]).then(
      () => 'resolved with a truncated result',
      (err: Error) => err.message,
    );
    expect(failure).toMatch(/produced more output than could be read/);
    // A caller that handles its own errors is told through the exit code, not by a quietly truncated stdout.
    const unchecked = await git.run(['cat-file', 'blob', sha], { reject: false });
    expect(unchecked.truncated).toBe(true);
    expect(unchecked.exitCode).not.toBe(0);
  }, 60000);

  it('treats a cap the caller asked for as a normal short read', async () => {
    const repo = await tmpGitRepo();
    const sha = await fatBlob(repo);
    const git = new Git(repo);

    // `captureDiff` reads this way: cut at the cap, no throw, and the prefix is the real output.
    const capped = await git.run(['cat-file', 'blob', sha], { maxBuffer: 64, raw: true });
    expect(capped.truncated).toBe(true);
    expect(capped.stdout).toBe('x'.repeat(64));
  }, 60000);
});
