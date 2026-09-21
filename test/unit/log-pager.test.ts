/**
 * The bounded log pager (spec §3.7): "paged from disk the way the transcript pager works; nothing loads a
 * whole file".
 *
 * The constraint the scope states in seconds is stated here in bytes as well: a 50 MB `stdout.log` opens in
 * under a second *because* the pager reads the end of it rather than the whole of it, and the second
 * assertion is the one that stays true on a fast disk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/index.js';
import { LOG_PAGE_LINES, MAX_LINE_BYTES, TRUNCATION_MARK, readPageAfter, readPageBefore, readTailPage } from '../../src/persistence/log-pager.js';

let dir: string;
const file = (name: string): string => path.join(dir, name);

beforeAll(async () => {
  dir = await tmpDir('cao-pager-');
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function write(name: string, text: string): Promise<string> {
  const p = file(name);
  await fs.writeFile(p, text);
  return p;
}

describe('the log pager (§3.7)', () => {
  it('reads the newest lines and says where they start', async () => {
    const p = await write('small.log', `${Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n')}\n`);
    const tail = await readTailPage(p, 5);
    expect(tail.lines).toEqual(['line 995', 'line 996', 'line 997', 'line 998', 'line 999']);
    expect(tail.atEnd).toBe(true);
    expect(tail.atStart).toBe(false);

    const older = await readPageBefore(p, tail.start, 5);
    expect(older.lines).toEqual(['line 990', 'line 991', 'line 992', 'line 993', 'line 994']);
    expect(older.end).toBe(tail.start);
  });

  it('walks back to the beginning and stops there', async () => {
    const p = await write('tiny.log', 'a\nb\nc\n');
    const tail = await readTailPage(p, 2);
    expect(tail.lines).toEqual(['b', 'c']);
    const older = await readPageBefore(p, tail.start, 2);
    expect(older.lines).toEqual(['a']);
    expect(older.atStart).toBe(true);
    expect((await readPageBefore(p, older.start, 2)).lines).toEqual([]);
  });

  it('reads forwards from an offset, and the two directions meet', async () => {
    const p = await write('forward.log', `${Array.from({ length: 50 }, (_, i) => `n${i}`).join('\n')}\n`);
    const first = await readPageAfter(p, 0, 10);
    expect(first.lines).toEqual(Array.from({ length: 10 }, (_, i) => `n${i}`));
    const second = await readPageAfter(p, first.end, 10);
    expect(second.lines[0]).toBe('n10');
    expect((await readPageBefore(p, second.start, 10)).lines).toEqual(first.lines);
  });

  it('pages a CRLF log without drifting a byte a line', async () => {
    // A Windows CLI writes CRLF, and an attempt's `stdout.log` is the child's bytes verbatim. The
    // terminator is two bytes, and every offset a page reports has to say so: a page that counted one
    // drifts a byte per line and starts the next page mid-word.
    const crlf = '\r\n';
    const p = await write('crlf.log', `${Array.from({ length: 50 }, (_, i) => `line ${i}`).join(crlf)}${crlf}`);
    const tail = await readTailPage(p, 10);
    expect(tail.lines).toEqual(Array.from({ length: 10 }, (_, i) => `line ${40 + i}`));
    expect(tail.atEnd).toBe(true);

    const older = await readPageBefore(p, tail.start, 10);
    expect(older.lines).toEqual(Array.from({ length: 10 }, (_, i) => `line ${30 + i}`));
    expect(older.end).toBe(tail.start);

    const first = await readPageAfter(p, 0, 10);
    expect(first.lines).toEqual(Array.from({ length: 10 }, (_, i) => `line ${i}`));
    const second = await readPageAfter(p, first.end, 10);
    expect(second.lines).toEqual(Array.from({ length: 10 }, (_, i) => `line ${10 + i}`));
    expect((await readPageBefore(p, second.start, 10)).lines).toEqual(first.lines);
  });

  it('keeps the offsets right on a CRLF file that does not end in a newline', async () => {
    // `a\r\nbb\r\nccc`: "a" is bytes 0-3, "bb" is 3-7, "ccc" is 7-10 and ends the file unterminated.
    const p = await write('crlf-open.log', ['a', 'bb', 'ccc'].join('\r\n'));
    const tail = await readTailPage(p, 2);
    expect(tail.lines).toEqual(['bb', 'ccc']);
    expect(tail.start).toBe(3);
    expect(tail.end).toBe((await fs.stat(p)).size);
    expect((await readPageBefore(p, tail.start, 2)).lines).toEqual(['a']);

    const page = await readPageAfter(p, 0, 2);
    expect(page.lines).toEqual(['a', 'bb']);
    expect(page.end).toBe(7);
    expect((await readPageAfter(p, page.end, 2)).lines).toEqual(['ccc']);
  });

  it('is an empty page for a file that is not there, rather than a throw', async () => {
    const missing = await readTailPage(file('nope.log'), 10);
    expect(missing.lines).toEqual([]);
    expect(missing.atStart && missing.atEnd).toBe(true);
  });

  it('cuts a line no terminal could show, and marks it', async () => {
    const p = await write('huge-line.log', `${'x'.repeat(MAX_LINE_BYTES * 3)}\nshort\n`);
    const tail = await readTailPage(p, 2);
    expect(tail.lines[1]).toBe('short');
    expect(tail.lines[0]!.endsWith(TRUNCATION_MARK)).toBe(true);
    expect(tail.lines[0]!.length).toBe(MAX_LINE_BYTES + 1);
  });

  it('opens a 50 MB log in well under a second, reading a page rather than the file', async () => {
    const p = file('big.log');
    const handle = await fs.open(p, 'w');
    // ~53 MB: 950_000 lines of ~58 bytes.
    const block = Array.from({ length: 10_000 }, (_, i) => `2026-09-21T09:00:00.000Z info  worker said something ${i}`).join('\n');
    for (let i = 0; i < 95; i += 1) await handle.write(`${block}\n`);
    await handle.close();
    const size = (await fs.stat(p)).size;
    expect(size).toBeGreaterThan(50 * 1024 * 1024);

    const started = Date.now();
    const tail = await readTailPage(p, LOG_PAGE_LINES);
    const older = await readPageBefore(p, tail.start, LOG_PAGE_LINES);
    const elapsed = Date.now() - started;

    expect(tail.lines).toHaveLength(LOG_PAGE_LINES);
    expect(tail.lines[LOG_PAGE_LINES - 1]).toContain('something 9999');
    expect(older.lines).toHaveLength(LOG_PAGE_LINES);
    expect(older.end).toBe(tail.start);
    expect(elapsed).toBeLessThan(1000);
    // What the second really rests on, and the part a fast disk cannot hide: two pages cost two small
    // reads from the end of the file, not 50 MB of them.
    expect(tail.scanned + older.scanned).toBeLessThan(1024 * 1024);
    expect(size - older.start).toBeLessThan(1024 * 1024);
  });
});
