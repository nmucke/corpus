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
