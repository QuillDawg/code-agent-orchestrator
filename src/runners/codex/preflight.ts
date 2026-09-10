/**
 * Which Codex CLI capabilities a task's `codex:` block turns into, and what the operator wrote to ask for
 * each of them. Both `cao run`'s readiness check and the scheduler's per-run preflight read this, so the
 * message an operator gets names the option and the YAML key rather than a bare capability name.
 */
import type { CodexOptions } from 'code-agent-orchestrator-protocol';
import type { CapabilityNeed } from '../preflight.js';

export function codexCapabilityNeeds(options: CodexOptions): CapabilityNeed[] {
  const transport = options.transport ?? 'exec';
  const needs: CapabilityNeed[] = [
    transport === 'appServer'
      ? { capability: 'appServer', option: 'codex app-server --stdio', key: 'codex.transport: appServer' }
      : { capability: 'exec', option: 'codex exec --json', key: `codex.transport: exec${options.transport ? '' : ' (the default)'}` },
  ];
  if (options.configMode === 'isolated') {
    needs.push({ capability: 'isolatedConfig', option: 'codex exec --ignore-user-config --ignore-rules', key: 'codex.configMode: isolated' });
  }
  // Automatic review is the only way an unattended task can answer its own approvals; a task that will not
  // be asked anything (approvals: deny, or a policy that never asks) does not need the flag at all.
  const approvals = options.approvals ?? 'auto';
  const asksForApprovals = transport === 'exec' ? approvals !== 'deny' : approvals !== 'deny' && approvals !== 'host';
  if (asksForApprovals && (options.approvalPolicy ?? 'on-request') === 'on-request') {
    needs.push({ capability: 'autoReview', option: '--approve-for-me', key: `codex.approvals: ${approvals}` });
  }
  return needs;
}
