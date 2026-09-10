import type { CodexOptions } from '../../types/workflow.js';

export interface ResolvedCodexPermissions {
  sandbox: NonNullable<CodexOptions['sandbox']>;
  approvalPolicy: NonNullable<CodexOptions['approvalPolicy']>;
  reviewer: 'user' | 'auto_review';
  host: boolean;
  autoReview: boolean;
}

/** Resolve the common security envelope before either Codex transport adapts it to its wire format. */
export function resolveCodexPermissions(options: CodexOptions, canInteract: boolean): ResolvedCodexPermissions {
  const preset = options.permissionMode ?? 'auto';
  if (preset === 'readOnly') return { sandbox: 'read-only', approvalPolicy: 'never', reviewer: 'user', host: false, autoReview: false };
  if (preset === 'fullAccess') return { sandbox: 'danger-full-access', approvalPolicy: 'never', reviewer: 'user', host: false, autoReview: false };

  const selected = options.approvals === 'auto' || options.approvals === undefined ? (canInteract ? 'host' : 'autoReview') : options.approvals;
  const approvalPolicy = options.approvalPolicy ?? (selected === 'deny' ? 'never' : 'on-request');
  return {
    sandbox: options.sandbox ?? 'workspace-write',
    approvalPolicy,
    reviewer: selected === 'autoReview' ? 'auto_review' : 'user',
    host: selected === 'host' && approvalPolicy === 'on-request',
    autoReview: selected === 'autoReview' && approvalPolicy === 'on-request',
  };
}
