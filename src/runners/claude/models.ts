/** Small facts about Claude models the CLI does not report until a session ends. */

const ONE_MILLION = 1_000_000;
const TWO_HUNDRED_K = 200_000;

/**
 * Live estimate of the context window in tokens for a model id or alias, or undefined when the model is not
 * a Claude model we know. The CLI reports the real figure in `result.modelUsage[].contextWindow`, which
 * replaces this estimate when the attempt finishes.
 *
 * Fable/Mythos and every Opus/Sonnet from 4.6 onwards ship with a 1M window by default. Haiku and the
 * models before 4.6 have 200K unless the legacy `[1m]` suffix opts into the 1M beta.
 */
export function contextWindowFor(model?: string): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (/\[1m\]|-1m\b/.test(m)) return ONE_MILLION;
  if (/fable|mythos/.test(m)) return ONE_MILLION;
  if (/haiku/.test(m)) return TWO_HUNDRED_K;
  if (!/opus|sonnet/.test(m)) return undefined;
  const version = modelVersion(m);
  if (version === undefined) return ONE_MILLION; // a bare alias such as `opus` resolves to the current model
  return version >= 4.6 ? ONE_MILLION : TWO_HUNDRED_K;
}

/**
 * `4.6` from `claude-opus-4-6`, `claude-opus-4-6-20260101`, `claude-3-7-sonnet-20250219` or
 * `us.anthropic.claude-sonnet-4-5-v1:0`; undefined for a bare alias. Date suffixes are not versions.
 */
function modelVersion(model: string): number | undefined {
  const tail = model.replace(/^.*?claude/, '');
  const match = /(?:^|\D)(\d{1,2})(?:[-.](\d{1,2}))?(?!\d)/.exec(tail);
  if (!match) return undefined;
  return Number(`${match[1]}.${match[2] ?? '0'}`);
}
