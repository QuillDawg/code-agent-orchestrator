import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';
import { renderHeader } from '../../src/cli/render/plain.js';
import { buildWorkflow } from '../helpers/index.js';

describe('CLI branding', () => {
  it('uses the generic project name in help output', () => {
    const help = buildProgram().helpInformation();

    expect(help).toContain('Code Agent Orchestrator');
    expect(help).not.toContain('Claude Code Orchestrator');
  });

  it('uses the generic project name in the run header', async () => {
    const { workflow } = await buildWorkflow(`
name: Branding test
tasks:
  - id: task
    prompt: test
`);

    expect(renderHeader({ workflow, runId: 'run-1', layers: [] })).toMatch(/^Code Agent Orchestrator/);
  });
});
