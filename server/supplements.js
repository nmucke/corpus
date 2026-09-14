// Pure helpers for the Supplements module: validation, frequency labels,
// derived status, and the doses a schedule or a logged session implies, which
// are computed at read time instead of being written by a clock or during sync.
// A scheduled dose is assumed taken, so the stored rows are the exceptions: a
// manual dose, or an override that changes or removes one derived dose. No
// SQLite, no clock other than the `today` and `now` arguments, so demo and live
// data go through the same rules.
import { SUPPLEMENT_TYPE_KEYS, DOSE_UNIT_KEYS, FREQUENCY_KIND_KEYS, WEEKDAYS } from '../public/supplements-catalog.js';

const DAY_MS = 86_400_000;
const NAME_MAX = 120;
const BRAND_MAX = 120;
const TIMING_MAX = 100;
const MARKDOWN_MAX = 4000;
const NOTE_MAX = 200;
const URL_MAX = 2048;
const AMOUNT_MAX = 100_000;
const PER_DAY_MAX = 6;
// A dose may be logged slightly ahead of the laptop's clock (a phone entry, a
// clock skew) but never scheduled into the future.
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

// Standalone default so the module can be exercised without the service; the
// service injects its own `fail` so callers see a real ServiceError.
function throwValidation(code, message) { const error = new Error(message); error.code = code; throw error; }

const weekdayLabels = new Map(WEEKDAYS.map((day) => [day.key, day.label]));
const PER_DAY_WORDS = [null, 'Every day', 'Twice a day', 'Three times a day', 'Four times a day', 'Five times a day', 'Six times a day'];

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
// `Date.parse` rolls an impossible day over (2026-02-30 becomes 2026-03-02), so
// the round trip is what proves the civil date is real; the browser's calendar
// maths rejects those keys outright, and a stored one would never line up.
function isDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(value);
}
function dayMs(date) { return Date.parse(`${date}T00:00:00Z`); }
// Civil dates are compared as UTC midnights so a daylight-saving change can
// neither skip nor repeat a day, matching service.js.
function dayCount(from, to) { return Math.max(0, Math.floor((dayMs(to) - dayMs(from)) / DAY_MS) + 1); }
function weekdayOf(date) { return (new Date(dayMs(date)).getUTCDay() + 6) % 7; } // Monday = 0
// A calendar slot names the civil date and the 0-based dose of that day.
const SLOT_PATTERN = /^(\d{4}-\d{2}-\d{2}):(\d+)$/;
// Built from the civil parts so the instant is the laptop's midnight, the same
// calendar `localDate` reads back; a UTC midnight would land on the day before.
function localMidnight(date) { const [year, month, day] = date.split('-').map(Number); return new Date(year, month - 1, day).toISOString(); }

// Module-private: the laptop's civil date for a Date, the same rule service.js
// uses, and the civil date of an ISO instant (null when it does not parse).
function localDate(now) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
function instantDate(value) { const ms = Date.parse(value); return Number.isFinite(ms) ? localDate(new Date(ms)) : null; }

function text(value, max, name, fail, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') fail('validation', `${name} must be text.`);
  const result = value.trim();
  if (required && !result) fail('validation', `${name} is required.`);
  if (result.length > max) fail('validation', `${name} is too long.`);
  return result;
}

function positiveNumber(value, name, fail) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > AMOUNT_MAX) fail('validation', `${name} must be a number greater than 0 and at most ${AMOUNT_MAX}.`);
  return value;
}

function purchaseUrl(value, fail) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail('validation', 'Where to buy must be text.');
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > URL_MAX) fail('validation', 'Where to buy is too long.');
  let parsed = null;
  try { parsed = new URL(trimmed); } catch { parsed = null; }
  // Rejected, never silently dropped: a javascript: or ftp: link in a saved
  // record would otherwise reach the browser's Buy link.
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) fail('validation', 'Where to buy must be an http or https link.');
  return parsed.href;
}

function frequency(value, fail) {
  if (!isObject(value)) fail('validation', 'Frequency must be an object.');
  if (!FREQUENCY_KIND_KEYS.includes(value.kind)) fail('validation', 'Frequency is not supported.');
  if (value.kind === 'daily') {
    const perDay = value.per_day == null ? 1 : value.per_day;
    if (!Number.isInteger(perDay) || perDay < 1 || perDay > PER_DAY_MAX) fail('validation', `Times per day must be a whole number from 1 to ${PER_DAY_MAX}.`);
    return { kind: 'daily', per_day: perDay };
  }
  if (value.kind === 'weekly') {
    if (!Array.isArray(value.weekdays) || value.weekdays.length < 1 || value.weekdays.length > 7) fail('validation', 'Pick between one and seven weekdays.');
    for (const day of value.weekdays) if (!Number.isInteger(day) || day < 0 || day > 6) fail('validation', 'Weekdays must be whole numbers from 0 (Monday) to 6 (Sunday).');
    const weekdays = [...new Set(value.weekdays)].sort((a, b) => a - b);
    if (weekdays.length !== value.weekdays.length) fail('validation', 'Weekdays must not repeat.');
    return { kind: 'weekly', weekdays };
  }
  return { kind: value.kind };
}

/** Clean supplement row fields, or a validation failure. `today` fills in an absent start date. */
export function validateSupplement(body, { today, fail = throwValidation } = {}) {
  if (!isObject(body)) fail('validation', 'Supplement must be an object.');
  const name = text(body.name, NAME_MAX, 'Name', fail, true);
  const brand = text(body.brand, BRAND_MAX, 'Brand', fail);
  if (!SUPPLEMENT_TYPE_KEYS.includes(body.type)) fail('validation', 'Supplement type is not supported.');
  const dose_amount = positiveNumber(body.dose_amount, 'Dose amount', fail);
  if (!DOSE_UNIT_KEYS.includes(body.dose_unit)) fail('validation', 'Dose unit is not supported.');
  const freq = frequency(body.frequency, fail);
  const timing = text(body.timing, TIMING_MAX, 'Timing', fail);
  const start_date = body.start_date == null || body.start_date === '' ? today : body.start_date;
  if (!isDateString(start_date)) fail('validation', 'Start date must be a YYYY-MM-DD date.');
  let end_date = body.end_date == null || body.end_date === '' ? null : body.end_date;
  if (end_date !== null) {
    if (!isDateString(end_date)) fail('validation', 'End date must be a YYYY-MM-DD date.');
    if (end_date < start_date) fail('validation', 'End date cannot be before the start date.');
  }
  const package_size = body.package_size == null || body.package_size === '' ? null : positiveNumber(body.package_size, 'Package size', fail);
  return {
    name, brand, type: body.type, dose_amount, dose_unit: body.dose_unit, frequency: freq, timing,
    start_date, end_date, purchase_url: purchaseUrl(body.purchase_url, fail), package_size,
    ingredients: text(body.ingredients, MARKDOWN_MAX, 'Ingredients', fail),
    notes: text(body.notes, MARKDOWN_MAX, 'Notes', fail),
  };
}

/**
 * Clean stored dose fields for `supplement`. `now` is the fallback instant and
 * the future bound; `today` bounds a calendar slot. A row names at most one of
 * `workout_id` and `slot`; naming neither makes it a manual dose.
 */
export function validateDose(body, supplement, { now = new Date(), today = localDate(now), fail = throwValidation } = {}) {
  if (!isObject(body)) fail('validation', 'Dose must be an object.');
  const wantsWorkout = body.workout_id != null && body.workout_id !== '';
  const wantsSlot = body.slot != null && body.slot !== '';
  // The two are alternative names for the same dose, so a row carrying both
  // would be an override of two different things at once.
  if (wantsWorkout && wantsSlot) fail('validation', 'A dose belongs to a session or to a scheduled slot, not both.');
  let workout_id = null;
  if (wantsWorkout) {
    if (typeof body.workout_id !== 'string' || body.workout_id.length > 255) fail('validation', 'Workout id is invalid.');
    if (supplement?.frequency?.kind !== 'workout') fail('validation', 'Only a with-every-workout supplement can record a session dose.');
    workout_id = body.workout_id;
  }
  let slot = null; let slotDate = null;
  if (wantsSlot) {
    if (typeof body.slot !== 'string' || !SLOT_PATTERN.test(body.slot)) fail('validation', 'Slot must look like YYYY-MM-DD:n.');
    const kind = supplement?.frequency?.kind;
    if (kind !== 'daily' && kind !== 'weekly') fail('validation', 'Only a daily or weekly supplement has scheduled slots.');
    slotDate = SLOT_PATTERN.exec(body.slot)[1];
    // Asking the schedule itself keeps the window, the weekday, `per_day` and
    // the "never after today" rule in one place instead of re-deriving them.
    if (!isDateString(slotDate) || !scheduledDoses(supplement, { from: slotDate, to: slotDate, today }).some((dose) => dose.slot === body.slot)) fail('validation', 'That dose is not on the schedule.');
    slot = body.slot;
  }
  const takenAtValue = body.taken_at == null || body.taken_at === '' ? now.toISOString() : body.taken_at;
  if (typeof takenAtValue !== 'string') fail('validation', 'Taken at must be an ISO 8601 instant.');
  const ms = Date.parse(takenAtValue);
  if (!Number.isFinite(ms)) fail('validation', 'Taken at must be an ISO 8601 instant.');
  if (ms > now.getTime() + FUTURE_TOLERANCE_MS) fail('validation', 'Taken at cannot be in the future.');
  const amountValue = body.amount == null || body.amount === '' ? supplement?.dose_amount : body.amount;
  if (typeof amountValue !== 'number' || !Number.isFinite(amountValue) || amountValue < 0 || amountValue > AMOUNT_MAX) fail('validation', `Amount must be a number from 0 to ${AMOUNT_MAX}.`);
  // Zero is the "skipped" marker for one scheduled dose, so it is meaningless
  // without a session or a slot: a manual dose of nothing is a phantom row.
  if (amountValue === 0 && !workout_id && !slot) fail('validation', 'A manual dose must be greater than 0.');
  // A slot override stands for its own dose whatever the clock said when the
  // user removed it, so the stored instant is the slot's midnight.
  const takenAt = slot ? localMidnight(slotDate) : new Date(ms).toISOString();
  return { taken_at: takenAt, date: slot ? slotDate : instantDate(takenAt), amount: amountValue, workout_id, slot, note: text(body.note, NOTE_MAX, 'Note', fail) };
}

/** "Every day", "Twice a day", "Mon, Wed, Fri", "With every workout", "As needed". */
export function frequencyLabel(freq) {
  if (freq?.kind === 'daily') return PER_DAY_WORDS[freq.per_day] ?? `${freq.per_day} times a day`;
  if (freq?.kind === 'weekly') return (freq.weekdays ?? []).map((day) => weekdayLabels.get(day) ?? String(day)).join(', ');
  if (freq?.kind === 'workout') return 'With every workout';
  return 'As needed';
}

/** Derived from the active window: `upcoming` before it, `ended` after it, `active` inside. */
export function supplementStatus(supplement, today) {
  if (supplement?.start_date && supplement.start_date > today) return 'upcoming';
  if (supplement?.end_date && supplement.end_date < today) return 'ended';
  return 'active';
}

// An open-ended supplement has no upper bound here: `workouts` are logged
// sessions, so nothing later than today can match anyway.
function inWindow(supplement, date) {
  if (!date) return false;
  if (supplement.start_date && date < supplement.start_date) return false;
  if (supplement.end_date && date > supplement.end_date) return false;
  return true;
}

// Keyed by workout id or by slot, as a Map or a plain object.
function overrideFor(overrides, key) {
  if (!overrides) return null;
  return (overrides instanceof Map ? overrides.get(key) : overrides[key]) ?? null;
}

/**
 * Doses implied by logged sessions for a `workout` supplement. A stored row in
 * `overridesByWorkoutId` replaces the amount and note (and lends its own id so
 * the browser can delete it); it is never the source of the dose itself.
 */
export function workoutDoses(supplement, workouts = [], overridesByWorkoutId = null) {
  if (supplement?.frequency?.kind !== 'workout') return [];
  const rows = [];
  for (const workout of workouts ?? []) {
    const date = instantDate(workout?.start_time);
    if (!date || !inWindow(supplement, date)) continue;
    const override = overrideFor(overridesByWorkoutId, workout.id);
    const amount = override ? override.amount : supplement.dose_amount;
    rows.push({
      id: override ? override.id : `workout:${supplement.id}:${workout.id}`,
      supplement_id: supplement.id,
      taken_at: workout.end_time || workout.start_time,
      date,
      amount,
      workout_id: workout.id,
      slot: null,
      workout_title: workout.title ?? null,
      source: 'workout',
      skipped: amount === 0,
      note: override ? (override.note ?? '') : '',
    });
  }
  return rows;
}

/**
 * Doses a `daily` or `weekly` schedule implies in the scheduled window: the
 * active window clipped to [from, to] and to `today`, because a dose is assumed
 * taken and nothing can be assumed of a day that has not happened. A stored row
 * in `overridesBySlot` replaces the amount and note and lends its own id; it is
 * never the source of the dose. Newest day first, then the day's doses in order.
 */
export function scheduledDoses(supplement, { from, to, today } = {}, overridesBySlot = null) {
  const kind = supplement?.frequency?.kind;
  if ((kind !== 'daily' && kind !== 'weekly') || !isDateString(from) || !isDateString(to)) return [];
  const start = supplement.start_date && supplement.start_date > from ? supplement.start_date : from;
  let end = supplement.end_date && supplement.end_date < to ? supplement.end_date : to;
  if (isDateString(today) && today < end) end = today;
  if (end < start) return [];
  const perDay = kind === 'daily' ? (supplement.frequency.per_day ?? 1) : 1;
  const weekdays = kind === 'weekly' ? new Set(supplement.frequency.weekdays ?? []) : null;
  if (weekdays && !weekdays.size) return [];
  const rows = [];
  for (let index = dayCount(start, end) - 1; index >= 0; index -= 1) {
    const date = new Date(dayMs(start) + index * DAY_MS).toISOString().slice(0, 10);
    if (weekdays && !weekdays.has(weekdayOf(date))) continue;
    const taken_at = localMidnight(date);
    for (let n = 0; n < perDay; n += 1) {
      const slot = `${date}:${n}`;
      const override = overrideFor(overridesBySlot, slot);
      const amount = override ? override.amount : supplement.dose_amount;
      rows.push({
        id: override ? override.id : `slot:${supplement.id}:${date}:${n}`,
        supplement_id: supplement.id,
        taken_at,
        date,
        amount,
        workout_id: null,
        slot,
        workout_title: null,
        source: 'schedule',
        skipped: amount === 0,
        note: override ? (override.note ?? '') : '',
      });
    }
  }
  return rows;
}

/** Doses the schedule expects between `from` and `to` inclusive, clipped to the active window and to `today`. */
export function expectedDoses(supplement, { from, to, today, workouts = [] } = {}) {
  const kind = supplement?.frequency?.kind;
  if (!kind || kind === 'as_needed' || !isDateString(from) || !isDateString(to)) return 0;
  const start = supplement.start_date && supplement.start_date > from ? supplement.start_date : from;
  // Nothing is expected of a day that has not happened yet.
  const limit = isDateString(today) && today < to ? today : to;
  const end = supplement.end_date && supplement.end_date < limit ? supplement.end_date : limit;
  if (end < start) return 0;
  if (kind === 'daily') return dayCount(start, end) * (supplement.frequency.per_day ?? 1);
  if (kind === 'weekly') {
    const wanted = new Set(supplement.frequency.weekdays ?? []);
    if (!wanted.size) return 0;
    let count = 0;
    for (let index = 0; index < dayCount(start, end); index += 1) {
      if (wanted.has(weekdayOf(new Date(dayMs(start) + index * DAY_MS).toISOString().slice(0, 10)))) count += 1;
    }
    return count;
  }
  let count = 0;
  for (const workout of workouts ?? []) {
    const date = instantDate(workout?.start_time);
    if (date && date >= start && date <= end) count += 1;
  }
  return count;
}
