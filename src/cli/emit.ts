// spec.md §4.2.3, §4.2.7, §5.4 — the emit switch, as a command applies it.
/**
 * `run` and `resume` share one question — *is this run announced?* — and §4.2.7 answers it in precedence
 * order: the per-invocation flag, then `CAO_EMIT`, then the persisted opt-in in `~/.cao/config.json`, then
 * off. This module is where that answer turns into `SchedulerDeps.emit`, which is **absent when emit is off**
 * — and with it absent the scheduler never touches `~/.cao` at all (§5.9).
 *
 * The other half is §4.2.3's rule about `capabilities`: the list is written from **what the run actually
 * wired up**, never from the `CAPABILITIES` constant. A run whose inbox failed to start does not claim it can
 * answer, and a build in which the inbox does not exist yet claims nothing at all.
 */
import { CAPABILITIES, type CapabilityToken } from 'code-agent-orchestrator-protocol';
import { emitFeedSetting, emitSetting, type EmitDecision } from '../persistence/registry.js';
import type { EmitAnnouncement } from '../workflow/scheduler.js';

/**
 * What a run has wired up by the time it announces itself. Facts, not tokens: the caller states what it
 * started, and `wiredCapabilities` says what that is called on the wire — so a later phase that wires the
 * request inbox turns one flag on here rather than deciding again what to advertise.
 *
 * Everything is optional and everything defaults to *not wired*, which is what makes the honest answer the
 * easy one.
 */
export interface WiredSurface {
  /** `watchRequests` is polling this run's `requests/` directory (§4.3.2, phase 4). */
  requests?: boolean;
  /**
   * The request kinds that watcher will act on — `stop`, `kill`, `answer`, `approve`, `restart` (§4.3.3).
   * Ignored unless `requests` is on: a kind nothing polls for is not a capability.
   */
  requestKinds?: readonly CapabilityToken[];
  /** Pending-interaction payloads are being written to `interactions/<uid>.json` (§4.4.2, phase 4). */
  interactions?: boolean;
  /** `canInteract` is gated on `~/.cao/presence/` (§4.6.2, phase 4). */
  presence?: boolean;
  /** The in-process feed is serving, and this is the URL that goes in the entry (§10.1, phase 7). */
  feedUrl?: string | null;
}

/** Sort tokens into `CAPABILITIES` order, so two runs that wired the same things write the same list. */
const ORDER = new Map<string, number>(CAPABILITIES.map((c, i) => [c as string, i]));

/**
 * §4.2.3 — the capability list for an entry, derived from what was wired.
 *
 * Today this is empty for every run `cao` starts: the registry writer announces a run, and nothing yet polls
 * `requests/`, writes interaction payloads or gates on presence. An empty list is the correct answer, not a
 * gap — §4.5's rule is that a surface enables each affordance by token, so a phase-2 run is shown and not
 * controlled, which is exactly what phase 2 promises (§7).
 */
export function wiredCapabilities(wired: WiredSurface = {}): CapabilityToken[] {
  const tokens = new Set<CapabilityToken>();
  if (wired.requests) {
    tokens.add('requests');
    for (const kind of wired.requestKinds ?? []) tokens.add(kind);
  }
  if (wired.interactions) tokens.add('interactions');
  if (wired.presence) tokens.add('presence');
  if (wired.feedUrl) tokens.add('feed');
  return [...tokens].sort((a, b) => (ORDER.get(a) ?? CAPABILITIES.length) - (ORDER.get(b) ?? CAPABILITIES.length));
}

export interface EmitPlan {
  /** The §4.2.7 outcome and the row that decided it. `cao emit status` prints the same pair. */
  decision: EmitDecision;
  /** `SchedulerDeps.emit`, or **undefined when emit is off** — absence is the off switch (§5.9). */
  announcement?: EmitAnnouncement;
  /** Advisories to print before the run starts. Empty in every ordinary invocation. */
  notes: string[];
}

export interface PlanEmitOptions {
  /** `--emit` / `--no-emit`; `undefined` when neither was given, which is what lets the rows below decide. */
  emit?: boolean;
  /** `--emit-feed`; reserved, and it warns rather than pretending (§10.1 is phase 7). */
  emitFeed?: boolean;
  wired?: WiredSurface;
  env?: NodeJS.ProcessEnv;
}

export async function planEmit(opts: PlanEmitOptions = {}): Promise<EmitPlan> {
  const env = opts.env ?? process.env;
  const decision = await emitSetting(opts.emit, env);
  const notes: string[] = [];
  const feed = emitFeedSetting(opts.emitFeed, env);
  if (feed.enabled) {
    notes.push(
      `${feed.source === 'env' ? 'CAO_EMIT_FEED' : '--emit-feed'} is reserved: this build serves no per-run feed, and this run does not advertise one.`,
    );
  }
  if (!decision.enabled) return { decision, notes };
  // The feed is deliberately not passed through: reserving the flag settles the grammar, and a `feedUrl` in
  // an entry would promise a surface something it can connect to (§4.2.3).
  return { decision, announcement: { capabilities: wiredCapabilities(opts.wired), feedUrl: null }, notes };
}
