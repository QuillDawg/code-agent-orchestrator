/**
 * The package's own manifest, read once. `--version` needs the version and `cao doctor` needs
 * `engines.node`; both run from `src/` under tsx and from a bundled `dist/bin.js`, which sit at
 * different depths, so the manifest is looked for at each of them and identified by name rather
 * than by whichever `package.json` happens to be nearest.
 */
import { createRequire } from 'node:module';

export interface PackageInfo {
  version: string;
  /** The `engines.node` range, when the manifest declares one. */
  node?: string;
}

const FALLBACK: PackageInfo = { version: '0.0.0' };

let cached: PackageInfo | null = null;

export function packageInfo(): PackageInfo {
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  for (const rel of ['../package.json', '../../package.json', '../../../package.json']) {
    try {
      const pkg = require(rel) as { name?: string; version?: string; engines?: { node?: string } };
      if (pkg.name === 'code-agent-orchestrator' && pkg.version) {
        cached = { version: pkg.version, ...(pkg.engines?.node ? { node: pkg.engines.node } : {}) };
        return cached;
      }
    } catch {
      /* try next */
    }
  }
  cached = FALLBACK;
  return cached;
}
