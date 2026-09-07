const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  d: 86_400_000,
};

/** Parse "60m", "1h30m", "90s", "1500ms" or a plain number (milliseconds). */
export function parseDuration(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error(`Invalid duration: ${input}`);
    return input;
  }
  const text = input.trim().toLowerCase();
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr|d)/g;
  let total = 0;
  let matched = '';
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    total += Number(m[1]) * (UNITS[m[2] as string] ?? 0);
    matched += m[0];
  }
  if (matched.replace(/\s+/g, '') !== text.replace(/\s+/g, '') || matched.length === 0) {
    throw new Error(`Invalid duration: "${input}" (use e.g. 30s, 10m, 1h30m)`);
  }
  return Math.round(total);
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}h ${mm}m ${ss}s` : `${mm}m ${ss}s`;
}

/**
 * Local `HH:MM:SS`, or `MM:SS` when `short` — the wall clock the user was watching, which is what every
 * other absolute time this tool prints uses. Timestamps are stored as UTC ISO strings; printing those
 * slices raw put the transcript hours away from `cao status` and `cao task` on any machine off UTC.
 */
export function formatClock(iso: string, short = false): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toTimeString().slice(0, 8);
  return short ? time.slice(3) : time;
}

/** Compact form for a cell that has no room for `00m 12s`: `12s`, `2m`, `1h04m`. */
export function formatDurationShort(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, '0')}m`;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Local wall-clock date and time: the one absolute format every command prints. */
export function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** How long ago something happened, in one unit: `42s ago`, `7m ago`, `3h ago`, `2d ago`. */
export function formatAge(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const seconds = Math.max(0, Math.floor((now - t) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Local date and time with the relative age beside it, as `cao status` and `cao task` both print it. */
export function formatWhen(iso: string, now = Date.now()): string {
  return `${formatLocal(iso)}  (${formatAge(iso, now)})`;
}
