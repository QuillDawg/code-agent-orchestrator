/**
 * The CLI proper. `bin.ts` loads this dynamically, after it has installed what has to be in place before
 * any dependency loads (see `tui/ink-caches.ts`); nothing else should import it.
 */
import { buildProgram } from './cli/program.js';

await buildProgram().parseAsync(process.argv);
