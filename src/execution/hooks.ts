/** Lifecycle hooks: shell commands declared explicitly in the workflow YAML. Never driven by worker output. */
import { execa } from 'execa';
import type { HooksConfig, ResolvedWorkflow } from '../types/workflow.js';
import type { EventBus } from '../events/event-bus.js';
import type { Logger } from '../logging/logger.js';
import { silentLogger } from '../logging/logger.js';

export type HookName = keyof HooksConfig;

export interface HookContext {
  taskId?: string;
  taskState?: string;
  env?: Record<string, string>;
}

export interface HookRunner {
  run(hook: HookName, ctx?: HookContext): Promise<void>;
}

export class ShellHookRunner implements HookRunner {
  constructor(
    private readonly workflow: ResolvedWorkflow,
    private readonly bus: EventBus,
    private readonly baseEnv: Record<string, string>,
    private readonly logger: Logger = silentLogger,
  ) {}

  async run(hook: HookName, ctx: HookContext = {}): Promise<void> {
    const commands = this.workflow.hooks[hook];
    if (!commands || commands.length === 0) return;
    for (const command of commands) {
      this.bus.emit({ type: 'hook.started', hook, command, taskId: ctx.taskId });
      this.logger.info(`hook ${hook}: ${command}`);
      const env: Record<string, string> = { ...this.baseEnv, ...ctx.env, CAO_HOOK: hook };
      if (ctx.taskId) env.CAO_TASK_ID = ctx.taskId;
      if (ctx.taskState) env.CAO_TASK_STATE = ctx.taskState;
      const res = await execa(command, {
        shell: true,
        cwd: this.workflow.repositoryRoot,
        env: { ...process.env, ...env },
        reject: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const exitCode = res.exitCode ?? -1;
      this.bus.emit({ type: 'hook.finished', hook, command, exitCode, taskId: ctx.taskId });
      if (exitCode !== 0) {
        const detail = `${String(res.stderr ?? '')}\n${String(res.stdout ?? '')}`.trim();
        const message = `hook ${hook} failed (exit ${exitCode}): ${command}${detail ? `\n${detail}` : ''}`;
        if (hook === 'beforeWorkflow' || hook === 'beforeTask') throw new Error(message);
        this.logger.warn(message);
        this.bus.emit({ type: 'workflow.warning', code: 'hook_failed', message, taskId: ctx.taskId });
      }
    }
  }
}

export const noopHookRunner: HookRunner = { run: async () => undefined };
