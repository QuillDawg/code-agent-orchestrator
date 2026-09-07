export class OrchestratorError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'OrchestratorError';
    this.exitCode = exitCode;
  }
}

export class ConfigError extends OrchestratorError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'ConfigError';
  }
}

export class UsageError extends OrchestratorError {
  constructor(message: string) {
    super(message, 2);
    this.name = 'UsageError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
