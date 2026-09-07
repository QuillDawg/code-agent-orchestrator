/**
 * `o` in the review view: hand the selected file to the user's editor.
 *
 * The dashboard owns this terminal for as long as the run lasts, so the editor is started detached with its
 * streams closed — a windowed editor (`code -g`, `subl`, `idea`) opens beside the run and the run keeps
 * going. A terminal editor cannot work that way: it would draw into a terminal Ink is repainting, so it is
 * named in a hint instead of being started invisibly.
 */
import path from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';

/** Editors that need to own the terminal. Matched on the command's basename, without a `.exe` suffix. */
const TERMINAL_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'pico', 'emacs', 'emacsclient', 'micro', 'kak', 'helix', 'hx', 'ne', 'joe']);

export interface OpenInEditorOptions {
  /** Directory the relative path is resolved against; the repository root in the dashboard. */
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** Injected by tests so nothing is actually started. */
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => { unref?: () => void };
}

/**
 * Start the editor for `file` and return the one line the dashboard shows about it. Never throws: a failure
 * to start is a notice, not an error that takes the dashboard down.
 */
export function openInEditor(file: string, opts: OpenInEditorOptions = {}): string {
  const env = opts.env ?? process.env;
  const command = (env.VISUAL ?? env.EDITOR ?? '').trim();
  const target = opts.root ? path.resolve(opts.root, file) : file;
  if (!command) return `Set $VISUAL or $EDITOR to open a file from here (e.g. EDITOR="code -g").`;

  // A command may carry its own flags ("code -g", "subl -n"); the first word is the program.
  const parts = command.split(/\s+/);
  const program = parts[0]!;
  const args = [...parts.slice(1), target];
  const name = path.basename(program).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
  if (TERMINAL_EDITORS.has(name)) {
    return `$${env.VISUAL ? 'VISUAL' : 'EDITOR'} is ${name}, which needs this terminal — the dashboard is using it. Run "${name} ${file}" elsewhere, or point $VISUAL at a windowed editor.`;
  }

  try {
    const child = (opts.spawnFn ?? spawn)(program, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    return `Opened ${file} in ${name}; the run keeps going.`;
  } catch (err) {
    return `Could not start ${name}: ${(err as Error).message}`;
  }
}
