/**
 * In-house render harness for full-screen Ink trees.
 *
 * `ink-testing-library` fakes a stdout that is 100 columns wide and has no `rows` at all, so a tree that
 * sizes itself to the terminal (everything in `src/tui/` does) cannot be tested through it: there is no
 * height to lay out against and no way to resize. This harness renders through Ink's own `render()` with
 * fake streams that report whatever `columns` and `rows` the test asks for, and emits `resize` on demand.
 *
 * `debug: true` is what makes `lastFrame()` readable: in debug mode Ink writes each committed frame to
 * stdout whole, instead of the erase-and-redraw escape sequences `log-update` produces. `interactive: true`
 * is pinned because Ink otherwise decides interactivity from `stdout.isTTY` and CI detection — which would
 * make the harness behave differently on a developer machine and on CI, and would drop Ink's own `resize`
 * listener (the one that recalculates the layout width) on CI only.
 */
import { EventEmitter } from 'node:events';
import type { ReactElement } from 'react';
import { render } from 'ink';
import { stripAnsi } from '../../src/util/text.js';

const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
const ctrl = (letter: string): string => String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);

/** Raw sequences a terminal sends, for `write()`. Named so a test reads as the keystroke, not the escape. */
export const KEYS = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  pageUp: `${ESC}[5~`,
  pageDown: `${ESC}[6~`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  enter: '\r',
  escape: ESC,
  tab: '\t',
  shiftTab: `${ESC}[Z`,
  backspace: DEL,
  ctrlC: ctrl('c'),
  ctrlF: ctrl('f'),
  ctrlJ: ctrl('j'),
  ctrlO: ctrl('o'),
  ctrlP: ctrl('p'),
} as const;

export interface RenderTreeOptions {
  /** Terminal width the tree lays out against. */
  columns?: number;
  /** Terminal height the tree lays out against; the thing `ink-testing-library` cannot give. */
  rows?: number;
}

export interface WaitForOptions {
  /** How long to keep looking before failing, in milliseconds. */
  timeout?: number;
  /** How long to wait between looks, in milliseconds. */
  interval?: number;
}

export interface RenderedTree {
  /** The last frame Ink committed, ANSI intact. */
  lastFrame(): string;
  /** The same frame with the escape sequences taken out — what a predicate or an assertion usually wants. */
  lastText(): string;
  /** Every write Ink made, oldest first, ANSI intact. */
  readonly frames: string[];
  /** Feed raw key sequences to the tree; see `KEYS`. */
  write(keys: string): void;
  /** Resolve once `predicate` accepts the ANSI-stripped last frame, or reject on timeout. */
  waitFor(predicate: (text: string) => boolean, options?: WaitForOptions): Promise<string>;
  /** Report a new terminal size and emit `resize`, as a real `process.stdout` does. */
  resize(columns: number, rows: number): Promise<void>;
  /** Re-render with a new element, for prop changes. */
  rerender(element: ReactElement): void;
  unmount(): void;
}

class FakeStdout extends EventEmitter {
  readonly frames: string[] = [];
  isTTY = true;
  constructor(
    public columns: number,
    public rows: number,
  ) {
    super();
    // Ink's own resize listener plus every `useWindowSize()` in the tree add up past Node's default of ten.
    this.setMaxListeners(0);
  }

  write = (frame: string, callback?: () => void): boolean => {
    this.frames.push(frame);
    callback?.();
    return true;
  };
}

/** Ink drains stdin the Node way — listen for `readable`, then `read()` until it returns null. */
class FakeStdin extends EventEmitter {
  isTTY = true;
  private readonly pending: string[] = [];
  constructor() {
    super();
    this.setMaxListeners(0);
  }

  write = (data: string): void => {
    this.pending.push(data);
    this.emit('readable');
    this.emit('data', data);
  };

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => this.pending.shift() ?? null;
}

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mount `element` against a fake terminal of `columns` x `rows`.
 *
 * Ink commits the first frame inside the mount, but React effects — and therefore anything a component
 * subscribes to on mount — settle a macrotask later, so await a tick before writing keys.
 */
export function renderTree(element: ReactElement, options: RenderTreeOptions = {}): RenderedTree {
  const stdout = new FakeStdout(options.columns ?? 80, options.rows ?? 24);
  const stdin = new FakeStdin();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  // Ink clears the screen through `log-update` when the width shrinks, which lands here as a write that is
  // nothing but escape sequences. It is not a frame; the frame follows it in the same turn.
  const lastFrame = (): string => {
    for (let i = stdout.frames.length - 1; i >= 0; i -= 1) {
      const frame = stdout.frames[i]!;
      if (stripAnsi(frame).trim() !== '') return frame;
    }
    return stdout.frames[stdout.frames.length - 1] ?? '';
  };
  const lastText = (): string => stripAnsi(lastFrame());

  return {
    lastFrame,
    lastText,
    frames: stdout.frames,
    write: (keys: string) => stdin.write(keys),
    async waitFor(predicate, waitOptions = {}) {
      const timeout = waitOptions.timeout ?? 2000;
      const interval = waitOptions.interval ?? 10;
      const deadline = Date.now() + timeout;
      for (;;) {
        const text = lastText();
        if (predicate(text)) return text;
        if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${timeout}ms. Last frame:\n${text}`);
        await tick(interval);
      }
    },
    async resize(columns: number, rows: number) {
      stdout.columns = columns;
      stdout.rows = rows;
      stdout.emit('resize');
      await tick();
    },
    rerender: (next: ReactElement) => instance.rerender(next),
    unmount: () => instance.unmount(),
  };
}

/** How many terminal rows a frame occupies, which is what "never render taller than `rows`" is measured on. */
export function frameHeight(frame: string): number {
  return stripAnsi(frame).replace(/\n$/, '').split('\n').length;
}
