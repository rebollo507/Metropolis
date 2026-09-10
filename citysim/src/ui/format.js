/**
 * Formatting. Pure functions, no allocation beyond the string, deterministic —
 * the in-game calendar is derived from `world.time.day` and a fixed epoch, never
 * from the wall clock.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const EPOCH = Date.UTC(2026, 0, 1);   // day 0 of every city is 1 Jan 2026

export function n0(v) {
  if (!Number.isFinite(v)) return '—';
  return Math.round(v).toLocaleString('en-US');
}

export function n1(v) {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(1);
}

/** 1,284 · 12.9K · 4.2M — for values that must fit a fixed slot. */
export function compact(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v), sg = v < 0 ? '-' : '';
  if (a < 10000) return sg + Math.round(a).toLocaleString('en-US');
  if (a < 1e6) return `${sg}${(a / 1e3).toFixed(a < 1e5 ? 1 : 0)}K`;
  if (a < 1e9) return `${sg}${(a / 1e6).toFixed(1)}M`;
  return `${sg}${(a / 1e9).toFixed(1)}B`;
}

export function money(v) {
  if (!Number.isFinite(v)) return '—';
  return (v < 0 ? '-$' : '$') + compact(Math.abs(v)).replace('-', '');
}

/** Signed, for a delta beside a value. */
export function signed(v, fmt = compact) {
  if (!Number.isFinite(v)) return '—';
  const r = fmt(Math.abs(v));
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + r;
}

export function pct(v, digits = 0) {
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

/** 13.5 → "13:30" */
export function clock(hours) {
  if (!Number.isFinite(hours)) return '--:--';
  const h = ((hours % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** day index → { weekday:'Mon', date:'14 Mar 2026', short:'Mon 14 Mar' } */
export function calendar(day) {
  const d = new Date(EPOCH + (Number.isFinite(day) ? day : 0) * 86400000);
  const wd = DAYS[d.getUTCDay()];
  const dd = d.getUTCDate();
  const mo = MONTHS[d.getUTCMonth()];
  return {
    weekday: wd,
    date: `${dd} ${mo} ${d.getUTCFullYear()}`,
    short: `${wd} ${dd} ${mo}`,
    year: d.getUTCFullYear(),
    weekend: d.getUTCDay() === 0 || d.getUTCDay() === 6,
  };
}

/** metres → "1.2 km" / "340 m" */
export function dist(m) {
  if (!Number.isFinite(m)) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

/** A house-number + street name from a segment id and position along it. */
export function address(segmentId, t, cls) {
  if (segmentId === undefined || segmentId === null) return null;
  const num = 1 + 2 * Math.round(((t ?? 0.5) * 60));
  const name = streetName(segmentId, cls);
  return `${num} ${name}`;
}

const SUFFIX = { alley: 'Lane', lane2: 'Street', lane4: 'Avenue', boulevard: 'Boulevard', highway: 'Highway' };
const STEMS = [
  'Ash', 'Birch', 'Cedar', 'Dock', 'Elm', 'Foundry', 'Granite', 'Harbour', 'Ironside',
  'Juniper', 'Kingsway', 'Linden', 'Maple', 'Northgate', 'Orchard', 'Pier', 'Quarry',
  'Riverside', 'Saltmarsh', 'Tanner', 'Union', 'Vantage', 'Warehouse', 'Yardley',
];

/** Deterministic: the same segment always has the same name. */
export function streetName(segmentId, cls) {
  const id = Math.abs(segmentId | 0);
  const stem = STEMS[(id * 2654435761 >>> 0) % STEMS.length];
  return `${stem} ${SUFFIX[cls] || 'Street'}`;
}

export default { n0, n1, compact, money, signed, pct, clock, calendar, dist, address, streetName };
