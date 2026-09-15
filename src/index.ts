// The shared contract, re-exported so that `code-agent-orchestrator`'s published surface is unchanged by
// the move to the protocol package (spec §4.1). A consumer importing this module sees what it saw before.
export * from 'code-agent-orchestrator-protocol';
export { loadWorkflow, parseWorkflowText } from './config/loader.js';
export { normalizeWorkflow } from './config/normalize.js';
export type { Diagnostic } from './config/normalize.js';
export { validateWorkflow, buildGraph, effectiveWorkspace } from './workflow/validator.js';
export { TaskGraph } from './workflow/graph.js';
export { WorkflowScheduler, exitCodeFor } from './workflow/scheduler.js';
export { summarize } from './workflow/states.js';
export type { SchedulerDeps, SchedulerResult } from './workflow/scheduler.js';
export { createRun, reconcileForResume } from './workflow/run-factory.js';
export { renderExecutionPlan } from './workflow/plan.js';
export { ContextBuilder } from './context/context-builder.js';
export { evaluateWhen, parseExpression, evaluateExpression, compileWhen } from './conditions/evaluator.js';
export { renderTemplate, templateReferences } from './templates/engine.js';
export { WorkflowEventBus } from './events/event-bus.js';
export type { EventBus } from './events/event-bus.js';
export { FileRunStore } from './persistence/run-store.js';
export type { RunStore } from './persistence/run-store.js';
export { ProcessManager, killTree } from './execution/process-manager.js';
export { RunnerRegistry } from './runners/task-runner.js';
export type { TaskRunner, RunnerInput, RunnerHooks, RunnerOutcome } from './runners/task-runner.js';
export { ClaudeRunner, buildClaudeArgs, resolveClaudeOptions } from './runners/claude/claude-runner.js';
export { CodexRunner, buildCodexArgs } from './runners/codex/codex-runner.js';
export { normalizeCodexFailure } from './runners/codex/failure.js';
export { parseClaudeLine, parseClaudeEvents, describeToolUse } from './runners/claude/event-parser.js';
export { encodeUserMessage, encodeControlResponse, encodeErrorResponse, toInteraction, permissionResult, PendingInteractions } from './runners/claude/protocol.js';
export { renderTranscript, renderEntry } from './tui/transcript.js';
export type { EntryContext, TranscriptRenderOptions } from './tui/transcript.js';
export { renderMarkdown } from './tui/markdown.js';
export { validateTaskResult, extractJsonObject, TASK_RESULT_JSON_SCHEMA, CONTRACT_SYSTEM_PROMPT } from './runners/contract.js';
export { GitWorkspaceManager, SharedOnlyWorkspaceManager } from './workspace/workspace-manager.js';
export type { WorkspaceManager } from './workspace/workspace-manager.js';
export { Git } from './workspace/git.js';
export { captureDiff, snapshotTree, snapshotIndexDir, snapshotIndexPath, removeSnapshotIndexDir, formatDiffStat } from './workspace/diff.js';
export type { CapturedDiff } from './workspace/diff.js';
export { Redactor } from './logging/redact.js';
export { ConsoleLogger, silentLogger } from './logging/logger.js';
export type { Logger } from './logging/logger.js';
export { prepareWorkflow, createRuntime } from './cli/app.js';
export { parseDuration, formatDuration } from './util/duration.js';
// Stayed behind when the interaction types moved to the protocol package: these shape operator-facing text,
// which is presentation rather than contract. Exported from here as they always were.
export { NEEDS_INPUT_HINT, withoutWorkerInstructions, asSentence } from './util/text.js';
// The registry (spec §4.2, §5.1). `SchedulerDeps.emit` is public, so the files it announces a run into have
// to be readable from here too: an embedder that turns emit on would otherwise have no way to list, classify
// or reap what its own runs wrote.
export {
  caoHome,
  assertSafeHome,
  homeRefusal,
  machineIdentity,
  sameMachine,
  registryKey,
  normalizedRepositoryRoot,
  repositoryHash,
  entryForRun,
  entryLiveness,
  writeEntry,
  removeEntry,
  listEntries,
  reap,
  readConfig,
  writeConfig,
  emitEnabled,
  emitSetting,
  emitFeedSetting,
  listPresence,
  hasFreshPresence,
  isSyncConflictName,
  setRegistryWarner,
  DEFAULT_RETAIN_DAYS,
} from './persistence/registry.js';
export type { EmitConfig, EmitDecision, EmitSource, EntryLiveness, AnnounceOptions } from './persistence/registry.js';
export type { EmitAnnouncement } from './workflow/scheduler.js';
// The switch as a command applies it (§4.2.7), and §4.2.3's rule that an entry advertises what the run
// actually wired up. An embedder that sets `SchedulerDeps.emit` needs the same derivation, or it invents a
// second one that is wrong the first time a capability lands.
export { planEmit, wiredCapabilities } from './cli/emit.js';
export type { EmitPlan, PlanEmitOptions, WiredSurface } from './cli/emit.js';
export { emitCommand, readEmitStatus, emitStatusLines, EMIT_ACTIONS } from './cli/commands/emit.js';
export type { EmitAction, EmitStatus, EmitCommandOptions } from './cli/commands/emit.js';
