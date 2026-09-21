/**
 * One provider's quota, as the one line the footer has room for (spec §3.6).
 *
 * Pure text, so the wording is asserted on directly rather than through a rendered frame. Two rules:
 *
 * - **Nothing is invented.** The windows are the ones the provider reported, under the labels it chose
 *   `[D30]`; `cao` adds no category and assumes no window exists.
 * - **A state that has no number still says something.** `unavailable`, `authRequired` and `error` carry
 *   the reason, because "no number" and "0% left" look identical to a chip that only ever shows a
 *   percentage, and only one of them is worth doing something about.
 */
import type { QuotaSnapshot, QuotaWindow } from 'code-agent-orchestrator-protocol';
import { formatDurationShort } from '../../util/duration.js';
import { glyph } from '../../util/glyphs.js';
import { sanitizeText } from '../../cli/color.js';

/** What separates the parts of a chip; the same bullet the header and the hints use. */
const SEP = (): string => ` ${glyph('bullet')} `;

/** `14:05`, in the reader's own time zone, which is the only one a reset time means anything in. */
export function resetTime(iso: string, at: Date = new Date(iso)): string {
  if (Number.isNaN(at.getTime())) return '';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** One window: `5h 42%`, plus `resets 14:05` as its own part when the provider said when. */
export function quotaWindowCells(window: QuotaWindow): string[] {
  const used = `${window.label} ${Math.round(window.usedPercent)}%`;
  const resets = window.resetsAt ? resetTime(window.resetsAt) : '';
  return resets ? [used, `resets ${resets}`] : [used];
}

/**
 * The chip for one provider at `now`.
 *
 * `now` is passed rather than read so a frame and a test date the same snapshot the same way; the age it
 * produces is the whole of the `ok Xm ago` / `stale Xm ago` distinction.
 */
export function quotaChip(snapshot: QuotaSnapshot, now: number): string {
  const parts: string[] = [snapshot.provider];
  const reason = snapshot.reason ? sanitizeText(snapshot.reason) : '';
  // `authRequired` is the one state whose reason *is* the whole message: naming the state as well would
  // put a word in front of the sentence that says what to do about it (§3.6).
  if (snapshot.state === 'authRequired') return [...parts, reason || 'sign in for quotas'].join(SEP());
  if (snapshot.state === 'loading') return [...parts, 'loading'].join(SEP());

  if (snapshot.planType) parts.push(sanitizeText(snapshot.planType));
  for (const window of snapshot.windows) parts.push(...quotaWindowCells(window));

  if (snapshot.state === 'ok' || snapshot.state === 'stale') {
    const age = Math.max(0, now - Date.parse(snapshot.readAt));
    if (snapshot.state === 'stale') parts.push('stale');
    else parts.push('ok');
    parts.push(`${formatDurationShort(Number.isFinite(age) ? age : 0)} ago`);
  } else {
    parts.push(snapshot.state);
    if (reason) parts.push(reason);
  }
  return parts.join(SEP());
}

/**
 * Every chip the footer would draw, most worth the space first.
 *
 * A provider that reported windows leads, and the ones that never will follow, because the footer gives
 * its cells up from the right when the line is full (`fitCells`): without this the fixed Claude signpost
 * — which says the same thing on every frame forever — would push out the numbers somebody is watching.
 * Within each group the providers keep the order they reported in, so nothing jumps between frames.
 */
export function quotaChips(snapshots: readonly QuotaSnapshot[], now: number): string[] {
  const measured = snapshots.filter((snapshot) => snapshot.windows.length > 0);
  const rest = snapshots.filter((snapshot) => snapshot.windows.length === 0);
  return [...measured, ...rest].map((snapshot) => quotaChip(snapshot, now));
}
