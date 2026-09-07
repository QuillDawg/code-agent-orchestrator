/**
 * Turns a validated workflow file into a ResolvedWorkflow: defaults, templates, foreach expansion,
 * template variable substitution, path resolution and the sequential/parallelGroup DAG rules.
 * Problems are collected as diagnostics so `cao validate` can report all of them at once.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import type { LoadedWorkflow } from './loader.js';
import type { TaskBody, TaskFile, ContextFile } from './schema.js';
import { CONTEXT_FIELDS, type ContextField } from '../types/result.js';
import type {
  ClaudeOptions,
  CodexOptions,
  ContextSource,
  ExecutionConfig,
  GitConfig,
  HooksConfig,
  ResolvedContextSpec,
  ResolvedTask,
  ResolvedWorkflow,
  RetryPolicy,
  WhenSpec,
  WorktreeConfig,
} from '../types/workflow.js';
import { parseDuration } from '../util/duration.js';
import { renderTemplate } from '../templates/engine.js';
import { isInside } from '../util/fs.js';
import { isPlainObject, unique } from '../util/misc.js';

export interface Diagnostic {
  level: 'error' | 'warning';
  message: string;
  taskId?: string;
}

export interface NormalizeResult {
  workflow: ResolvedWorkflow;
  diagnostics: Diagnostic[];
}

const DEFAULT_CONTEXT_FIELDS: ContextField[] = CONTEXT_FIELDS.filter((f) => f !== 'data');
const DEFAULT_TIMEOUT = '60m';
/** Transient API errors (5xx, overloaded, network) are recovered by resuming the session; see RetryPolicy. */
const DEFAULT_TRANSIENT_ATTEMPTS = 3;
const DEFAULT_TRANSIENT_DELAY_MS = 30_000;
const DEFAULT_TRANSIENT_MAX_DELAY_MS = 5 * 60_000;
const GLOB_CHARS = /[*?[\]{}]/;

const TASK_FIELD_KEYS = new Set([
  'id',
  'name',
  'type',
  'prompt',
  'promptFile',
  'template',
  'runner',
  'agent',
  'model',
  'effort',
  'dependsOn',
  'parallelGroup',
  'workingDirectory',
  'timeout',
  'retries',
  'retry',
  'onFailure',
  'runIfDependencyFailed',
  'context',
  'when',
  'env',
  'claude',
  'codex',
  'state',
  'completion',
  'workspace',
  'approval',
  'foreach',
  'as',
  'foreachSequential',
]);

const ITEM_OVERRIDE_KEYS = [
  'name',
  'type',
  'parallelGroup',
  'dependsOn',
  'workingDirectory',
  'timeout',
  'retries',
  'retry',
  'onFailure',
  'when',
  'context',
  'env',
  'claude',
  'codex',
  'agent',
  'model',
  'effort',
  'workspace',
  'prompt',
  'template',
] as const;

const DEFAULT_INTERACTION_TIMEOUT_MS = 30 * 60_000;

function buildExecution(file: LoadedWorkflow['file']): ExecutionConfig {
  const ex = file.execution ?? {};
  const mode = ex.mode ?? (ex.sequential === false ? 'dag' : 'sequential');
  let sequential: 'shared' | 'worktree' = 'shared';
  let parallel: 'shared' | 'worktree' = 'worktree';
  if (typeof ex.workspaceStrategy === 'string') {
    sequential = ex.workspaceStrategy;
    parallel = ex.workspaceStrategy;
  } else if (ex.workspaceStrategy) {
    sequential = ex.workspaceStrategy.sequential ?? sequential;
    parallel = ex.workspaceStrategy.parallel ?? parallel;
  }
  const wt = ex.worktree ?? {};
  const worktree: WorktreeConfig = {
    directory: wt.directory ?? '.orchestrator/worktrees',
    branchPrefix: wt.branchPrefix ?? 'orchestrator/',
    base: wt.base ?? 'runStart',
    branchConflict: wt.branchConflict ?? 'suffix',
    mergeBack: wt.mergeBack ?? true,
    mergeConflictStrategy: wt.mergeConflictStrategy ?? 'agent',
    autoCommit: wt.autoCommit ?? true,
    cleanup: wt.cleanup ?? 'onSuccess',
    copyIgnored: wt.copyIgnored ?? [],
  };
  return {
    mode,
    maxConcurrency: ex.maxConcurrency ?? 1,
    workingDirectoryStrategy: ex.workingDirectoryStrategy ?? 'repositoryRoot',
    workspaceStrategy: { sequential, parallel },
    allowUnsafeSharedParallel: ex.allowUnsafeSharedParallel ?? false,
    worktree,
    stopMode: ex.stopMode ?? 'wait',
    killGraceMs: ex.killGrace !== undefined ? parseDuration(ex.killGrace) : process.platform === 'win32' ? 3000 : 5000,
    outputBufferLines: ex.outputBufferLines ?? 500,
    interactionTimeoutMs: ex.interactionTimeout === 'never' ? null : ex.interactionTimeout !== undefined ? parseDuration(ex.interactionTimeout) : DEFAULT_INTERACTION_TIMEOUT_MS,
  };
}

function toList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function buildHooks(file: LoadedWorkflow['file']): HooksConfig {
  const h = file.hooks ?? {};
  return {
    beforeWorkflow: toList(h.beforeWorkflow),
    afterWorkflow: toList(h.afterWorkflow),
    beforeTask: toList(h.beforeTask),
    afterTask: toList(h.afterTask),
    onTaskFailure: toList(h.onTaskFailure),
    onInputRequired: toList(h.onInputRequired),
  };
}

function mergeClaude(...layers: Array<ClaudeOptions | undefined>): ClaudeOptions {
  const out: ClaudeOptions = {};
  for (const layer of layers) if (layer) Object.assign(out, stripUndefined(layer));
  return out;
}

function mergeCodex(...layers: Array<CodexOptions | undefined>): CodexOptions {
  const out: CodexOptions = {};
  for (const layer of layers) if (layer) Object.assign(out, stripUndefined(layer));
  return out;
}

function stripUndefined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** Merge task bodies: later layers override earlier ones; nested runner options merge key-wise. */
function mergeBodies(...layers: Array<Record<string, unknown> | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) continue;
      if ((k === 'env' || k === 'claude' || k === 'codex') && isPlainObject(v) && isPlainObject(out[k])) {
        out[k] = { ...(out[k] as Record<string, unknown>), ...v };
      } else {
        out[k] = v;
      }
    }
  }
  return out;
}

interface ExpandedTask {
  body: Record<string, unknown>;
  id: string;
  sourceId: string;
  item?: unknown;
  index?: number;
  docIndex: number;
}

function itemKey(item: unknown, index: number): string {
  if (isPlainObject(item)) {
    for (const k of ['id', 'key', 'number', 'issue', 'name']) {
      const v = item[k];
      if (typeof v === 'string' || typeof v === 'number') return String(v);
    }
    return String(index + 1);
  }
  return String(item);
}

function slugify(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

export async function normalizeWorkflow(loaded: LoadedWorkflow): Promise<NormalizeResult> {
  const { file, configPath, launchDirectory, repositoryRoot } = loaded;
  const diagnostics: Diagnostic[] = [];
  const error = (message: string, taskId?: string): void => {
    diagnostics.push({ level: 'error', message, taskId });
  };
  const warn = (message: string, taskId?: string): void => {
    diagnostics.push({ level: 'warning', message, taskId });
  };

  const execution = buildExecution(file);
  const git: GitConfig = {
    enabled: file.git?.enabled ?? true,
    requireCleanWorkingTree: file.git?.requireCleanWorkingTree ?? false,
    captureDiff: file.git?.captureDiff ?? true,
    maxDiffBytes: file.git?.maxDiffBytes ?? 2 * 1024 * 1024,
  };
  const hooks = buildHooks(file);
  const variables = file.variables ?? {};
  const templates = file.templates ?? {};
  const defaults = (file.defaults ?? {}) as Record<string, unknown>;
  const workflowClaude = mergeClaude(file.claude);
  const workflowCodex = mergeCodex(file.codex);

  // ---- foreach expansion -------------------------------------------------------------------
  const expanded: ExpandedTask[] = [];
  let docIndex = 0;
  for (const task of file.tasks as TaskFile[]) {
    const { foreach, as, foreachSequential, ...rest } = task;
    if (!foreach) {
      expanded.push({ body: rest as Record<string, unknown>, id: task.id, sourceId: task.id, docIndex: docIndex++ });
      continue;
    }
    const collection = (file as Record<string, unknown>)[foreach] ?? variables[foreach];
    if (!Array.isArray(collection)) {
      error(`Task "${task.id}": foreach collection "${foreach}" is not a list (define it as a top-level key or under variables)`, task.id);
      continue;
    }
    if (collection.length === 0) warn(`Task "${task.id}": foreach collection "${foreach}" is empty; no tasks generated`, task.id);
    const alias = as ?? 'item';
    const seenKeys = new Set<string>();
    collection.forEach((item, index) => {
      const key = slugify(itemKey(item, index));
      if (seenKeys.has(key)) error(`Task "${task.id}": foreach produces duplicate child id suffix "${key}"`, task.id);
      seenKeys.add(key);
      const childId = `${task.id}-${key}`;
      const overrides: Record<string, unknown> = {};
      if (isPlainObject(item)) {
        for (const k of ITEM_OVERRIDE_KEYS) if (item[k] !== undefined) overrides[k] = item[k];
      }
      const body = mergeBodies(rest as Record<string, unknown>, overrides);
      if (foreachSequential && overrides.parallelGroup === undefined) delete body.parallelGroup;
      body[alias] = item;
      if (alias !== 'item') body.item = item;
      body.index = index;
      expanded.push({ body, id: childId, sourceId: task.id, item, index, docIndex: docIndex++ });
    });
  }

  // ---- duplicate ids ------------------------------------------------------------------------
  const idCounts = new Map<string, number>();
  for (const t of expanded) idCounts.set(t.id, (idCounts.get(t.id) ?? 0) + 1);
  for (const [id, n] of idCounts) if (n > 1) error(`Task id "${id}" is duplicated (${n} times)`, id);

  const sourceChildren = new Map<string, string[]>();
  for (const t of expanded) {
    if (t.sourceId !== t.id) sourceChildren.set(t.sourceId, [...(sourceChildren.get(t.sourceId) ?? []), t.id]);
  }
  const allIds = expanded.map((t) => t.id);
  const expandRef = (ref: string): string[] => sourceChildren.get(ref) ?? [ref];

  // ---- per-task resolution ------------------------------------------------------------------
  const tasks: ResolvedTask[] = [];
  const rawContexts = new Map<string, ContextFile | undefined>();
  const configDir = path.dirname(configPath);

  for (const ex of expanded) {
    const taskId = ex.id;
    let templateBody: Record<string, unknown> | undefined;
    const templateName = ex.body.template as string | undefined;
    if (templateName !== undefined) {
      templateBody = templates[templateName] as Record<string, unknown> | undefined;
      if (!templateBody) {
        error(`Task "${taskId}": template "${templateName}" does not exist`, taskId);
        continue;
      }
      if (templateBody.template) warn(`Template "${templateName}": nested templates are not supported; ignored`, taskId);
    }
    const body = mergeBodies(defaults, templateBody, ex.body) as TaskBody & Record<string, unknown>;

    const isApproval = body.type === 'approval' || body.approval === true;
    const name = typeof body.name === 'string' ? body.name : taskId;
    const type = (body.type as string | undefined) ?? (isApproval ? 'approval' : 'task');

    // Template scope: custom scalar fields + item + well-known variables.
    const custom: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) if (!TASK_FIELD_KEYS.has(k)) custom[k] = v;
    const scope: Record<string, unknown> = {
      ...custom,
      task: { id: taskId, name, type, sourceId: ex.sourceId },
      workflow: { name: file.name },
      repository: repositoryRoot,
      launchDirectory,
      variables,
      vars: variables,
      env: { ...process.env, ...loaded.environment },
      item: ex.item,
      index: ex.index,
    };
    const render = (text: string, field: string): string => {
      const r = renderTemplate(text, scope);
      if (r.missing.length) error(`Task "${taskId}": unknown template variable(s) in ${field}: ${r.missing.map((m) => `{{${m}}}`).join(', ')}`, taskId);
      return r.text;
    };

    let prompt = '';
    if (typeof body.prompt === 'string') {
      prompt = render(body.prompt, 'prompt');
    } else if (typeof body.promptFile === 'string') {
      const promptPath = path.resolve(configDir, render(body.promptFile, 'promptFile'));
      if (!isInside(repositoryRoot, promptPath) && !isInside(configDir, promptPath)) {
        error(`Task "${taskId}": promptFile must be inside the repository or the workflow directory`, taskId);
      } else {
        try {
          prompt = render(await fs.readFile(promptPath, 'utf8'), 'promptFile');
        } catch (err) {
          error(`Task "${taskId}": cannot read promptFile ${promptPath}: ${(err as Error).message}`, taskId);
        }
      }
    }
    if (!prompt.trim() && !isApproval) error(`Task "${taskId}": prompt is required (set prompt, promptFile or a template)`, taskId);
    if (isApproval && !prompt.trim()) prompt = `Approve continuing after "${name}"?`;

    // Working directory
    const wdRaw = typeof body.workingDirectory === 'string' ? render(body.workingDirectory, 'workingDirectory') : '';
    const workingDirectory = wdRaw ? path.resolve(repositoryRoot, wdRaw) : repositoryRoot;
    if (!isInside(repositoryRoot, workingDirectory)) {
      error(`Task "${taskId}": workingDirectory "${wdRaw}" escapes the repository root ${repositoryRoot}`, taskId);
    }
    const workingDirectoryRelative = path.relative(repositoryRoot, workingDirectory);

    // Timeouts / retries
    let timeoutMs = parseDuration(DEFAULT_TIMEOUT);
    try {
      if (body.timeout !== undefined) timeoutMs = parseDuration(body.timeout as string | number);
    } catch (err) {
      error(`Task "${taskId}": ${(err as Error).message}`, taskId);
    }
    const retryBody = (body.retry ?? {}) as Record<string, unknown>;
    const retryDuration = (key: string, fallback: number): number => {
      try {
        if (retryBody[key] !== undefined) return parseDuration(retryBody[key] as string | number);
      } catch (err) {
        error(`Task "${taskId}": retry.${key}: ${(err as Error).message}`, taskId);
      }
      return fallback;
    };
    const delayMs = retryDuration('delay', 0);
    const transientDelayMs = retryDuration('transientDelay', DEFAULT_TRANSIENT_DELAY_MS);
    const transientMaxDelayMs = retryDuration('transientMaxDelay', DEFAULT_TRANSIENT_MAX_DELAY_MS);
    if (transientMaxDelayMs < transientDelayMs) error(`Task "${taskId}": retry.transientMaxDelay must be >= retry.transientDelay`, taskId);
    const retry: RetryPolicy = {
      attempts: (retryBody.attempts as number | undefined) ?? (body.retries as number | undefined) ?? 0,
      includePreviousFailure: (retryBody.includePreviousFailure as boolean | undefined) ?? true,
      resetWorkspace: (retryBody.resetWorkspace as boolean | undefined) ?? false,
      delayMs,
      transientAttempts: (retryBody.transientAttempts as number | undefined) ?? DEFAULT_TRANSIENT_ATTEMPTS,
      transientDelayMs,
      transientMaxDelayMs,
      resumeSession: (retryBody.resumeSession as boolean | undefined) ?? true,
    };

    // Dependencies (foreach source ids expand to children)
    const explicitDeps = Array.isArray(body.dependsOn) ? (body.dependsOn as string[]) : undefined;
    const dependsOn = explicitDeps ? unique(explicitDeps.flatMap(expandRef)) : [];
    if (dependsOn.includes(taskId)) error(`Task "${taskId}" depends on itself`, taskId);

    // Context is resolved in a second pass once every task's final type is known (fromType).
    rawContexts.set(taskId, body.context as ContextFile | undefined);
    const context = null;

    // Env (values rendered; keys must be plain)
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries((body.env ?? {}) as Record<string, string>)) env[k] = render(String(v), `env.${k}`);

    const when = body.when as WhenSpec | undefined;

    const claude = mergeClaude(workflowClaude, body.claude as ClaudeOptions | undefined);
    const codex = mergeCodex(workflowCodex, body.codex as CodexOptions | undefined);
    const agent = (body.agent as ResolvedTask['agent'] | undefined) ?? ((body.runner as ResolvedTask['agent'] | undefined) ?? file.agent ?? 'claude');
    // New generic workflow fields are authoritative; nested Claude values remain legacy fallbacks.
    const model = (body.model as string | undefined) ?? file.model ?? (agent === 'claude' ? claude.model : undefined);
    const effort = (body.effort as ResolvedTask['effort'] | undefined) ?? file.effort ?? (agent === 'claude' ? claude.effort : undefined);
    const completionBody = body.completion as { completedAt?: string; runId?: string; tasks?: Record<string, { completedAt?: string; runId?: string }> } | undefined;
    const completed = body.state === 'completed'
      ? { completedAt: completionBody?.completedAt, runId: completionBody?.runId }
      : completionBody?.tasks?.[taskId];

    tasks.push({
      id: taskId,
      sourceId: ex.sourceId,
      name,
      type,
      docIndex: ex.docIndex,
      dependsOn,
      implicitDeps: [],
      parallelGroup: typeof body.parallelGroup === 'string' ? body.parallelGroup : undefined,
      runner: agent,
      agent,
      model,
      effort,
      prompt,
      workingDirectory,
      workingDirectoryRelative,
      timeoutMs,
      retry,
      onFailure: (body.onFailure as ResolvedTask['onFailure'] | undefined) ?? 'stop',
      runIfDependencyFailed: (body.runIfDependencyFailed as boolean | undefined) ?? false,
      context,
      when,
      env,
      claude,
      codex,
      completed,
      isApproval,
      workspace: (body.workspace as ResolvedTask['workspace'] | undefined) ?? 'auto',
      vars: custom,
    });
    // record whether deps were explicit for the DAG pass
    (tasks[tasks.length - 1] as ResolvedTask & { __explicitDeps?: boolean }).__explicitDeps = explicitDeps !== undefined;
  }

  for (const task of tasks) task.context = resolveContext(rawContexts.get(task.id), task.id, allIds, tasks, expandRef, error);
  applyDagRules(tasks, execution, error);

  const workflow: ResolvedWorkflow = {
    version: 1,
    name: file.name,
    configPath,
    launchDirectory,
    repositoryRoot,
    gitRoot: loaded.gitRoot,
    variables,
    environmentKeys: Object.keys(loaded.environment),
    execution,
    git,
    hooks,
    claude: workflowClaude,
    codex: workflowCodex,
    agent: file.agent ?? 'claude',
    model: file.model,
    effort: file.effort,
    tasks,
  };
  return { workflow, diagnostics };
}

function resolveContext(
  raw: ContextFile | undefined,
  taskId: string,
  allIds: string[],
  resolvedTasks: ResolvedTask[],
  expandRef: (ref: string) => string[],
  error: (msg: string, taskId?: string) => void,
): ResolvedContextSpec | null {
  if (raw === undefined || raw === false) return null;
  const include = (raw.include as ContextField[] | undefined) ?? DEFAULT_CONTEXT_FIELDS;
  const sources: ContextSource[] = [];
  const add = (id: string, fields: ContextField[]): void => {
    if (id === taskId) return;
    const existing = sources.find((s) => s.taskId === id);
    if (existing) existing.include = unique([...existing.include, ...fields]);
    else sources.push({ taskId: id, include: fields });
  };
  for (const src of raw.from ?? []) {
    const ref = typeof src === 'string' ? src : src.task;
    const fields = typeof src === 'string' ? include : (src.include ?? include);
    if (GLOB_CHARS.test(ref)) {
      const matcher = picomatch(ref);
      const matched = allIds.filter((id) => matcher(id));
      if (matched.length === 0) error(`Task "${taskId}": context pattern "${ref}" matches no tasks`, taskId);
      matched.forEach((id) => add(id, fields));
    } else {
      const ids = expandRef(ref);
      for (const id of ids) {
        if (!allIds.includes(id)) error(`Task "${taskId}": context source "${ref}" is not a known task`, taskId);
        else add(id, fields);
      }
    }
  }
  if (raw.fromType) {
    const types = Array.isArray(raw.fromType) ? raw.fromType : [raw.fromType];
    const byType = resolvedTasks.filter((t) => types.includes(t.type) && t.id !== taskId).map((t) => t.id);
    if (byType.length === 0) error(`Task "${taskId}": context.fromType ${types.join(', ')} matches no tasks`, taskId);
    byType.forEach((id) => add(id, include));
  }
  return { sources, includeFailed: raw.includeFailed ?? false, maxChars: raw.maxChars ?? 60_000 };
}

/** Sequential-mode DAG rules (see docs/configuration.md#execution-order). */
function applyDagRules(tasks: ResolvedTask[], execution: ExecutionConfig, error: (m: string, t?: string) => void): void {
  const seenGroups = new Map<string, number>();
  let frontier: string[] = [];
  let currentGroup: string | undefined;
  let groupMembers: string[] = [];
  let frontierBeforeGroup: string[] = [];

  const closeGroup = (): void => {
    if (currentGroup !== undefined) {
      frontier = [...groupMembers];
      currentGroup = undefined;
      groupMembers = [];
    }
  };

  for (const task of [...tasks].sort((a, b) => a.docIndex - b.docIndex)) {
    const explicit = (task as ResolvedTask & { __explicitDeps?: boolean }).__explicitDeps === true;
    delete (task as ResolvedTask & { __explicitDeps?: boolean }).__explicitDeps;
    if (execution.mode === 'dag') {
      if (task.parallelGroup) error(`Task "${task.id}": parallelGroup is not allowed in execution.mode "dag"; use dependsOn`, task.id);
      continue;
    }
    if (task.parallelGroup) {
      if (currentGroup !== task.parallelGroup) {
        closeGroup();
        if (seenGroups.has(task.parallelGroup)) {
          error(`parallelGroup "${task.parallelGroup}" is not contiguous (tasks in a group must be listed together)`, task.id);
        }
        seenGroups.set(task.parallelGroup, task.docIndex);
        currentGroup = task.parallelGroup;
        frontierBeforeGroup = [...frontier];
      }
      if (!explicit) {
        task.implicitDeps = [...frontierBeforeGroup];
        task.dependsOn = unique([...task.dependsOn, ...task.implicitDeps]);
      }
      groupMembers.push(task.id);
      continue;
    }
    closeGroup();
    if (!explicit) {
      task.implicitDeps = [...frontier];
      task.dependsOn = unique([...task.dependsOn, ...task.implicitDeps]);
    }
    frontier = [task.id];
  }
  closeGroup();
}
