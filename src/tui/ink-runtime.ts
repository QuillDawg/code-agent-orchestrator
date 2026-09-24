/**
 * Loading Ink so that a long-lived workspace does not grow its heap without limit.
 *
 * Two things in the rendering stack keep something for every frame drawn, and the workspace draws one every
 * 120 ms while a run is active. Left alone, a two-hour run reaches the V8 heap limit and the process dies
 * with "JavaScript heap out of memory". `prepareInk` deals with both, and `bin.ts` calls it before the rest
 * of the CLI is imported. Nothing here may statically import Ink or React, or anything that does.
 *
 * **React's development build.** With `NODE_ENV` unset, Ink loads the development reconciler, which records
 * a `performance.measure` entry per component per commit for the profiler's tracks. Node keeps every entry
 * on the global performance timeline until someone clears it, and nobody does. A shipped CLI wants the
 * production build anyway, so React and Ink are loaded once with `NODE_ENV=production`, and every later
 * import is served that same instance from the module cache. The variable is put back straight afterwards:
 * the agents this process spawns inherit its environment, and `NODE_ENV=production` would change what an
 * `npm install` in the operator's repository does. An operator who sets `NODE_ENV` themselves gets what
 * they asked for.
 *
 * **Ink's text caches.** `ink/build/measure-text.js` and `ink/build/wrap-text.js` each memoise on a module-level map keyed by the
 * full text of a `<Text>` node, and never evict. The workspace redraws every 120 ms while a run is active,
 * and nearly every frame carries a string it has never drawn before — a spinner frame, an elapsed time, a
 * new line of agent output — so both maps gain entries on every frame. Over a two-hour run that is
 * gigabytes, and the process dies with "JavaScript heap out of memory".
 *
 * Neither cache is exported, so nothing can clear them from outside. Instead a module-load hook rewrites
 * the two files as Ink loads them: each cache is emptied when it reaches its limit. The strings still on
 * screen are measured again on the next frame and cached afresh, so the cost is one re-measure per live
 * string every couple of thousand new ones.
 */
import module from 'node:module';

/**
 * Rewrite one of Ink's cache modules so its cache is emptied at 2000 entries (a frame draws a few dozen
 * strings, so that is many frames), or return `null` for any other file — or for one whose source no longer
 * has the shape this expects, in which case Ink loads untouched. A test pins the shape, so an Ink upgrade
 * that changes it fails there rather than quietly bringing the leak back.
 *
 * Self-contained and free of inner functions on purpose: the pre-22.15 fallback below ships it to the
 * loader thread as source text, where no bundler helper exists.
 */
export function boundInkCacheSource(url: string, source: string): string | null {
  const limit = 2000;
  let pairs: [string, string][];
  // Module URLs are file URLs, so the separator is always `/`, Windows included.
  if (/\/ink\/build\/measure-text\.js$/.test(url)) {
    pairs = [['cache.set(text, dimensions);', `if (cache.size >= ${limit}) cache.clear(); cache.set(text, dimensions);`]];
  } else if (/\/ink\/build\/wrap-text\.js$/.test(url)) {
    pairs = [
      ['const cache = {};', 'let cache = {}; let cacheSize = 0;'],
      ['cache[cacheKey] = wrappedText;', `if (cacheSize >= ${limit}) { cache = {}; cacheSize = 0; } cache[cacheKey] = wrappedText; cacheSize += 1;`],
    ];
  } else {
    return null;
  }
  let out = source;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) return null;
    out = out.replace(from, to);
  }
  return out;
}

let prepared: Promise<void> | undefined;

/** Bound Ink's caches and load React and Ink in production mode. Idempotent; call before anything imports `ink`. */
export function prepareInk(): Promise<void> {
  prepared ??= (async () => {
    boundInkCaches();
    const env = process.env.NODE_ENV;
    if (env === undefined) process.env.NODE_ENV = 'production';
    try {
      await Promise.all([import('react'), import('react/jsx-runtime'), import('ink')]);
    } finally {
      if (env === undefined) delete process.env.NODE_ENV;
    }
  })();
  return prepared;
}

/** Install the load hook that rewrites Ink's cache modules. Must run before Ink is first imported. */
function boundInkCaches(): void {
  const text = (source: unknown): string => (typeof source === 'string' ? source : Buffer.from(source as Uint8Array).toString('utf8'));
  // Node 22.15+: synchronous, in-thread hooks.
  const registerHooks = (module as { registerHooks?: (hooks: object) => unknown }).registerHooks;
  if (registerHooks) {
    registerHooks({
      load(url: string, context: object, nextLoad: (url: string, context: object) => { source?: unknown }) {
        const result = nextLoad(url, context);
        const bounded = result.source === undefined || result.source === null ? null : boundInkCacheSource(url, text(result.source));
        return bounded === null ? result : { ...result, source: bounded };
      },
    });
    return;
  }
  // Node 22.12–22.14: the same rewrite, run by an off-thread loader built from this module's own source.
  const loader = [
    `const boundInkCacheSource = ${boundInkCacheSource.toString()};`,
    'export async function load(url, context, nextLoad) {',
    '  const result = await nextLoad(url, context);',
    "  const text = typeof result.source === 'string' ? result.source : result.source ? Buffer.from(result.source).toString('utf8') : null;",
    '  const bounded = text === null ? null : boundInkCacheSource(url, text);',
    '  return bounded === null ? result : { ...result, source: bounded };',
    '}',
  ].join('\n');
  module.register(`data:text/javascript,${encodeURIComponent(loader)}`);
}
