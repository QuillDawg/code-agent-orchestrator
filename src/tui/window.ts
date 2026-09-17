/**
 * One windowing rule for every list in the workspace [D9].
 *
 * Ink lays out every child it is given, so a list that hands it two hundred rows draws two hundred rows and
 * the frame is taller than the terminal — which is the one thing §2.5 forbids, because it scrolls the screen
 * away and makes Ink 7 tear on Windows. Every list therefore slices itself to the rows it was given first,
 * and the slice is computed here rather than four times over: the sidebar, the Overview task table, the
 * review list and the task picker all ask this function the same question.
 *
 * What comes back is everything a list needs to be honest about what it is not showing: the slice, how many
 * rows are off screen in each direction, the `N more` markers to say so, and a scrollbar column with one
 * glyph per visible row so the position is readable at a glance (and without colour).
 */
import { glyph } from '../util/glyphs.js';

export interface WindowSlice<T> {
  /** Index of the first visible item. */
  start: number;
  /** Index after the last visible item. */
  end: number;
  items: T[];
  /** How many items sit above and below the slice. */
  above: number;
  below: number;
  /** `▲ 3 more` / `▼ 12 more`, or undefined when nothing is hidden that way. */
  aboveMarker?: string;
  belowMarker?: string;
  /** One glyph per visible row: the scrollbar column, thumb where the slice is. */
  scrollbar: string[];
}

export interface WindowOptions {
  /**
   * The start the list used last time, which turns the window from centring into scrolling: it stays put
   * until the cursor would leave it, and then moves by exactly the rows needed. Lists that keep no state
   * across renders omit it and get the centred window the dashboard has always drawn.
   */
  anchor?: number;
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/** The visible slice of `items` for `cursor`, at most `visibleRows` tall. */
export function windowOf<T>(items: readonly T[], cursor: number, visibleRows: number, options: WindowOptions = {}): WindowSlice<T> {
  const total = items.length;
  const size = Math.max(0, Math.floor(visibleRows));
  if (size === 0 || total === 0) return { start: 0, end: 0, items: [], above: 0, below: total, scrollbar: [] };

  const maxStart = Math.max(0, total - size);
  const position = clamp(Math.floor(cursor), 0, Math.max(0, total - 1));
  let start: number;
  if (options.anchor === undefined) {
    start = clamp(position - Math.floor(size / 2), 0, maxStart);
  } else {
    start = clamp(options.anchor, 0, maxStart);
    if (position < start) start = position;
    else if (position >= start + size) start = position - size + 1;
    start = clamp(start, 0, maxStart);
  }

  const end = Math.min(total, start + size);
  const above = start;
  const below = total - end;
  return {
    start,
    end,
    items: items.slice(start, end),
    above,
    below,
    aboveMarker: above > 0 ? `${glyph('scrollUp')} ${above} more` : undefined,
    belowMarker: below > 0 ? `${glyph('scrollDown')} ${below} more` : undefined,
    scrollbar: scrollbarColumn(total, start, end - start),
  };
}

/**
 * The scrollbar column for a slice: `size` glyphs, the thumb covering the proportion of the list on screen.
 * A list that fits is all thumb, which reads as "this is everything" rather than as a bar stuck at the top.
 */
export function scrollbarColumn(total: number, start: number, size: number): string[] {
  if (size <= 0) return [];
  const track = glyph('scrollTrack');
  const thumb = glyph('scrollThumb');
  if (total <= size) return Array.from({ length: size }, () => thumb);
  const thumbSize = clamp(Math.round((size / total) * size), 1, size);
  const maxStart = total - size;
  const thumbStart = clamp(Math.round((start / maxStart) * (size - thumbSize)), 0, size - thumbSize);
  return Array.from({ length: size }, (_, i) => (i >= thumbStart && i < thumbStart + thumbSize ? thumb : track));
}
