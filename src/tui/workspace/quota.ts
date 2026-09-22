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
import { formatTokens } from '../format.js';
import { glyph } from '../../util/glyphs.js';
import { sanitizeText } from '../../cli/color.js';

/** What separates the parts of a chip; the same bullet the header and the hints use. */
const SEP = (): string => ` ${glyph('bullet')} `;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number): string => String(n).padStart(2, '0');
const startOfDay = (at: Date): number => new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();

/**
 * When a window rolls over, in the reader's own time zone — which is the only one it means anything in.
 *
 * A bare `14:05` is right for the five-hour window and a lie for the weekly one: Codex's second window is
 * 10080 minutes, so the clock time it resets at is the same time of day a *week* from now, and the chip
 * read `7d 61% · resets 13:12` twelve minutes before 13:12. So the day comes too as soon as the reset is
 * not today, and past five days the clock time is dropped — at that distance the date is the answer and
 * the minute is noise, and a weekday alone would come round again.
 */
export function resetTime(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000);
  if (days === 0) return clock;
  if (days > 0 && days <= 5) return `${WEEKDAYS[at.getDay()]} ${clock}`;
  return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/**
 * One window: `5h 42%`, plus `resets 14:05` as its own part when the provider said when.
 *
 * A window whose limit is unknown says what was spent instead of a percentage. That is the whole of the
 * difference between a reading and an estimate on this line: `5h 42%` is a share of something the provider
 * named, `5h 10.9M` is a count of something `cao` added up, and the chip says which it is.
 */
export function quotaWindowCells(window: QuotaWindow, now: Date = new Date()): string[] {
  const used =
    window.usedPercent !== null
      ? `${window.label} ${Math.round(window.usedPercent)}%`
      : `${window.label} ${window.usedTokens !== undefined ? formatTokens(window.usedTokens) : '?'}`;
  const resets = window.resetsAt ? resetTime(window.resetsAt, now) : '';
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

  // Before the numbers, never after: the chip is one string in a `truncate-end` Text, so a line that runs
  // out of room loses its tail - and an estimate that has lost the word "est" is the dishonest half.
  if (snapshot.estimated) parts.push('est');
  if (snapshot.planType) parts.push(sanitizeText(snapshot.planType));
  for (const window of snapshot.windows) parts.push(...quotaWindowCells(window, new Date(now)));

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
