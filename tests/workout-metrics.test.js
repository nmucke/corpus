import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimeMs,
  workoutWindow,
  mergeWindows,
  needsFetch,
  heartRateSummary,
  zoneMinutes,
  estimateSegments,
  workoutTotals,
  summariseWorkout,
  overviewRow,
  coverageCounts,
  blankMetrics,
  LATE_DATA_MS,
} from '../server/workout-metrics.js';
import { WORKOUT_METRIC_KEYS, WINDOW_PADDING } from '../public/workout-metrics-catalog.js';

const START = Date.parse('2026-01-05T10:00:00Z');
const END = START + 60 * 60_000;
const MINUTE = 60_000;

const workoutOf = (overrides = {}) => ({
  id: 'w1',
  title: 'Full Body 2',
  routine_id: 'r1',
  // Hevy sends `+00:00`; demo and Google data use `Z`. Both must parse.
  start_time: '2026-01-05T10:00:00+00:00',
  end_time: '2026-01-05T11:00:00Z',
  exercises: [
    { index: 0, title: 'Barbell Back Squat', exercise_template_id: 't-squat', sets: [{ index: 0, type: 'warmup', weight_kg: 40, reps: 10 }, { index: 1, type: 'normal', weight_kg: 100, reps: 5 }] },
    { index: 1, title: 'Cable Row', exercise_template_id: 't-row', sets: [{ index: 0, type: 'normal', weight_kg: 60, reps: 10 }, { index: 1, type: 'normal', weight_kg: 60, reps: 10 }, { index: 2, type: 'normal', weight_kg: 60, reps: 10 }, { index: 3, type: 'normal', weight_kg: 60, reps: 10 }] },
  ],
  ...overrides,
});

const heartRateSamples = ({ from = START, to = END, step = 10_000, value = 100 } = {}) => {
  const samples = [];
  for (let atMs = from; atMs <= to; atMs += step) samples.push({ metric: 'heart_rate', atMs, value, durationMs: null, label: null });
  return samples;
};
const interval = (metric, atMs, value, label = null, durationMs = MINUTE) => ({ metric, atMs, value, durationMs, label });

test('workout windows pad both offsets, drop unusable rows, and merge when they overlap', () => {
  assert.equal(parseTimeMs('2026-01-05T10:00:00+00:00'), START);
  assert.equal(parseTimeMs('2026-01-05T10:00:00Z'), START);
  assert.equal(parseTimeMs(START), START);
  assert.equal(parseTimeMs('later today'), null);

  const window = workoutWindow(workoutOf());
  assert.deepEqual(window, {
    workoutId: 'w1',
    startMs: START,
    endMs: END,
    durationMs: 60 * MINUTE,
    windowStartMs: START - WINDOW_PADDING.beforeSeconds * 1000,
    windowEndMs: END + WINDOW_PADDING.afterSeconds * 1000,
  });
  assert.equal(workoutWindow({ id: 'w2', start_time: 'nonsense', end_time: '2026-01-05T11:00:00Z' }), null);
  assert.equal(workoutWindow({ id: 'w3', start_time: '2026-01-05T11:00:00Z', end_time: '2026-01-05T11:00:00Z' }), null, 'a zero-length workout has no window');

  // Back-to-back sessions overlap once padded and become a single request.
  const back = workoutWindow({ id: 'w2', start_time: new Date(END + 5 * MINUTE).toISOString(), end_time: new Date(END + 40 * MINUTE).toISOString() });
  const later = workoutWindow({ id: 'w3', start_time: '2026-01-06T10:00:00Z', end_time: '2026-01-06T11:00:00Z' });
  const groups = mergeWindows([later, window, back]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].windows.map((entry) => entry.workoutId), ['w1', 'w2']);
  assert.equal(groups[0].startMs, window.windowStartMs);
  assert.equal(groups[0].endMs, back.windowEndMs);
  assert.deepEqual(groups[1].windows.map((entry) => entry.workoutId), ['w3']);
});

test('needsFetch covers a missing row, edited workout times, and late-arriving data', () => {
  const window = workoutWindow(workoutOf());
  const complete = { start_ms: window.windowStartMs, end_ms: window.windowEndMs, status: 'complete', fetched_at: new Date(END).toISOString() };
  assert.equal(needsFetch(window, null), true);
  assert.equal(needsFetch(window, complete), false);
  assert.equal(needsFetch(window, { ...complete, end_ms: window.windowEndMs + 1 }), true, 'Hevy edited the workout times');
  const empty = { ...complete, status: 'empty' };
  assert.equal(needsFetch(window, empty), true, 'an empty window is retried while data can still arrive');
  assert.equal(needsFetch(window, { ...empty, fetched_at: new Date(END + LATE_DATA_MS + 1).toISOString() }), false);
  assert.equal(needsFetch(window, { ...empty, fetched_at: 'never' }), true);
  assert.equal(needsFetch(null, null), false);
});

test('heart rate summaries clip to the workout and treat long gaps as missing coverage', () => {
  const samples = heartRateSamples();
  samples[10].value = 171;
  samples[20].value = 62;
  const summary = heartRateSummary(samples, START, END);
  assert.equal(summary.sample_count, 361);
  assert.equal(summary.max, 171);
  assert.equal(summary.min, 62);
  assert.equal(summary.avg, 100);
  assert.equal(summary.median_interval_ms, 10_000);
  assert.equal(summary.coverage, 1);

  // A dropout longer than max(3x median, 15 s) is not covered: 10 min 20 s of
  // the hour are missing once the samples at both edges are dropped too.
  const withGap = samples.filter((sample) => sample.atMs < START + 20 * MINUTE || sample.atMs > START + 30 * MINUTE);
  const gapped = heartRateSummary(withGap, START, END);
  assert.equal(gapped.coverage, 0.828);
  assert.equal(gapped.median_interval_ms, 10_000);

  // Samples in the padded window are charted but never counted in the summary.
  const padded = [...heartRateSamples({ from: START - 5 * MINUTE, to: START - 10_000, value: 200 }), ...samples];
  assert.deepEqual(heartRateSummary(padded, START, END), summary);
  assert.equal(heartRateSummary([], START, END), null);
  const single = heartRateSummary([{ metric: 'heart_rate', atMs: START + 1000, value: 120 }], START, END);
  assert.deepEqual(single, { avg: 120, max: 120, min: 120, coverage: 0, sample_count: 1, median_interval_ms: null });
});

test('zone minutes prorate edge intervals and report unzoned minutes as none', () => {
  const samples = [
    interval('zone', START - 30_000, 1, 'FAT_BURN'), // half of it is before the workout
    ...Array.from({ length: 20 }, (_, index) => interval('zone', START + (index + 1) * MINUTE, 1, 'CARDIO')),
    interval('zone', START + 40 * MINUTE, 1, 'PEAK'),
  ];
  assert.deepEqual(zoneMinutes(samples, START, END), { FAT_BURN: 1, CARDIO: 20, PEAK: 1, none: 39 });
  assert.equal(zoneMinutes([], START, END), null);

  // Google awards 2 active zone minutes for one minute in PEAK. The stored value
  // keeps that credit; zone minutes are wall-clock time, so one minute in PEAK
  // is one minute and the zones can never add up to more than the workout.
  const peak = [interval('zone', START, 2, 'PEAK'), interval('zone', START + MINUTE, 1, 'CARDIO')];
  assert.deepEqual(zoneMinutes(peak, START, END), { FAT_BURN: 0, CARDIO: 1, PEAK: 1, none: 58 });
  const allPeak = Array.from({ length: 60 }, (_, index) => interval('zone', START + index * MINUTE, 2, 'PEAK'));
  assert.deepEqual(zoneMinutes(allPeak, START, END), { FAT_BURN: 0, CARDIO: 0, PEAK: 60, none: 0 });

  // A stored interval with no width is the one minute the API reports.
  assert.deepEqual(zoneMinutes([interval('zone', START, 2, 'PEAK', null)], START, END).PEAK, 1);
});

test('exercise segments split the workout by set count and by routine rest when known', () => {
  const workout = workoutOf();
  const equal = estimateSegments(workout, { startMs: START, endMs: END });
  assert.deepEqual(equal.map((segment) => [segment.index, segment.title, segment.sets]), [[0, 'Barbell Back Squat', 2], [1, 'Cable Row', 4]]);
  assert.equal(equal[0].from_ms, START);
  assert.equal(equal[0].to_ms, START + 20 * MINUTE, 'two of six sets');
  assert.equal(equal[1].to_ms, END, 'the last segment ends with the workout');
  assert.equal(equal[0].heart_rate, null, 'no samples, no numbers');

  // 2 x (40 + 180) = 440 against 4 x (40 + 30) = 280 seconds of estimated work.
  const weighted = estimateSegments(workout, { startMs: START, endMs: END, restSeconds: new Map([[0, 180], [1, 30]]), heartRate: heartRateSamples({ step: 60_000 }) });
  assert.equal(weighted[0].to_ms, START + Math.round((60 * MINUTE * 440) / 720));
  assert.deepEqual(weighted[0].heart_rate, { avg: 100, max: 100 });
  assert.deepEqual(estimateSegments({ exercises: [] }, { startMs: START, endMs: END }), []);
});

test('summariseWorkout keeps the padded series, clips every number, and labels the estimate', () => {
  const samples = [
    ...heartRateSamples({ from: START - 5 * MINUTE, to: START - 10_000, value: 70 }),
    ...heartRateSamples({ value: 130 }),
    interval('steps', START - MINUTE, 100),           // entirely before the workout
    interval('steps', START + MINUTE, 100),
    interval('steps', END - 30_000, 100),             // half of it is after the workout
    interval('calories', START + MINUTE, 6.4),
    interval('zone', START + MINUTE, 1, 'CARDIO'),
  ];
  const result = summariseWorkout({ workout: workoutOf(), samples });
  assert.deepEqual(Object.keys(result.series).sort(), [...WORKOUT_METRIC_KEYS].sort());
  assert.deepEqual(result.window, { start_ms: START - 5 * MINUTE, end_ms: END + 10 * MINUTE });
  assert.equal(result.series.heart_rate.unit, 'bpm');
  assert.equal(result.series.heart_rate.samples.length, 391, 'the padded window is charted in full');
  assert.deepEqual(result.series.heart_rate.samples[0], [START - 5 * MINUTE, 70]);
  assert.equal(result.series.steps.interval_ms, MINUTE);
  assert.deepEqual(result.series.zone.samples, [[START + MINUTE, 1, 'CARDIO']]);
  assert.equal(result.summary.heart_rate.avg, 130, 'the warm-up pad is outside the summary');
  assert.equal(result.summary.steps, 150);
  assert.equal(result.summary.calories, 6);
  assert.deepEqual(result.summary.zones, { FAT_BURN: 0, CARDIO: 1, PEAK: 0, none: 59 });
  assert.equal(result.summary.duration_min, 60);
  assert.equal(result.estimated_segments, true);
  assert.equal(result.exercises.length, 2);
  assert.equal(summariseWorkout({ workout: { id: 'x' } }), null);

  const blank = blankMetrics(workoutOf());
  assert.deepEqual(blank.window, result.window);
  assert.deepEqual(blank.series.heart_rate, { unit: 'bpm', samples: [] });
  assert.deepEqual(blank.summary, { heart_rate: null, calories: null, steps: null, zones: null, duration_min: 60 });
  assert.deepEqual(blank.exercises, []);
  assert.deepEqual(blankMetrics(null).window, null);
});

test('overview rows carry training totals next to the metric summary', () => {
  const workout = workoutOf();
  const types = new Map([['t-squat', 'weight_reps'], ['t-row', 'weight_reps']]);
  assert.deepEqual(workoutTotals(workout, types), { exercise_count: 2, set_count: 5, volume_kg: 2900 });
  assert.equal(workoutTotals(workout, new Map([['t-squat', 'weight_reps'], ['t-row', 'cardio']])).volume_kg, 500, 'cardio templates are outside external load');
  const summary = summariseWorkout({ workout, samples: heartRateSamples({ value: 140 }) }).summary;
  const ready = overviewRow({ workout, status: 'ready', summary, templateTypes: types });
  assert.deepEqual(ready, {
    id: 'w1',
    title: 'Full Body 2',
    start_time: workout.start_time,
    end_time: workout.end_time,
    duration_min: 60,
    status: 'ready',
    exercise_count: 2,
    set_count: 5,
    volume_kg: 2900,
    heart_rate: { avg: 140, max: 140, min: 140, coverage: 1 },
    calories: null,
    steps: null,
    zones: null,
  });
  const unfetched = overviewRow({ workout, status: 'unfetched', templateTypes: types });
  assert.equal(unfetched.heart_rate, null);
  assert.equal(unfetched.set_count, 5, 'training totals do not need metrics');
  assert.deepEqual(coverageCounts([ready, unfetched, { status: 'empty' }, { status: 'not_connected' }]), { workouts: 4, with_metrics: 1, unfetched: 2, empty: 1 });
});
