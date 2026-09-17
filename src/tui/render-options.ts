/**
 * The options the workspace is mounted with (§2.5), and the one of them a user chooses: the alternate
 * screen [D4].
 *
 * `alternateScreen` is on by default, because a workspace that a run lives in should not shred the
 * scrollback of the terminal it was started from, and on quit the shell comes back exactly as it was with
 * the run summary printed into it. It is off with `--no-alt-screen`, with `CAO_ALT_SCREEN=0`, or with
 * `"altScreen": false` in `~/.cao/config.json` — in that order, so the flag on this invocation always beats
 * the environment and the environment always beats the file.
 *
 * The file is **read, never written, and only if it is already there**. `cao` with emit off has never
 * touched `~/.cao` and must not start now, so there is no create, no mkdir and no default file: a missing
 * one simply says nothing. It is read through the registry's own home resolution and path-shape check, so a
 * `CAO_HOME` that is refused for writing is not quietly trusted for reading either.
 */
import { readFileSync } from 'node:fs';
import type { RenderOptions } from 'ink';
import { caoHome, configFile, homeRefusal } from '../persistence/registry.js';
import { isPlainObject } from '../util/misc.js';

/** Terminals that do not answer the kitty query are left exactly as they were [D15]. */
export const BASE_RENDER_OPTIONS = {
  incrementalRendering: true,
  exitOnCtrlC: false,
  patchConsole: false,
  kittyKeyboard: { mode: 'auto' },
} as const satisfies Omit<RenderOptions, 'alternateScreen'>;

const OFF = new Set(['', '0', 'false', 'no', 'off']);

/** `~/.cao/config.json` as it is on disk, or null when there is no readable one. Never creates it. */
export function readUserConfig(home: string = caoHome()): Record<string, unknown> | null {
  if (homeRefusal(home) !== null) return null;
  let text: string;
  try {
    text = readFileSync(configFile(home), 'utf8');
  } catch {
    // Missing, unreadable, or a directory: all of them mean "the user has not said", and none of them is
    // worth a warning on the frame the workspace is about to draw.
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export interface AltScreenRequest {
  /** `--no-alt-screen` gives `false`; undefined means the user did not say on this invocation. */
  flag?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injected by tests; the default reads `~/.cao/config.json` if it already exists. */
  config?: () => Record<string, unknown> | null;
}

/** Whether to mount into the alternate screen [D4]. */
export function altScreenEnabled(request: AltScreenRequest = {}): boolean {
  if (request.flag !== undefined) return request.flag;
  const env = request.env ?? process.env;
  const fromEnv = env.CAO_ALT_SCREEN;
  if (fromEnv !== undefined) return !OFF.has(fromEnv.trim().toLowerCase());
  const stored = (request.config ?? (() => readUserConfig()))();
  if (stored && typeof stored.altScreen === 'boolean') return stored.altScreen;
  return true;
}

/** Every option the workspace is rendered with, `alternateScreen` resolved. */
export function workspaceRenderOptions(request: AltScreenRequest = {}): RenderOptions {
  return { ...BASE_RENDER_OPTIONS, alternateScreen: altScreenEnabled(request) };
}
