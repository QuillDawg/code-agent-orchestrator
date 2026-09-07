/**
 * Safe template substitution: `{{ dotted.path }}` lookups only.
 * No helpers, no expressions, no code evaluation. Unknown paths are reported, never silently emptied.
 */
import { isPlainObject } from '../util/misc.js';

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)\s*\}\}/g;

export interface RenderResult {
  text: string;
  missing: string[];
}

export function lookupPath(scope: Record<string, unknown>, dotted: string): unknown {
  const parts = dotted.split('.');
  let current: unknown = scope;
  for (const part of parts) {
    if (Array.isArray(current)) {
      const idx = Number(part);
      if (!Number.isInteger(idx)) return undefined;
      current = current[idx];
    } else if (isPlainObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, part)) return undefined;
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringify).join(', ');
  return JSON.stringify(value);
}

export function renderTemplate(template: string, scope: Record<string, unknown>): RenderResult {
  const missing: string[] = [];
  const text = template.replace(PLACEHOLDER, (whole, dotted: string) => {
    const value = lookupPath(scope, dotted);
    if (value === undefined) {
      missing.push(dotted);
      return whole;
    }
    return stringify(value);
  });
  return { text, missing: [...new Set(missing)] };
}

/** Extract every `{{path}}` referenced by a template (used by validation). */
export function templateReferences(template: string): string[] {
  const refs: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) refs.push(m[1] as string);
  return [...new Set(refs)];
}

/** Recursively render string values inside an object (used for task fields such as name/workingDirectory). */
export function renderDeep<T>(value: T, scope: Record<string, unknown>, missing: Set<string>): T {
  if (typeof value === 'string') {
    const r = renderTemplate(value, scope);
    r.missing.forEach((m) => missing.add(m));
    return r.text as unknown as T;
  }
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, scope, missing)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, scope, missing);
    return out as T;
  }
  return value;
}
