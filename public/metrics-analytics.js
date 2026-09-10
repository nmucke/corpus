// Pure helpers for the Metrics module: calendar-day math on 'YYYY-MM-DD'
// strings, gap filling, rolling means, and window summaries. No DOM, no
// imports, so the server and tests can load it too. Date arithmetic runs on
// UTC day ordinals so it never drifts across daylight-saving changes.

const DAY_MS = 24 * 60 * 60 * 1000;
const PERIODS = { '4w': 28, '12w': 84, '26w': 182, '1y': 365 };

function calendarParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= daysInMonth ? { year, month, day } : null;
}

function pad(value, width) { return String(value).padStart(width, '0'); }

function finite(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return typeof value !== 'boolean' && value !== null && value !== '' && Number.isFinite(number) ? number : null;
}

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }

/** Number of whole days since the Unix epoch for a valid 'YYYY-MM-DD' key, else null. */
export function dateOrdinal(key) {
  const parts = calendarParts(key);
  if (!parts) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return Math.round(date.getTime() / DAY_MS);
}

/** Inverse of dateOrdinal. */
export function ordinalDate(ordinal) {
  const date = new Date(ordinal * DAY_MS);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;
}

export function addDays(key, days) {
  const ordinal = dateOrdinal(key);
  return ordinal == null ? null : ordinalDate(ordinal + days);
}

/** Every day key from `from` to `to` inclusive; empty when the range is invalid or reversed. */
export function listDays(from, to) {
  const start = dateOrdinal(from), end = dateOrdinal(to);
  if (start == null || end == null || end < start) return [];
  const days = [];
  for (let ordinal = start; ordinal <= end; ordinal++) days.push(ordinalDate(ordinal));
  return days;
}

export function periodDays(period) { return PERIODS[period] || PERIODS['12w']; }

/** The `days`-long window that ends on `to` (inclusive). */
export function dateRange(to, days) {
  const length = Math.max(1, Math.floor(Number(days) || 1));
  return { from: addDays(to, -(length - 1)), to };
}

/** The window of equal length immediately before `from`..`to`. */
export function previousRange(from, to) {
  const start = dateOrdinal(from), end = dateOrdinal(to);
  if (start == null || end == null || end < start) return { from: null, to: null };
  const length = end - start + 1;
  return { from: ordinalDate(start - length), to: ordinalDate(start - 1) };
}

/** One entry per calendar day in the range; `value` is null on days without a finite point. */
export function fillDays(series, from, to) {
  const values = new Map();
  for (const point of Array.isArray(series) ? series : []) {
    const value = finite(point?.value);
    if (calendarParts(point?.date) && value != null) values.set(point.date, value);
  }
  return listDays(from, to).map((date) => ({ date, value: values.has(date) ? values.get(date) : null }));
}

/** Trailing mean over `window` days, aligned with `filled`; null when fewer than 3 points fall in the window. */
export function rollingMean(filled, window = 7) {
  const size = Math.max(1, Math.floor(window));
  return filled.map((_, index) => {
    const values = [];
    for (let cursor = Math.max(0, index - size + 1); cursor <= index; cursor++) {
      const value = filled[cursor]?.value;
      if (value != null) values.push(value);
    }
    return values.length >= 3 ? mean(values) : null;
  });
}

/** Window statistics; `change` is this window's mean minus the previous window's mean. */
export function summarize(filled, previousFilled = []) {
  const present = (Array.isArray(filled) ? filled : []).filter((point) => point?.value != null);
  const values = present.map((point) => point.value);
  const latest = present.length ? present[present.length - 1] : null;
  const current = mean(values);
  const previous = mean((Array.isArray(previousFilled) ? previousFilled : []).filter((point) => point?.value != null).map((point) => point.value));
  return {
    latest: latest ? latest.value : null,
    latestDate: latest ? latest.date : null,
    mean: current,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    count: values.length,
    change: current != null && previous != null ? current - previous : null,
  };
}

const STAGES = [['deep', 'sleep_deep_minutes'], ['light', 'sleep_light_minutes'], ['rem', 'sleep_rem_minutes'], ['awake', 'sleep_awake_minutes']];

/**
 * Per-date sleep rows from the stage series. `total` comes from `sleep_minutes`
 * and falls back to the stage sum when only stages were reported. Pass a range
 * to get a row for every day (nulls on days without sleep data).
 */
export function sleepStack(series, from, to) {
  const rows = new Map();
  const row = (date) => {
    if (!rows.has(date)) rows.set(date, { date, deep: null, light: null, rem: null, awake: null, total: null });
    return rows.get(date);
  };
  const read = (key, assign) => {
    for (const point of Array.isArray(series?.[key]) ? series[key] : []) {
      const value = finite(point?.value);
      if (calendarParts(point?.date) && value != null) assign(row(point.date), value);
    }
  };
  for (const [stage, key] of STAGES) read(key, (entry, value) => { entry[stage] = value; });
  read('sleep_minutes', (entry, value) => { entry.total = value; });
  for (const entry of rows.values()) {
    if (entry.total != null) continue;
    const stages = STAGES.map(([stage]) => entry[stage]).filter((value) => value != null);
    entry.total = stages.length ? stages.reduce((sum, value) => sum + value, 0) : null;
  }
  const dates = from && to ? listDays(from, to) : [...rows.keys()].sort();
  return dates.map((date) => rows.get(date) || { date, deep: null, light: null, rem: null, awake: null, total: null });
}

/** Mean value on days with a workout versus days without one. */
export function trainingDaySplit(filled, workoutDates) {
  const dates = workoutDates instanceof Set ? workoutDates : new Set(workoutDates || []);
  const training = [], rest = [];
  for (const point of Array.isArray(filled) ? filled : []) {
    if (point?.value == null) continue;
    (dates.has(point.date) ? training : rest).push(point.value);
  }
  return { training: mean(training), rest: mean(rest) };
}
