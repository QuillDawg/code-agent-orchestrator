/**
 * How many rows and columns each part of the workspace gets, for one terminal size.
 *
 * Kept out of the components and away from React so it can be asserted on directly: "no frame is ever taller
 * than `rows`" (§2.5) is a property of these numbers, and a test that has to mount an Ink tree to check it
 * can only ever check the sizes it happened to render at.
 *
 * Every panel is sized from `useWindowSize()` and therefore from here; nothing in the workspace reads
 * `process.stdout.columns` for itself.
 */

/** Below this the sidebar is a one-line task strip and the footer starts shedding columns (§3.2). */
export const COMPACT_COLUMNS = 100;
/** Below this there are not enough rows to spend any of them on a column of task names. */
export const COMPACT_ROWS = 30;
/** The width the transcript viewer already calls narrow, so one terminal is compact everywhere or nowhere. */
export const NARROW_COLUMNS = 100;

/** Footer columns, most important first; the last ones are dropped as the terminal narrows. */
export type FooterColumn = 'shortcuts' | 'quota' | 'freshness';

export interface LayoutInput {
  columns: number;
  rows: number;
  /** Rows the header needs this frame: it grows a line when something is waiting for a human. */
  headerRows: number;
  /** A notice costs the footer a second line rather than pushing the body off the bottom. */
  notice: boolean;
}

export interface WorkspaceLayout {
  columns: number;
  rows: number;
  /** 80x24-class terminal: sidebar collapsed, footer shortened. */
  compact: boolean;
  /** The viewer's own threshold, for the surfaces that already shorten themselves at it. */
  narrow: boolean;
  headerRows: number;
  tabRows: number;
  footerRows: number;
  /** Columns the sidebar occupies, 0 when it is collapsed into the strip. */
  sidebarWidth: number;
  /** 1 while the sidebar is collapsed: the one-line task strip that replaces it. */
  stripRows: number;
  /** Rows between the tab bar and the footer, the strip included. */
  bodyRows: number;
  mainWidth: number;
  mainRows: number;
  footerColumns: FooterColumn[];
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export function workspaceLayout(input: LayoutInput): WorkspaceLayout {
  const columns = Math.max(20, Math.floor(input.columns) || 80);
  const rows = Math.max(6, Math.floor(input.rows) || 24);
  const compact = columns < COMPACT_COLUMNS || rows < COMPACT_ROWS;
  const headerRows = clamp(input.headerRows, 1, Math.max(1, rows - 4));
  const tabRows = 1;
  const footerRows = input.notice ? 2 : 1;
  const sidebarWidth = compact ? 0 : clamp(Math.round(columns * 0.3), 26, 38);
  const stripRows = compact ? 1 : 0;
  const bodyRows = Math.max(1, rows - headerRows - tabRows - footerRows);
  return {
    columns,
    rows,
    compact,
    narrow: columns < NARROW_COLUMNS,
    headerRows,
    tabRows,
    footerRows,
    sidebarWidth,
    stripRows,
    bodyRows,
    // One column of gap between the sidebar and the panel, so the two lists do not read as one table.
    mainWidth: Math.max(20, columns - (sidebarWidth ? sidebarWidth + 1 : 0)),
    mainRows: Math.max(1, bodyRows - stripRows),
    footerColumns: footerColumnsFor(columns),
  };
}

/**
 * Which footer columns fit. Freshness goes first because it is the one a glance can do without — the
 * shortcuts are how the panel is used at all, and the quota chips are how a run is stopped before it runs
 * out (§3.2, §3.6).
 */
export function footerColumnsFor(columns: number): FooterColumn[] {
  const out: FooterColumn[] = ['shortcuts'];
  if (columns >= 70) out.push('quota');
  if (columns >= COMPACT_COLUMNS) out.push('freshness');
  return out;
}
