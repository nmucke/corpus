import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routinePayload } from '../public/routine-builder.js';

test('routine builder converts pounds to kg, preserves zero and null targets, and creates rep ranges', () => {
  const payload = routinePayload('Upper', 'Slow tempo', [{ id: 'bench', rest: '90', notes: '', sets: [
    { type: 'normal', weight: '220.46226218', reps: '8', repEnd: '12', duration: '', distance: '' },
    { type: 'warmup', weight: '0', reps: '10', repEnd: '', duration: '0', distance: '' },
  ] }], 'lb');
  const [working, warmup] = payload.exercises[0].sets;
  assert.ok(Math.abs(working.weight_kg - 100) < 0.00001);
  assert.deepEqual(working.rep_range, { start: 8, end: 12 });
  assert.equal(working.reps, null);
  assert.equal(working.duration_seconds, null);
  assert.equal(warmup.weight_kg, 0);
  assert.equal(warmup.reps, 10);
  assert.equal(warmup.rep_range, null);
  assert.equal(payload.exercises[0].exercise_template_id, 'bench');
});
