/**
 * The release packaging: what npm publishes, what GitHub renders, and what CI runs.
 *
 * These are cheap guards for things that are only noticed when they are already wrong — a tarball with
 * internal research notes in it, a `prepublishOnly` that stopped building, a CI matrix that quietly lost
 * Windows. Everything is read from the repository root, which is vitest's cwd.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const root = process.cwd();
const read = (...parts: string[]) => fs.readFile(path.join(root, ...parts), 'utf8');

interface PackageJson {
  name: string;
  version: string;
  description: string;
  license: string;
  author: string;
  homepage: string;
  repository: { type: string; url: string };
  bugs: { url: string };
  keywords: string[];
  engines: { node: string };
  bin: Record<string, string>;
  main: string;
  types: string;
  exports: Record<string, unknown>;
  files: string[];
  publishConfig: { access: string; tag: string };
  scripts: Record<string, string>;
}

const pkg = JSON.parse(await read('package.json')) as PackageJson;

describe('package.json', () => {
  it('carries the metadata npm and GitHub render on the front page', () => {
    expect(pkg.author).toBeTruthy();
    expect(pkg.license).toBe('MIT');
    expect(pkg.description).toBeTruthy();
    expect(pkg.homepage).toMatch(/^https:\/\/github\.com\//);
    expect(pkg.repository.type).toBe('git');
    expect(pkg.repository.url).toMatch(/^git\+https:\/\/github\.com\/.+\.git$/);
    expect(pkg.bugs.url).toMatch(/^https:\/\/github\.com\/.+\/issues$/);
    expect(pkg.keywords.length).toBeGreaterThanOrEqual(5);
    expect(pkg.keywords).toEqual(pkg.keywords.map((k) => k.toLowerCase()));
    // Beta by default: `npm install -g code-agent-orchestrator` must not resolve to it before 1.0.
    expect(pkg.publishConfig).toEqual({ access: 'public', tag: 'beta' });
  });

  it('rebuilds and re-checks before a publish, because dist/ is gitignored', () => {
    // The build is last on purpose: the payload is produced from code the three checks just passed.
    const steps = (pkg.scripts.prepublishOnly ?? '').split('&&').map((s) => s.trim());
    expect(steps).toEqual(['npm run typecheck', 'npm run lint', 'npm test', 'npm run build']);
  });

  it('exposes exactly one entry point plus package.json, so dist/* is not public surface', () => {
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './package.json']);
    expect(pkg.exports['./package.json']).toBe('./package.json');
    expect(pkg.exports['.']).toEqual({ types: pkg.types, default: pkg.main });
    // `types` first: the condition order in the map is what a bundler resolves by.
    expect(Object.keys(pkg.exports['.'] as object)).toEqual(['types', 'default']);
    // No `./` prefix: npm 11 treats `./dist/bin.js` as an invalid bin path and strips the entry at publish.
    for (const target of Object.values(pkg.bin)) expect(target).toMatch(/^dist//);
  });

  it('publishes the reference docs but not docs/research', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('LICENSE');
    // A bare `docs` entry would sweep in docs/research — 129 kB of internal notes.
    expect(pkg.files).not.toContain('docs');
    expect(pkg.files.some((f) => f.startsWith('docs/research'))).toBe(false);
    expect(pkg.files).toContain('docs/*.md');
  });

  it('agrees with .nvmrc about the Node version', async () => {
    const nvmrc = (await read('.nvmrc')).trim();
    expect(nvmrc).toBe('22');
    expect(pkg.engines.node).toBe(`>=${nvmrc}`);
  });
});

describe('LICENSE', () => {
  it('is MIT, dated, and names the same holder as package.json', async () => {
    const license = await read('LICENSE');
    expect(license).toContain('MIT License');
    expect(license).toContain('Permission is hereby granted, free of charge');
    const copyright = /Copyright \(c\) (\d{4}) (.+)/.exec(license);
    expect(copyright).not.toBeNull();
    expect(Number(copyright![1])).toBeGreaterThanOrEqual(2026);
    // `author` may carry a URL in parentheses; the holder is the name in front of it.
    expect(pkg.author.startsWith(copyright![2]!.trim())).toBe(true);
  });
});

describe('CI workflow', () => {
  it('runs the three checks on both Node versions and both operating systems', async () => {
    const ci = parseYaml(await read('.github', 'workflows', 'ci.yml')) as {
      jobs: Record<string, { strategy: { matrix: { os: string[]; node: string[] } }; steps: { run?: string }[] }>;
    };
    const job = Object.values(ci.jobs)[0]!;
    expect(job.strategy.matrix.os).toEqual(['ubuntu-latest', 'windows-latest']);
    expect(job.strategy.matrix.node).toEqual(['22', '24']);
    const runs = job.steps.map((s) => s.run ?? '').join('\n');
    for (const script of ['npm ci', 'npm run typecheck', 'npm run lint', 'npm test']) {
      expect(runs).toContain(script);
    }
    // The integration suites need a real git; nothing here needs Claude or Codex.
    expect(runs).toContain('git --version');
  });
});

describe('GitHub templates', () => {
  it('asks a "workflow fails" report for the two listings that answer most of them', async () => {
    const template = await read('.github', 'ISSUE_TEMPLATE', 'workflow-fails.yml');
    const form = parseYaml(template) as { name: string; body: { attributes: { label?: string; description?: string } }[] };
    expect(form.name).toMatch(/workflow fails/i);
    const labels = form.body.map((f) => `${f.attributes.label ?? ''} ${f.attributes.description ?? ''}`).join('\n');
    expect(labels).toContain('cao validate');
    expect(labels).toContain('--json');
    expect(labels).toMatch(/run directory/i);
    expect(labels).toContain('.orchestrator/runs/');
  });

  it('has a pull request template pointing at the same checks CI runs', async () => {
    const pr = await read('.github', 'pull_request_template.md');
    for (const script of ['npm run typecheck', 'npm run lint', 'npm test']) expect(pr).toContain(script);
    expect(pr).toContain('CHANGELOG.md');
  });
});

describe('.gitignore', () => {
  it('does not ignore the tracked skills or their installer', async () => {
    const ignore = await read('.gitignore');
    const rules = ignore
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
    expect(rules).not.toContain('.agents/');
    expect(rules).not.toContain('.agents');
    expect(rules.some((r) => r.includes('install-cao-skills'))).toBe(false);
    // Both decisions are recorded where the next person looks for them.
    expect(ignore).toContain('.agents/');
    expect(ignore).toContain('.cao-files/');
  });
});
