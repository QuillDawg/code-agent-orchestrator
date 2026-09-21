/**
 * How this machine is signed in to Codex, without starting anything (spec §3.7, the `quota` doctor check).
 *
 * Which of the two login modes is in force decides whether a quota read can succeed at all: the app-server
 * refuses `account/rateLimits/read` for API-key auth, which is `authRequired` in the footer and a warning in
 * `cao doctor`. Reading it from the files the CLI itself writes keeps the answer free — `codex login status`
 * is a process, and its wording is English prose nobody should parse.
 *
 * Never throws. An unreadable home, a relocated `CODEX_HOME` or a layout this does not recognise answers
 * `unknown`, which grades nothing.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { codexHome } from './session-file.js';
import type { AuthMode } from '../auth.js';

/** `auth.json` as far as this cares: a stored API key, or the OAuth tokens a ChatGPT sign-in leaves. */
interface CodexAuth {
  OPENAI_API_KEY?: unknown;
  tokens?: unknown;
}

/**
 * `apiKey` when a key is in the environment or stored in `auth.json`, `subscription` when the ChatGPT tokens
 * are there instead, `none` when neither is, `unknown` when the file cannot be read.
 *
 * The environment wins, because that is the order the CLI itself resolves them in: an `OPENAI_API_KEY` in
 * the shell is what the next `codex` invocation will use, whatever `auth.json` holds.
 */
export async function codexAuthMode(env: NodeJS.ProcessEnv = process.env): Promise<AuthMode> {
  if (env.OPENAI_API_KEY?.trim() || env.CODEX_API_KEY?.trim()) return 'apiKey';
  const file = path.join(codexHome(env), 'auth.json');
  // `ENOENT` is the only failure that is an answer: there is no `auth.json`, so nobody has signed in. A
  // permission denied, a `CODEX_HOME` that is not a directory, an I/O error — those are facts that could
  // not be established, and reporting them as a signed-out machine would put a verdict on a silence.
  const text = await fs.readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : undefined));
  if (text === undefined) return 'unknown';
  if (text === null) return 'none';
  let parsed: CodexAuth;
  try {
    parsed = JSON.parse(text) as CodexAuth;
  } catch {
    return 'unknown';
  }
  if (typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim()) return 'apiKey';
  if (parsed.tokens && typeof parsed.tokens === 'object') return 'subscription';
  return 'none';
}
