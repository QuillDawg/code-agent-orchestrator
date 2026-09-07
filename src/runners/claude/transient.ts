/**
 * Classifies worker failures that are almost certainly temporary infrastructure problems rather than
 * something wrong with the task: API 5xx/overloaded/rate-limit responses and network drops. Claude Code in
 * print mode exits when such an error is not recovered by its own retries, so the orchestrator resumes the
 * session instead of counting the attempt as a real failure.
 */

const TRANSIENT_PATTERNS: RegExp[] = [
  /\bAPI Error:?\s*(?:5\d\d|429)\b/i,
  /\b(?:5\d\d|429)\b[^\n]{0,40}\b(?:internal server error|bad gateway|service unavailable|gateway time-?out|overloaded|too many requests)/i,
  /\binternal server error\b/i,
  /\bbad gateway\b/i,
  /\bservice unavailable\b/i,
  /\bgateway time-?out\b/i,
  /\boverloaded(?:_error)?\b/i,
  /\brate[ _-]?limit(?:ed|_error)?\b/i,
  /\btoo many requests\b/i,
  /\bapi_error\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|ECONNABORTED)\b/,
  /\bsocket hang up\b/i,
  /\bfetch failed\b/i,
  /\bnetwork error\b/i,
  /\bconnection (?:error|reset|closed|refused|timed out)\b/i,
  /\brequest timed out\b/i,
  /\bAPI (?:connection|request) (?:error|timeout|timed out)\b/i,
  /\bstream (?:error|closed|ended) unexpectedly\b/i,
  /\bmodel (?:is )?(?:currently )?(?:unavailable|overloaded)\b/i,
];

/** Errors that look transient on the surface but must never be retried automatically. */
const PERMANENT_PATTERNS: RegExp[] = [
  /\bAPI Error:?\s*(?:400|401|403|404|413|422)\b/i,
  /\b(?:invalid|expired) (?:api key|token|credentials)\b/i,
  /\bauthentication(?:_error)?\b/i,
  /\bpermission(?:_error| denied)\b/i,
  /\bbilling\b/i,
  /\binsufficient (?:credit|quota|funds)\b/i,
  /\bcontext (?:window|length) exceeded\b/i,
  /\bprompt is too long\b/i,
  /\bmax(?:imum)? (?:turns|budget)\b/i,
  /\bbudget exceeded\b/i,
];

/** True when the text describes a temporary API/network failure worth recovering from by resuming the session. */
export function isTransientApiError(text: string | undefined | null): boolean {
  if (!text) return false;
  if (PERMANENT_PATTERNS.some((re) => re.test(text))) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(text));
}
