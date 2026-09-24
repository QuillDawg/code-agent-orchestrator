/**
 * Draws many frames through Ink, each with text it has never drawn before, the way the workspace does while
 * a run is active, and reports how far the heap grew. Run with `node --expose-gc --import tsx`.
 *
 * Arguments: `prepared` loads Ink through `prepareInk` first, `fallback` does too with `registerHooks`
 * hidden (the Node 22.12–22.14 path), and `raw` imports Ink as it comes. Prints one JSON line.
 */
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';

const mode = process.argv[2] ?? 'prepared';
if (mode === 'fallback') delete (createRequire(import.meta.url)('node:module') as { registerHooks?: unknown }).registerHooks;
if (mode !== 'raw') await (await import('../../src/tui/ink-runtime.js')).prepareInk();
const nodeEnvAfter = process.env.NODE_ENV ?? null;

const React = (await import('react')).default;
const { render, Box, Text } = await import('ink');

const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
stdout.on('data', () => undefined);
const row = '⠋ running task-alpha  '.repeat(10);
const frame = (n: number) =>
  React.createElement(Box, { flexDirection: 'column' }, ...Array.from({ length: 6 }, (_, i) => React.createElement(Text, { key: i, color: 'green' }, `${row} ${i} elapsed ${n}ms`)));

const app = render(frame(0), { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false });
let n = 0;
const draw = async (count: number): Promise<number> => {
  for (let i = 0; i < count; i += 1) app.rerender(frame(++n));
  await new Promise((resolve) => setTimeout(resolve, 0));
  (globalThis as { gc?: () => void }).gc?.();
  return process.memoryUsage().heapUsed;
};

const frames = Number(process.env.INK_HEAP_FRAMES ?? 4000);
const before = await draw(1000);
const after = await draw(frames);
app.unmount();

const loaded = Object.keys(createRequire(import.meta.url).cache);
process.stdout.write(
  `${JSON.stringify({
    growthMb: (after - before) / 1048576,
    nodeEnvAfter,
    reconciler: loaded.some((k) => k.includes('react-reconciler.production')) ? 'production' : loaded.some((k) => k.includes('react-reconciler.development')) ? 'development' : 'unknown',
  })}\n`,
);
process.exit(0);
