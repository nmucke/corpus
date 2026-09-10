// One formatting vocabulary for the whole front end (numbers, durations,
// dates, loads and prescribed sets). Pure functions, no DOM, no imports, so
// tests and the server can load this module too.
//
// Absent values have one vocabulary:
//   MISSING          '—'                  a cell or number with no value
//   NOT_SET          'Not set'            a field the user has not filled in
//   NEVER_SYNCED     'Never synced'       a sync timestamp that never happened
//   MISSING_ROUTINE  'No longer in Hevy'  a broken reference
//
// Units live in labels ("Load (kg)", "Time (s)"), never in table cells.

export const LB_PER_KG = 2.2046226218;
export const MISSING = '—';
export const NOT_SET = 'Not set';
export const NEVER_SYNCED = 'Never synced';
export const MISSING_ROUTINE = 'No longer in Hevy';

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Locale number with at most `decimals` fraction digits; MISSING when absent. */
export function formatNumber(value, decimals = 0) {
  const number = finite(value);
  if (number == null) return MISSING;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format(number);
}

/** Abbreviated magnitude for cramped chart axes only: `7.5k`, `1.2m`. */
export function formatCompact(value) {
  const number = finite(value);
  if (number == null) return MISSING;
  const magnitude = Math.abs(number);
  if (magnitude >= 1_000_000) return `${formatNumber(number / 1_000_000, 1)}m`;
  if (magnitude >= 1000) return `${formatNumber(number / 1000, 1)}k`;
  return formatNumber(number);
}

/** Minutes as `7h 12m`; whole hours drop the minutes part. */
export function formatDuration(minutes) {
  const number = finite(minutes);
  if (number == null) return MISSING;
  const total = Math.round(number);
  const hours = Math.floor(Math.abs(total) / 60);
  const remainder = Math.abs(total) % 60;
  const sign = total < 0 ? '-' : '';
  if (!hours) return `${sign}${remainder}m`;
  return remainder ? `${sign}${hours}h ${remainder}m` : `${sign}${hours}h`;
}

/** Seconds as `90 s`. */
export function formatSeconds(seconds) {
  const number = finite(seconds);
  if (number == null) return MISSING;
  return `${formatNumber(number)} s`;
}

/** Formats a 'YYYY-MM-DD' key in the local calendar without timezone shifts. */
export function formatDay(key, options = { month: 'short', day: 'numeric' }) {
  const match = DAY_KEY.exec(String(key ?? ''));
  if (!match) return 'Unknown date';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

/** An ISO datetime (or Date) in the local calendar; 'Unknown date' when unparseable. */
export function dateLabel(value, options = { month: 'short', day: 'numeric' }) {
  if (value == null || value === '') return 'Unknown date';
  if (typeof value === 'string' && DAY_KEY.test(value)) return formatDay(value, options);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown date' : new Intl.DateTimeFormat(undefined, options).format(date);
}

/** Medium date plus short time, for sync timestamps and session starts. */
export function formatDateTime(value) {
  return dateLabel(value, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * A stopwatch reading for elapsed time inside a session: `12:30`, `1:02:30`.
 * Sub-minute resolution matters here, so this is not `formatDuration`.
 */
export function formatElapsed(ms) {
  const number = finite(ms);
  if (number == null) return MISSING;
  const total = Math.round(Math.abs(number) / 1000);
  const sign = number < 0 ? '-' : '';
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours ? `${sign}${hours}:${pad(minutes)}:${pad(seconds)}` : `${sign}${minutes}:${pad(seconds)}`;
}

/** A heart rate with its unit, for the trace readout (cells keep the unit in the header). */
export function formatBpm(value) {
  const number = finite(value);
  return number == null ? MISSING : `${formatNumber(number)} bpm`;
}

/** Kilograms in the display unit (no unit suffix — units belong in labels). */
export function convertKg(kg, unit = 'kg') {
  const number = finite(kg);
  if (number == null) return null;
  return unit === 'lb' ? number * LB_PER_KG : number;
}

/** A load in the display unit, at most one decimal; MISSING when absent. */
export function formatLoad(kg, unit = 'kg') {
  const converted = convertKg(kg, unit);
  return converted == null ? MISSING : formatNumber(converted, 1);
}

/** `3 sets` / `1 set`; the count is locale-formatted. */
export function plural(count, singular, plural = `${singular}s`) {
  const number = finite(count) ?? 0;
  return `${formatNumber(number)} ${Math.abs(number) === 1 ? singular : plural}`;
}

/**
 * One line describing a prescribed set: rep range or reps, load, time,
 * distance, RPE and a non-normal set type, joined with ' · '.
 * @param {{rep_range?:{start?:number,end?:number}, reps?:number, weight_kg?:number, duration_seconds?:number, distance_meters?:number, rpe?:number, type?:string}} set
 */
export function formatSet(set, unit = 'kg') {
  const parts = [];
  const range = set?.rep_range;
  if (range && typeof range === 'object') parts.push(`${range.start ?? MISSING}–${range.end ?? MISSING} reps`);
  else if (set?.reps != null) parts.push(`${formatNumber(set.reps)} reps`);
  if (set?.weight_kg != null) parts.push(`${formatLoad(set.weight_kg, unit)} ${unit}`);
  if (set?.duration_seconds != null) parts.push(formatSeconds(set.duration_seconds));
  if (set?.distance_meters != null) parts.push(`${formatNumber(set.distance_meters)} m`);
  if (set?.rpe != null) parts.push(`RPE ${formatNumber(set.rpe, 1)}`);
  if (set?.type && set.type !== 'normal') parts.push(String(set.type).replaceAll('_', ' '));
  return parts.join(' · ') || NOT_SET;
}
