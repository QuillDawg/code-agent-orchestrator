import { describe, expect, it } from 'vitest';
import { buildCodexArgs } from '../../src/runners/codex/codex-runner.js';

describe('Codex runner arguments', () => {
  it('maps the auto permission preset and includes structured output files', () => {
    const args = buildCodexArgs({ permissionMode: 'auto' }, 'schema.json', 'final.json');
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'workspace-write', '-c', 'approval_policy="on-request"', 'exec', '--json', '--output-schema', 'schema.json', '--output-last-message', 'final.json']));
  });

  it('uses an explicit session for a resumed worker', () => {
    const args = buildCodexArgs({ permissionMode: 'readOnly' }, 'schema.json', 'final.json', 'thread-1');
    expect(args).toEqual(expect.arrayContaining(['--sandbox', 'read-only', 'exec', 'resume', 'thread-1']));
  });
});
