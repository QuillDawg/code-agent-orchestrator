/** Reads a workflow YAML file, validates its raw shape and resolves the repository/launch directories. */
import { promises as fs, realpathSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { workflowFileSchema, type WorkflowFile } from './schema.js';
import { ConfigError } from '../util/errors.js';
import { Git } from '../workspace/git.js';
import { isInside, pathExists } from '../util/fs.js';
import { Redactor } from '../logging/redact.js';

export interface LoadedWorkflow {
  file: WorkflowFile;
  raw: string;
  configPath: string;
  launchDirectory: string;
  repositoryRoot: string;
  gitRoot?: string;
  /** Values merged from `environment` and `envFile` (runtime only, never persisted). */
  environment: Record<string, string>;
  /** Values treated as secrets for redaction. */
  secrets: string[];
}

export interface LoadOptions {
  /** Directory the CLI was launched from. Defaults to process.cwd(). */
  launchDirectory?: string;
  /** Explicit repository override (CLI flag). */
  repository?: string;
}

export function parseWorkflowText(raw: string, configPath = '<inline>'): WorkflowFile {
  let doc: unknown;
  try {
    doc = YAML.parse(raw, { prettyErrors: true });
  } catch (err) {
    throw new ConfigError(`Failed to parse YAML in ${configPath}: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ConfigError(`${configPath}: workflow file must be a YAML mapping`);
  }
  const parsed = workflowFileSchema.safeParse(doc);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new ConfigError(`Invalid workflow configuration in ${configPath}:\n${lines.join('\n')}`);
  }
  return parsed.data;
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Canonical absolute path (resolves symlinks and Windows 8.3 short names) when the path exists. */
export async function canonicalPath(p: string): Promise<string> {
  const resolved = path.resolve(p);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export async function loadWorkflow(configPathInput: string, opts: LoadOptions = {}): Promise<LoadedWorkflow> {
  const launchDirectory = await canonicalPath(opts.launchDirectory ?? process.cwd());
  const configPath = path.resolve(launchDirectory, configPathInput);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    // The errno text repeats the path and adds nothing a user can act on; say what is missing instead.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new ConfigError(`Workflow file not found: ${configPath}. Check the path, or omit it to use one of workflow.yaml, workflow.yml, cao.yaml in the current directory.`);
    if (code === 'EISDIR') throw new ConfigError(`${configPath} is a directory, not a workflow file. Name the YAML file itself.`);
    throw new ConfigError(`Cannot read workflow file ${configPath}: ${(err as Error).message}`);
  }
  const file = parseWorkflowText(raw, configPath);

  // Repository resolution: explicit flag > YAML `repository` (relative to launch dir) > launch dir.
  let repositoryRoot: string;
  const gitRootOfLaunch = await Git.topLevel(launchDirectory);
  if (opts.repository) {
    repositoryRoot = path.resolve(launchDirectory, opts.repository);
  } else if (file.repository) {
    repositoryRoot = path.resolve(launchDirectory, file.repository);
  } else {
    const strategy = file.execution?.workingDirectoryStrategy ?? 'repositoryRoot';
    repositoryRoot = strategy === 'repositoryRoot' && gitRootOfLaunch ? gitRootOfLaunch : launchDirectory;
  }
  if (!(await pathExists(repositoryRoot))) {
    throw new ConfigError(`Repository directory does not exist: ${repositoryRoot}`);
  }
  repositoryRoot = await canonicalPath(repositoryRoot);
  const gitRoot = (await Git.topLevel(repositoryRoot)) ?? undefined;

  const environment: Record<string, string> = {};
  const secrets: string[] = [];
  if (file.envFile) {
    const envPath = path.resolve(repositoryRoot, file.envFile);
    if (!isInside(repositoryRoot, envPath) && !isInside(launchDirectory, envPath)) {
      throw new ConfigError(`envFile must be inside the repository or launch directory: ${file.envFile}`);
    }
    let text: string;
    try {
      text = await fs.readFile(envPath, 'utf8');
    } catch (err) {
      throw new ConfigError(`Cannot read envFile ${envPath}: ${(err as Error).message}`);
    }
    for (const [k, v] of Object.entries(parseEnvFile(text))) {
      environment[k] = v;
      secrets.push(v);
    }
  }
  for (const [k, v] of Object.entries(file.environment ?? {})) {
    environment[k] = v;
    if (Redactor.isSecretKey(k)) secrets.push(v);
  }

  return { file, raw, configPath, launchDirectory, repositoryRoot, gitRoot, environment, secrets };
}
