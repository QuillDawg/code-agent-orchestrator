#!/usr/bin/env node
import { installCrashHandlers } from './cli/crash.js';
import { prepareInk } from './tui/ink-runtime.js';

installCrashHandlers();
// Before anything else loads Ink or React, which is why the CLI comes in below rather than as a static
// import: the bundler hoists every static import to the top of `dist/bin.js`, ahead of this line.
await prepareInk();

// A computed specifier, so the bundler leaves `main` as its own file (a tsup entry) instead of inlining it.
await import(new URL('./main.js', import.meta.url).href);
