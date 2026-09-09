import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../server/service.js';

const requestId = '8b2a2c22-5394-4d87-8d9e-e8c7718cce11';
const template = { id: 'template-1', title: 'Back squat', type: 'weight_reps' };
const workout = { id: 'workout-1', title: 'Existing workout', start_time: '2026-01-01T10:00:00.000Z', end_time: '2026-01-01T11:00:00.000Z', exercises: [] };
const draft = (id = requestId) => ({
  requestId: id,
  title: 'Strength A',
  notes: 'Move with control.',
  exercises: [{ exercise_template_id: 'template-1', rest_seconds: 120, notes: 'Brace first.', sets: [{ type: 'normal', weight_kg: 80, reps: null, rep_range: { start: 5, end: 8 }, duration_seconds: null, distance_meters: null }] }],
});

function snapshotResponse(resource) {
  const values = { workouts: [workout], routines: [], exercise_templates: [template] };
  return new Response(JSON.stringify({ page: 1, page_count: 1, [resource]: values[resource] }));
}

async function serviceFor(t, post) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-routines-'));
  const calls = [];
  const service = await createService({ dataDir, fetchImpl: async (url, options = {}) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, options });
    if (options.method === 'POST') return post(options);
    return snapshotResponse(parsed.pathname.split('/').at(-1));
  } });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  await service.saveSettings({ apiKey: 'routine-test-key' });
  await service.sync();
  return { service, calls };
}

test('creates an exact canonical Hevy routine, caches it, and preserves workouts', async (t) => {
  let posted;
  const remote = { id: 'routine-new', title: 'Strength A', notes: 'Move with control.', folder_id: null, exercises: [{ index: 0, title: 'Back squat', exercise_template_id: 'template-1', superset_id: null, rest_seconds: 120, notes: 'Brace first.', sets: [{ index: 0, type: 'normal', weight_kg: 80, reps: null, rep_range: { start: 5, end: 8 }, duration_seconds: null, distance_meters: null }] }] };
  const { service, calls } = await serviceFor(t, async (options) => {
    posted = JSON.parse(options.body);
    return new Response(JSON.stringify({ routine: remote }), { status: 201 });
  });
  const result = await service.createRoutine(draft());
  assert.deepEqual(posted, { routine: { title: 'Strength A', notes: 'Move with control.', folder_id: null, exercises: [{ exercise_template_id: 'template-1', superset_id: null, rest_seconds: 120, notes: 'Brace first.', sets: [{ type: 'normal', weight_kg: 80, reps: null, rep_range: { start: 5, end: 8 }, duration_seconds: null, distance_meters: null }] }] } });
  const postCall = calls.find((call) => call.options.method === 'POST');
  assert.equal(postCall.url.pathname, '/v1/routines');
  assert.equal(postCall.options.headers['api-key'], 'routine-test-key');
  assert.equal(postCall.options.headers['content-type'], 'application/json');
  assert.equal(result.routine.id, 'routine-new');
  const state = service.getState();
  assert.deepEqual(state.workouts.map((item) => item.id), ['workout-1']);
  assert.ok(state.routines.some((item) => item.id === 'routine-new'));
});

test('routine publications are idempotent across repeated request ids', async (t) => {
  let posts = 0;
  const { service } = await serviceFor(t, async () => {
    posts += 1;
    return new Response(JSON.stringify({ id: 'routine-idempotent', title: 'Strength A', exercises: [] }), { status: 201 });
  });
  const first = await service.createRoutine(draft());
  const second = await service.createRoutine(draft());
  assert.equal(posts, 1);
  assert.deepEqual(second, first);
  await assert.rejects(service.createRoutine({ ...draft(), title: 'Changed title' }), (error) => error.code === 'request_conflict' && error.status === 409);
});

test('invalid and demo-mode requests do not call Hevy', async (t) => {
  let calls = 0;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-routine-validate-'));
  const service = await createService({ dataDir, fetchImpl: async () => { calls += 1; throw new Error('should not fetch'); } });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  await service.saveSettings({ apiKey: 'routine-test-key' });
  await assert.rejects(service.createRoutine(draft()), { code: 'live_mode_required' });
  assert.equal(calls, 0);
  await service.setDemo(false);
  await assert.rejects(service.createRoutine({ ...draft(), requestId: 'not-a-uuid' }), { code: 'validation' });
  await assert.rejects(service.createRoutine({ ...draft(), exercises: [{ ...draft().exercises[0], exercise_template_id: 'demo-squat' }] }), { code: 'validation' });
  assert.equal(calls, 0);
});

test('ambiguous publication is persisted and never reposted automatically', async (t) => {
  let posts = 0;
  const { service } = await serviceFor(t, async () => { posts += 1; throw new TypeError('offline'); });
  await assert.rejects(service.createRoutine(draft()), (error) => error.code === 'publication_uncertain' && error.message === 'Hevy may have created this routine. Sync/check Hevy before trying again.');
  await assert.rejects(service.createRoutine(draft()), { code: 'publication_uncertain' });
  assert.equal(posts, 1);
});

test('a known Hevy rejection removes the ledger record so the corrected same request id can publish', async (t) => {
  let posts = 0;
  const { service } = await serviceFor(t, async () => {
    posts += 1;
    if (posts === 1) return new Response(JSON.stringify({ error: 'bad routine' }), { status: 400 });
    return new Response(JSON.stringify({ id: 'corrected-routine', title: 'Corrected', exercises: [] }), { status: 201 });
  });
  await assert.rejects(service.createRoutine(draft()), { code: 'routine_rejected' });
  const result = await service.createRoutine({ ...draft(), title: 'Corrected' });
  assert.equal(result.routine.id, 'corrected-routine');
  assert.equal(posts, 2);
});

test('successful request ids survive a service restart and malformed local cache returns a warning without reposting', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-routine-restart-'));
  let posts = 0;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST') {
      posts += 1;
      // A valid remote id but malformed exercises makes the optional cache fail.
      return new Response(JSON.stringify({ id: 'cache-warning', title: 'Strength A', exercises: {} }), { status: 201 });
    }
    return snapshotResponse(new URL(url).pathname.split('/').at(-1));
  };
  const first = await createService({ dataDir, fetchImpl });
  t.after(async () => { await rm(dataDir, { recursive: true, force: true }); });
  await first.saveSettings({ apiKey: 'routine-test-key' });
  await first.sync();
  const result = await first.createRoutine(draft());
  assert.match(result.warning, /could not cache/i);
  first.close();
  const reopened = await createService({ dataDir, fetchImpl });
  t.after(() => reopened.close());
  const repeat = await reopened.createRoutine(draft());
  assert.equal(repeat.routine.id, 'cache-warning');
  assert.equal(posts, 1);
});

test('invalid set forms are rejected before a routine POST', async (t) => {
  let posts = 0;
  const { service } = await serviceFor(t, async () => { posts += 1; return new Response('{}', { status: 500 }); });
  const invalids = [
    { ...draft(), exercises: [{ ...draft().exercises[0], sets: [{ ...draft().exercises[0].sets[0], rep_range: { start: 8, end: 5 } }] }] },
    { ...draft(), exercises: [{ ...draft().exercises[0], sets: [{ ...draft().exercises[0].sets[0], weight_kg: Infinity }] }] },
    { ...draft(), exercises: [{ ...draft().exercises[0], sets: [{ ...draft().exercises[0].sets[0], type: 'cardio' }] }] },
  ];
  for (const body of invalids) await assert.rejects(service.createRoutine(body), { code: 'validation' });
  assert.equal(posts, 0);
});
