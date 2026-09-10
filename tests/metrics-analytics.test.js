import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  dateRange,
  fillDays,
  listDays,
  periodDays,
  previousRange,
  rollingMean,
  sleepStack,
  summarize,
  trainingDaySplit,
} from '../public/metrics-analytics.js';

test('periodDays maps the picker values and falls back to 12 weeks', () => {
  assert.equal(periodDays('4w'), 28);
  assert.equal(periodDays('12w'), 84);
  assert.equal(periodDays('26w'), 182);
  assert.equal(periodDays('1y'), 365);
  assert.equal(periodDays('nope'), 84);
});

test('day arithmetic stays on calendar days across month ends, leap days, and DST', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Amsterdam';
  try {
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(addDays('2026-03-28', 3), '2026-03-31');
    assert.equal(addDays('2026-10-24', 2), '2026-10-26');
    assert.equal(listDays('2026-03-28', '2026-03-31').length, 4);
    assert.deepEqual(listDays('2026-03-31', '2026-03-28'), []);
    assert.equal(addDays('2026-02-30', 1), null);
    assert.deepEqual(dateRange('2026-09-09', 28), { from: '2026-08-13', to: '2026-09-09' });
    assert.deepEqual(dateRange('2026-09-09', 1), { from: '2026-09-09', to: '2026-09-09' });
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('previousRange is the adjacent window of equal length', () => {
  assert.deepEqual(previousRange('2026-08-13', '2026-09-09'), { from: '2026-07-16', to: '2026-08-12' });
  assert.deepEqual(previousRange('2026-09-09', '2026-09-09'), { from: '2026-09-08', to: '2026-09-08' });
  assert.deepEqual(previousRange('2026-09-09', '2026-09-01'), { from: null, to: null });
});

test('fillDays produces one entry per day with nulls in gaps and ignores bad points', () => {
  const filled = fillDays([
    { date: '2026-09-01', value: 10 },
    { date: '2026-09-03', value: '12.5' },
    { date: '2026-09-04', value: null },
    { date: '2026-09-05', value: 'abc' },
    { date: 'not-a-date', value: 3 },
    { date: '2026-09-30', value: 99 },
  ], '2026-09-01', '2026-09-05');
  assert.deepEqual(filled, [
    { date: '2026-09-01', value: 10 },
    { date: '2026-09-02', value: null },
    { date: '2026-09-03', value: 12.5 },
    { date: '2026-09-04', value: null },
    { date: '2026-09-05', value: null },
  ]);
  assert.deepEqual(fillDays(undefined, '2026-09-01', '2026-09-02'), [{ date: '2026-09-01', value: null }, { date: '2026-09-02', value: null }]);
});

test('rollingMean uses a trailing window and returns null with fewer than 3 points', () => {
  const filled = fillDays([
    { date: '2026-09-01', value: 2 },
    { date: '2026-09-02', value: 4 },
    { date: '2026-09-03', value: 6 },
    { date: '2026-09-05', value: 8 },
  ], '2026-09-01', '2026-09-10');
  const means = rollingMean(filled, 7);
  assert.equal(means[0], null);
  assert.equal(means[1], null);
  assert.equal(means[2], 4);
  assert.equal(means[3], 4);
  assert.equal(means[4], 5);
  assert.equal(means[6], 5);
  assert.equal(means[7], 6);
  assert.equal(means[8], null);
  assert.equal(means[9], null);
  assert.equal(rollingMean(filled, 3)[2], 4);
  assert.equal(rollingMean(filled, 3)[4], null);
  assert.equal(means.length, filled.length);
});

test('summarize reports latest, extremes, count, and the change versus the previous window', () => {
  const current = fillDays([{ date: '2026-09-02', value: 70 }, { date: '2026-09-04', value: 74 }], '2026-09-01', '2026-09-05');
  const previous = fillDays([{ date: '2026-08-30', value: 80 }], '2026-08-27', '2026-08-31');
  const stats = summarize(current, previous);
  assert.deepEqual(stats, { latest: 74, latestDate: '2026-09-04', mean: 72, min: 70, max: 74, count: 2, change: -8 });
  assert.equal(summarize(current, []).change, null);
  assert.deepEqual(summarize([], previous), { latest: null, latestDate: null, mean: null, min: null, max: null, count: 0, change: null });
});

test('sleepStack merges stage series per date and takes the total from sleep_minutes', () => {
  const series = {
    sleep_minutes: [{ date: '2026-09-02', value: 420 }],
    sleep_deep_minutes: [{ date: '2026-09-02', value: 60 }, { date: '2026-09-03', value: 50 }],
    sleep_light_minutes: [{ date: '2026-09-02', value: 240 }, { date: '2026-09-03', value: 200 }],
    sleep_rem_minutes: [{ date: '2026-09-02', value: 120 }],
    sleep_awake_minutes: [{ date: '2026-09-02', value: 30 }],
  };
  assert.deepEqual(sleepStack(series), [
    { date: '2026-09-02', deep: 60, light: 240, rem: 120, awake: 30, total: 420 },
    { date: '2026-09-03', deep: 50, light: 200, rem: null, awake: null, total: 250 },
  ]);
  const ranged = sleepStack(series, '2026-09-01', '2026-09-03');
  assert.equal(ranged.length, 3);
  assert.deepEqual(ranged[0], { date: '2026-09-01', deep: null, light: null, rem: null, awake: null, total: null });
  assert.deepEqual(sleepStack({}), []);
});

test('trainingDaySplit averages workout days separately from rest days', () => {
  const filled = fillDays([
    { date: '2026-09-01', value: 10000 },
    { date: '2026-09-02', value: 4000 },
    { date: '2026-09-03', value: 12000 },
    { date: '2026-09-04', value: 6000 },
  ], '2026-09-01', '2026-09-05');
  assert.deepEqual(trainingDaySplit(filled, new Set(['2026-09-01', '2026-09-03', '2026-09-05'])), { training: 11000, rest: 5000 });
  assert.deepEqual(trainingDaySplit(filled, new Set()), { training: null, rest: 8000 });
  assert.deepEqual(trainingDaySplit(filled, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']), { training: 8000, rest: null });
});
