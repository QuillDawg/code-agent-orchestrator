/**
 * `code-agent-orchestrator-protocol` — the contract between the `cao` CLI and CAO Desktop. Spec §4.1.
 *
 * Zero runtime dependencies, no Node builtins, browser-safe. Everything here is either a shape written to or
 * read from disk by both artifacts, or pure logic over one of those shapes that would otherwise be written a
 * second time. Nothing that touches a filesystem, a process or a terminal belongs in this package.
 */
export * from './protocol.js';
export * from './workflow.js';
export * from './result.js';
export * from './runner.js';
export * from './run.js';
export * from './events.js';
export * from './interaction.js';
export * from './transcript.js';
export * from './transcript-plan.js';
export * from './paths.js';
export * from './registry.js';
export * from './requests.js';
export * from './pending-interaction.js';
export * from './presence.js';
