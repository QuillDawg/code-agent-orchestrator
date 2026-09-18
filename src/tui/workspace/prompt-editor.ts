/**
 * `Ctrl+O` in the task editor: the prompt in `$VISUAL` / `$EDITOR` (spec §3.4).
 *
 * The opposite decision to `src/tui/dashboard/editor.ts`, and deliberately so. Opening a *file the run
 * touched* is a side errand — the run keeps going and a windowed editor opens beside it — but a prompt is
 * being edited *by* the form, which cannot continue until the editor has written it back. So this one waits,
 * and because it waits it can hand the terminal over properly: `suspendTerminal` puts the workspace off the
 * alternate screen and out of raw mode, `vim` gets a terminal of its own, and Ink repaints on the frame
 * after it exits.
 *
 * Never throws. Every failure is a sentence for the notice area, because a missing `$EDITOR` is not a reason
 * for the workspace to come down mid-edit.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { splitCommand } from '../../runners/claude/detect.js';
import { suspendTerminal } from '../terminal.js';
import { ulid } from '../../util/ulid.js';

export interface EditPromptResult {
  /** The prompt as the editor left it, or undefined when nothing came back and the draft stands. */
  text?: string;
  /** What the workspace says about it; always present, so the operator is never left guessing. */
  notice: string;
}

export interface EditPromptOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected by tests: runs the editor and returns its exit code without starting a process. */
  run?: (file: string, args: string[]) => Promise<number>;
  /** Injected by tests, so the terminal handover can be asserted without a TTY. */
  suspend?: typeof suspendTerminal;
  /** Where the scratch file goes; the OS temp directory by default. */
  directory?: string;
}

const defaultRun = async (file: string, args: string[]): Promise<number> => {
  const res = await execa(file, args, { stdio: 'inherit', reject: false, windowsHide: false });
  return res.exitCode ?? 1;
};

export async function editPromptExternally(prompt: string, opts: EditPromptOptions = {}): Promise<EditPromptResult> {
  const env = opts.env ?? process.env;
  const command = (env.VISUAL ?? env.EDITOR ?? '').trim();
  if (!command) {
    return { notice: 'Set $VISUAL or $EDITOR to write the prompt in an editor (e.g. EDITOR=vim); the form itself still takes typing.' };
  }
  const { file: program, args } = splitCommand(command);
  // `.md`, so an editor that colours by extension colours a prompt the way it is written.
  const scratch = path.join(opts.directory ?? os.tmpdir(), `cao-prompt-${ulid()}.md`);
  const suspend = opts.suspend ?? suspendTerminal;
  const run = opts.run ?? defaultRun;
  try {
    await fs.writeFile(scratch, prompt, 'utf8');
    const code = await suspend(() => run(program, [...args, scratch]));
    if (code !== 0) return { notice: `${path.basename(program)} exited ${code}; the prompt was left as it was.` };
    const text = await fs.readFile(scratch, 'utf8');
    if (text.trim() === '') return { notice: 'The editor came back with an empty prompt, so nothing was changed.' };
    return { text, notice: `Prompt taken from ${path.basename(program)}.` };
  } catch (err) {
    return { notice: `Could not edit the prompt in ${path.basename(program)}: ${(err as Error).message}` };
  } finally {
    await fs.rm(scratch, { force: true }).catch(() => undefined);
  }
}
