import { describe, expect, it } from 'vitest';
import { contextWindowFor, supportsAutoMode, supportsEffort } from '../../src/runners/claude/models.js';
import { agentLabel, shortModelName } from '../../src/tui/format.js';

describe('contextWindowFor', () => {
  it('gives current Opus, Sonnet and Fable models the 1M window they ship with', () => {
    for (const m of ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5-1']) {
      expect(contextWindowFor(m), m).toBe(1_000_000);
    }
  });

  it('treats bare aliases as the current model in that family', () => {
    expect(contextWindowFor('opus')).toBe(1_000_000);
    expect(contextWindowFor('sonnet')).toBe(1_000_000);
    expect(contextWindowFor('fable')).toBe(1_000_000);
    expect(contextWindowFor('haiku')).toBe(200_000);
  });

  it('keeps 200K for Haiku and for models before 4.6', () => {
    for (const m of ['claude-haiku-4-5', 'claude-opus-4-5-20251101', 'claude-opus-4-1-20250805', 'claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022']) {
      expect(contextWindowFor(m), m).toBe(200_000);
    }
  });

  it('honours the legacy [1m] opt-in on older models', () => {
    expect(contextWindowFor('claude-sonnet-4-5-20250929[1m]')).toBe(1_000_000);
    expect(contextWindowFor('sonnet[1m]')).toBe(1_000_000);
  });

  it('understands Bedrock and Vertex ids', () => {
    expect(contextWindowFor('us.anthropic.claude-opus-4-6-v1:0')).toBe(1_000_000);
    expect(contextWindowFor('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-5@20251101')).toBe(200_000);
  });

  it('does not guess for unknown or missing models', () => {
    expect(contextWindowFor(undefined)).toBeUndefined();
    expect(contextWindowFor('gpt-5.6-terra')).toBeUndefined();
  });
});

describe('agent label', () => {
  it('shortens Claude model ids', () => {
    expect(shortModelName('claude-opus-5')).toBe('opus-5');
    expect(shortModelName('claude-sonnet-4-5-20250929')).toBe('sonnet-4-5');
    expect(shortModelName('opus')).toBe('opus');
    expect(shortModelName('gpt-5.6-terra')).toBe('gpt-5.6-terra');
    expect(shortModelName(undefined)).toBeUndefined();
  });

  it('pipes the model after the agent when it is known', () => {
    expect(agentLabel('claude', 'claude-opus-5')).toBe('claude|opus-5');
    expect(agentLabel('codex', 'gpt-5.6-terra')).toBe('codex|gpt-5.6-terra');
    expect(agentLabel('claude', undefined)).toBe('claude');
  });
});

describe('supportsEffort', () => {
  it('is false only for Haiku, the one family Claude Code documents no effort levels for', () => {
    for (const m of ['haiku', 'claude-haiku-4-5', 'claude-3-5-haiku-20241022', 'us.anthropic.claude-haiku-4-5-v1:0']) expect(supportsEffort(m), m).toBe(false);
    for (const m of ['opus', 'sonnet', 'fable', 'claude-opus-5', 'claude-sonnet-4-6', undefined]) expect(supportsEffort(m), String(m)).toBe(true);
  });
});

describe('supportsAutoMode', () => {
  it('matches the models Claude Code runs its classifier for: Sonnet 5, Opus 4.7 and later, Fable', () => {
    for (const m of ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-fable-5-1', 'claude-mythos-5-1', 'opus', 'sonnet', 'fable', undefined]) {
      expect(supportsAutoMode(m), String(m)).toBe(true);
    }
    for (const m of ['haiku', 'claude-haiku-4-5', 'claude-3-5-haiku-20241022', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'us.anthropic.claude-haiku-4-5-v1:0']) {
      expect(supportsAutoMode(m), m).toBe(false);
    }
    // not a Claude family we know: the CLI decides
    expect(supportsAutoMode('gpt-5.6-terra')).toBe(true);
  });
});
