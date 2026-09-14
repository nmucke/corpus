import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  adherence,
  dayKeys,
  doseCalendar,
  dosesPerPackage,
  dueToday,
  expectedOnDay,
  formatDose,
  groupByDate,
  isActiveOn,
  isCounted,
  isDerived,
  isSkipped,
  packageDays,
  slotKey,
  takenToday,
  weekdayIndex,
  workoutsByDate,
} from '../public/supplements-analytics.js';

// 2026-09-07 is a Monday, so the week below runs Mon → Sun and Mon/Wed/Fri are
// weekday indexes 0, 2 and 4 in the Monday-first `WEEKDAYS` vocabulary.
const MONDAY = '2026-09-07';
const WEDNESDAY = '2026-09-09';
const THURSDAY = '2026-09-10';
const SUNDAY = '2026-09-13';

function supplement(overrides = {}) {
  return {
    id: 's1',
    name: 'Creatine',
    dose_amount: 5,
    dose_unit: 'g',
    frequency: { kind: 'daily', per_day: 1 },
    start_date: MONDAY,
    end_date: null,
    package_size: null,
    ...overrides,
  };
}

/** Dose rows carry their own civil date, exactly as the service returns them. */
function dose(date, { id = `${date}-1`, supplement_id = 's1', amount = 5, ...rest } = {}) {
  return { id, supplement_id, date, taken_at: `${date}T08:00:00.000Z`, amount, ...rest };
}

/** A derived scheduled row, exactly as the service returns one. */
function slotDose(date, index = 0, { amount = 5, id = `slot:s1:${date}:${index}`, ...rest } = {}) {
  return {
    id,
    supplement_id: 's1',
    date,
    taken_at: `${date}T00:00:00`,
    amount,
    slot: `${date}:${index}`,
    source: 'schedule',
    skipped: amount === 0,
    ...rest,
  };
}

/** A logged session; local start times keep the fixtures timezone independent. */
function workout(date, { id = `w-${date}`, hour = 18 } = {}) {
  return { id, start_time: `${date}T${String(hour).padStart(2, '0')}:00:00` };
}

test('formatDose pluralises count units and leaves symbol units alone', () => {
  assert.equal(formatDose(1, 'capsule'), '1 capsule');
  assert.equal(formatDose(2, 'capsule'), '2 capsules');
  assert.equal(formatDose(1, 'scoop'), '1 scoop');
  assert.equal(formatDose(5, 'g'), '5 g');
  assert.equal(formatDose(1000, 'iu'), '1,000 IU');
  assert.equal(formatDose(2.5, 'g'), '2.5 g');
  assert.equal(formatDose(0, 'tablet'), '0 tablets');
  // A skipped or unknown value never renders as `NaN` or a bare unit.
  assert.equal(formatDose(null, 'g'), '—');
  assert.equal(formatDose('nope', 'g'), '—');
  assert.equal(formatDose(3, ''), '3');
});

test('weekdayIndex is Monday-first and rejects impossible dates', () => {
  assert.equal(weekdayIndex(MONDAY), 0);
  assert.equal(weekdayIndex(WEDNESDAY), 2);
  assert.equal(weekdayIndex(SUNDAY), 6);
  assert.equal(weekdayIndex('2026-02-30'), null);
  assert.equal(weekdayIndex(''), null);
});

test('addDays and dayKeys walk the calendar without a timezone shift', () => {
  assert.equal(addDays(MONDAY, 6), SUNDAY);
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('bad', 1), null);
  assert.equal(dayKeys(MONDAY, SUNDAY).length, 7);
  assert.deepEqual(dayKeys(MONDAY, MONDAY), [MONDAY]);
  assert.deepEqual(dayKeys(SUNDAY, MONDAY), []);
});

test('isActiveOn covers the inclusive window and an open end date', () => {
  const ongoing = supplement();
  assert.equal(isActiveOn(ongoing, MONDAY), true);
  assert.equal(isActiveOn(ongoing, '2026-09-06'), false);
  assert.equal(isActiveOn(ongoing, '2027-01-01'), true);
  const ended = supplement({ end_date: WEDNESDAY });
  assert.equal(isActiveOn(ended, WEDNESDAY), true);
  assert.equal(isActiveOn(ended, THURSDAY), false);
});

test('dueToday answers for every frequency kind', () => {
  assert.equal(dueToday(supplement(), THURSDAY), true);
  // Outside the active window nothing is due, whatever the schedule says.
  assert.equal(dueToday(supplement({ end_date: WEDNESDAY }), THURSDAY), false);

  const weekly = supplement({ frequency: { kind: 'weekly', weekdays: [0, 2, 4] } });
  assert.equal(dueToday(weekly, WEDNESDAY), true);
  assert.equal(dueToday(weekly, THURSDAY), false);

  const linked = supplement({ frequency: { kind: 'workout' } });
  assert.equal(dueToday(linked, THURSDAY, []), false);
  assert.equal(dueToday(linked, THURSDAY, [workout(THURSDAY)]), true);
  assert.equal(dueToday(linked, THURSDAY, 2), true);

  assert.equal(dueToday(supplement({ frequency: { kind: 'as_needed' } }), THURSDAY), false);
});

test('expectedOnDay counts times per day and one dose per session', () => {
  assert.equal(expectedOnDay(supplement({ frequency: { kind: 'daily', per_day: 3 } }), THURSDAY), 3);
  assert.equal(expectedOnDay(supplement({ frequency: { kind: 'workout' } }), THURSDAY, 2), 2);
  assert.equal(expectedOnDay(supplement({ frequency: { kind: 'as_needed' } }), THURSDAY), 0);
});

test('takenToday counts only the doses of that supplement on that day', () => {
  const doses = [
    dose(THURSDAY),
    dose(THURSDAY, { id: 'b' }),
    dose(THURSDAY, { id: 'c', supplement_id: 's2' }),
    dose(WEDNESDAY, { id: 'd' }),
    // A `0` amount is the skipped marker, never a taken dose.
    dose(THURSDAY, { id: 'e', amount: 0 }),
  ];
  assert.equal(takenToday(doses, 's1', THURSDAY), 2);
  assert.equal(takenToday(doses, 's2', THURSDAY), 1);
  assert.equal(takenToday(doses, 's1', MONDAY), 0);
  assert.equal(takenToday([], 's1', THURSDAY), 0);
  // Without a stored civil date the local date of `taken_at` is used.
  assert.equal(takenToday([{ supplement_id: 's1', taken_at: `${THURSDAY}T08:00:00`, amount: 5 }], 's1', THURSDAY), 1);
});

test('adherence for a daily supplement multiplies by times per day', () => {
  const twice = supplement({ frequency: { kind: 'daily', per_day: 2 } });
  const doses = [dose(MONDAY), dose(MONDAY, { id: 'b' }), dose(WEDNESDAY)];
  const result = adherence(twice, doses, { from: MONDAY, to: WEDNESDAY });
  assert.deepEqual(result, { expected: 6, taken: 3, ratio: 0.5, days: 3 });
});

test('slotKey names the nth scheduled dose of a day', () => {
  assert.equal(slotKey(MONDAY, 0), `${MONDAY}:0`);
  assert.equal(slotKey(MONDAY, 2), `${MONDAY}:2`);
  assert.equal(slotKey(MONDAY), `${MONDAY}:0`);
  // A slot index is never negative, and a slot needs a real date.
  assert.equal(slotKey(MONDAY, -3), `${MONDAY}:0`);
  assert.equal(slotKey('2026-02-30', 0), null);
  assert.equal(slotKey('', 0), null);
});

test('isDerived marks the rows the schedule computes, not the stored overrides', () => {
  assert.equal(isDerived(slotDose(MONDAY)), true);
  assert.equal(isDerived({ id: 'workout:s1:w-1' }), true);
  // An override keeps its own uuid, so it can be deleted.
  assert.equal(isDerived({ id: '2f1d8a0e-0c5f-4d2e-9f3a-1b6c7d8e9f01' }), false);
  assert.equal(isDerived({}), false);
  assert.equal(isDerived(null), false);
});

test('isSkipped reads the `0` override, whichever way the row states it', () => {
  assert.equal(isSkipped(slotDose(MONDAY, 0, { amount: 0 })), true);
  assert.equal(isSkipped({ amount: 5, skipped: true }), true);
  assert.equal(isSkipped(slotDose(MONDAY)), false);
  // A row without an amount is neither taken nor skipped.
  assert.equal(isSkipped({ id: 'a' }), false);
});

test('isCounted is the one rule the views and the analytics share', () => {
  assert.equal(isCounted(slotDose(MONDAY)), true);
  assert.equal(isCounted(slotDose(MONDAY, 0, { amount: 0 })), false, 'a skipped dose is never counted');
  assert.equal(isCounted({ amount: 5, skipped: true }), false);
  assert.equal(isCounted({ id: 'a' }), false, 'a row without an amount counts as nothing');
});

test('a skipped scheduled dose counts as a miss, never as a dose', () => {
  const daily = supplement();
  const doses = [
    slotDose(MONDAY),
    slotDose(WEDNESDAY, 0, { amount: 0, id: 'override-1' }),
  ];
  assert.equal(takenToday(doses, 's1', MONDAY), 1);
  assert.equal(takenToday(doses, 's1', WEDNESDAY), 0);

  const result = adherence(daily, doses, { from: MONDAY, to: WEDNESDAY });
  assert.equal(result.expected, 3);
  assert.equal(result.taken, 1);

  const cells = new Map(doseCalendar(daily, doses, { from: MONDAY, to: WEDNESDAY }).map((cell) => [cell.date, cell]));
  // The skipped day is expected and untaken, so the strip outlines it.
  assert.deepEqual(cells.get(MONDAY), { date: MONDAY, taken: 1, expected: 1 });
  assert.deepEqual(cells.get(WEDNESDAY), { date: WEDNESDAY, taken: 0, expected: 1 });
});

test('adherence clamps taken to expected for the ratio', () => {
  // A manual dose on top of the schedule must never read as more than 100%.
  const result = adherence(supplement(), [slotDose(MONDAY), dose(MONDAY, { id: 'extra' })], { from: MONDAY, to: MONDAY });
  assert.equal(result.expected, 1);
  assert.equal(result.taken, 2);
  assert.equal(result.ratio, 1);
});

test('adherence clips the range to the active window', () => {
  const ended = supplement({ end_date: WEDNESDAY });
  const result = adherence(ended, [dose(MONDAY)], { from: '2026-09-01', to: SUNDAY });
  assert.equal(result.days, 3);
  assert.equal(result.expected, 3);
  assert.equal(result.taken, 1);
});

test('adherence for a weekly supplement counts only its weekdays', () => {
  const weekly = supplement({ frequency: { kind: 'weekly', weekdays: [0, 2, 4] } });
  const result = adherence(weekly, [dose(MONDAY), dose(WEDNESDAY)], { from: MONDAY, to: SUNDAY });
  assert.equal(result.expected, 3);
  assert.equal(result.taken, 2);
  assert.equal(result.ratio, 2 / 3);
});

test('adherence for a workout supplement expects one dose per session', () => {
  const linked = supplement({ frequency: { kind: 'workout' } });
  const workouts = [workout(MONDAY), workout(WEDNESDAY), workout(WEDNESDAY, { id: 'w2', hour: 20 }), workout('2026-09-06')];
  const result = adherence(linked, [dose(MONDAY), dose(WEDNESDAY, { amount: 0 })], { from: MONDAY, to: SUNDAY, workouts });
  // The session before the start date falls outside the window.
  assert.equal(result.expected, 3);
  assert.equal(result.taken, 1);
});

test('adherence for an as_needed supplement expects nothing and has no ratio', () => {
  const asNeeded = supplement({ frequency: { kind: 'as_needed' } });
  const result = adherence(asNeeded, [dose(MONDAY), dose(WEDNESDAY)], { from: MONDAY, to: SUNDAY });
  assert.equal(result.expected, 0);
  assert.equal(result.taken, 2);
  assert.equal(result.ratio, null);
});

test('workoutsByDate counts sessions per local date and skips broken rows', () => {
  const counts = workoutsByDate([workout(WEDNESDAY), workout(WEDNESDAY, { id: 'w2', hour: 20 }), { start_time: 'nope' }]);
  assert.equal(counts.get(WEDNESDAY), 2);
  assert.equal(counts.size, 1);
});

test('doseCalendar marks taken, missed and unexpected days across the range', () => {
  const weekly = supplement({ frequency: { kind: 'weekly', weekdays: [0, 2, 4] }, end_date: '2026-09-11' });
  const cells = doseCalendar(weekly, [dose(MONDAY), dose(SUNDAY, { id: 'extra' })], { from: '2026-09-06', to: SUNDAY });
  assert.equal(cells.length, 8);
  const byDate = new Map(cells.map((cell) => [cell.date, cell]));
  // Before the start date: nothing expected, nothing logged.
  assert.deepEqual(byDate.get('2026-09-06'), { date: '2026-09-06', taken: 0, expected: 0 });
  // Taken on a scheduled day.
  assert.deepEqual(byDate.get(MONDAY), { date: MONDAY, taken: 1, expected: 1 });
  // Scheduled and missed.
  assert.deepEqual(byDate.get(WEDNESDAY), { date: WEDNESDAY, taken: 0, expected: 1 });
  // Not a scheduled weekday.
  assert.deepEqual(byDate.get(THURSDAY), { date: THURSDAY, taken: 0, expected: 0 });
  // After the end date an extra dose still shows as taken.
  assert.deepEqual(byDate.get(SUNDAY), { date: SUNDAY, taken: 1, expected: 0 });
});

test('doseCalendar follows the sessions of a workout supplement', () => {
  const linked = supplement({ frequency: { kind: 'workout' } });
  const cells = doseCalendar(linked, [], { from: MONDAY, to: WEDNESDAY, workouts: [workout(WEDNESDAY)] });
  assert.deepEqual(cells.map((cell) => cell.expected), [0, 0, 1]);
});

test('dosesPerPackage rounds down to whole doses and is null without a size', () => {
  assert.equal(dosesPerPackage(supplement({ package_size: 500 })), 100);
  assert.equal(dosesPerPackage(supplement({ package_size: 502 })), 100);
  assert.equal(dosesPerPackage(supplement({ dose_amount: 3, package_size: 10 })), 3);
  assert.equal(dosesPerPackage(supplement()), null);
  assert.equal(dosesPerPackage(supplement({ package_size: 0 })), null);
  assert.equal(dosesPerPackage(supplement({ package_size: 100, dose_amount: 0 })), null);
});

test('packageDays divides by the schedule rate and rounds to whole days', () => {
  assert.equal(packageDays(supplement({ package_size: 500 })), 100);
  assert.equal(packageDays(supplement({ package_size: 500, frequency: { kind: 'daily', per_day: 2 } })), 50);
  // Mon/Wed/Fri is three doses a week, so 100 doses last about 233 days.
  assert.equal(packageDays(supplement({ package_size: 500, frequency: { kind: 'weekly', weekdays: [0, 2, 4] } })), 233);
  assert.equal(packageDays(supplement()), null);
});

test('packageDays measures the free kinds from an adherence result', () => {
  const linked = supplement({ frequency: { kind: 'workout' }, package_size: 500 });
  // Four sessions in twenty days is one dose every five days.
  assert.equal(packageDays(linked, { expected: 4, taken: 4, days: 20 }), 500);
  assert.equal(packageDays(linked, { expected: 0, taken: 0, days: 20 }), null);
  assert.equal(packageDays(linked, null), null);

  const asNeeded = supplement({ frequency: { kind: 'as_needed' }, package_size: 500 });
  assert.equal(packageDays(asNeeded, { expected: 0, taken: 10, days: 20 }), 200);
  assert.equal(packageDays(asNeeded, { expected: 0, taken: 0, days: 0 }), null);
});

test('groupByDate keeps the slots of one day in schedule order', () => {
  // Every slot of a day shares the same `taken_at`, so the slot id breaks the tie.
  const groups = groupByDate([slotDose(MONDAY, 2), slotDose(MONDAY, 0), slotDose(MONDAY, 1)]);
  assert.deepEqual(groups[0].doses.map((item) => item.slot), [`${MONDAY}:0`, `${MONDAY}:1`, `${MONDAY}:2`]);
});

test('groupByDate buckets doses newest first, inside and between days', () => {
  const groups = groupByDate([
    { id: 'a', date: WEDNESDAY, taken_at: `${WEDNESDAY}T08:00:00.000Z`, amount: 5 },
    { id: 'b', date: THURSDAY, taken_at: `${THURSDAY}T07:00:00.000Z`, amount: 5 },
    { id: 'c', date: WEDNESDAY, taken_at: `${WEDNESDAY}T20:00:00.000Z`, amount: 5 },
    { id: 'd', taken_at: 'nonsense', amount: 5 },
  ]);
  assert.deepEqual(groups.map((group) => group.date), [THURSDAY, WEDNESDAY]);
  assert.deepEqual(groups[1].doses.map((item) => item.id), ['c', 'a']);
  assert.deepEqual(groupByDate(null), []);
});
