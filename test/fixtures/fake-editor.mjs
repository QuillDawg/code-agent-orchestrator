#!/usr/bin/env node
/**
 * A `$VISUAL` / `$EDITOR` that needs no terminal: it rewrites the file it was given and exits.
 *
 * `Ctrl+O` in the composer and in the task editor hands the terminal over to a real editor through
 * `suspendTerminal()` and waits for it, so the only way to test the round trip end to end is to have an
 * editor that can run under vitest. What it writes is deterministic and unmistakable, so a test can tell
 * "the editor's text came back" from "the draft was left alone".
 *
 * `CAO_FAKE_EDITOR_TEXT` overrides what it writes; `CAO_FAKE_EDITOR_EXIT` makes it fail instead.
 */
import { promises as fs } from 'node:fs';

const file = process.argv[2];
const code = Number(process.env.CAO_FAKE_EDITOR_EXIT ?? '0');
if (!file) {
  process.stderr.write('fake-editor: no file to edit\n');
  process.exit(2);
}
if (code !== 0) process.exit(code);
const existing = await fs.readFile(file, 'utf8').catch(() => '');
const text = process.env.CAO_FAKE_EDITOR_TEXT ?? `${existing}\nedited by the fake editor`;
await fs.writeFile(file, text, 'utf8');
process.exit(0);
