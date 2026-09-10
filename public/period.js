// One date-range vocabulary and one shared state for every dashboard.
// The value is persisted in localStorage (not the URL) so it survives
// navigation and reload; storage failures fall back to an in-memory value.
//
// Analytics modules keep their own maths but derive from these tokens:
//   analytics.js       wants weeks as a string  -> String(periodWeeks(value) ?? 'all')
//   metrics-analytics  wants days               -> periodDays(value)

export const PERIODS = [
  ['4w', '4 weeks'],
  ['12w', '12 weeks'],
  ['26w', '26 weeks'],
  ['1y', '1 year'],
  ['all', 'All'],
];

export const DEFAULT_PERIOD = '12w';
export const STORAGE_KEY = 'corpus.period';

const WEEKS = { '4w': 4, '12w': 12, '26w': 26, '1y': 52, all: null };
const DAYS = { '4w': 28, '12w': 84, '26w': 182, '1y': 365, all: null };

let memory = DEFAULT_PERIOD;

/** True for a value in PERIODS. */
export function isPeriod(value) {
  return PERIODS.some(([key]) => key === value);
}

function storage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}

/** The shared range token; DEFAULT_PERIOD when nothing valid is stored. */
export function getPeriod() {
  try {
    const stored = storage()?.getItem(STORAGE_KEY);
    if (isPeriod(stored)) return stored;
  } catch {
    // Storage can throw in private windows; fall through to the memory value.
  }
  return memory;
}

/** Stores a valid range token and returns the effective value. */
export function setPeriod(value) {
  if (!isPeriod(value)) return getPeriod();
  memory = value;
  try {
    storage()?.setItem(STORAGE_KEY, value);
  } catch {
    // Persisting is best-effort; the in-memory value still applies.
  }
  return value;
}

/** Human label for the picker and for "vs previous <label>" copy. */
export function periodLabel(value) {
  return (PERIODS.find(([key]) => key === value) || PERIODS.find(([key]) => key === DEFAULT_PERIOD))[1];
}

/** Whole weeks in the range, or null for 'all'. */
export function periodWeeks(value) {
  return isPeriod(value) ? WEEKS[value] : WEEKS[DEFAULT_PERIOD];
}

/** Calendar days in the range, or null for 'all'. */
export function periodDays(value) {
  return isPeriod(value) ? DAYS[value] : DAYS[DEFAULT_PERIOD];
}

/** The value analytics.js expects: a week count as a string, or 'all'. */
export function analyticsPeriod(value = getPeriod()) {
  return String(periodWeeks(value) ?? 'all');
}
