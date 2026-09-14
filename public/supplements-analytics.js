// Pure helpers for the Supplements views: what is due today, how much was taken,
// adherence across a range, the calendar-strip cells and the package maths.
//
// Scheduled doses are assumed taken: the dose list the server returns already
// carries one row per scheduled slot and per logged session, so everything here
// counts rows rather than guessing. A skipped row (`amount: 0`) is the user
// saying they did not take that dose, and counts as a miss.
//
// No DOM, so `node --test` loads this module directly. Local dates are the
// `YYYY-MM-DD` keys the rest of the app uses (`localDateKey` from
// program-timeline.js), and weekdays are Monday-first (Mon = 0) to match
// `WEEKDAYS` in supplements-catalog.js.

import { DOSE_UNITS } from './supplements-catalog.js';
import { MISSING, formatNumber } from './format.js';
import { localDateKey } from './program-timeline.js';

const DAY_MS = 86_400_000;
const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A guard so a malformed range can never spin the day loop. */
const MAX_RANGE_DAYS = 3000;

function keyFromTime(time) {
  const date = new Date(time);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** UTC midnight for a real civil date key, or null. Calendar maths only. */
function parseKey(value) {
  const match = DAY_KEY.exec(String(value ?? ''));
  if (!match) return null;
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(time) && keyFromTime(time) === match[0] ? time : null;
}

function finite(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Today in the local calendar, as a date key. */
export function todayKey(now = new Date()) {
  return localDateKey(now instanceof Date ? now : new Date(now));
}

/** `2026-09-10` shifted by whole days; null when the key is not a real date. */
export function addDays(key, delta) {
  const time = parseKey(key);
  const step = finite(delta);
  if (time == null || step == null) return null;
  return keyFromTime(time + Math.round(step) * DAY_MS);
}

/** Every date key from `from` through `to`, inclusive; empty when reversed. */
export function dayKeys(from, to) {
  const start = parseKey(from);
  const end = parseKey(to);
  if (start == null || end == null || end < start) return [];
  const days = Math.min(Math.round((end - start) / DAY_MS), MAX_RANGE_DAYS);
  return Array.from({ length: days + 1 }, (_, index) => keyFromTime(start + index * DAY_MS));
}

/** Monday = 0 … Sunday = 6, matching `WEEKDAYS`; null for a bad key. */
export function weekdayIndex(key) {
  const time = parseKey(key);
  if (time == null) return null;
  return (new Date(time).getUTCDay() + 6) % 7;
}

/** The date a dose belongs to: its stored civil date, else the local date of `taken_at`. */
export function doseDate(dose) {
  if (DAY_KEY.test(String(dose?.date ?? ''))) return dose.date;
  return localDateKey(new Date(dose?.taken_at));
}

/** A skipped dose: the `0` override written when the user did not take one. */
export function isSkipped(dose) {
  return Boolean(dose?.skipped) || finite(dose?.amount) === 0;
}

/** A dose that counts as taken; a skipped row counts as a miss, never a dose. */
export function isCounted(dose) {
  return !isSkipped(dose) && (finite(dose?.amount) ?? 0) > 0;
}

/** The slot id of the `n`-th scheduled dose of a day: `YYYY-MM-DD:n`. */
export function slotKey(date, n = 0) {
  if (parseKey(date) == null) return null;
  const index = Math.max(0, Math.round(finite(n) ?? 0));
  return `${date}:${index}`;
}

/**
 * A row computed from the schedule or from a logged session. Derived rows have
 * synthetic ids and cannot be deleted; they are skipped with a `0` override.
 */
export function isDerived(dose) {
  const id = String(dose?.id ?? '');
  return id.startsWith('workout:') || id.startsWith('slot:');
}

function frequency(supplement) {
  const value = supplement?.frequency;
  return value && typeof value === 'object' ? value : { kind: 'daily' };
}

function perDay(supplement) {
  const value = Math.round(finite(frequency(supplement).per_day) ?? 1);
  return Math.min(6, Math.max(1, value));
}

function weekdays(supplement) {
  const list = frequency(supplement).weekdays;
  return Array.isArray(list) ? list.map((day) => finite(day)).filter((day) => day != null && day >= 0 && day <= 6) : [];
}

/** True while `key` is inside the supplement's active window (inclusive). */
export function isActiveOn(supplement, key) {
  const day = parseKey(key);
  const start = parseKey(supplement?.start_date);
  if (day == null || start == null || day < start) return false;
  const end = parseKey(supplement?.end_date);
  return end == null ? true : day <= end;
}

/**
 * How many doses the schedule expects on one day. `workoutCount` is the number
 * of sessions logged that day and only matters for the `workout` kind.
 */
export function expectedOnDay(supplement, key, workoutCount = 0) {
  if (!isActiveOn(supplement, key)) return 0;
  const kind = frequency(supplement).kind;
  if (kind === 'daily') return perDay(supplement);
  if (kind === 'weekly') return weekdays(supplement).includes(weekdayIndex(key)) ? 1 : 0;
  if (kind === 'workout') return Math.max(0, Math.round(finite(workoutCount) ?? 0));
  return 0;
}

/** Sessions per local date, from the workouts already in `state`. */
export function workoutsByDate(workouts) {
  const counts = new Map();
  for (const workout of Array.isArray(workouts) ? workouts : []) {
    const key = localDateKey(new Date(workout?.start_time));
    if (key) counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Is this supplement on today's list? `workoutsToday` is a session count or the
 * sessions themselves. `as_needed` is never due — it has its own sub-list.
 */
export function dueToday(supplement, today, workoutsToday = 0) {
  const count = Array.isArray(workoutsToday) ? workoutsToday.length : finite(workoutsToday) ?? 0;
  return expectedOnDay(supplement, today, count) > 0;
}

/** Doses actually taken for one supplement on one day; skipped rows do not count. */
export function takenToday(doses, supplementId, today) {
  return (Array.isArray(doses) ? doses : []).filter(
    (dose) => dose?.supplement_id === supplementId && doseDate(dose) === today && isCounted(dose),
  ).length;
}

/**
 * Newest first. Every slot of a day shares one `taken_at` (its local midnight),
 * so the slot id breaks the tie and keeps a day's doses in schedule order.
 */
function byRecency(a, b) {
  const time = String(b?.taken_at).localeCompare(String(a?.taken_at));
  return time !== 0 ? time : String(a?.slot ?? '').localeCompare(String(b?.slot ?? ''));
}

/** The doses of one supplement inside `[from, to]`, newest first. */
export function dosesInRange(doses, supplementId, from, to) {
  return (Array.isArray(doses) ? doses : [])
    .filter((dose) => {
      if (supplementId != null && dose?.supplement_id !== supplementId) return false;
      const date = doseDate(dose);
      return Boolean(date) && date >= from && date <= to;
    })
    .sort(byRecency);
}

/**
 * `{ expected, taken, ratio, days }` for one supplement over `[from, to]`.
 * `expected` only counts days inside the active window and `taken` is clamped
 * to it for the ratio; `ratio` is null when
 * nothing was expected (every `as_needed` supplement, and windows with no
 * scheduled day), so the views can show a count instead of a percentage.
 */
export function adherence(supplement, doses, { from, to, workouts = [] } = {}) {
  const counts = workoutsByDate(workouts);
  const days = dayKeys(from, to).filter((key) => isActiveOn(supplement, key));
  let expected = 0;
  for (const key of days) expected += expectedOnDay(supplement, key, counts.get(key) || 0);
  const taken = dosesInRange(doses, supplement?.id, from, to).filter(isCounted).length;
  // Manual doses on top of a schedule can push `taken` past `expected`; the
  // ratio is clamped so a card never reads more than 100%.
  const ratio = expected > 0 ? Math.min(taken, expected) / expected : null;
  return { expected, taken, ratio, days: days.length };
}

/**
 * One cell per day in `[from, to]`: `{ date, taken, expected }`. The strip reads
 * filled when `taken > 0`, outlined when a day expected a dose and none was
 * taken (missed, or skipped by hand), and blank otherwise.
 */
export function doseCalendar(supplement, doses, { from, to, workouts = [] } = {}) {
  const counts = workoutsByDate(workouts);
  const taken = new Map();
  for (const dose of dosesInRange(doses, supplement?.id, from, to)) {
    if (!isCounted(dose)) continue;
    const date = doseDate(dose);
    taken.set(date, (taken.get(date) || 0) + 1);
  }
  return dayKeys(from, to).map((date) => ({
    date,
    taken: taken.get(date) || 0,
    expected: expectedOnDay(supplement, date, counts.get(date) || 0),
  }));
}

/** Whole doses in one package, or null without a package size or dose amount. */
export function dosesPerPackage(supplement) {
  const size = finite(supplement?.package_size);
  const dose = finite(supplement?.dose_amount);
  if (size == null || dose == null || size <= 0 || dose <= 0) return null;
  return Math.floor(size / dose);
}

/** Doses per calendar day the schedule implies; measured for the free kinds. */
function dailyRate(supplement, usage) {
  const kind = frequency(supplement).kind;
  if (kind === 'daily') return perDay(supplement);
  if (kind === 'weekly') return weekdays(supplement).length / 7;
  const days = finite(usage?.days) ?? 0;
  if (days <= 0) return null;
  const doses = kind === 'workout' ? finite(usage?.expected) : finite(usage?.taken);
  return doses == null || doses <= 0 ? null : doses / days;
}

/**
 * How long a package lasts, in whole days. `workout` and `as_needed` have no
 * fixed schedule, so they need an `adherence()` result to measure the rate;
 * without one (or without a package size) the answer is null.
 */
export function packageDays(supplement, usage = null) {
  const perPackage = dosesPerPackage(supplement);
  if (perPackage == null || perPackage <= 0) return null;
  const rate = dailyRate(supplement, usage);
  if (rate == null || !(rate > 0)) return null;
  return Math.round(perPackage / rate);
}

/** `5 g`, `2 capsules`, `1 scoop`, `1,000 IU`; MISSING without an amount. */
export function formatDose(amount, unit) {
  const number = finite(amount);
  if (number == null) return MISSING;
  const entry = DOSE_UNITS.find((item) => item.key === unit);
  const fallback = String(unit ?? '').trim();
  const label = Math.abs(number) === 1 ? entry?.label ?? fallback : entry?.plural ?? fallback;
  return `${formatNumber(number, 2)} ${label}`.trim();
}

/** `[{ date, doses }]`, newest date first and newest dose first inside a day. */
export function groupByDate(doses) {
  const groups = new Map();
  for (const dose of Array.isArray(doses) ? doses : []) {
    const date = doseDate(dose);
    if (!date) continue;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(dose);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, list]) => ({ date, doses: list.sort(byRecency) }));
}
