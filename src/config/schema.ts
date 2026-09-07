/** Zod schema for the workflow YAML (version 1). Raw shape only; semantic validation lives in workflow/validator.ts. */
import { z } from 'zod';
import { CONTEXT_FIELDS } from '../types/result.js';

export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

const durationSchema = z.union([z.string().min(1), z.number().nonnegative()]);

const stringList = z.array(z.string());

export const retrySchema = z
  .object({
    attempts: z.number().int().min(0).max(20).optional(),
    includePreviousFailure: z.boolean().optional(),
    resetWorkspace: z.boolean().optional(),
    delay: durationSchema.optional(),
    transientAttempts: z.number().int().min(0).max(50).optional(),
    transientDelay: durationSchema.optional(),
    transientMaxDelay: durationSchema.optional(),
    resumeSession: z.boolean().optional(),
    resultNudges: z.number().int().min(0).max(5).optional(),
  })
  .strict();

export const claudeOptionsSchema = z
  .object({
    command: z.string().min(1).optional(),
    permissionMode: z.enum(['auto', 'acceptEdits', 'dontAsk', 'bypassPermissions', 'plan', 'manual']).optional(),
    model: z.string().min(1).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    maxBudgetUsd: z.number().positive().optional(),
    allowedTools: stringList.optional(),
    disallowedTools: stringList.optional(),
    addDirs: stringList.optional(),
    sessionPersistence: z.boolean().optional(),
    extraArgs: stringList.optional(),
    appendSystemPrompt: z.string().optional(),
    permissionPrompts: z.enum(['ask', 'deny']).optional(),
  })
  .strict();

export const codexOptionsSchema = z
  .object({
    command: z.string().min(1).optional(),
    permissionMode: z.enum(['auto', 'readOnly', 'fullAccess']).optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    approvalPolicy: z.enum(['on-request', 'never']).optional(),
    addDirs: stringList.optional(),
    profile: z.string().min(1).optional(),
    extraArgs: stringList.optional(),
  })
  .strict();

const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const completionMetadataSchema = z.object({ completedAt: z.string().optional(), runId: z.string().optional() }).strict();
const completionSchema = completionMetadataSchema.extend({ tasks: z.record(completionMetadataSchema).optional() }).strict();

const contextFieldSchema = z.enum(CONTEXT_FIELDS);

export const contextSourceSchema = z.union([
  z.string().min(1),
  z
    .object({
      task: z.string().min(1),
      include: z.array(contextFieldSchema).optional(),
    })
    .strict(),
]);

export const contextSchema = z.union([
  z.literal(false),
  z
    .object({
      from: z.array(contextSourceSchema).optional(),
      fromType: z.union([z.string().min(1), z.array(z.string().min(1))]).optional(),
      include: z.array(contextFieldSchema).optional(),
      includeFailed: z.boolean().optional(),
      maxChars: z.number().int().positive().optional(),
    })
    .strict(),
]);

export const whenSchema = z.union([
  z.object({ task: z.string().min(1), status: z.union([z.string(), z.array(z.string())]) }).strict(),
  z.object({ expr: z.string().min(1) }).strict(),
]);

const onFailureSchema = z.enum(['stop', 'continue', 'skip_dependents']);
const workspaceModeSchema = z.enum(['shared', 'worktree']);

/** Fields shared by templates, defaults and tasks. */
export const taskBodySchema = z
  .object({
    name: z.string().optional(),
    type: z.string().min(1).optional(),
    prompt: z.string().optional(),
    promptFile: z.string().optional(),
    template: z.string().min(1).optional(),
    runner: z.string().min(1).optional(),
    agent: z.enum(['claude', 'codex']).optional(),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
    dependsOn: z.array(z.string().min(1)).optional(),
    parallelGroup: z.string().min(1).optional(),
    workingDirectory: z.string().optional(),
    timeout: durationSchema.optional(),
    retries: z.number().int().min(0).max(20).optional(),
    retry: retrySchema.optional(),
    onFailure: onFailureSchema.optional(),
    runIfDependencyFailed: z.boolean().optional(),
    context: contextSchema.optional(),
    when: whenSchema.optional(),
    env: z.record(z.string()).optional(),
    claude: claudeOptionsSchema.optional(),
    codex: codexOptionsSchema.optional(),
    state: z.literal('completed').optional(),
    completion: completionSchema.optional(),
    workspace: workspaceModeSchema.optional(),
    approval: z.boolean().optional(),
  })
  .passthrough();

export const taskSchema = taskBodySchema.extend({
  id: z.string().regex(TASK_ID_PATTERN, 'Task id may contain letters, digits, ".", "_" and "-" (max 80 chars)'),
  foreach: z.string().min(1).optional(),
  as: z.string().min(1).optional(),
  foreachSequential: z.boolean().optional(),
});

export const worktreeSchema = z
  .object({
    directory: z.string().min(1).optional(),
    branchPrefix: z.string().min(1).optional(),
    base: z.enum(['runStart', 'headAtStart']).optional(),
    branchConflict: z.enum(['suffix', 'reuse', 'fail']).optional(),
    mergeBack: z.boolean().optional(),
    mergeConflictStrategy: z.enum(['agent', 'claude', 'codex', 'fail']).optional(),
    autoCommit: z.boolean().optional(),
    cleanup: z.enum(['onSuccess', 'always', 'never']).optional(),
    copyIgnored: stringList.optional(),
  })
  .strict();

export const executionSchema = z
  .object({
    mode: z.enum(['sequential', 'dag']).optional(),
    sequential: z.boolean().optional(),
    maxConcurrency: z.number().int().min(1).max(64).optional(),
    workingDirectoryStrategy: z.enum(['repositoryRoot', 'launchDirectory']).optional(),
    workspaceStrategy: z
      .union([
        workspaceModeSchema,
        z.object({ sequential: workspaceModeSchema.optional(), parallel: workspaceModeSchema.optional() }).strict(),
      ])
      .optional(),
    allowUnsafeSharedParallel: z.boolean().optional(),
    worktree: worktreeSchema.optional(),
    stopMode: z.enum(['wait', 'cancel']).optional(),
    killGrace: durationSchema.optional(),
    outputBufferLines: z.number().int().min(10).max(10_000).optional(),
    interactionTimeout: z.union([durationSchema, z.literal('never')]).optional(),
  })
  .strict();

export const gitSchema = z
  .object({
    enabled: z.boolean().optional(),
    requireCleanWorkingTree: z.boolean().optional(),
    captureDiff: z.boolean().optional(),
    maxDiffBytes: z.number().int().min(0).optional(),
  })
  .strict();

const hookList = z.union([z.string().min(1), z.array(z.string().min(1))]).optional();

export const hooksSchema = z
  .object({
    beforeWorkflow: hookList,
    afterWorkflow: hookList,
    beforeTask: hookList,
    afterTask: hookList,
    onTaskFailure: hookList,
    onInputRequired: hookList,
  })
  .strict();

export const workflowFileSchema = z
  .object({
    version: z.literal(1).optional(),
    name: z.string().min(1),
    description: z.string().optional(),
    repository: z.string().optional(),
    variables: z.record(z.unknown()).optional(),
    environment: z.record(z.string()).optional(),
    envFile: z.string().optional(),
    agent: z.enum(['claude', 'codex']).optional(),
    model: z.string().min(1).optional(),
    effort: effortSchema.optional(),
    claude: claudeOptionsSchema.optional(),
    codex: codexOptionsSchema.optional(),
    execution: executionSchema.optional(),
    git: gitSchema.optional(),
    defaults: taskBodySchema.optional(),
    templates: z.record(taskBodySchema).optional(),
    hooks: hooksSchema.optional(),
    tasks: z.array(taskSchema).min(1),
  })
  .passthrough();

export type WorkflowFile = z.infer<typeof workflowFileSchema>;
export type TaskFile = z.infer<typeof taskSchema>;
export type TaskBody = z.infer<typeof taskBodySchema>;
export type ContextFile = z.infer<typeof contextSchema>;
