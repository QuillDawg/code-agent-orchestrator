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

const SECURITY_FLAGS = new Set([
  '--sandbox', '-s', '--ask-for-approval', '-a', '--approve-for-me', '--full-auto', '--yolo',
  '--dangerously-bypass-approvals-and-sandbox', '--add-dir',
]);

/** Raw passthrough must not be able to override CAO's validated sandbox/approval envelope. */
export function codexExtraArgsSecurityConflict(args: string[] | undefined): string | undefined {
  if (!args) return undefined;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!.toLowerCase();
    if (SECURITY_FLAGS.has(token) || [...SECURITY_FLAGS].some((flag) => token.startsWith(`${flag}=`))) return args[index];
    if ((token === '-c' || token === '--config') && /(?:^|[.])(approval_policy|approvals_reviewer|sandbox|permissions?)(?:[.=]|$)/i.test(args[index + 1] ?? '')) {
      return `${args[index]} ${args[index + 1]}`;
    }
  }
  return undefined;
}
