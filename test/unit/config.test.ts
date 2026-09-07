import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildWorkflow } from '../helpers/index.js';
import { parseWorkflowText } from '../../src/config/loader.js';

const errors = (d: { level: string; message: string }[]) => d.filter((x) => x.level === 'error').map((x) => x.message);

describe('workflow schema', () => {
  it('parses a minimal valid workflow', () => {
    const file = parseWorkflowText('name: x\ntasks:\n  - id: a\n    prompt: hi\n');
    expect(file.name).toBe('x');
    expect(file.tasks).toHaveLength(1);
  });

  it('rejects invalid YAML', () => {
    expect(() => parseWorkflowText('name: [unclosed\ntasks: 1')).toThrow(/Failed to parse YAML/);
  });

  it('rejects a missing name and empty tasks with paths in the message', () => {
    expect(() => parseWorkflowText('tasks: []')).toThrow(/name/);
    expect(() => parseWorkflowText('name: x\ntasks: []')).toThrow(/tasks/);
  });

  it('rejects bad task ids and unknown execution keys', () => {
    expect(() => parseWorkflowText('name: x\ntasks:\n  - id: "bad id!"\n    prompt: p')).toThrow(/Task id/);
    expect(() => parseWorkflowText('name: x\nexecution:\n  bogus: 1\ntasks:\n  - id: a\n    prompt: p')).toThrow(/execution/);
  });
});

describe('normalize', () => {
  it('resolves generic agent, model, effort and Codex permissions per task', async () => {
    const { workflow, diagnostics } = await buildWorkflow(`
name: multi-agent
agent: codex
model: gpt-5.6-terra
effort: high
codex:
  permissionMode: auto
tasks:
  - id: inherit
    prompt: p
  - id: override
    agent: claude
    model: sonnet
    effort: max
    prompt: p
`);
    expect(errors(diagnostics)).toEqual([]);
    expect(workflow.tasks[0]).toMatchObject({ agent: 'codex', runner: 'codex', model: 'gpt-5.6-terra', effort: 'high' });
    expect(workflow.tasks[0]!.codex.permissionMode).toBe('auto');
    expect(workflow.tasks[1]).toMatchObject({ agent: 'claude', runner: 'claude', model: 'sonnet', effort: 'max' });
  });

  it('marks completed task definitions for a subsequent run', async () => {
    const { workflow } = await buildWorkflow(`
name: resumable
tasks:
  - id: done
    state: completed
    completion: { completedAt: '2026-01-01T00:00:00.000Z', runId: run-1 }
    prompt: p
`);
    expect(workflow.tasks[0]!.completed).toEqual({ completedAt: '2026-01-01T00:00:00.000Z', runId: 'run-1' });
  });
  it('applies defaults, templates and task overrides', async () => {
    const { workflow, diagnostics } = await buildWorkflow(`
name: t
defaults:
  timeout: 10m
  retries: 1
  onFailure: continue
templates:
  impl:
    type: implementation
    prompt: "/implement {{issueNumber}}"
    timeout: 30m
tasks:
  - id: a
    template: impl
    issueNumber: 101
  - id: b
    template: impl
    issueNumber: 102
    timeout: 5m
    retries: 3
`);
    expect(errors(diagnostics)).toEqual([]);
    const [a, b] = workflow.tasks;
    expect(a!.prompt).toBe('/implement 101');
    expect(a!.type).toBe('implementation');
    expect(a!.timeoutMs).toBe(30 * 60_000);
    expect(a!.retry.attempts).toBe(1);
    expect(a!.onFailure).toBe('continue');
    expect(b!.timeoutMs).toBe(5 * 60_000);
    expect(b!.retry.attempts).toBe(3);
  });

  it('reports unknown templates and missing prompts', async () => {
    const { diagnostics } = await buildWorkflow(`
name: t
tasks:
  - id: a
    template: nope
  - id: b
`);
    expect(errors(diagnostics)).toEqual(expect.arrayContaining([expect.stringContaining('template "nope" does not exist'), expect.stringContaining('prompt is required')]));
  });

  it('renders workflow/task/variable/env placeholders and reports unknown ones', async () => {
    const { workflow, diagnostics } = await buildWorkflow(
      `
name: wf
variables:
  prd: docs/prd.md
tasks:
  - id: a
    name: Alpha
    prompt: "{{workflow.name}} {{task.id}} {{task.name}} {{variables.prd}} {{env.FOO}} {{repository}}"
  - id: b
    prompt: "{{missing.thing}}"
`,
      { environment: { FOO: 'bar' } },
    );
    expect(workflow.tasks[0]!.prompt).toContain('wf a Alpha docs/prd.md bar');
    expect(workflow.tasks[0]!.prompt).toContain(workflow.repositoryRoot);
    expect(errors(diagnostics)).toEqual([expect.stringContaining('{{missing.thing}}')]);
  });

  it('expands foreach over scalar and object collections with per-item overrides', async () => {
    const { workflow, diagnostics } = await buildWorkflow(`
name: t
issues:
  - number: 101
  - number: 102
    parallelGroup: auth
  - number: 103
    parallelGroup: auth
  - number: 104
    name: Last one
templates:
  impl:
    prompt: "/implement {{item.number}} ({{index}})"
tasks:
  - id: implement
    foreach: issues
    template: impl
  - id: review
    context:
      from: [implement]
    prompt: review
`);
    expect(errors(diagnostics)).toEqual([]);
    const ids = workflow.tasks.map((t) => t.id);
    expect(ids).toEqual(['implement-101', 'implement-102', 'implement-103', 'implement-104', 'review']);
    expect(workflow.tasks[0]!.prompt).toBe('/implement 101 (0)');
    expect(workflow.tasks[1]!.prompt).toBe('/implement 102 (1)');
    expect(workflow.tasks[3]!.name).toBe('Last one');
    const scalar = await buildWorkflow('name: t\nids: [7, 8]\ntasks:\n  - id: x\n    foreach: ids\n    as: n\n    prompt: "do {{n}}"\n');
    expect(scalar.workflow.tasks.map((t) => [t.id, t.prompt])).toEqual([['x-7', 'do 7'], ['x-8', 'do 8']]);
    expect(scalar.workflow.tasks[1]!.dependsOn).toEqual(['x-7']);
    expect(workflow.tasks[1]!.parallelGroup).toBe('auth');
    // sequential chain then parallel group then sequential
    expect(workflow.tasks[1]!.dependsOn).toEqual(['implement-101']);
    expect(workflow.tasks[2]!.dependsOn).toEqual(['implement-101']);
    expect(workflow.tasks[3]!.dependsOn).toEqual(['implement-102', 'implement-103']);
    // referencing the foreach source expands to all children
    expect(workflow.tasks[4]!.dependsOn).toEqual(['implement-104']);
    expect(workflow.tasks[4]!.context!.sources.map((s) => s.taskId)).toEqual(['implement-101', 'implement-102', 'implement-103', 'implement-104']);
  });

  it('rejects foreach over a non-list', async () => {
    const { diagnostics } = await buildWorkflow('name: t\nissues: 5\ntasks:\n  - id: a\n    foreach: issues\n    prompt: p\n');
    expect(errors(diagnostics)[0]).toMatch(/is not a list/);
  });

  it('applies the sequential DAG rules: implicit chain, parallelGroup, explicit dependsOn', async () => {
    const { workflow, diagnostics } = await buildWorkflow(`
name: t
tasks:
  - id: analyze
    prompt: p
  - id: impl-api
    parallelGroup: impl
    prompt: p
  - id: impl-ui
    parallelGroup: impl
    prompt: p
  - id: review
    prompt: p
  - id: security
    dependsOn: [analyze]
    prompt: p
  - id: release
    prompt: p
  - id: root
    dependsOn: []
    prompt: p
`);
    expect(errors(diagnostics)).toEqual([]);
    const deps = Object.fromEntries(workflow.tasks.map((t) => [t.id, t.dependsOn]));
    expect(deps).toEqual({
      analyze: [],
      'impl-api': ['analyze'],
      'impl-ui': ['analyze'],
      review: ['impl-api', 'impl-ui'],
      security: ['analyze'],
      release: ['security'],
      root: [],
    });
    expect(workflow.tasks.find((t) => t.id === 'review')!.implicitDeps).toEqual(['impl-api', 'impl-ui']);
    expect(workflow.tasks.find((t) => t.id === 'security')!.implicitDeps).toEqual([]);
  });

  it('rejects non-contiguous parallel groups and parallelGroup in dag mode', async () => {
    const a = await buildWorkflow('name: t\ntasks:\n  - id: a\n    parallelGroup: g\n    prompt: p\n  - id: b\n    prompt: p\n  - id: c\n    parallelGroup: g\n    prompt: p\n');
    expect(errors(a.diagnostics)[0]).toMatch(/not contiguous/);
    const b = await buildWorkflow('name: t\nexecution:\n  mode: dag\ntasks:\n  - id: a\n    parallelGroup: g\n    prompt: p\n');
    expect(errors(b.diagnostics)[0]).toMatch(/not allowed in execution.mode "dag"/);
  });

  it('dag mode only uses explicit edges', async () => {
    const { workflow } = await buildWorkflow('name: t\nexecution:\n  mode: dag\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    prompt: p\n  - id: c\n    dependsOn: [a, b]\n    prompt: p\n');
    expect(workflow.tasks.map((t) => t.dependsOn)).toEqual([[], [], ['a', 'b']]);
  });

  it('resolves working directories relative to the repository root and rejects escapes', async () => {
    const { workflow, diagnostics } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    workingDirectory: ./apps/api\n    prompt: p\n  - id: b\n    workingDirectory: ../outside\n    prompt: p\n');
    expect(workflow.tasks[0]!.workingDirectory).toBe(path.join(workflow.repositoryRoot, 'apps', 'api'));
    expect(workflow.tasks[0]!.workingDirectoryRelative).toBe(path.join('apps', 'api'));
    expect(errors(diagnostics)[0]).toMatch(/escapes the repository root/);
  });

  it('parses durations and reports invalid ones', async () => {
    const { workflow, diagnostics } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    timeout: 1h30m\n    retry:\n      attempts: 2\n      delay: 5s\n    prompt: p\n  - id: b\n    timeout: soon\n    prompt: p\n');
    expect(workflow.tasks[0]!.timeoutMs).toBe(90 * 60_000);
    expect(workflow.tasks[0]!.retry.delayMs).toBe(5000);
    expect(errors(diagnostics)[0]).toMatch(/Invalid duration/);
  });

  it('resolves context sources by id, glob and type with field selectors', async () => {
    const { workflow, diagnostics } = await buildWorkflow(`
name: t
tasks:
  - id: impl-1
    type: implementation
    prompt: p
  - id: impl-2
    type: implementation
    prompt: p
  - id: test
    type: test
    prompt: p
  - id: review
    context:
      from:
        - "impl-*"
        - task: test
          include: [summary, warnings]
      fromType: implementation
    prompt: p
`);
    expect(errors(diagnostics)).toEqual([]);
    const ctx = workflow.tasks[3]!.context!;
    expect(ctx.sources.map((s) => s.taskId)).toEqual(['impl-1', 'impl-2', 'test']);
    expect(ctx.sources.find((s) => s.taskId === 'test')!.include).toEqual(['summary', 'warnings']);
    expect(ctx.sources.find((s) => s.taskId === 'impl-1')!.include).not.toContain('data');
  });

  it('marks approval tasks', async () => {
    const { workflow } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n  - id: gate\n    type: approval\n    prompt: Continue?\n');
    expect(workflow.tasks[1]!.isApproval).toBe(true);
    expect(workflow.tasks[1]!.type).toBe('approval');
  });
});

describe('validator', () => {
  it('detects duplicate ids', async () => {
    const { diagnostics } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    prompt: p\n  - id: a\n    prompt: p\n');
    expect(errors(diagnostics).some((m) => m.includes('duplicated'))).toBe(true);
  });

  it('detects unknown dependencies', async () => {
    const { validation } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    dependsOn: [issue-999]\n    prompt: p\n');
    expect(errors(validation.diagnostics)).toEqual([expect.stringContaining('unknown dependency "issue-999"')]);
  });

  it('detects circular dependencies with the cycle path', async () => {
    const { validation } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    dependsOn: [c]\n    prompt: p\n  - id: b\n    dependsOn: [a]\n    prompt: p\n  - id: c\n    dependsOn: [b]\n    prompt: p\n');
    expect(errors(validation.diagnostics)[0]).toMatch(/Circular dependency detected: .*a.*/);
  });

  it('requires when/context references to be transitive dependencies', async () => {
    const { validation } = await buildWorkflow(`
name: t
execution:
  mode: dag
tasks:
  - id: a
    prompt: p
  - id: b
    prompt: p
    when:
      task: a
      status: success
  - id: c
    dependsOn: [a]
    context:
      from: [b]
    prompt: p
`);
    const msgs = errors(validation.diagnostics);
    expect(msgs).toEqual(expect.arrayContaining([expect.stringContaining('when refers to "a"'), expect.stringContaining('context source "b" is not a (transitive) dependency')]));
  });

  it('refuses concurrent tasks in the same shared working tree', async () => {
    const yaml = `
name: t
execution:
  maxConcurrency: 2
  workspaceStrategy:
    parallel: shared
tasks:
  - id: a
    prompt: p
  - id: b
    parallelGroup: g
    prompt: p
  - id: c
    parallelGroup: g
    prompt: p
`;
    const bad = await buildWorkflow(yaml);
    expect(errors(bad.validation.diagnostics)[0]).toMatch(/may run concurrently in the same working tree/);
    const ok = await buildWorkflow(yaml.replace('workspaceStrategy:\n    parallel: shared', 'allowUnsafeSharedParallel: true\n  workspaceStrategy:\n    parallel: shared'));
    expect(ok.validation.ok).toBe(true);
  });

  it('requires git for worktrees', async () => {
    const { validation } = await buildWorkflow('name: t\nexecution:\n  maxConcurrency: 2\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    parallelGroup: g\n    prompt: p\n  - id: c\n    parallelGroup: g\n    prompt: p\n');
    expect(errors(validation.diagnostics)[0]).toMatch(/Worktree isolation requires/);
    const withGit = await buildWorkflow('name: t\nexecution:\n  maxConcurrency: 2\ntasks:\n  - id: a\n    prompt: p\n  - id: b\n    parallelGroup: g\n    prompt: p\n  - id: c\n    parallelGroup: g\n    prompt: p\n', { gitRoot: process.cwd() });
    expect(withGit.validation.ok).toBe(true);
    expect(withGit.validation.layers).toEqual([['a'], ['b', 'c']]);
  });

  it('flags unknown runners', async () => {
    const { validation } = await buildWorkflow('name: t\ntasks:\n  - id: a\n    runner: gemini\n    prompt: p\n');
    expect(errors(validation.diagnostics)[0]).toMatch(/unknown runner "gemini"/);
  });
});
