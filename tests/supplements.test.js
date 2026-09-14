import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createService } from '../server/service.js';
import { validateSupplement, validateDose, frequencyLabel, supplementStatus, workoutDoses, scheduledDoses, expectedDoses } from '../server/supplements.js';
import { adherence } from '../public/supplements-analytics.js';

const DAY_MS = 86_400_000;
const pad = (value) => String(value).padStart(2, '0');
const localDate = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
// Civil days relative to the laptop's calendar, so the same assertions hold in
// any timezone and across a daylight-saving change.
const day = (offset = 0) => { const now = new Date(); return localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)); };
const instant = (offset = 0, hour = 12) => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour).toISOString(); };
const localInstant = (offset, hour, minute) => { const now = new Date(); return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute).toISOString(); };
const spanDays = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
// The instant a derived dose carries: the laptop's midnight for that civil day.
const midnight = (date) => { const [year, month, dayOfMonth] = date.split('-').map(Number); return new Date(year, month - 1, dayOfMonth).toISOString(); };
const weekdayOf = (date) => (new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay() + 6) % 7; // Monday = 0
// Scheduled doses now fill the log, so the hand-logged rows are picked out.
const manual = (doses) => doses.filter((dose) => dose.source === 'manual');
const meta = (dataDir, key) => { const db = new DatabaseSync(path.join(dataDir, 'corpus.sqlite')); try { return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null; } finally { db.close(); } };
const setMeta = (dataDir, key, value) => { const db = new DatabaseSync(path.join(dataDir, 'corpus.sqlite')); try { db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(value, key); } finally { db.close(); } };

async function withService(t, fetchImpl = async () => { throw new Error('not called'); }) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-supplements-'));
  const service = await createService({ dataDir, fetchImpl });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { service, dataDir };
}

const creatine = (overrides = {}) => ({ name: 'Creatine monohydrate', brand: 'Bulk', type: 'creatine', dose_amount: 5, dose_unit: 'g', frequency: { kind: 'daily' }, start_date: day(-10), ...overrides });

// --- pure helpers ----------------------------------------------------------

test('validateSupplement enforces the schema limits and normalises the frequency', () => {
  const clean = validateSupplement(creatine({ brand: '  Bulk  ', timing: 'Morning', notes: 'Cheap', frequency: { kind: 'weekly', weekdays: [4, 0, 2] } }), { today: day() });
  assert.equal(clean.brand, 'Bulk', 'text fields are trimmed');
  assert.deepEqual(clean.frequency, { kind: 'weekly', weekdays: [0, 2, 4] }, 'weekdays are sorted');
  assert.equal(clean.end_date, null);
  assert.equal(clean.purchase_url, null);
  assert.equal(clean.package_size, null);
  assert.equal(clean.ingredients, '');
  assert.equal(validateSupplement(creatine({ start_date: undefined }), { today: day() }).start_date, day(), 'an absent start date defaults to today');
  assert.deepEqual(validateSupplement(creatine(), { today: day() }).frequency, { kind: 'daily', per_day: 1 });

  const rejected = [
    [creatine({ name: '' }), 'an empty name'],
    [creatine({ name: 'x'.repeat(121) }), 'a name over 120 chars'],
    [creatine({ brand: 'x'.repeat(121) }), 'a brand over 120 chars'],
    [creatine({ type: 'nootropic' }), 'an unknown type'],
    [creatine({ dose_unit: 'pinch' }), 'an unknown dose unit'],
    [creatine({ dose_amount: 0 }), 'a zero dose'],
    [creatine({ dose_amount: -5 }), 'a negative dose'],
    [creatine({ dose_amount: 100_001 }), 'a dose over the maximum'],
    [creatine({ dose_amount: '5' }), 'a dose that is not a number'],
    [creatine({ timing: 'x'.repeat(101) }), 'a timing over 100 chars'],
    [creatine({ ingredients: 'x'.repeat(4001) }), 'ingredients over 4000 chars'],
    [creatine({ notes: 'x'.repeat(4001) }), 'notes over 4000 chars'],
    [creatine({ start_date: '2026-13-02' }), 'an impossible start date'],
    // `Date.parse` would roll these over to a real day, so a shape-only check
    // stores a date the browser's calendar maths refuses to read back.
    [creatine({ start_date: '2026-02-30' }), 'a day that does not exist in that month'],
    [creatine({ start_date: '2025-02-29' }), 'a leap day in a common year'],
    [creatine({ start_date: day(-1), end_date: '2026-04-31' }), 'an impossible end date'],
    [creatine({ start_date: 'yesterday' }), 'a start date that is not YYYY-MM-DD'],
    [creatine({ start_date: day(-1), end_date: day(-2) }), 'an end date before the start date'],
    [creatine({ package_size: 0 }), 'a zero package size'],
    [creatine({ frequency: { kind: 'sometimes' } }), 'an unknown frequency kind'],
    [creatine({ frequency: { kind: 'daily', per_day: 7 } }), 'more than six doses a day'],
    [creatine({ frequency: { kind: 'daily', per_day: 1.5 } }), 'a fractional per_day'],
    [creatine({ frequency: { kind: 'weekly', weekdays: [] } }), 'an empty weekday list'],
    [creatine({ frequency: { kind: 'weekly', weekdays: [7] } }), 'a weekday outside 0-6'],
    [creatine({ frequency: { kind: 'weekly', weekdays: [1, 1] } }), 'repeated weekdays'],
  ];
  for (const [body, why] of rejected) assert.throws(() => validateSupplement(body, { today: day() }), { code: 'validation' }, why);
});

test('purchase_url accepts http and https and rejects every other scheme', () => {
  for (const url of ['http://example.com/creatine', 'https://example.com/creatine?ref=1']) {
    assert.equal(validateSupplement(creatine({ purchase_url: url }), { today: day() }).purchase_url, new URL(url).href);
  }
  for (const url of ['javascript:alert(1)', 'ftp://example.com/creatine', 'file:///etc/passwd', 'data:text/html,hi', 'not a url']) {
    assert.throws(() => validateSupplement(creatine({ purchase_url: url }), { today: day() }), { code: 'validation' }, url);
  }
  assert.equal(validateSupplement(creatine({ purchase_url: '' }), { today: day() }).purchase_url, null, 'an empty field is simply absent');
  assert.throws(() => validateSupplement(creatine({ purchase_url: `https://example.com/${'x'.repeat(2100)}` }), { today: day() }), { code: 'validation' });
});

test('validateDose defaults, bounds the future, and reserves zero for skipped sessions', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const supplement = { id: 's1', dose_amount: 5, frequency: { kind: 'daily', per_day: 1 } };
  const dose = validateDose({}, supplement, { now });
  assert.equal(dose.taken_at, now.toISOString());
  assert.equal(dose.amount, 5, 'the amount defaults to the supplement dose');
  assert.equal(dose.workout_id, null);
  assert.equal(dose.slot, null);
  assert.equal(dose.note, '');
  assert.equal(dose.date, localDate(now));
  assert.equal(validateDose({ taken_at: '2026-09-10T12:30:00.000Z' }, supplement, { now }).taken_at, '2026-09-10T12:30:00.000Z', 'a little clock skew is allowed');
  assert.throws(() => validateDose({ taken_at: '2026-09-10T14:00:00.000Z' }, supplement, { now }), { code: 'validation' }, 'more than an hour ahead');
  assert.throws(() => validateDose({ taken_at: 'later' }, supplement, { now }), { code: 'validation' });
  assert.throws(() => validateDose({ amount: -1 }, supplement, { now }), { code: 'validation' });
  assert.throws(() => validateDose({ amount: 0 }, supplement, { now }), { code: 'validation' }, 'zero is only a skipped session');
  assert.throws(() => validateDose({ note: 'x'.repeat(201) }, supplement, { now }), { code: 'validation' });
  assert.throws(() => validateDose({ workout_id: 'w1' }, supplement, { now }), { code: 'validation' }, 'only a workout supplement takes a session id');
  const linked = { id: 's2', dose_amount: 2, frequency: { kind: 'workout' } };
  assert.deepEqual(validateDose({ workout_id: 'w1', amount: 0 }, linked, { now }), { taken_at: now.toISOString(), date: localDate(now), amount: 0, workout_id: 'w1', slot: null, note: '' });
});

test('validateDose takes a calendar slot only where the schedule generates one', () => {
  const now = new Date('2026-03-04T09:00:00.000Z');
  const options = { now, today: '2026-03-04' };
  // 2026-03-02 is a Monday.
  const daily = { id: 's1', dose_amount: 5, frequency: { kind: 'daily', per_day: 2 }, start_date: '2026-03-02', end_date: null };
  const weekly = { id: 's2', dose_amount: 1, frequency: { kind: 'weekly', weekdays: [0] }, start_date: '2026-03-01', end_date: null };
  const skipped = validateDose({ slot: '2026-03-03:1', amount: 0 }, daily, options);
  // Whatever the clock said when the user removed it, the row stands for its own dose.
  assert.deepEqual(skipped, { taken_at: midnight('2026-03-03'), date: '2026-03-03', amount: 0, workout_id: null, slot: '2026-03-03:1', note: '' });
  assert.equal(validateDose({ slot: '2026-03-04:0', taken_at: '2026-03-04T08:00:00.000Z' }, daily, options).taken_at, midnight('2026-03-04'), 'the body instant is ignored for a slot');
  assert.equal(validateDose({ slot: '2026-03-02:0' }, weekly, options).amount, 1, 'a listed weekday is on the schedule');

  const rejected = [
    [{ slot: '2026-03-03' }, daily, 'a slot without the dose number'],
    [{ slot: 'today:0' }, daily, 'a slot that is not a date'],
    [{ slot: '2026-02-30:0' }, daily, 'a day that does not exist in that month'],
    [{ slot: '2026-03-03:2' }, daily, 'a dose number at or above per_day'],
    [{ slot: '2026-03-05:0' }, daily, 'a day after today'],
    [{ slot: '2026-03-01:0' }, daily, 'a day before the start date'],
    [{ slot: '2026-03-03:0' }, { ...daily, end_date: '2026-03-02' }, 'a day after the end date'],
    [{ slot: '2026-03-03:0' }, weekly, 'a weekday the schedule does not list'],
    [{ slot: '2026-03-02:1' }, weekly, 'a second dose on a weekly schedule'],
    [{ slot: '2026-03-03:0' }, { ...daily, frequency: { kind: 'workout' } }, 'a slot on a workout supplement'],
    [{ slot: '2026-03-03:0' }, { ...daily, frequency: { kind: 'as_needed' } }, 'a slot on an as-needed supplement'],
    [{ slot: '2026-03-03:0', workout_id: 'w1' }, daily, 'a session and a slot at once'],
    [{ slot: '2026-03-03:0', workout_id: 'w1' }, { ...daily, frequency: { kind: 'workout' } }, 'a session and a slot on a workout supplement'],
    [{ slot: '2026-03-03:0', amount: -1 }, daily, 'a negative amount'],
  ];
  for (const [body, supplement, why] of rejected) assert.throws(() => validateDose(body, supplement, options), { code: 'validation' }, why);
});

test('frequencyLabel and supplementStatus read the way the cards and exports do', () => {
  assert.equal(frequencyLabel({ kind: 'daily', per_day: 1 }), 'Every day');
  assert.equal(frequencyLabel({ kind: 'daily', per_day: 2 }), 'Twice a day');
  assert.equal(frequencyLabel({ kind: 'daily', per_day: 6 }), 'Six times a day');
  assert.equal(frequencyLabel({ kind: 'weekly', weekdays: [0, 2, 4] }), 'Mon, Wed, Fri');
  assert.equal(frequencyLabel({ kind: 'workout' }), 'With every workout');
  assert.equal(frequencyLabel({ kind: 'as_needed' }), 'As needed');
  assert.equal(supplementStatus({ start_date: '2026-09-11' }, '2026-09-10'), 'upcoming');
  assert.equal(supplementStatus({ start_date: '2026-09-10' }, '2026-09-10'), 'active');
  assert.equal(supplementStatus({ start_date: '2026-01-01', end_date: '2026-09-10' }, '2026-09-10'), 'active', 'the end date is inclusive');
  assert.equal(supplementStatus({ start_date: '2026-01-01', end_date: '2026-09-09' }, '2026-09-10'), 'ended');
});

test('workoutDoses derives one dose per session and lets an override replace it', () => {
  const supplement = { id: 's1', dose_amount: 2, dose_unit: 'scoop', frequency: { kind: 'workout' }, start_date: '2026-09-01', end_date: null };
  // Local datetimes, not UTC instants: 17:00Z on 2026-08-31 is already 2026-09-01
  // east of UTC+7, which would put the first session inside the window there.
  const workouts = [
    { id: 'w1', title: 'Lower', start_time: '2026-08-31T17:00:00', end_time: '2026-08-31T18:00:00' },
    { id: 'w2', title: 'Upper', start_time: '2026-09-02T17:00:00', end_time: '2026-09-02T18:00:00' },
    { id: 'w3', title: 'Pull', start_time: '2026-09-03T17:00:00', end_time: null },
    { id: 'w4', title: 'Broken', start_time: null, end_time: null },
  ];
  const plain = workoutDoses(supplement, workouts);
  assert.deepEqual(plain.map((dose) => dose.workout_id), ['w2', 'w3'], 'sessions before the start date and without a start time are skipped');
  assert.deepEqual(plain[0], { id: 'workout:s1:w2', supplement_id: 's1', taken_at: '2026-09-02T18:00:00', date: '2026-09-02', amount: 2, workout_id: 'w2', slot: null, workout_title: 'Upper', source: 'workout', skipped: false, note: '' });
  assert.equal(plain[1].taken_at, '2026-09-03T17:00:00', 'a session with no end time falls back to its start');

  const overrides = new Map([['w2', { id: 'stored-1', amount: 3, note: 'Double scoop' }], ['w3', { id: 'stored-2', amount: 0, note: '' }], ['gone', { id: 'stale', amount: 0, note: '' }]]);
  const overridden = workoutDoses(supplement, workouts, overrides);
  assert.deepEqual(overridden[0], { id: 'stored-1', supplement_id: 's1', taken_at: '2026-09-02T18:00:00', date: '2026-09-02', amount: 3, workout_id: 'w2', slot: null, workout_title: 'Upper', source: 'workout', skipped: false, note: 'Double scoop' });
  assert.equal(overridden[1].id, 'stored-2');
  assert.equal(overridden[1].skipped, true, 'a zero override is a skipped session');
  assert.equal(overridden.length, 2, 'an override whose workout is gone matches nothing');
  assert.deepEqual(workoutDoses({ ...supplement, frequency: { kind: 'daily', per_day: 1 } }, workouts), [], 'only workout supplements derive session doses');
  assert.deepEqual(workoutDoses({ ...supplement, end_date: '2026-09-02' }, workouts).map((dose) => dose.workout_id), ['w2'], 'the window closes on the end date');
});

test('scheduledDoses fills the window with assumed doses and lets an override replace one', () => {
  const daily = { id: 's1', dose_amount: 5, frequency: { kind: 'daily', per_day: 2 }, start_date: '2026-03-02', end_date: null };
  const rows = scheduledDoses(daily, { from: '2026-03-01', to: '2026-03-31', today: '2026-03-04' });
  assert.deepEqual(rows.map((dose) => dose.slot), ['2026-03-04:0', '2026-03-04:1', '2026-03-03:0', '2026-03-03:1', '2026-03-02:0', '2026-03-02:1'], 'newest day first, each day in order, and never past today');
  assert.deepEqual(rows.at(-2), { id: 'slot:s1:2026-03-02:0', supplement_id: 's1', taken_at: midnight('2026-03-02'), date: '2026-03-02', amount: 5, workout_id: null, slot: '2026-03-02:0', workout_title: null, source: 'schedule', skipped: false, note: '' });
  assert.deepEqual(scheduledDoses(daily, { from: '2026-03-03', to: '2026-03-03', today: '2026-03-31' }).map((dose) => dose.slot), ['2026-03-03:0', '2026-03-03:1'], 'the requested range clips the window');
  assert.deepEqual(scheduledDoses({ ...daily, end_date: '2026-03-03' }, { from: '2026-03-01', to: '2026-03-31', today: '2026-03-31' }).map((dose) => dose.date), ['2026-03-03', '2026-03-03', '2026-03-02', '2026-03-02'], 'the end date closes the window');
  assert.deepEqual(scheduledDoses(daily, { from: '2026-03-01', to: '2026-03-31', today: '2026-03-01' }), [], 'nothing before the start date');
  assert.deepEqual(scheduledDoses({ ...daily, frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-03-01', to: '2026-03-31', today: '2026-03-03' }).map((dose) => dose.slot), ['2026-03-03:0', '2026-03-02:0']);
  for (const kind of ['workout', 'as_needed']) {
    assert.deepEqual(scheduledDoses({ ...daily, frequency: { kind } }, { from: '2026-03-01', to: '2026-03-31', today: '2026-03-04' }), [], `${kind} supplements derive no calendar doses`);
  }

  // 2026-03-02 is a Monday, so Monday and Thursday are the 2nd, 5th, 9th and 12th.
  const weekly = { id: 's2', dose_amount: 1, frequency: { kind: 'weekly', weekdays: [0, 3] }, start_date: '2026-03-01', end_date: null };
  assert.deepEqual(scheduledDoses(weekly, { from: '2026-03-01', to: '2026-03-14', today: '2026-03-31' }).map((dose) => dose.slot), ['2026-03-12:0', '2026-03-09:0', '2026-03-05:0', '2026-03-02:0'], 'one dose per listed weekday');
  assert.deepEqual(scheduledDoses(weekly, { from: '2026-03-01', to: '2026-03-14', today: '2026-03-06' }).map((dose) => dose.slot), ['2026-03-05:0', '2026-03-02:0'], 'still never past today');

  const overrides = new Map([['2026-03-03:1', { id: 'stored-1', amount: 0, note: 'Forgot' }], ['2026-03-02:1', { id: 'stored-2', amount: 2, note: '' }], ['2026-03-09:0', { id: 'stale', amount: 0, note: '' }]]);
  const overridden = scheduledDoses(daily, { from: '2026-03-01', to: '2026-03-31', today: '2026-03-04' }, overrides);
  assert.equal(overridden.length, 6, 'an override outside the window matches nothing and adds no row');
  assert.deepEqual(overridden.find((dose) => dose.slot === '2026-03-03:1'), { id: 'stored-1', supplement_id: 's1', taken_at: midnight('2026-03-03'), date: '2026-03-03', amount: 0, workout_id: null, slot: '2026-03-03:1', workout_title: null, source: 'schedule', skipped: true, note: 'Forgot' });
  const changed = overridden.find((dose) => dose.slot === '2026-03-02:1');
  assert.deepEqual([changed.id, changed.amount, changed.skipped], ['stored-2', 2, false], 'a changed amount is not a skip');
});

test('expectedDoses counts each frequency kind across a window and a DST change', () => {
  const window = { start_date: '2026-03-01', end_date: null };
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-03-01', to: '2026-03-07' }), 7);
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'daily', per_day: 3 } }, { from: '2026-03-01', to: '2026-03-07' }), 21);
  // Europe and the US both change clocks inside this range; civil days are
  // counted, so neither is skipped nor doubled.
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-03-01', to: '2026-04-01' }), 32);
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-10-01', to: '2026-11-30' }), 61);
  // 2026-03-02 is a Monday.
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'weekly', weekdays: [0, 2, 4] } }, { from: '2026-03-02', to: '2026-03-08' }), 3);
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'weekly', weekdays: [0] } }, { from: '2026-03-02', to: '2026-03-29' }), 4);
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'weekly', weekdays: [6] } }, { from: '2026-03-02', to: '2026-03-08' }), 1, 'weekday 6 is Sunday');
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'as_needed' } }, { from: '2026-03-01', to: '2026-12-31' }), 0);
  // A dose is assumed taken, so nothing is expected of a day that has not happened.
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'daily', per_day: 2 } }, { from: '2026-03-01', to: '2026-03-31', today: '2026-03-05' }), 10);
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'weekly', weekdays: [0] } }, { from: '2026-03-02', to: '2026-03-29', today: '2026-03-10' }), 2);
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-03-01', to: '2026-03-31', today: '2026-02-01' }), 0, 'a window that has not started expects nothing');
  const workouts = [{ start_time: '2026-03-02T17:00:00Z' }, { start_time: '2026-03-04T17:00:00Z' }, { start_time: '2026-02-01T17:00:00Z' }];
  assert.equal(expectedDoses({ ...window, frequency: { kind: 'workout' } }, { from: '2026-03-01', to: '2026-03-31', workouts }), 2);
  // The active window clips the requested range from both ends.
  assert.equal(expectedDoses({ start_date: '2026-03-05', end_date: '2026-03-08', frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-03-01', to: '2026-03-31' }), 4);
  assert.equal(expectedDoses({ start_date: '2026-04-01', end_date: null, frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-03-01', to: '2026-03-31' }), 0);
});

test('the server and the browser expect the same number of doses for one window', () => {
  // The cards and History read `adherence()` in the browser while the service
  // and the export read `expectedDoses()`; a drift between them would show the
  // user two different denominators for the same supplement.
  const workouts = [{ start_time: '2026-03-02T17:00:00' }, { start_time: '2026-03-04T17:00:00' }, { start_time: '2026-02-01T17:00:00' }];
  const cases = [
    [{ start_date: '2026-03-01', end_date: null, frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-03-01', to: '2026-04-01' }],
    [{ start_date: '2026-03-01', end_date: null, frequency: { kind: 'daily', per_day: 3 } }, { from: '2026-03-01', to: '2026-03-07' }],
    [{ start_date: '2026-03-05', end_date: '2026-03-08', frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-03-01', to: '2026-03-31' }],
    [{ start_date: '2026-03-01', end_date: null, frequency: { kind: 'weekly', weekdays: [0, 2, 4] } }, { from: '2026-03-02', to: '2026-03-29' }],
    [{ start_date: '2026-03-01', end_date: null, frequency: { kind: 'weekly', weekdays: [6] } }, { from: '2026-03-02', to: '2026-03-08' }],
    [{ start_date: '2026-03-01', end_date: null, frequency: { kind: 'as_needed' } }, { from: '2026-03-01', to: '2026-03-31' }],
    [{ start_date: '2026-03-01', end_date: null, frequency: { kind: 'workout' } }, { from: '2026-03-01', to: '2026-03-31', workouts }],
    [{ start_date: '2026-04-01', end_date: null, frequency: { kind: 'daily', per_day: 1 } }, { from: '2026-03-01', to: '2026-03-31' }],
    // Both sides count civil days, so the spring and autumn clock changes agree.
    [{ start_date: '2026-01-01', end_date: null, frequency: { kind: 'daily', per_day: 2 } }, { from: '2026-03-25', to: '2026-04-02' }],
    [{ start_date: '2026-01-01', end_date: null, frequency: { kind: 'daily', per_day: 2 } }, { from: '2026-10-20', to: '2026-11-05' }],
  ];
  for (const [supplement, range] of cases) {
    assert.equal(expectedDoses(supplement, range), adherence({ id: 's1', ...supplement }, [], range).expected, JSON.stringify([supplement.frequency, range.from, range.to]));
  }
});

// --- service ---------------------------------------------------------------

test('supplements are created, updated, ordered, and scoped to the active mode', async (t) => {
  const { service } = await withService(t);
  const saved = await service.saveSupplement(creatine({ purchase_url: 'https://example.com/creatine', package_size: 500, timing: 'Morning with breakfast' }));
  assert.match(saved.id, /^[0-9a-f-]{36}$/);
  assert.equal(saved.status, 'active');
  assert.equal(saved.frequency_label, 'Every day');
  assert.deepEqual(saved.frequency, { kind: 'daily', per_day: 1 });
  assert.deepEqual(service.getState().supplements, [saved]);

  const later = await service.saveSupplement(creatine({ name: 'Vitamin D', type: 'vitamin', dose_unit: 'iu', dose_amount: 1000, start_date: day(3) }));
  const ended = await service.saveSupplement(creatine({ name: 'Ashwagandha', type: 'herbal', start_date: day(-40), end_date: day(-1) }));
  const active = await service.saveSupplement(creatine({ name: 'Beta-alanine', type: 'amino_acid' }));
  assert.equal(later.status, 'upcoming');
  assert.equal(ended.status, 'ended');
  assert.deepEqual(service.getState().supplements.map((row) => row.name), ['Beta-alanine', 'Creatine monohydrate', 'Vitamin D', 'Ashwagandha'], 'active then upcoming then ended, each by name');

  const updated = await service.saveSupplement({ ...creatine({ name: 'Creatine', dose_amount: 3 }), id: saved.id });
  assert.equal(updated.id, saved.id);
  assert.equal(updated.created_at, saved.created_at, 'an update keeps the creation time');
  assert.equal(updated.dose_amount, 3);
  await assert.rejects(service.saveSupplement({ ...creatine(), id: 'missing' }), { code: 'not_found', status: 404 });
  assert.deepEqual((await service.deleteSupplement(active.id)), { id: active.id, deleted: true });
  await assert.rejects(service.deleteSupplement(active.id), { code: 'not_found', status: 404 });

  await service.setDemo(false);
  assert.deepEqual(service.getState().supplements, [], 'live mode starts empty');
  assert.deepEqual(service.getSupplementDoses({ days: 730 }).doses, []);
  await assert.rejects(service.deleteSupplement(saved.id), { code: 'not_found', status: 404 }, 'a demo supplement is invisible in live mode');
  await service.setDemo(true);
  assert.equal(service.getState().supplements.length, 3);
});

test('doses log, cascade, clamp the range, and come back newest first', async (t) => {
  const { service } = await withService(t);
  const supplement = await service.saveSupplement(creatine({ start_date: day(-30) }));
  const first = await service.logDose(supplement.id, { taken_at: instant(-2, 9) });
  const second = await service.logDose(supplement.id, { taken_at: instant(-1, 9), amount: 2.5, note: 'Half scoop' });
  const third = await service.logDose(supplement.id, {});
  assert.deepEqual(first.dose, { id: first.dose.id, supplement_id: supplement.id, taken_at: instant(-2, 9), date: day(-2), amount: 5, unit: 'g', workout_id: null, slot: null, workout_title: null, source: 'manual', skipped: false, note: '' });
  assert.equal(second.dose.amount, 2.5);
  assert.equal(second.dose.note, 'Half scoop');

  const listed = service.getSupplementDoses({ days: 90 });
  assert.equal(listed.mode, 'demo');
  assert.equal(listed.range.to, day());
  assert.equal(spanDays(listed.range.from, listed.range.to), 90);
  assert.deepEqual(manual(listed.doses).map((dose) => dose.id), [third.dose.id, second.dose.id, first.dose.id], 'newest first');

  assert.equal(spanDays(...Object.values(service.getSupplementDoses({ days: 1 }).range)), 7, 'days clamps up to 7');
  assert.equal(spanDays(...Object.values(service.getSupplementDoses({ days: 9999 }).range)), 730, 'days clamps down to 730');
  assert.equal(manual(service.getSupplementDoses({ days: 7 }).doses).length, 3, 'the range filters by civil date');
  assert.equal(spanDays(...Object.values(service.getSupplementDoses().range)), 90, 'the default is 90 days');

  assert.deepEqual(await service.deleteDose(second.dose.id), { id: second.dose.id, deleted: true });
  assert.equal(manual(service.getSupplementDoses({ days: 90 }).doses).length, 2);
  await assert.rejects(service.deleteDose(second.dose.id), { code: 'not_found', status: 404 });
  await assert.rejects(service.logDose('missing', {}), { code: 'not_found', status: 404 });

  await service.deleteSupplement(supplement.id);
  assert.deepEqual(service.getSupplementDoses({ days: 730 }).doses, [], 'doses and their schedule cascade with the supplement');
});

test('a dose taken late in the evening is filed under its local civil date', async (t) => {
  const { service } = await withService(t);
  const supplement = await service.saveSupplement(creatine({ start_date: day(-3) }));
  // 23:30 local is a different UTC day west of Greenwich and 00:30 local is one
  // east of it, so a UTC-derived date would move either dose to the wrong day.
  const late = await service.logDose(supplement.id, { taken_at: localInstant(-1, 23, 30) });
  const early = await service.logDose(supplement.id, { taken_at: localInstant(0, 0, 30) });
  assert.equal(late.dose.date, day(-1), 'a 23:30 dose belongs to that evening, not the next UTC day');
  assert.equal(early.dose.date, day(), 'a 00:30 dose belongs to that morning, not the previous UTC day');
  assert.deepEqual(manual(service.getSupplementDoses({ days: 7 }).doses).map((dose) => dose.date), [day(), day(-1)]);
});

test('doses are scoped through their supplement, so neither mode can write the other', async (t) => {
  const { service } = await withService(t);
  const demo = await service.saveSupplement(creatine());
  const demoDose = await service.logDose(demo.id, {});
  await service.setDemo(false);
  const live = await service.saveSupplement(creatine({ name: 'Live creatine' }));
  const liveDose = await service.logDose(live.id, {});
  // `supplement_doses` has no mode column: both writes have to reach the mode
  // through the parent supplement or demo and live data would mix.
  await assert.rejects(service.logDose(demo.id, {}), { code: 'not_found', status: 404 }, 'a demo supplement takes no dose from live mode');
  await assert.rejects(service.deleteDose(demoDose.dose.id), { code: 'not_found', status: 404 }, 'a demo dose is not deletable from live mode');
  assert.deepEqual(manual(service.getSupplementDoses({ days: 7 }).doses).map((dose) => dose.id), [liveDose.dose.id], 'live mode only reads its own doses');

  await service.setDemo(true);
  await assert.rejects(service.logDose(live.id, {}), { code: 'not_found', status: 404 }, 'a live supplement takes no dose from demo mode');
  await assert.rejects(service.deleteDose(liveDose.dose.id), { code: 'not_found', status: 404 }, 'a live dose is not deletable from demo mode');
  assert.deepEqual(manual(service.getSupplementDoses({ days: 7 }).doses).map((dose) => dose.id), [demoDose.dose.id], 'the demo dose survived every cross-mode write');

  // A slot override carries no mode of its own either: the same slot key exists
  // in both modes, so only the parent supplement keeps the two apart.
  const demoSkip = await service.logDose(demo.id, { slot: `${day(-1)}:0`, amount: 0 });
  await service.setDemo(false);
  await assert.rejects(service.logDose(demo.id, { slot: `${day(-1)}:0`, amount: 0 }), { code: 'not_found', status: 404 }, 'live mode cannot skip a demo slot');
  await assert.rejects(service.deleteDose(demoSkip.dose.id), { code: 'not_found', status: 404 }, 'live mode cannot restore a demo slot');
  const liveSkip = await service.logDose(live.id, { slot: `${day(-1)}:0`, amount: 0 });
  assert.deepEqual(service.getSupplementDoses({ days: 7 }).doses.filter((dose) => dose.skipped).map((dose) => dose.id), [liveSkip.dose.id], 'live mode sees only its own override');
  await service.setDemo(true);
  await assert.rejects(service.deleteDose(liveSkip.dose.id), { code: 'not_found', status: 404 }, 'demo mode cannot restore a live slot');
  assert.deepEqual(service.getSupplementDoses({ days: 7 }).doses.filter((dose) => dose.skipped).map((dose) => dose.id), [demoSkip.dose.id], 'and demo mode sees only its own');
});

test('a workout supplement derives a dose per demo session and honours overrides', async (t) => {
  const { service } = await withService(t);
  await service.setDemo(true);
  const workouts = service.getState().workouts;
  const oldest = workouts.reduce((first, workout) => (workout.start_time < first.start_time ? workout : first));
  const supplement = await service.saveSupplement(creatine({ name: 'Pre-workout', type: 'pre_workout', dose_unit: 'scoop', dose_amount: 1, frequency: { kind: 'workout' }, start_date: oldest.start_time.slice(0, 10) }));
  const derived = service.getSupplementDoses({ days: 730 }).doses;
  assert.equal(derived.length, workouts.length, 'one derived dose per logged session');
  assert.ok(derived.every((dose) => dose.source === 'workout' && dose.unit === 'scoop' && dose.amount === 1 && !dose.skipped));
  assert.ok(derived.every((dose) => dose.id.startsWith(`workout:${supplement.id}:`)));
  assert.ok(derived.every((dose) => dose.workout_title));
  assert.ok(Date.parse(derived[0].taken_at) >= Date.parse(derived.at(-1).taken_at), 'still newest first');
  await assert.rejects(service.deleteDose(derived[0].id), { code: 'not_found', status: 404 }, 'a derived dose has no stored row to delete');

  const target = workouts[5];
  const skipped = await service.logDose(supplement.id, { workout_id: target.id, amount: 0 });
  assert.equal(skipped.dose.skipped, true);
  assert.equal(skipped.dose.workout_title, target.title);
  assert.equal(skipped.dose.source, 'workout');
  let listed = service.getSupplementDoses({ days: 730 }).doses;
  assert.equal(listed.length, workouts.length, 'an override replaces the derived dose rather than adding one');
  assert.equal(listed.find((dose) => dose.workout_id === target.id).id, skipped.dose.id);
  assert.equal(listed.find((dose) => dose.workout_id === target.id).amount, 0);

  const changed = await service.logDose(supplement.id, { workout_id: target.id, amount: 2, note: 'Extra' });
  assert.equal(changed.dose.id, skipped.dose.id, 'the same session upserts one override row');
  listed = service.getSupplementDoses({ days: 730 }).doses;
  assert.equal(listed.length, workouts.length);
  assert.deepEqual([listed.find((dose) => dose.workout_id === target.id).amount, listed.find((dose) => dose.workout_id === target.id).note], [2, 'Extra']);

  await service.deleteDose(changed.dose.id);
  const restored = service.getSupplementDoses({ days: 730 }).doses.find((dose) => dose.workout_id === target.id);
  assert.equal(restored.id, `workout:${supplement.id}:${target.id}`, 'deleting the override restores the derived dose');
  assert.equal(restored.amount, 1);

  await assert.rejects(service.logDose(supplement.id, { workout_id: 'no-such-workout' }), { code: 'workout_not_found', status: 404 });
  // Leaving `workout` behind takes the override rows with it, in the same write.
  await service.logDose(supplement.id, { workout_id: target.id, amount: 0 });
  const daily = await service.saveSupplement({ ...creatine({ name: 'Pre-workout', type: 'pre_workout', dose_unit: 'scoop', dose_amount: 1, start_date: supplement.start_date }), id: supplement.id });
  assert.equal(daily.frequency.kind, 'daily');
  const afterChange = service.getSupplementDoses({ days: 730 }).doses;
  assert.ok(afterChange.every((dose) => dose.source === 'schedule'), 'the session doses and their overrides are gone, the calendar takes over');
  assert.ok(!afterChange.some((dose) => dose.skipped), 'the skipped session did not survive as a calendar skip');
});

test('an override for a workout that is no longer imported is ignored', async (t) => {
  const workout = (id, title, offset) => ({ id, title, routine_id: 'r1', start_time: instant(offset, 17), end_time: instant(offset, 18), exercises: [] });
  const routine = { id: 'r1', title: 'Strength', folder_id: null, exercises: [] };
  const template = { id: 't1', title: 'Squat' };
  const data = { workouts: [[workout('w1', 'Lower', -3), workout('w2', 'Upper', -1)]], routines: [[routine]], exercise_templates: [[template]] };
  const fetchImpl = async (url) => {
    const resource = new URL(url).pathname.split('/').at(-1);
    const page = Number(new URL(url).searchParams.get('page'));
    const pages = data[resource];
    if (!pages?.[page - 1]) return new Response(JSON.stringify({ page, page_count: pages?.length ?? 0, [resource]: [] }));
    return new Response(JSON.stringify({ page, page_count: pages.length, [resource]: pages[page - 1] }));
  };
  const { service } = await withService(t, fetchImpl);
  await service.saveSettings({ apiKey: 'a-safe-test-key' });
  await service.sync();
  const supplement = await service.saveSupplement(creatine({ frequency: { kind: 'workout' }, start_date: day(-10) }));
  await service.logDose(supplement.id, { workout_id: 'w1', amount: 0 });
  assert.deepEqual(service.getSupplementDoses({ days: 730 }).doses.map((dose) => dose.workout_id), ['w2', 'w1']);
  data.workouts = [[workout('w2', 'Upper', -1)]];
  await service.sync();
  assert.deepEqual(service.getSupplementDoses({ days: 730 }).doses.map((dose) => dose.workout_id), ['w2'], 'the stale override matches nothing');
});

test('a daily supplement is assumed taken, and a slot override removes one dose', async (t) => {
  const { service } = await withService(t);
  const supplement = await service.saveSupplement(creatine({ start_date: day(-2), frequency: { kind: 'daily', per_day: 2 } }));
  let doses = service.getSupplementDoses({ days: 30 }).doses;
  assert.deepEqual(doses.map((dose) => dose.slot), [`${day()}:0`, `${day()}:1`, `${day(-1)}:0`, `${day(-1)}:1`, `${day(-2)}:0`, `${day(-2)}:1`], 'two a day since the start date, through today and no further');
  assert.ok(doses.every((dose) => dose.source === 'schedule' && dose.unit === 'g' && dose.amount === 5 && !dose.skipped && dose.workout_id === null && dose.workout_title === null));
  assert.equal(doses[0].id, `slot:${supplement.id}:${day()}:0`);
  assert.equal(doses[0].taken_at, midnight(day()), 'a derived dose sits at the local midnight of its day');
  await assert.rejects(service.deleteDose(doses[0].id), { code: 'not_found', status: 404 }, 'a derived dose has no stored row to delete');

  const skipped = await service.logDose(supplement.id, { slot: `${day(-1)}:1`, amount: 0 });
  assert.equal(skipped.dose.source, 'schedule');
  assert.equal(skipped.dose.slot, `${day(-1)}:1`);
  assert.equal(skipped.dose.skipped, true);
  assert.equal(skipped.dose.date, day(-1), 'the row is filed on its slot day, not on the day it was removed');
  doses = service.getSupplementDoses({ days: 30 }).doses;
  assert.equal(doses.length, 6, 'an override replaces the derived dose rather than adding one');
  const overridden = doses.find((dose) => dose.slot === `${day(-1)}:1`);
  assert.deepEqual([overridden.id, overridden.amount, overridden.skipped], [skipped.dose.id, 0, true]);

  const changed = await service.logDose(supplement.id, { slot: `${day(-1)}:1`, amount: 2.5, note: 'Half' });
  assert.equal(changed.dose.id, skipped.dose.id, 'the same slot upserts one override row');
  doses = service.getSupplementDoses({ days: 30 }).doses;
  assert.equal(doses.length, 6);
  assert.deepEqual([doses.find((dose) => dose.slot === `${day(-1)}:1`).amount, doses.find((dose) => dose.slot === `${day(-1)}:1`).note], [2.5, 'Half']);

  await service.deleteDose(changed.dose.id);
  const restored = service.getSupplementDoses({ days: 30 }).doses.find((dose) => dose.slot === `${day(-1)}:1`);
  assert.equal(restored.id, `slot:${supplement.id}:${day(-1)}:1`, 'deleting the override restores the derived dose');
  assert.deepEqual([restored.amount, restored.skipped, restored.note], [5, false, '']);

  // An extra dose on top of the schedule is still logged by hand.
  const extra = await service.logDose(supplement.id, { taken_at: instant(-1, 15) });
  assert.equal(extra.dose.source, 'manual');
  assert.equal(extra.dose.slot, null);
  assert.equal(service.getSupplementDoses({ days: 30 }).doses.length, 7);
});

test('a weekly supplement only derives its listed weekdays, and refuses any other slot', async (t) => {
  const { service } = await withService(t);
  const weekdays = [weekdayOf(day(-1)), weekdayOf(day(-3))].sort((a, b) => a - b);
  const supplement = await service.saveSupplement(creatine({ name: 'Vitamin D', type: 'vitamin', start_date: day(-6), frequency: { kind: 'weekly', weekdays } }));
  assert.deepEqual(service.getSupplementDoses({ days: 30 }).doses.map((dose) => dose.slot), [`${day(-1)}:0`, `${day(-3)}:0`], 'one dose per listed weekday inside the window');
  await assert.rejects(service.logDose(supplement.id, { slot: `${day(-2)}:0`, amount: 0 }), { code: 'validation' }, 'an unlisted weekday is not on the schedule');
  await assert.rejects(service.logDose(supplement.id, { slot: `${day(-1)}:1`, amount: 0 }), { code: 'validation' }, 'a weekly schedule has one dose a day');
  await assert.rejects(service.logDose(supplement.id, { slot: `${day(7)}:0`, amount: 0 }), { code: 'validation' }, 'a slot after today');
  await assert.rejects(service.logDose(supplement.id, { slot: 'tomorrow', amount: 0 }), { code: 'validation' }, 'a slot that is not YYYY-MM-DD:n');
  await assert.rejects(service.logDose(supplement.id, { slot: `${day(-1)}:0`, workout_id: 'w1', amount: 0 }), { code: 'validation' }, 'a session and a slot at once');
  const asNeeded = await service.saveSupplement(creatine({ name: 'Magnesium', type: 'mineral', frequency: { kind: 'as_needed' } }));
  await assert.rejects(service.logDose(asNeeded.id, { slot: `${day()}:0`, amount: 0 }), { code: 'validation' }, 'an as-needed supplement has no schedule to skip');
  const skipped = await service.logDose(supplement.id, { slot: `${day(-1)}:0`, amount: 0 });
  assert.equal(service.getSupplementDoses({ days: 30 }).doses.find((dose) => dose.slot === `${day(-1)}:0`).id, skipped.dose.id);
});

test('an edit drops the slot overrides the schedule no longer generates', async (t) => {
  const { service } = await withService(t);
  const supplement = await service.saveSupplement(creatine({ start_date: day(-4), frequency: { kind: 'daily', per_day: 3 } }));
  for (const slot of [`${day(-1)}:0`, `${day(-1)}:2`, `${day(-4)}:1`]) await service.logDose(supplement.id, { slot, amount: 0 });
  assert.equal(service.getSupplementDoses({ days: 30 }).doses.filter((dose) => dose.skipped).length, 3);

  // Two a day from two days ago: the third dose of a day and the older day both leave the schedule.
  await service.saveSupplement({ ...creatine({ start_date: day(-2), frequency: { kind: 'daily', per_day: 2 } }), id: supplement.id });
  assert.deepEqual(service.getSupplementDoses({ days: 30 }).doses.filter((dose) => dose.skipped).map((dose) => dose.slot), [`${day(-1)}:0`], 'only the still-scheduled skip survives');
  await service.saveSupplement({ ...creatine({ start_date: day(-4), frequency: { kind: 'daily', per_day: 3 } }), id: supplement.id });
  assert.deepEqual(service.getSupplementDoses({ days: 30 }).doses.filter((dose) => dose.skipped).map((dose) => dose.slot), [`${day(-1)}:0`], 'the deleted rows do not come back when the schedule grows again');

  await service.saveSupplement({ ...creatine({ start_date: day(-4), frequency: { kind: 'as_needed' } }), id: supplement.id });
  assert.deepEqual(service.getSupplementDoses({ days: 30 }).doses, [], 'an as-needed supplement keeps neither derived doses nor slot overrides');
  await service.saveSupplement({ ...creatine({ start_date: day(-4), frequency: { kind: 'daily', per_day: 3 } }), id: supplement.id });
  assert.ok(service.getSupplementDoses({ days: 30 }).doses.every((dose) => !dose.skipped), 'the calendar comes back without its old skips');
});

test('the export writes supplements.md with fields, frequency, status, and recent doses', async (t) => {
  const { service, dataDir } = await withService(t);
  const supplement = await service.saveSupplement(creatine({ purchase_url: 'https://example.com/creatine', package_size: 500, notes: 'Cheapest in 1 kg tubs.', ingredients: '- Creatine monohydrate' }));
  await service.logDose(supplement.id, { taken_at: instant(-1, 9) });
  await service.logDose(supplement.id, { taken_at: instant(-40, 9) });
  await service.logDose(supplement.id, { slot: `${day()}:0`, amount: 0 });
  const result = await service.exportMarkdown();
  assert.ok(result.files.includes('exports/supplements.md'));
  const output = await readFile(path.join(dataDir, 'exports', 'supplements.md'), 'utf8');
  assert.match(output, /^# Supplements$/m);
  assert.match(output, /^## Creatine monohydrate$/m);
  assert.match(output, /- Frequency: Every day/);
  assert.match(output, /- Status: active/);
  assert.match(output, /- Dose: 5 g/);
  assert.match(output, /- Package: 500 g/);
  assert.match(output, /- Where to buy: https:\/\/example\.com\/creatine/);
  assert.match(output, /Cheapest in 1 kg tubs\./);
  assert.match(output, new RegExp(`### Doses ${day(-29)} to ${day()}`));
  assert.ok(output.includes(`- ${instant(-1, 9)}: 5 g (Manual)`), 'a hand-logged dose keeps its instant and says where it came from');
  // A scheduled dose sits at a local midnight, so writing its instant in UTC
  // would name the day before east of Greenwich; it is filed by its civil day.
  assert.ok(output.includes(`- ${day(-1)}: 5 g (Scheduled)`), 'an assumed dose is filed under its own day');
  assert.ok(output.includes(`- ${day()}: Skipped (Scheduled)`), 'and a removed one reads as skipped on that day');
  assert.ok(!output.includes(midnight(day())), 'no scheduled dose exports a UTC midnight instant');
  assert.ok(!output.includes(instant(-40, 9)), 'only the last 30 days of doses are exported');
});

test('a fresh database records schema version 8 and an older one is migrated', async (t) => {
  const { dataDir } = await withService(t);
  assert.equal(meta(dataDir, 'schema_version'), '8');
  setMeta(dataDir, 'schema_version', '7');
  const upgraded = await createService({ dataDir });
  t.after(() => upgraded.close());
  assert.equal(meta(dataDir, 'schema_version'), '8');
  assert.deepEqual(upgraded.getState().supplements, []);
});

test('a version 8 database that predates the slot column gets it on the next open', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-supplements-'));
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  const first = await createService({ dataDir });
  first.close();
  // The shape version 8 had before scheduled doses: overrides named a workout only.
  const db = new DatabaseSync(path.join(dataDir, 'corpus.sqlite'));
  db.exec('DROP INDEX supplement_doses_slot');
  db.exec('ALTER TABLE supplement_doses DROP COLUMN slot');
  const columns = () => new Set(db.prepare('PRAGMA table_info(supplement_doses)').all().map((column) => column.name));
  assert.ok(!columns().has('slot'), 'the old table has no slot column');
  db.close();
  assert.equal(meta(dataDir, 'schema_version'), '8', 'the version alone does not say the column is there');

  const upgraded = await createService({ dataDir });
  t.after(() => upgraded.close());
  const after = new DatabaseSync(path.join(dataDir, 'corpus.sqlite'));
  try {
    assert.ok(new Set(after.prepare('PRAGMA table_info(supplement_doses)').all().map((column) => column.name)).has('slot'), 'the column is added in place');
    assert.ok(after.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get('supplement_doses_slot'), 'and the unique index with it');
  } finally { after.close(); }
  const supplement = await upgraded.saveSupplement(creatine({ start_date: day(-1) }));
  const skipped = await upgraded.logDose(supplement.id, { slot: `${day()}:0`, amount: 0 });
  assert.equal(skipped.dose.skipped, true, 'the migrated table stores a slot override');
  assert.deepEqual(upgraded.getSupplementDoses({ days: 7 }).doses.map((dose) => dose.id), [skipped.dose.id, `slot:${supplement.id}:${day(-1)}:0`]);
});
