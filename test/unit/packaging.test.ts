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
import { PROTOCOL_VERSION } from 'code-agent-orchestrator-protocol';

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

const pkg = JSON.parse(await read('package.json')) as PackageJson & { dependencies: Record<string, string> };
const protocolPkg = JSON.parse(await read('packages', 'protocol', 'package.json')) as PackageJson;

/** Compare release numbers, ignoring any prerelease tail: `2.0.0-beta.1` sorts as `2.0.0`. */
const order = (version: string): number[] => version.split('-')[0]!.split('.').map(Number);
const atLeast = (version: string, floor: string): boolean => {
  const [a, b] = [order(version), order(floor)];
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};
/** The lowest version a caret or tilde range can install — what a fresh `npm install` could pick. */
const lowest = (range: string): string => range.replace(/^[\^~>=]+/, '').trim();
const resolved = async (name: string): Promise<string> => (JSON.parse(await read('node_modules', name, 'package.json')) as { version: string }).version;

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
    for (const target of Object.values(pkg.bin)) expect(target).toMatch(/^dist\//);
  });

  it('publishes the reference docs but not docs/research', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('LICENSE');
    // A bare `docs` entry would sweep in docs/research — 129 kB of internal notes.
    expect(pkg.files).not.toContain('docs');
    expect(pkg.files.some((f) => f.startsWith('docs/research'))).toBe(false);
    expect(pkg.files).toContain('docs/*.md');
  });

  // The plan for this beta and the reasoning behind it are written for the people building it: a stage
  // list with exit criteria, a table of suggestions nobody built, open questions. Everything else under
  // docs/ tells a reader what `cao` does today, and these two would be the only pages in the tarball
  // describing what it might do next — which is the one thing the documentation is not allowed to do.
  it('negates the beta planning documents, which are not for a reader of the package', () => {
    expect(pkg.files).toContain('!docs/cao-v2-beta-spec.md');
    expect(pkg.files).toContain('!docs/cao-v2-beta-decisions.md');
    // After the glob they exclude, or npm re-adds what the glob matched.
    for (const negated of pkg.files.filter((f) => f.startsWith('!'))) {
      expect(pkg.files.indexOf(negated)).toBeGreaterThan(pkg.files.indexOf('docs/*.md'));
    }
  });

  /**
   * A production dependency is installed on every machine that installs `cao`, whether or not the bundle
   * reaches for it. Two survived being designed out — `ink-link` (no panel emits an OSC 8 hyperlink) and
   * `zod-to-json-schema` (no JSON Schema is published) — and cost every install their trees. `src/` is
   * the whole of what tsup bundles, so an import there is the only thing that makes one of these needed.
   */
  it('declares no production dependency that src/ never imports', async () => {
    const sources: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (/\.tsx?$/.test(entry.name)) sources.push(await fs.readFile(full, 'utf8'));
      }
    };
    await walk(path.join(root, 'src'));
    const imported = new Set<string>();
    for (const source of sources) {
      for (const m of source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = m[1]!;
        if (specifier.startsWith('.') || specifier.startsWith('node:')) continue;
        // `react/jsx-runtime` and the like: the dependency is the package, not the entry point.
        imported.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!);
      }
    }
    for (const name of Object.keys(pkg.dependencies)) expect(imported, `${name} is installed and never imported`).toContain(name);
  });

  it('agrees with .nvmrc about the Node line and clears every production dependency floor', async () => {
    const nvmrc = (await read('.nvmrc')).trim();
    expect(nvmrc).toBe('22');
    const floor = /^>=\s*(\d+)(?:\.\d+)*$/.exec(pkg.engines.node);
    expect(floor).not.toBeNull();
    // `.nvmrc` names the line a contributor develops on; `engines` names the oldest release that runs.
    expect(floor![1]).toBe(nvmrc);
    // A floor below what a dependency declares is a promise the install cannot keep: commander 15 says
    // `>=22.12.0`, so a bare `>=22` would advertise Node 22.0 as supported and break there.
    for (const name of Object.keys(pkg.dependencies)) {
      const declared = (JSON.parse(await read('node_modules', name, 'package.json')) as { engines?: { node?: string } }).engines?.node;
      // Only the plain `>=x[.y[.z]]` form is compared; a union like execa's `^18.19 || >=20.5` is a lower
      // bar than this project's floor has ever been and nothing useful comes of parsing it.
      const simple = declared === undefined ? undefined : /^>=\s*([\d.]+)$/.exec(declared)?.[1];
      if (simple !== undefined) expect(atLeast(lowest(pkg.engines.node), simple), `${name} needs node ${declared}`).toBe(true);
    }
  });
});

/**
 * §4 S5 and `[D2]`: the release is `2.0.0-beta.2` on the `beta` tag, the protocol package moves on its own
 * train to `0.3.0` (`[D39]`, one field made nullable and the rest additive), and `PROTOCOL_VERSION` — the
 * on-disk contract, a different number for a different reason — does not move at all.
 */
describe('release versions', () => {
  it('is 2.0.0-beta.2, and says so in the changelog', async () => {
    expect(pkg.version).toBe('2.0.0-beta.2');
    expect(await read('CHANGELOG.md')).toContain(`## [${pkg.version}]`);
  });

  it('carries the protocol package at its own minor, with the CLI range following it', async () => {
    expect(protocolPkg.version).toBe('0.3.0');
    expect(await read('packages', 'protocol', 'CHANGELOG.md')).toContain(`## [${protocolPkg.version}]`);
    // The range has to admit what the workspace builds, or a published CLI installs a protocol its bundle
    // was never compiled against.
    const range = pkg.dependencies['code-agent-orchestrator-protocol']!;
    expect(range).toBe(`^${protocolPkg.version}`);
    expect(atLeast(protocolPkg.version, lowest(range))).toBe(true);
    expect(await resolved('code-agent-orchestrator-protocol')).toBe(protocolPkg.version);
  });

  it('leaves PROTOCOL_VERSION at 1: the wire major did not move with the package', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

/**
 * The tarball, listed rather than remembered. `files` is a set of globs, and what they actually expand to on
 * disk is the thing nobody looks at until an internal note is on npm. Adding a document under `docs/` turns
 * this red on purpose: it ships, so it gets reviewed here first.
 */
describe('tarball contents', () => {
  const listing = async (dir: string): Promise<string[]> =>
    (await fs.readdir(path.join(root, dir), { withFileTypes: true })).filter((e) => e.isFile()).map((e) => `${dir}/${e.name}`).sort();

  it('publishes these reference documents and no others', async () => {
    const excluded = pkg.files.filter((f) => f.startsWith('!')).map((f) => f.slice(1));
    const onDisk = (await listing('docs')).filter((f) => f.endsWith('.md'));
    // On disk and still excluded: the negation is doing the work, not a document that quietly moved away.
    for (const file of excluded) expect(onDisk).toContain(file);
    expect(onDisk.filter((f) => !excluded.includes(f))).toEqual([
      'docs/agent-cli-integration.md',
      'docs/architecture.md',
      'docs/capabilities.md',
      'docs/configuration.md',
      'docs/desktop.md',
      'docs/models.md',
    ]);
    // `docs/*.md` is one level deep, which is what keeps docs/research out; assert the directory is still
    // there, so the glob is doing the excluding rather than an empty directory faking it.
    expect((await fs.readdir(path.join(root, 'docs', 'research'))).length).toBeGreaterThan(0);
  });

  it('publishes the examples as workflows plus the one file they are run against', async () => {
    const examples = await listing('examples');
    expect(examples.length).toBeGreaterThanOrEqual(12);
    expect(examples.filter((f) => !f.endsWith('.yaml'))).toEqual(['examples/documentation-smoke-target.md']);
  });

  it('has no .npmignore, so `files` is the only thing deciding', async () => {
    await expect(fs.access(path.join(root, '.npmignore'))).rejects.toThrow();
  });
});

/**
 * `npm test` never sees the artifact: it imports source through the repository's own node_modules. The
 * packaged smoke is what installs the tarball and runs it, so what is asserted here is that it exists and
 * that CI actually runs it — on both operating systems, since a `files` or `bin` mistake shows up on one.
 */
describe('packaged smoke', () => {
  it('is wired into npm run smoke:pack, building first', () => {
    expect(pkg.scripts['smoke:pack']).toBe('npm run build && node scripts/smoke-packaged.mjs');
  });

  it('exists and drives the commands the release is accepted on', async () => {
    const smoke = await read('scripts', 'smoke-packaged.mjs');
    for (const command of ['--help', 'doctor', 'run', 'ui', 'diagnostics']) expect(smoke).toContain(command);
    // It installs the workspace protocol package too: it is external in the bundle, so a published CLI
    // without it beside it does not start.
    expect(smoke).toContain('code-agent-orchestrator-protocol');
  });

  it('runs in CI on both operating systems, with the ink floor and a production audit', async () => {
    const ci = parseYaml(await read('.github', 'workflows', 'ci.yml')) as {
      jobs: Record<string, { strategy?: { matrix?: { os?: string[] } }; steps: { run?: string }[] }>;
    };
    const job = ci.jobs['package'];
    expect(job).toBeDefined();
    expect(job!.strategy?.matrix?.os).toEqual(['ubuntu-latest', 'windows-latest']);
    const runs = job!.steps.map((s) => s.run ?? '').join('\n');
    expect(runs).toContain('npm run smoke:pack');
    expect(runs).toContain('npm audit --omit=dev');
    // The ink floor is checked on the resolved tree in CI as well as here, because `npm ci` there and
    // `npm install` here can land on different versions of the same caret range.
    expect(runs).toContain('7.0.6');
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
  it('runs the checks on both Node versions and both operating systems', async () => {
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
  it('asks a "workflow fails" report for the two outputs that answer most of them', async () => {
    const template = await read('.github', 'ISSUE_TEMPLATE', 'workflow-fails.yml');
    const form = parseYaml(template) as { name: string; body: { attributes: { label?: string; description?: string } }[] };
    expect(form.name).toMatch(/workflow fails/i);
    const labels = form.body.map((f) => `${f.attributes.label ?? ''} ${f.attributes.description ?? ''}`).join('\n');
    expect(labels).toContain('cao validate');
    expect(labels).toContain('--json');
    // The bundle, not a hand-made `ls -R`: it carries the doctor facts, the workflow, the events and
    // every attempt record, already redacted, which is what the listing was a poor substitute for.
    expect(labels).toContain('cao diagnostics');
    expect(labels).toContain('--out');
    expect(labels).toContain('.orchestrator/runs/');
    // And never the file this tool has never written.
    expect(labels).not.toContain('run.json');
  });

  it('has a pull request template pointing at the same checks CI runs', async () => {
    const pr = await read('.github', 'pull_request_template.md');
    for (const script of ['npm run typecheck', 'npm run lint', 'npm test']) expect(pr).toContain(script);
    expect(pr).toContain('CHANGELOG.md');
  });
});

/**
 * The UI stack has two floors that are not obvious from the version numbers, so they are asserted rather
 * than remembered: Ink 7.0.0-7.0.5 rendered garbled output on every Windows terminal (ink#969, fixed by
 * #971 in 7.0.6), and Ink 7 needs React 19.2 or newer to run at all.
 */
describe('UI stack', () => {
  it('resolves ink at or above the Windows rendering fix in 7.0.6', async () => {
    expect(atLeast(await resolved('ink'), '7.0.6')).toBe(true);
    expect(atLeast(lowest((pkg as unknown as { dependencies: Record<string, string> }).dependencies['ink']!), '7.0.6')).toBe(true);
  });

  it('resolves react at or above the 19.2 ink 7 requires', async () => {
    expect(atLeast(await resolved('react'), '19.2.0')).toBe(true);
    expect(atLeast(lowest((pkg as unknown as { dependencies: Record<string, string> }).dependencies['react']!), '19.2.0')).toBe(true);
  });

  it('installs one copy of react and one of ink, so hooks and the reconciler agree', async () => {
    // A second copy anywhere under node_modules means two React instances and "invalid hook call" at runtime.
    for (const name of ['react', 'ink']) {
      const nested = await fs.readdir(path.join(root, 'node_modules'), { withFileTypes: true, recursive: true }).then((entries) => entries.filter((e) => e.isDirectory() && e.name === name && /node_modules$/.test(e.parentPath)).map((e) => path.join(e.parentPath, e.name)));
      expect(nested).toEqual([path.join(root, 'node_modules', name)]);
    }
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
