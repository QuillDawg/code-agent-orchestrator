#!/usr/bin/env node
import { buildProgram } from './cli/program.js';
import { installCrashHandlers } from './cli/crash.js';

installCrashHandlers();

await buildProgram().parseAsync(process.argv);
