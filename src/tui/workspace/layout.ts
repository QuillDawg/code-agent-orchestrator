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

/**
 * Columns between the sidebar and the panel: the rule, then a space.
 *
 * Two rather than one, because the panel's text would otherwise start in the column next to the rule; and
 * two rather than three, because the sidebar already pads its own last column, so the scrollbar and the
 * rule are separated without buying a third. Every column here is one the panel does not get.
 */
export const SIDEBAR_GUTTER = 2;

/** Fewer rows than this in the body and the rules are given up: a list with nothing in it is worse. */
const MIN_BODY_ROWS = 6;

/** Footer columns, most important first; the last ones are dropped as the terminal narrows. */
export type FooterColumn = 'shortcuts' | 'spend' | 'quota' | 'freshness';

export interface LayoutInput {
  columns: number;
  rows: number;
  /** Rows the header needs this frame: it grows a line when something is waiting for a human. */
  headerRows: number;
  /** A notice costs the footer a second line rather than pushing the body off the bottom. */
  notice: boolean;
  /**
   * Ink says a screen reader is attached: no rules at all (§3.2).
   *
   * The same reason the header collapses to one line. A reader announces the frame from the top on every
   * change, and a rule is a hundred-odd box-drawing characters read out on every one of them.
   */
  screenReader?: boolean;
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
  /** Rows spent on horizontal rules this frame, 0, 1 or 2; already deducted from `bodyRows`. */
  ruleRows: number;
  /** The rule under the tab bar, which carries the `teeDown` where the sidebar seam meets it. */
  topRule: boolean;
  /** The rule above the footer, with the `teeUp`. */
  bottomRule: boolean;
  /** Compact's single rule, between the one-line task strip and the panel; inside `bodyRows`. */
  stripRule: boolean;
  /** Columns the sidebar seam occupies, 0 when the sidebar is collapsed. */
  gutterColumns: number;
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
  // Provisional: the strip is given up below, on a terminal with only one body row to spend.
  const wantsStrip = compact ? 1 : 0;
  // A row spent on a rule is a row the panel does not get, so it is spent here or not at all (§2.5). Two on
  // a roomy terminal - under the tab bar and above the footer, so the body reads as one fenced region - and
  // one in compact, where it goes under the task strip instead: at 24 rows the panel cannot spare two, the
  // tab bar already says which tab is open, and the strip is the boundary a reader actually loses.
  const wanted = input.screenReader ? 0 : compact ? 1 : 2;
  const spare = rows - headerRows - tabRows - footerRows - wantsStrip - MIN_BODY_ROWS;
  const ruleRows = Math.max(0, Math.min(wanted, spare));
  const topRule = !compact && ruleRows > 0;
  const bottomRule = !compact && ruleRows > 1;
  const bodyRows = Math.max(1, rows - headerRows - tabRows - footerRows - (topRule ? 1 : 0) - (bottomRule ? 1 : 0));
  // With one row of body there is nothing to separate: the panel takes it, rather than the strip taking it
  // and the panel being floored to a second row the body does not have. `bodyRows` has its own floor of 1,
  // so without this the two together claimed two rows out of one and Ink clipped whichever came second.
  const stripRows = wantsStrip && bodyRows > 1 ? 1 : 0;
  const stripRule = compact && ruleRows > 0 && bodyRows > stripRows + 1;
  const gutterColumns = sidebarWidth ? SIDEBAR_GUTTER : 0;
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
    ruleRows,
    topRule,
    bottomRule,
    stripRule,
    gutterColumns,
    // The seam between the sidebar and the panel is charged to the panel, so the three add up to the frame.
    mainWidth: Math.max(20, columns - sidebarWidth - gutterColumns),
    mainRows: Math.max(1, bodyRows - stripRows - (stripRule ? 1 : 0)),
    footerColumns: footerColumnsFor(columns),
  };
}

/**
 * Which footer columns fit. Freshness goes first because it is the one a glance can do without — the
 * shortcuts are how the panel is used at all, and the quota chips are how a run is stopped before it runs
 * out (§3.2, §3.6).
 */
export function footerColumnsFor(columns: number): FooterColumn[] {
  // No width gate on the spend cell: `fitCells` already guarantees the way out survives, and a second
  // threshold on top of it would only hide the run's own number on a terminal that had room for it.
  const out: FooterColumn[] = ['shortcuts'];
  // The run's own spend needs a terminal with room for it *and* for the panel's keys. Below this the keys
  // win outright: a footer that traded "F / L follow" for a token count is the complaint, not the fix.
  if (columns >= COMPACT_COLUMNS) out.push('spend');
  if (columns >= 70) out.push('quota');
  if (columns >= COMPACT_COLUMNS) out.push('freshness');
  return out;
}
