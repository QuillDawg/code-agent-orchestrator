/**
 * The workspace's heap must stay flat however long a run is (`src/tui/ink-runtime.ts`).
 *
 * Before `prepareInk`, every frame the workspace drew left something behind — Ink's text caches and React's
 * development-build performance entries — and a two-hour run died at the V8 heap limit. The heap tests draw
 * a few thousand frames in a child process, where Ink loads fresh, and measure what stays.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import { boundInkCacheSource } from '../../src/tui/ink-runtime.js';

const inkBuild = path.join(path.dirname(createRequire(import.meta.url).resolve('ink')), '..', 'build');
const inkFile = async (name: string) => {
  const file = path.join(inkBuild, name);
  return { url: pathToFileURL(file).href, source: await fs.readFile(file, 'utf8') };
};

interface HeapReport {
  growthMb: number;
  nodeEnvAfter: string | null;
  reconciler: 'production' | 'development' | 'unknown';
}

async function drawFrames(mode: 'raw' | 'prepared' | 'fallback'): Promise<HeapReport> {
  const { stdout } = await execa(process.execPath, ['--expose-gc', '--import', 'tsx', 'test/fixtures/ink-heap.mts', mode], {
    env: { NODE_ENV: undefined },
    extendEnv: true,
    windowsHide: true,
  });
  const line = stdout.split('\n').find((l) => l.startsWith('{'));
  return JSON.parse(line ?? '') as HeapReport;
}

describe('boundInkCacheSource', () => {
  // If an Ink upgrade reshapes either file, the rewrite quietly stops applying and the leak is back. This is
  // where that is noticed.
  it('rewrites both of the installed Ink cache modules', async () => {
    for (const name of ['measure-text.js', 'wrap-text.js']) {
      const { url, source } = await inkFile(name);
      const bounded = boundInkCacheSource(url, source);
      expect(bounded, `${name} no longer has the shape the rewrite expects`).not.toBeNull();
      expect(bounded).toContain('2000');
    }
  });

  it('leaves every other module alone', async () => {
    const { source } = await inkFile('measure-text.js');
    expect(boundInkCacheSource('file:///somewhere/else/measure-text.js', source)).toBeNull();
    expect(boundInkCacheSource(pathToFileURL(path.join(inkBuild, 'ink.js')).href, 'const cache = {};')).toBeNull();
  });

  it('leaves an Ink file it does not recognise alone rather than half-rewriting it', async () => {
    const { url } = await inkFile('wrap-text.js');
    expect(boundInkCacheSource(url, 'const cache = {};\n// reshaped by an upgrade')).toBeNull();
  });
});

describe('prepareInk', () => {
  it('without it, the heap grows with every frame drawn', async () => {
    const report = await drawFrames('raw');
    expect(report.growthMb).toBeGreaterThan(30);
  }, 60_000);

  it('with it, the heap stays flat, React is the production build, and NODE_ENV is left as it was', async () => {
    const report = await drawFrames('prepared');
    expect(report.growthMb).toBeLessThan(10);
    expect(report.reconciler).toBe('production');
    expect(report.nodeEnvAfter).toBeNull();
  }, 60_000);

  it('does the same on a Node without registerHooks', async () => {
    const report = await drawFrames('fallback');
    expect(report.growthMb).toBeLessThan(10);
    expect(report.reconciler).toBe('production');
  }, 60_000);
});
