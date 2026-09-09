import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/index.js';

async function runningApp(t) {
  const calls = { reviews: [], publishes: [] };
  const service = {
    getState: () => ({ mode: 'demo', workouts: [], routines: [], exerciseTemplates: [], programs: [], proposals: [], trainingProfile: { goals: '', equipment: '', constraints: '', schedule: '' } }),
    reviewProposal: async (id, value) => { calls.reviews.push({ id, value }); return { id, status: 'accepted' }; },
    publishLocalRoutine: async (id) => { calls.publishes.push(id); return { routine: { id } }; },
  };
  const app = createApp(service, { assistantToken: 'a'.repeat(64) });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  return { base: `http://127.0.0.1:${app.address().port}`, calls };
}

function post(url, body, headers = {}) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

test('assistant bearer is limited to strict MCP args envelopes', async (t) => {
  const { base, calls } = await runningApp(t);
  const bearer = { Authorization: `Bearer ${'a'.repeat(64)}` };

  assert.equal((await fetch(`${base}/api/assistant/tools/corpus_summary`)).status, 401);
  assert.equal((await post(`${base}/api/assistant/tools/corpus_summary`, { args: {} }, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await post(`${base}/api/assistant/tools/corpus_summary`, {}, bearer)).status, 400);
  assert.equal((await post(`${base}/api/assistant/tools/corpus_summary`, { args: {}, extra: true }, bearer)).status, 400);
  const tool = await post(`${base}/api/assistant/tools/corpus_summary`, { args: {} }, bearer);
  assert.equal(tool.status, 200);
  assert.equal((await tool.json()).mode, 'demo');

  assert.equal((await fetch(`${base}/api/session`, { headers: bearer })).status, 403);
  assert.equal((await post(`${base}/api/proposals/proposal-1/review`, { action: 'accept', expectedRevision: 1 }, bearer)).status, 403);
  assert.equal((await post(`${base}/api/local-routines/local-1/publish`, {}, bearer)).status, 403);
  assert.deepEqual(calls, { reviews: [], publishes: [] });
});

test('a browser session and CSRF token can review, while a missing token cannot', async (t) => {
  const { base, calls } = await runningApp(t);
  const denied = await post(`${base}/api/proposals/proposal-1/review`, { action: 'accept', expectedRevision: 1 });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, 'csrf_invalid');

  const session = await fetch(`${base}/api/session`);
  assert.equal(session.status, 200);
  const { csrfToken } = await session.json();
  const cookie = session.headers.get('set-cookie').split(';', 1)[0];
  const accepted = await post(`${base}/api/proposals/proposal-1/review`, { action: 'accept', expectedRevision: 1 }, { Cookie: cookie, 'X-Corpus-CSRF': csrfToken });
  assert.equal(accepted.status, 200);
  assert.deepEqual(calls.reviews, [{ id: 'proposal-1', value: { action: 'accept', expectedRevision: 1 } }]);
});
