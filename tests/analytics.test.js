import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validDate, durationMinutes, filterByPeriod, weeklySeries, summarize, workoutVolume, templateMap, exerciseProgress } from '../public/analytics.js';

const templates = templateMap([
  { id: 'bench', type: 'weight_reps' },
  { id: 'assisted', type: 'bodyweight_assisted_reps' },
  { id: 'running', type: 'distance_duration' },
]);
const workout = (date, id = 'bench') => ({ start_time: date, exercises: [{ exercise_template_id: id, title: 'Same title', sets: [{ type: 'normal', weight_kg: 50, reps: 10 }, { type: 'warmup', weight_kg: 20, reps: 10 }] }] });

test('volume excludes warmups, assistance, cardio, absent values, and invalid data', () => {
  assert.equal(workoutVolume(workout('2026-09-09'), templates), 500);
  assert.equal(workoutVolume(workout('2026-09-09', 'assisted'), templates), 0);
  assert.equal(workoutVolume(workout('2026-09-09', 'running'), templates), 0);
  assert.equal(workoutVolume({ exercises: [{ sets: [{ weight_kg: null, reps: 10 }, { weight_kg: -3, reps: 10 }] }] }), 0);
});

test('week charts and totals use identical calendar boundaries including current partial week', () => {
  const now = new Date(2026, 8, 9, 12);
  const workouts = [workout(new Date(2026, 7, 17, 0).toISOString()), workout(new Date(2026, 8, 8).toISOString()), workout(new Date(2026, 7, 16, 23).toISOString()), workout(new Date(2026, 8, 10).toISOString())];
  const totals = summarize(workouts, '4', now, templates);
  const points = weeklySeries(workouts, '4', now, templates);
  assert.equal(points.length, 4);
  assert.equal(totals.workouts, 2);
  assert.equal(totals.workouts, points.reduce((sum, p) => sum + p.workouts, 0));
  assert.equal(totals.volumeKg, points.reduce((sum, p) => sum + p.volumeKg, 0));
  assert.equal(totals.consistency, 50);
  assert.equal(filterByPeriod(workouts, 'all', now).length, 3);
});

test('week buckets stay aligned across daylight saving changes', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Amsterdam';
  try {
    const workouts = [workout('2026-03-23T12:00:00+01:00'), workout('2026-03-30T12:00:00+02:00')];
    const points = weeklySeries(workouts, '4', new Date('2026-04-01T12:00:00+02:00'), templates);
    assert.equal(points.reduce((sum, p) => sum + p.workouts, 0), 2);
    assert.ok(points.every(p => p.start.getDay() === 1 && p.start.getHours() === 0));
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('exercise progress matches source IDs, with valid dates and durations', () => {
  assert.equal(exerciseProgress([workout('2026-09-09'), workout('2026-09-09', 'assisted')], 'bench', templates).length, 1);
  assert.equal(validDate(null), null);
  assert.equal(durationMinutes({ start_time: null, end_time: '2026-09-09' }), 0);
  assert.equal(durationMinutes({ start_time: '2026-09-09T12:00:00Z', end_time: '2026-09-09T13:00:00Z' }), 60);
  const repeated = workout('2026-09-09');
  repeated.exercises.push({ ...repeated.exercises[0], sets: [{ type: 'normal', weight_kg: 60, reps: 5 }] });
  const progress = exerciseProgress([repeated], 'bench', templates);
  assert.equal(progress.length, 1);
  assert.equal(progress[0].bestKg, 60);
  assert.equal(progress[0].volumeKg, 800);
});
