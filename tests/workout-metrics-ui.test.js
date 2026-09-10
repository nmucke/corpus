import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activeZoneMinutes,
  cleanSamples,
  gapThreshold,
  hasMetrics,
  layoutSegments,
  medianInterval,
  overviewChange,
  overviewSummary,
  paddedExtent,
  partitionWindows,
  splitRuns,
  timeTicks,
  traceWindow,
  zoneClass,
  zoneRows,
} from '../public/workout-metrics-analytics.js';
import { formatBpm, formatElapsed } from '../public/format.js';

/** The zone list the shared catalog owns; tests pass their own copy. */
const ZONES = [
  { key: 'FAT_BURN', label: 'Fat burn' },
  { key: 'CARDIO', label: 'Cardio' },
  { key: 'PEAK', label: 'Peak' },
];

const START = 1_757_392_410_000;

/** A run of samples `seconds` apart, `count` long, starting at `at`. */
function run(at, count, seconds, value = 100) {
  return Array.from({ length: count }, (_, index) => [at + index * seconds * 1000, value + index]);
}

test('formatElapsed reads as a stopwatch and keeps sub-minute resolution', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(750_000), '12:30');
  assert.equal(formatElapsed(59_400), '0:59');
  assert.equal(formatElapsed(3_750_000), '1:02:30');
  assert.equal(formatElapsed(-90_000), '-1:30');
  assert.equal(formatElapsed(null), '—');
  assert.equal(formatElapsed('nope'), '—');
});

test('formatBpm carries its unit and degrades to MISSING', () => {
  assert.equal(formatBpm(128), '128 bpm');
  assert.equal(formatBpm(null), '—');
  assert.equal(formatBpm(undefined), '—');
});

test('cleanSamples drops malformed pairs, sorts by time and ignores a third slot', () => {
  const samples = cleanSamples([[3, 99], ['bad', 1], [1, 'x'], [2, 80], [1, 70], null, [4]]);
  assert.deepEqual(samples, [[1, 70], [2, 80], [3, 99]]);
  assert.deepEqual(cleanSamples(null), []);
  // Zone samples are 3-tuples `[atMs, minutes, label]`; the label is not a value.
  assert.deepEqual(cleanSamples([[2, 1, 'CARDIO'], [1, 1, 'PEAK']]), [[1, 1], [2, 1]]);
});

test('medianInterval uses the middle gap, not the mean, so one dropout cannot skew it', () => {
  assert.equal(medianInterval([[0, 1], [1000, 2], [2000, 3], [600_000, 4]]), 1000);
  assert.equal(medianInterval([[0, 1], [1000, 2], [3000, 3]]), 1500);
  assert.equal(medianInterval([[0, 1]]), null);
});

test('gapThreshold is max(3x median, 15 s) and falls back to the floor', () => {
  assert.equal(gapThreshold(run(START, 5, 1)), 15_000);
  assert.equal(gapThreshold(run(START, 5, 10)), 30_000);
  assert.equal(gapThreshold([], { medianMs: null }), 15_000);
  assert.equal(gapThreshold([], { medianMs: 20_000 }), 60_000);
});

test('splitRuns breaks the line only where coverage actually stops', () => {
  const dense = [...run(START, 4, 2), ...run(START + 600_000, 3, 2)];
  const runs = splitRuns(dense);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].length, 4);
  assert.equal(runs[1].length, 3);
  // 6 s spacing stays one run: below the 15 s floor even though it is 3x the median.
  assert.equal(splitRuns(run(START, 5, 6)).length, 1);
  // An explicit threshold wins over the derived one.
  assert.equal(splitRuns(run(START, 5, 6), 5000).length, 5);
  assert.deepEqual(splitRuns([]), []);
  // One sample is still one run; a series that is all gaps is a run per sample.
  assert.deepEqual(splitRuns([[START, 90]]), [[[START, 90]]]);
  assert.equal(splitRuns([[0, 90], [60_000, 91], [120_000, 92]], 15_000).every((one) => one.length === 1), true);
  // Steady 60 s spacing is a cadence, not a dropout: the derived threshold keeps it whole.
  assert.equal(splitRuns([[0, 90], [60_000, 91], [120_000, 92]]).length, 1);
});

test('traceWindow prefers the served window and falls back to what is on screen', () => {
  assert.deepEqual(traceWindow({ start_ms: 10, end_ms: 20 }, []), { startMs: 10, endMs: 20 });
  // A null or degenerate window still has samples worth drawing.
  assert.deepEqual(traceWindow(null, run(START, 3, 10)), { startMs: START, endMs: START + 20_000 });
  assert.deepEqual(
    traceWindow({ start_ms: null, end_ms: null }, [], { startMs: 5, endMs: 25 }),
    { startMs: 5, endMs: 25 },
  );
  assert.equal(traceWindow(null, []), null);
  assert.equal(traceWindow({ start_ms: 30, end_ms: 30 }, [[30, 90]]), null);
});

test('zoneClass names the one rule a zone paints with', () => {
  assert.equal(zoneClass('FAT_BURN'), 'zone--fat-burn');
  assert.equal(zoneClass('none'), 'zone--none');
  assert.equal(zoneClass(null), 'zone--none');
});

test('paddedExtent snaps outward to round bpm gridlines and never goes negative', () => {
  assert.deepEqual(paddedExtent([96, 171]), { min: 80, max: 180 });
  assert.deepEqual(paddedExtent([60, 62]), { min: 50, max: 70 });
  assert.deepEqual(paddedExtent([3]), { min: 0, max: 10 });
  assert.deepEqual(paddedExtent([]), { min: 0, max: 10 });
});

test('timeTicks picks a round cadence inside the label budget', () => {
  assert.deepEqual(timeTicks(10 * 60_000, { max: 6 }).map((tick) => tick.ms / 60_000), [0, 2, 4, 6, 8, 10]);
  const long = timeTicks(52 * 60_000, { max: 6 });
  assert.deepEqual(long.map((tick) => tick.ms / 60_000), [0, 15, 30, 45]);
  assert.deepEqual(timeTicks(90_000, { max: 4 }).map((tick) => tick.ms), [0, 30_000, 60_000, 90_000]);
  assert.deepEqual(timeTicks(0), [{ ms: 0 }]);
  assert.deepEqual(timeTicks(null), [{ ms: 0 }]);
});

test('layoutSegments clamps to the padded window, drops misses and alternates bands', () => {
  const window = { startMs: 0, endMs: 1000 };
  const laid = layoutSegments([
    { index: 0, title: 'Squat', sets: 4, from_ms: -100, to_ms: 200 },
    { index: 1, title: 'Bench', sets: 3, from_ms: 400, to_ms: 600 },
    { index: 2, title: 'Outside', sets: 1, from_ms: 2000, to_ms: 2500 },
    { index: 3, title: 'Zero width', sets: 1, from_ms: 700, to_ms: 700 },
    { index: 4, title: 'Tail', sets: 2, from_ms: 900, to_ms: 1400 },
  ], window);
  assert.deepEqual(laid.map((segment) => segment.title), ['Squat', 'Bench', 'Tail']);
  assert.deepEqual(laid.map((segment) => [segment.from, segment.to]), [[0, 0.2], [0.4, 0.6], [0.9, 1]]);
  assert.deepEqual(laid.map((segment) => segment.band), [0, 1, 0]);
  assert.deepEqual(laid.map((segment) => segment.number), [1, 2, 3]);
  assert.deepEqual(laid.map((segment) => segment.heartRate), [null, null, null]);
  assert.equal(laid[0].fromMs, 0);
  assert.equal(laid[2].toMs, 1000);
  assert.deepEqual(layoutSegments(null, window), []);
  assert.deepEqual(layoutSegments([], { startMs: 10, endMs: 10 }), []);
});

test('zoneRows keeps the catalog order, puts `none` last and shares sum to 1', () => {
  const rows = zoneRows({ FAT_BURN: 18, CARDIO: 22, PEAK: 6, none: 5 }, ZONES);
  assert.deepEqual(rows.map((row) => row.key), ['FAT_BURN', 'CARDIO', 'PEAK', 'none']);
  assert.deepEqual(rows.map((row) => row.className), ['zone--fat-burn', 'zone--cardio', 'zone--peak', 'zone--none']);
  assert.deepEqual(rows.map((row) => row.label), ['Fat burn', 'Cardio', 'Peak', 'Below zones']);
  assert.equal(rows.reduce((sum, row) => sum + row.share, 0).toFixed(6), '1.000000');
  assert.equal(rows[0].total, 51);
  const blank = zoneRows(null, ZONES);
  assert.deepEqual(blank.map((row) => row.minutes), [0, 0, 0, 0]);
  assert.deepEqual(blank.map((row) => row.share), [0, 0, 0, 0]);
});

test('activeZoneMinutes counts only real zones', () => {
  assert.equal(activeZoneMinutes({ FAT_BURN: 18, CARDIO: 22, PEAK: 6, none: 5 }, ZONES), 46);
  assert.equal(activeZoneMinutes(null, ZONES), 0);
});

const row = (id, status, avg, max, zones, calories) => ({
  id,
  start_time: '2026-09-09T04:28:30+00:00',
  status,
  heart_rate: avg == null ? null : { avg, max },
  zones,
  calories,
});

test('hasMetrics is true only for a fetched session with a heart rate', () => {
  assert.equal(hasMetrics(row('a', 'ready', 128, 171, {}, 300)), true);
  assert.equal(hasMetrics(row('b', 'ready', null)), false);
  assert.equal(hasMetrics(row('c', 'unfetched', null)), false);
  assert.equal(hasMetrics(row('d', 'empty', null)), false);
  assert.equal(hasMetrics(null), false);
});

test('overviewSummary skips the sessions missing one number rather than counting a zero', () => {
  const rows = [
    row('a', 'ready', 120, 160, { FAT_BURN: 10 }, 300),
    row('b', 'ready', 140, null, null, null),
  ];
  const summary = overviewSummary(rows, ZONES);
  assert.equal(summary.measured, 2);
  assert.equal(summary.peakHr, 160);
  assert.equal(summary.calories, 300);
  // A missing zone split is unknown, not zero, so only the row that has one counts.
  assert.equal(summary.zoneMinutes, 10);
});

test('overviewSummary averages over the measured sessions, not every session', () => {
  const rows = [
    row('a', 'ready', 120, 160, { FAT_BURN: 10, CARDIO: 20, PEAK: 0, none: 5 }, 300),
    row('b', 'ready', 140, 180, { FAT_BURN: 20, CARDIO: 20, PEAK: 10, none: 0 }, 400),
    row('c', 'unfetched', null, null, null, null),
  ];
  const summary = overviewSummary(rows, ZONES);
  assert.equal(summary.sessions, 3);
  assert.equal(summary.measured, 2);
  assert.equal(summary.avgHr, 130);
  assert.equal(summary.peakHr, 170);
  assert.equal(summary.zoneMinutes, 40);
  assert.equal(summary.calories, 350);
});

test('overviewSummary reports nulls rather than zeros when nothing is measured', () => {
  const summary = overviewSummary([row('a', 'unfetched', null)], ZONES);
  assert.deepEqual(
    [summary.avgHr, summary.peakHr, summary.zoneMinutes, summary.calories],
    [null, null, null, null],
  );
  assert.deepEqual(overviewSummary(null, ZONES).sessions, 0);
});

test('overviewChange needs both windows before it claims a delta', () => {
  const change = overviewChange({ avgHr: 130, peakHr: 170, zoneMinutes: 40, calories: 350 }, { avgHr: 125, peakHr: null, zoneMinutes: 30, calories: 350 });
  assert.equal(change.avgHr, 5);
  assert.equal(change.peakHr, null);
  assert.equal(change.zoneMinutes, 10);
  assert.equal(change.calories, 0);
  assert.deepEqual(overviewChange({ avgHr: 130 }, null).avgHr, null);
});

test('partitionWindows splits the selected range from the one before it', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse('2026-09-10T12:00:00Z');
  const at = (daysAgo) => ({ id: `d${daysAgo}`, start_time: new Date(now - daysAgo * day).toISOString() });
  const rows = [at(1), at(20), at(40), at(70), at(200)];
  const split = partitionWindows(rows, 28, now);
  assert.deepEqual(split.current.map((item) => item.id), ['d1', 'd20']);
  assert.deepEqual(split.previous.map((item) => item.id), ['d40']);
  // `All` has no window to compare against.
  const all = partitionWindows(rows, null, now);
  assert.equal(all.current.length, 5);
  assert.deepEqual(all.previous, []);
  // Unparseable start times never reach a chart.
  assert.deepEqual(partitionWindows([{ id: 'x', start_time: 'nope' }], 28, now).current, []);
});
