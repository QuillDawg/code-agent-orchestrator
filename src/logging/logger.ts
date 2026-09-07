import { Redactor } from './redact.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  child(prefix: string): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  redactor?: Redactor;
  sink?: (line: string) => void;
  prefix?: string;
}

/** Logs to stderr (stdout is reserved for machine-readable output). */
export class ConsoleLogger implements Logger {
  private readonly level: number;
  private readonly redactor: Redactor;
  private readonly sink: (line: string) => void;
  private readonly prefix: string;

  constructor(opts: LoggerOptions = {}) {
    this.level = LEVELS[opts.level ?? 'info'];
    this.redactor = opts.redactor ?? new Redactor();
    this.sink = opts.sink ?? ((line) => process.stderr.write(`${line}\n`));
    this.prefix = opts.prefix ?? '';
  }

  private write(level: LogLevel, msg: string): void {
    if (LEVELS[level] < this.level) return;
    const ts = new Date().toTimeString().slice(0, 8);
    this.sink(this.redactor.redact(`${ts} ${level.padEnd(5)} ${this.prefix}${msg}`));
  }

  debug(msg: string): void {
    this.write('debug', msg);
  }
  info(msg: string): void {
    this.write('info', msg);
  }
  warn(msg: string): void {
    this.write('warn', msg);
  }
  error(msg: string): void {
    this.write('error', msg);
  }
  child(prefix: string): Logger {
    return new ConsoleLogger({
      level: (Object.keys(LEVELS) as LogLevel[]).find((k) => LEVELS[k] === this.level) ?? 'info',
      redactor: this.redactor,
      sink: this.sink,
      prefix: `${this.prefix}${prefix} `,
    });
  }
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
