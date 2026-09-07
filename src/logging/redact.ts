/** Secret redaction for logs and persisted artifacts. */

const SECRET_KEY_PATTERN = /(secret|token|password|passwd|api[_-]?key|private[_-]?key|credential|auth)/i;

const VALUE_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic keys
  /sk-[A-Za-z0-9_-]{20,}/g, // generic sk- keys
  /ghp_[A-Za-z0-9]{20,}/g, // GitHub PAT
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: Iterable<string> = []) {
    this.secrets = [...new Set([...secrets].filter((s) => typeof s === 'string' && s.length >= 6))].sort(
      (a, b) => b.length - a.length,
    );
  }

  static isSecretKey(key: string): boolean {
    return SECRET_KEY_PATTERN.test(key);
  }

  redact(text: string): string {
    if (!text) return text;
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join('[REDACTED]');
    for (const re of VALUE_PATTERNS) out = out.replace(re, '[REDACTED]');
    return out;
  }

  redactValue<T>(value: T): T {
    if (typeof value === 'string') return this.redact(value) as unknown as T;
    if (Array.isArray(value)) return value.map((v) => this.redactValue(v)) as unknown as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = Redactor.isSecretKey(k) && typeof v === 'string' ? '[REDACTED]' : this.redactValue(v);
      }
      return out as T;
    }
    return value;
  }
}

export const defaultRedactor = new Redactor();
