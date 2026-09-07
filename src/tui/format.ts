/** Small number formatters shared by the dashboard and the CLI commands. */

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '-';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd)) return '-';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * How long one tool call took: `40ms`, `0.4s`, `12s`, `3m 04s`. Sub-second precision matters here because most
 * tool calls are fast and the point of the number is to make the slow one stand out.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 100) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** `opus-5` from `claude-opus-5`, `sonnet-4-5` from `claude-sonnet-4-5-20250929`; other agents' models pass through. */
export function shortModelName(model?: string): string | undefined {
  if (!model) return undefined;
  const short = model.replace(/^claude-/i, '').replace(/-\d{8}$/, '');
  return short || undefined;
}

/** `claude|opus-5` — the agent and, when known, the model it is actually running. */
export function agentLabel(agent: string, model?: string): string {
  const short = shortModelName(model);
  return short ? `${agent}|${short}` : agent;
}

/** Context utilisation 0..1, or undefined when unknown. */
export function contextRatio(usage?: { contextTokens?: number; contextWindow?: number }): number | undefined {
  if (!usage?.contextTokens || !usage.contextWindow) return undefined;
  return Math.min(1, usage.contextTokens / usage.contextWindow);
}

/** A fixed-width bar like `████░░░░`. */
export function bar(ratio: number, width: number): string {
  const filled = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}
