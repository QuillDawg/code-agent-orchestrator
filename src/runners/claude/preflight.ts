/**
 * Which Claude Code capabilities a task's `claude:` block turns into. Two of them are unconditional: every
 * Claude attempt streams events and every one enforces the completion contract with a JSON schema, so a CLI
 * without them cannot run any task at all.
 */
import type { ClaudeOptions } from 'code-agent-orchestrator-protocol';
import type { CapabilityNeed } from '../preflight.js';

export function claudeCapabilityNeeds(options: ClaudeOptions): CapabilityNeed[] {
  const needs: CapabilityNeed[] = [
    { capability: 'streamJson', option: '--output-format stream-json --verbose', key: 'the orchestrator itself (every Claude attempt is read from stream-json)' },
    { capability: 'structuredOutput', option: '--json-schema', key: 'the completion contract (every Claude attempt)' },
  ];
  if (options.configMode === 'isolated') {
    needs.push({ capability: 'isolatedConfig', option: '--safe-mode', key: 'claude.configMode: isolated' });
  }
  return needs;
}
