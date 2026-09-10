export const MINIMUM_AGENT_VERSIONS = { claude: '2.1.259', codex: '0.153.0' } as const;

function numericVersion(text: string): number[] | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}

/** Compare the first semantic-looking version in vendor-formatted output. */
export function versionAtLeast(actual: string | undefined, minimum: string): boolean | undefined {
  const have = actual ? numericVersion(actual) : undefined;
  const need = numericVersion(minimum);
  if (!have || !need) return undefined;
  for (let index = 0; index < Math.max(have.length, need.length); index++) {
    if ((have[index] ?? 0) !== (need[index] ?? 0)) return (have[index] ?? 0) > (need[index] ?? 0);
  }
  return true;
}
