import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../server/service.js';

async function withService(t, fetchImpl) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-backend-'));
  const service = await createService({ dataDir, fetchImpl });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { service, dataDir };
}

const workout = (id, title = 'Session') => ({ id, title, routine_id: 'r1', start_time: '2026-01-02T10:00:00.000Z', end_time: '2026-01-02T11:00:00.000Z', exercises: [{ index: 0, title: 'Squat', exercise_template_id: 't1', notes: 'deep', sets: [{ index: 0, type: 'normal', weight_kg: 100, reps: 5, rpe: 8 }] }] });
const routine = { id: 'r1', title: 'Strength', folder_id: null, exercises: [{ index: 0, title: 'Squat', exercise_template_id: 't1', notes: 'controlled', rest_seconds: 120, sets: [{ index: 0, type: 'normal', rep_range: { start: 5, end: 8 } }] }] };
const template = { id: 't1', title: 'Squat', primary_muscle_group: 'quadriceps' };

function pagedFetch(data) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url);
    calls.push({ path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), key: options.headers['api-key'] });
    const resource = parsed.pathname.split('/').at(-1);
    const page = Number(parsed.searchParams.get('page'));
    const pages = data[resource];
    if (!pages?.[page - 1]) return new Response(JSON.stringify({ page, page_count: pages?.length ?? 0, [resource]: [] }));
    return new Response(JSON.stringify({ page, page_count: pages.length, [resource]: pages[page - 1] }));
  };
  return { fetchImpl, calls };
}

test('defaults to isolated realistic demo data and persists private settings', async (t) => {
  const { service, dataDir } = await withService(t, async () => { throw new Error('not called'); });
  const before = service.getState();
  assert.equal(before.mode, 'demo');
  assert.equal(before.workouts.length, 30);
  assert.equal(before.routines.length, 4);
  await service.saveSettings({ apiKey: 'a-safe-test-key', unit: 'lb' });
  const after = service.getState();
  assert.deepEqual(after.settings, { unit: 'lb', hasApiKey: true, lastSync: null, googleHealth: { hasClient: false, connected: false, lastSync: null } });
  assert.equal((await stat(path.join(dataDir, 'settings.json'))).mode & 0o777, 0o600);
  await assert.rejects(service.saveSettings({ unit: 'stone' }), { code: 'validation' });
  await service.saveSettings({ apiKey: '' });
  assert.equal(service.getState().settings.hasApiKey, true, 'an empty key field keeps the stored key');
  await service.saveSettings({ clearApiKey: true });
  assert.equal(service.getState().settings.hasApiKey, false, 'clearApiKey forgets the stored key');
  assert.equal(service.getState().workouts.length, 30, 'clearing the key keeps data');
  await service.saveSettings({ apiKey: 'a-safe-test-key' });
});

test('sync paginates Hevy resources, is idempotent, and reconciles deletions', async (t) => {
  const data = { workouts: [[workout('w1')], [workout('w2', 'Second')]], routines: [[routine]], exercise_templates: [[template]] };
  const mock = pagedFetch(data);
  const { service } = await withService(t, mock.fetchImpl);
  await service.saveSettings({ apiKey: 'a-safe-test-key' });
  let state = await service.sync();
  assert.equal(state.mode, 'live');
  assert.deepEqual(state.workouts.map((item) => item.id).sort(), ['w1', 'w2']);
  assert.equal(state.routines[0].exercises[0].sets[0].rep_range.start, 5);
  assert.equal(mock.calls.find((call) => call.path.endsWith('/workouts')).query.pageSize, '10');
  assert.equal(mock.calls.find((call) => call.path.endsWith('/exercise_templates')).query.pageSize, '100');
  assert.ok(mock.calls.every((call) => call.key === 'a-safe-test-key'));
  data.workouts = [[workout('w2', 'Second revised')]];
  state = await service.sync();
  assert.deepEqual(state.workouts.map((item) => item.id), ['w2']);
  assert.equal(state.workouts[0].title, 'Second revised');
});

test('a malformed nested snapshot rolls back prior writes and leaves live data untouched', async (t) => {
  const data = { workouts: [[workout('w1')]], routines: [[routine]], exercise_templates: [[template]] };
  const mock = pagedFetch(data);
  let responder = mock.fetchImpl;
  const { service } = await withService(t, (...args) => responder(...args));
  await service.saveSettings({ apiKey: 'a-safe-test-key' });
  await service.sync();
  const original = service.getState().workouts;
  const failingFetch = async (url) => {
    const resource = new URL(url).pathname.split('/').at(-1);
    const payload = resource === 'workouts' ? [workout('w2'), { ...workout('w3'), exercises: {} }] : resource === 'routines' ? [routine] : [template];
    return new Response(JSON.stringify({ page: 1, page_count: 1, [resource]: payload }));
  };
  responder = failingFetch;
  await assert.rejects(service.sync(), TypeError);
  assert.deepEqual(service.getState().workouts.map((item) => item.id), original.map((item) => item.id));
});

test('Hevy empty-account, duplicate-id, invalid-key, and rate-limit responses are handled safely', async (t) => {
  const empty = async (url) => {
    const resource = new URL(url).pathname.split('/').at(-1);
    return new Response(JSON.stringify({ page: 1, page_count: 0, [resource]: [] }));
  };
  const { service } = await withService(t, empty);
  await service.saveSettings({ apiKey: 'a-safe-test-key' });
  const emptyState = await service.sync();
  assert.equal(emptyState.mode, 'live');
  assert.equal(emptyState.workouts.length, 0);

  const duplicate = async (url) => {
    const resource = new URL(url).pathname.split('/').at(-1);
    const payload = resource === 'workouts' ? [workout('same'), workout('same')] : resource === 'routines' ? [routine] : [template];
    return new Response(JSON.stringify({ page: 1, page_count: 1, [resource]: payload }));
  };
  const duplicateDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-duplicate-'));
  const duplicateService = await createService({ dataDir: duplicateDir, fetchImpl: duplicate });
  t.after(async () => { duplicateService.close(); await rm(duplicateDir, { recursive: true, force: true }); });
  await duplicateService.saveSettings({ apiKey: 'a-safe-test-key' });
  await assert.rejects(duplicateService.sync(), { code: 'bad_response' });

  for (const [httpStatus, code] of [[401, 'invalid_key'], [429, 'rate_limited']]) {
    const blockedDir = await mkdtemp(path.join(os.tmpdir(), `corpus-${code}-`));
    const blocked = await createService({ dataDir: blockedDir, fetchImpl: async () => new Response('', { status: httpStatus }) });
    t.after(async () => { blocked.close(); await rm(blockedDir, { recursive: true, force: true }); });
    await blocked.saveSettings({ apiKey: 'secret-that-must-not-leak' });
    await assert.rejects(blocked.sync(), (error) => error.code === code && !error.message.includes('secret-that-must-not-leak'));
  }
});

test('programs remain scoped to the selected data mode and export has no secret', async (t) => {
  const { service, dataDir } = await withService(t, async () => { throw new Error('not called'); });
  const demoRoutine = service.getState().routines[0].id;
  const program = await service.saveProgram({ title: 'Demo week', description: 'Build consistency', days: [{ label: 'Monday', routineId: demoRoutine }] });
  assert.equal(service.getState().programs[0].id, program.id);
  await service.setDemo(false);
  assert.equal(service.getState().programs.length, 0);
  await service.setDemo(true);
  assert.equal(service.getState().programs.length, 1);
  await service.saveSettings({ apiKey: 'private-test-secret' });
  const result = await service.exportMarkdown();
  assert.deepEqual(result.files, ['exports/workouts.md', 'exports/routines.md', 'exports/overview.md', 'exports/programs.md', 'exports/metrics.md', 'exports/supplements.md']);
  const output = await readFile(path.join(dataDir, 'exports', 'overview.md'), 'utf8');
  assert.match(output, /Demo data/);
  assert.doesNotMatch(output, /private-test-secret/);
});
