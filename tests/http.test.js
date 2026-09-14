import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApp } from '../server/index.js';

test('local HTTP interface blocks foreign origins, rebinding, invalid JSON, and private files', async (t) => {
  const calls = [];
  const publications = [];
  const edits = [];
  const app = createApp({ getState: () => ({ mode: 'live' }), saveSettings: (value) => { calls.push(value); return { ok: true }; }, createRoutine: (value) => {
    publications.push(value);
    if (value.title === 'Uncertain') throw Object.assign(new Error('Check Hevy before retrying.'), { status: 502, code: 'publication_uncertain' });
    return { routine: { id: 'new-routine', title: value.title } };
  }, updateRoutine: (id, value) => { edits.push({ id, value }); return { routine: { id, title: value.title } }; } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/api/state`)).json(), { mode: 'live' });
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/state`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' })).status, 400);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{"unit":"kg"}' })).status, 200);
  assert.deepEqual(calls, [{ unit: 'kg' }]);
  const created = await fetch(`${base}/api/routines`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Strength"}' });
  assert.equal(created.status, 200);
  assert.deepEqual(await created.json(), { routine: { id: 'new-routine', title: 'Strength' } });
  assert.deepEqual(publications, [{ title: 'Strength' }]);
  const uncertain = await fetch(`${base}/api/routines`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Uncertain"}' });
  assert.equal(uncertain.status, 502);
  assert.equal((await uncertain.json()).code, 'publication_uncertain');
  const edited = await fetch(`${base}/api/routines/existing-routine`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{"title":"Revised strength"}' });
  assert.equal(edited.status, 200);
  assert.deepEqual(await edited.json(), { routine: { id: 'existing-routine', title: 'Revised strength' } });
  assert.deepEqual(edits, [{ id: 'existing-routine', value: { title: 'Revised strength' } }]);
  assert.equal((await fetch(`${base}/api/routines/existing-routine`, { method: 'PUT', body: '{}' })).status, 415);
  assert.equal((await fetch(`${base}/api/routines/existing-routine`, { method: 'PUT', headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal(edits.length, 1);
  assert.equal((await fetch(`${base}/api/demo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"enabled":"yes"}' })).status, 400);
  for (const path of ['/data/settings.json', '/server/service.js', '/%2e%2e%2fserver%2fservice.js']) assert.equal((await fetch(base + path)).status, 404);
});

test('workout metric routes read, sync, and report an unknown workout', async (t) => {
  const notFound = (id) => Object.assign(new Error('Workout was not found.'), { status: 404, code: 'workout_not_found', id });
  const syncs = [];
  const known = new Set(['w1', 'w 2']);
  const app = createApp({
    getState: () => ({ mode: 'live' }),
    getWorkoutMetrics: (id) => {
      if (!known.has(id)) throw notFound(id);
      // Missing samples are a status, never a 404.
      return { mode: 'live', workout: { id }, status: syncs.some((call) => call.workoutIds.includes(id)) ? 'ready' : 'unfetched', series: { heart_rate: { unit: 'bpm', samples: [] } } };
    },
    syncWorkoutMetrics: (options) => { syncs.push(options); return { fetched: 1, empty: 0, failed: [], warnings: [] }; },
    getWorkoutMetricsOverview: ({ days }) => ({ mode: 'live', range: { from: '2026-06-12', to: '2026-09-10' }, coverage: { workouts: 1, with_metrics: 0, unfetched: 1, empty: 0 }, days }),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;

  const unfetched = await fetch(`${base}/api/workouts/w1/metrics`);
  assert.equal(unfetched.status, 200);
  assert.deepEqual(await unfetched.json(), { mode: 'live', workout: { id: 'w1' }, status: 'unfetched', series: { heart_rate: { unit: 'bpm', samples: [] } } });

  const missing = await fetch(`${base}/api/workouts/nope/metrics`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'Workout was not found.', code: 'workout_not_found' });

  // No request body is required, and the response is the workout's metrics.
  const synced = await fetch(`${base}/api/workouts/w%202/metrics/sync`, { method: 'POST' });
  assert.equal(synced.status, 200);
  assert.equal((await synced.json()).status, 'ready');
  assert.deepEqual(syncs, [{ workoutIds: ['w 2'], budget: 1 }], 'ids are decoded and the budget is one window');
  assert.equal((await fetch(`${base}/api/workouts/nope/metrics/sync`, { method: 'POST' })).status, 404);

  const overview = await fetch(`${base}/api/metrics/workouts?days=30`);
  assert.equal(overview.status, 200);
  assert.deepEqual(await overview.json(), { mode: 'live', range: { from: '2026-06-12', to: '2026-09-10' }, coverage: { workouts: 1, with_metrics: 0, unfetched: 1, empty: 0 }, days: 30 });
  assert.equal((await (await fetch(`${base}/api/metrics/workouts`)).json()).days, 90);
  assert.equal((await fetch(`${base}/api/workouts/w1/metrics`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/workouts/w1/metrics/sync`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(syncs.length, 2, 'the cross-site sync never reached the service');
});

test('supplement routes read doses, save, log, and delete without confusing ids', async (t) => {
  const calls = [];
  const record = (name, ...args) => { calls.push([name, ...args]); return { ok: name }; };
  const app = createApp({
    getState: () => ({ mode: 'live' }),
    getSupplementDoses: ({ days }) => ({ mode: 'live', range: { from: '2026-06-12', to: '2026-09-10' }, doses: [], days }),
    saveSupplement: (payload) => { calls.push(['saveSupplement', payload]); return { id: 's1', name: payload.name }; },
    deleteSupplement: (id) => record('deleteSupplement', id),
    logDose: (id, payload) => { calls.push(['logDose', id, payload]); return { dose: { id: 'd1', supplement_id: id } }; },
    deleteDose: (id) => record('deleteDose', id),
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const jsonHeaders = { 'Content-Type': 'application/json' };

  const doses = await fetch(`${base}/api/supplements/doses?days=30`);
  assert.equal(doses.status, 200);
  assert.equal((await doses.json()).days, 30);
  assert.equal((await (await fetch(`${base}/api/supplements/doses`)).json()).days, 90, 'days defaults to 90');

  const saved = await fetch(`${base}/api/supplements`, { method: 'POST', headers: jsonHeaders, body: '{"name":"Creatine"}' });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { id: 's1', name: 'Creatine' });

  const logged = await fetch(`${base}/api/supplements/s%201/doses`, { method: 'POST', headers: jsonHeaders, body: '{"amount":5}' });
  assert.equal(logged.status, 200);
  assert.deepEqual(await logged.json(), { dose: { id: 'd1', supplement_id: 's 1' } });
  assert.equal((await fetch(`${base}/api/supplements/s1/doses`, { method: 'POST', body: '{}' })).status, 415);

  // The literal `doses` segment must never be read as a supplement id.
  const removedDose = await fetch(`${base}/api/supplements/doses/abc`, { method: 'DELETE' });
  assert.equal(removedDose.status, 200);
  assert.deepEqual(await removedDose.json(), { ok: 'deleteDose' });
  const removed = await fetch(`${base}/api/supplements/s%201`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: 'deleteSupplement' });

  assert.deepEqual(calls, [
    ['saveSupplement', { name: 'Creatine' }],
    ['logDose', 's 1', { amount: 5 }],
    ['deleteDose', 'abc'],
    ['deleteSupplement', 's 1'],
  ], 'ids are decoded and deleteSupplement never saw the doses path');

  assert.equal((await fetch(`${base}/api/supplements/doses/abc/extra`, { method: 'DELETE' })).status, 404);
  assert.equal((await fetch(`${base}/api/supplements/nope`, { method: 'PUT', headers: jsonHeaders, body: '{}' })).status, 404);
  assert.equal((await fetch(`${base}/api/supplements/doses`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal(calls.length, 4, 'the cross-site read never reached the service');
});
