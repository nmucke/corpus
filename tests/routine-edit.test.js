import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../server/service.js';
import { routinePayload } from '../public/routine-builder.js';

const requestId = '7b2a2c22-5394-4d87-8d9e-e8c7718cce11';
const routine = {
  id: 'routine-1', title: 'Old title', notes: null, folder_id: 9,
  exercises: [{ index: 0, title: 'Squat', exercise_template_id: 'template-1', superset_id: 4, rest_seconds: 0, notes: null,
    sets: [{ index: 0, type: 'normal', weight_kg: 0, reps: 5, rep_range: { start: null, end: null }, duration_seconds: 0, distance_meters: null, custom_metric: 12 }] }],
};
const template = { id: 'template-1', title: 'Squat', type: 'weight_reps' };

function snapshot(url) {
  const resource = new URL(url).pathname.split('/').at(-1);
  return new Response(JSON.stringify({ page: 1, page_count: 1, [resource]: resource === 'routines' ? [routine] : resource === 'exercise_templates' ? [template] : [] }));
}

async function serviceFor(t, handler, { readBack = routine } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-routine-edit-'));
  const calls = [];
  const service = await createService({ dataDir, fetchImpl: async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    if (options.method === 'PUT') return handler(options);
    if (new URL(url).pathname === `/v1/routines/${routine.id}`) return new Response(JSON.stringify({ routine: readBack }));
    return snapshot(url);
  } });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  await service.saveSettings({ apiKey: 'routine-edit-key' });
  await service.sync();
  return { service, calls };
}

test('updates the same routine with PUT and preserves nullable and hidden metadata', async (t) => {
  let sent;
  const remote = { ...routine, title: 'New title' };
  const { service, calls } = await serviceFor(t, async (options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ routine: remote }), { status: 200 });
  });
  const program = await service.saveProgram({ title: 'Weekly plan', days: [{ label: 'Monday', routineId: routine.id }] });
  const result = await service.updateRoutine('routine-1', { requestId, title: 'New title' });
  const put = calls.find(({ options }) => options.method === 'PUT');
  assert.equal(put.url.pathname, '/v1/routines/routine-1');
  assert.equal(put.options.headers['api-key'], 'routine-edit-key');
  assert.equal(sent.routine.folder_id, 9);
  assert.equal(sent.routine.notes, null);
  assert.equal(sent.routine.exercises[0].superset_id, 4);
  assert.equal(sent.routine.exercises[0].sets[0].custom_metric, 12);
  assert.equal(sent.routine.exercises[0].sets[0].weight_kg, 0);
  assert.equal(Object.hasOwn(sent.routine.exercises[0].sets[0], 'rep_range'), false);
  assert.equal(result.routine.id, 'routine-1');
  assert.equal(service.getState().routines[0].title, 'New title');
  assert.deepEqual(service.getState().programs[0], program);
  await service.updateRoutine('routine-1', { requestId, title: 'New title' });
  assert.equal(calls.filter(({ options }) => options.method === 'PUT').length, 1);
  assert.equal(calls.filter(({ options }) => options.method === 'POST').length, 0);
});

test('does not repeat an uncertain edit', async (t) => {
  let puts = 0;
  const { service } = await serviceFor(t, async () => { puts += 1; throw new TypeError('offline'); });
  const body = { requestId, title: 'New title' };
  await assert.rejects(service.updateRoutine('routine-1', body), (error) => error.code === 'publication_uncertain' && /saved these changes/.test(error.message));
  await assert.rejects(service.updateRoutine('routine-1', body), { code: 'publication_uncertain' });
  assert.equal(puts, 1);
  assert.equal(service.getState().routines[0].title, 'Old title');
});

test('rejects demo mode, missing local routines, and remote routine 404 without writing', async (t) => {
  let puts = 0;
  const { service } = await serviceFor(t, async () => { puts += 1; return new Response('{}', { status: 404 }); });
  await assert.rejects(service.updateRoutine('missing', { requestId, title: 'Nope' }), (error) => error.code === 'not_found' && error.status === 404);
  await assert.rejects(service.updateRoutine('routine-1', { requestId, title: 'Gone' }), (error) => error.code === 'routine_not_found' && error.status === 404);
  assert.equal(service.getState().routines[0].title, 'Old title');
  assert.equal(puts, 1);
  await service.setDemo(true);
  await assert.rejects(service.updateRoutine('routine-1', { requestId, title: 'Demo' }), { code: 'live_mode_required' });
  assert.equal(puts, 1);
});

test('reordered editor metadata preserves explicit nulls and pound conversions', async (t) => {
  let sent;
  const { service } = await serviceFor(t, async options => {
    sent = JSON.parse(options.body).routine;
    return new Response(JSON.stringify({ ...sent, id: routine.id }), { status: 200 });
  });
  const values = [
    { id: template.id, rest: '', notes: null, superset_id: null, sets: [{ type: 'normal', weight: '0', reps: '', repEnd: '', duration: '', distance: '', customMetric: null }] },
    { id: template.id, rest: '0', notes: null, superset_id: 4, sets: [{ type: 'normal', weight: '220.46226218', reps: '5', repEnd: '8', duration: '0', distance: '', customMetric: 12 }] },
  ];
  await service.updateRoutine(routine.id, { requestId, ...routinePayload('Reordered', null, values, 'lb', routine) });
  assert.equal(sent.folder_id, 9);
  assert.equal(sent.exercises[0].superset_id, null);
  assert.equal(sent.exercises[0].rest_seconds, null);
  assert.equal(sent.exercises[0].sets[0].custom_metric, null);
  assert.equal(sent.exercises[0].sets[0].weight_kg, 0);
  assert.equal(sent.exercises[1].superset_id, 4);
  assert.equal(sent.exercises[1].sets[0].custom_metric, 12);
  assert.ok(Math.abs(sent.exercises[1].sets[0].weight_kg - 100) < 0.00001);
  assert.deepEqual(sent.exercises[1].sets[0].rep_range, { start: 5, end: 8 });
});

test('an update response for a different routine cannot overwrite the local record', async t => {
  const { service } = await serviceFor(t, async () => new Response(JSON.stringify({ ...routine, id: 'wrong-id' }), { status: 200 }));
  await assert.rejects(service.updateRoutine(routine.id, { requestId, title: 'Changed' }), { code: 'publication_uncertain' });
  assert.deepEqual(service.getState().routines.map(r => r.id), [routine.id]);
  assert.equal(service.getState().routines[0].title, 'Old title');
});

test('surfaces Hevy routine validation details for rejected edits', async (t) => {
  const { service } = await serviceFor(t, async () => new Response(JSON.stringify({ error: 'Expected object, received null' }), { status: 400 }));
  await assert.rejects(
    service.updateRoutine(routine.id, { requestId, title: 'Rejected edit' }),
    (error) => error.code === 'routine_rejected' && error.status === 400 && error.message === 'Hevy rejected this routine: Expected object, received null',
  );
});

test('treats a bodyless 2xx PUT as confirmed and caches the submitted routine', async (t) => {
  let puts = 0;
  const { service } = await serviceFor(t, async () => {
    puts += 1;
    return new Response(null, { status: 204 });
  });
  const result = await service.updateRoutine(routine.id, { requestId, title: 'Confirmed without body' });
  assert.equal(result.routine.id, routine.id);
  assert.equal(result.routine.title, 'Confirmed without body');
  assert.equal(result.routine.exercises[0].title, template.title);
  assert.equal(service.getState().routines[0].title, 'Confirmed without body');
  await service.updateRoutine(routine.id, { requestId, title: 'Confirmed without body' });
  assert.equal(puts, 1);
});

test('verifies an ambiguous PUT by reading Hevy and never retries the write', async (t) => {
  let puts = 0;
  const readBack = { ...routine, title: 'Committed before disconnect' };
  const { service, calls } = await serviceFor(t, async () => {
    puts += 1;
    throw new TypeError('connection closed after write');
  }, { readBack });
  const result = await service.updateRoutine(routine.id, { requestId, title: readBack.title });
  assert.equal(result.routine.title, readBack.title);
  assert.equal(service.getState().routines[0].title, readBack.title);
  assert.equal(puts, 1);
  assert.equal(calls.filter(({ url, options }) => !options.method && url.pathname === `/v1/routines/${routine.id}`).length, 1);
});
