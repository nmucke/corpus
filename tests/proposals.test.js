import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createService, entityHash } from '../server/service.js';

const ids = ['31a3fa09-5bc1-4c09-86bb-3530f8dbaf51', 'a7d3fa09-5bc1-4c09-86bb-3530f8dbaf52', 'c1d3fa09-5bc1-4c09-86bb-3530f8dbaf53', 'd1d3fa09-5bc1-4c09-86bb-3530f8dbaf54'];
async function demoService(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-proposal-'));
  const service = await createService({ dataDir });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return service;
}
function routine(key = 'new-lower') {
  return { key, routine: { title: 'AI Lower', notes: 'Controlled tempo.', exercises: [{ exercise_template_id: 'demo-squat', rest_seconds: 120, sets: [{ type: 'normal', weight_kg: 80, reps: 5 }] }] } };
}
function draft(requestId, extra = {}) {
  return { requestId, title: 'Four week lower focus', rationale: 'Build confidence with a modest squat progression.', routines: [routine()], programs: [{ key: 'block', program: { title: 'Lower block', description: '', start_date: null, duration_weeks: null, days: [{ label: 'Monday', routineKey: 'new-lower' }] } }], ...extra };
}

const remoteTemplate = { id: 'template-1', title: 'Squat', type: 'weight_reps' };
const remoteTemplateTwo = { id: 'template-2', title: 'Deadlift', type: 'weight_reps' };
const remoteTemplateThree = { id: 'template-3', title: 'Row', type: 'weight_reps' };
const remoteRoutine = {
  id: 'remote-1', title: 'Remote lower', notes: null, folder_id: 7,
  exercises: [{ index: 0, title: 'Squat', exercise_template_id: remoteTemplate.id, superset_id: 3, rest_seconds: 90, notes: null,
    sets: [{ index: 0, type: 'normal', weight_kg: 100, reps: 5, rep_range: { start: null, end: null }, duration_seconds: 0, distance_meters: null, custom_metric: 12 }] }],
};

async function liveService(t, { routines = [remoteRoutine], templates = [remoteTemplate], handler = async () => new Response('{}', { status: 500 }) } = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-proposal-live-'));
  const calls = []; let currentRoutines = routines;
  const service = await createService({ dataDir, fetchImpl: async (url, options = {}) => {
    calls.push({ url: new URL(url), options });
    if (options.method === 'POST' || options.method === 'PUT') return handler(url, options);
    const resource = new URL(url).pathname.split('/').at(-1);
    return new Response(JSON.stringify({ page: 1, page_count: 1, [resource]: resource === 'routines' ? currentRoutines : resource === 'exercise_templates' ? templates : [] }));
  } });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  await service.saveSettings({ apiKey: 'test-key-123' }); await service.sync();
  return { service, calls, dataDir, setRoutines: (value) => { currentRoutines = value; } };
}

function editRoutineDraft(requestId, target, title = 'Edited lower') {
  return { requestId, title: 'Edit remote routine', rationale: 'A small edit.', programs: [], routines: [{ key: 'edit', targetId: target.id, baseHash: entityHash(target), routine: { title, exercises: target.exercises.map((exercise) => ({ exercise_template_id: exercise.exercise_template_id, notes: exercise.notes, rest_seconds: exercise.rest_seconds, sets: exercise.sets.map(({ type, weight_kg, reps, rep_range, duration_seconds, distance_meters }) => ({ type, weight_kg, reps, rep_range, duration_seconds, distance_meters })) })) } }] };
}

test('drafts are visible, validate templates, and acceptance is local and atomic', async (t) => {
  const service = await demoService(t);
  const proposal = await service.submitProposal(draft(ids[0]));
  assert.equal(proposal.status, 'draft');
  assert.equal(service.getState().proposals[0].id, proposal.id);
  assert.equal(service.getState().routines.some((value) => value.title === 'AI Lower'), false);
  const accepted = await service.reviewProposal(proposal.id, { action: 'accept', expectedRevision: 1 });
  const localId = accepted.result.routineIds['new-lower'];
  assert.match(localId, /^local-/);
  const state = service.getState();
  assert.equal(state.routines.find((value) => value.id === localId).source, 'local');
  assert.equal(state.programs.find((value) => value.id === accepted.result.programIds.block).days[0].routineId, localId);
  await assert.rejects(service.publishLocalRoutine(localId), { code: 'live_mode_required' });
  await assert.rejects(service.submitProposal(draft(ids[1], { routines: [routine('bad')], programs: [], title: 'Bad', rationale: 'Nope', requestId: ids[1], ...{ routines: [{ key: 'bad', routine: { title: 'Bad', exercises: [{ exercise_template_id: 'made-up', sets: [{ type: 'normal', reps: 1 }] }] } }] } })), { code: 'validation' });
});

test('declined drafts are immutable and requested revisions replace only the next revision', async (t) => {
  const service = await demoService(t);
  const proposal = await service.submitProposal(draft(ids[0]));
  await service.reviewProposal(proposal.id, { action: 'request_revision', expectedRevision: 1, feedback: 'Use fewer sets.' });
  const revised = await service.submitProposal(draft(ids[1], { id: proposal.id, expectedRevision: 1, title: 'Revised lower focus' }));
  assert.equal(revised.revision, 2);
  assert.equal(service.getProposal(proposal.id).history.length, 2);
  await service.reviewProposal(proposal.id, { action: 'decline', expectedRevision: 2 });
  await assert.rejects(service.submitProposal(draft(ids[2], { id: proposal.id, expectedRevision: 2 })), { code: 'proposal_immutable' });
});

test('target hashes and review revisions reject stale edits', async (t) => {
  const service = await demoService(t);
  const current = service.getState().routines[0];
  const body = draft(ids[0], { routines: [{ key: 'edit', targetId: current.id, baseHash: entityHash(current), routine: { title: 'Edited', exercises: current.exercises.map((exercise) => ({ exercise_template_id: exercise.exercise_template_id, notes: exercise.notes, rest_seconds: exercise.rest_seconds, sets: exercise.sets.map(({ type, weight_kg, reps, rep_range, duration_seconds, distance_meters }) => ({ type, weight_kg, reps, rep_range, duration_seconds, distance_meters })) })) } }], programs: [] });
  const proposal = await service.submitProposal(body);
  // A separate accepted local change makes the visible target different.
  const other = await service.submitProposal(draft(ids[1], { routines: [{ key: 'other', targetId: current.id, baseHash: entityHash(current), routine: body.routines[0].routine }], programs: [] }));
  await service.reviewProposal(other.id, { action: 'accept', expectedRevision: 1 });
  await assert.rejects(service.reviewProposal(proposal.id, { action: 'accept', expectedRevision: 1 }), { code: 'stale_target' });
  await assert.rejects(service.reviewProposal(proposal.id, { action: 'decline', expectedRevision: 2 }), { code: 'revision_conflict' });
});

test('AI routine reordering carries hidden metadata by template occurrence, never by index', async (t) => {
  const target = {
    id: 'reorder-1', title: 'Metadata source', notes: 'Keep folder.', folder_id: 17,
    exercises: [
      { index: 0, title: 'Squat', exercise_template_id: remoteTemplate.id, superset_id: 8, rest_seconds: 90, notes: 'Squat note', sets: [{ index: 0, type: 'normal', reps: 5, custom_metric: 18 }] },
      { index: 1, title: 'Deadlift', exercise_template_id: remoteTemplateTwo.id, superset_id: 9, rest_seconds: 120, notes: 'Deadlift note', sets: [{ index: 0, type: 'normal', reps: 6, custom_metric: 29 }] },
    ],
  };
  const { service } = await liveService(t, { routines: [target], templates: [remoteTemplate, remoteTemplateTwo, remoteTemplateThree] });
  const proposal = await service.submitProposal({ requestId: ids[0], title: 'Reordered', rationale: 'Put deadlifts first.', programs: [], routines: [{ key: 'edit', targetId: target.id, baseHash: entityHash(target), routine: { title: 'Reordered', exercises: [
    { exercise_template_id: remoteTemplateTwo.id, sets: [{ type: 'normal', reps: 6 }] },
    { exercise_template_id: remoteTemplate.id, sets: [{ type: 'normal', reps: 5 }] },
    { exercise_template_id: remoteTemplateThree.id, sets: [{ type: 'normal', reps: 10 }] },
  ] } }] });
  const after = proposal.routines[0].after;
  assert.equal(after.folder_id, 17);
  assert.equal(after.exercises[0].notes, 'Deadlift note');
  assert.equal(after.exercises[0].superset_id, 9);
  assert.equal(after.exercises[0].sets[0].custom_metric, 29);
  assert.equal(after.exercises[1].notes, 'Squat note');
  assert.equal(after.exercises[1].superset_id, 8);
  assert.equal(after.exercises[1].sets[0].custom_metric, 18);
  assert.equal(after.exercises[2].notes, '');
  assert.equal(after.exercises[2].superset_id, null);
  assert.equal(after.exercises[2].sets[0].custom_metric, null);
});

test('proposal schedules reject impossible calendar dates before storage', async (t) => {
  const service = await demoService(t);
  await assert.rejects(service.submitProposal(draft(ids[0], { routines: [], programs: [{ key: 'invalid-date', program: { title: 'Invalid date', start_date: '2026-02-31', duration_weeks: 4, days: [{ label: 'Monday', routineId: 'demo-routine-lower' }] } }] })), { code: 'validation' });
  assert.equal(service.getState().proposals.length, 0);
});

test('publishing an accepted live local routine creates once and remaps program days', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-proposal-live-'));
  let posts = 0;
  const template = { id: 'template-1', title: 'Squat' };
  const service = await createService({ dataDir, fetchImpl: async (url, options = {}) => {
    if (options.method === 'POST') {
      posts += 1;
      return new Response(JSON.stringify({ routine: { ...JSON.parse(options.body).routine, id: 'remote-new' } }), { status: 201 });
    }
    const resource = new URL(url).pathname.split('/').at(-1);
    return new Response(JSON.stringify({ page: 1, page_count: 1, [resource]: resource === 'exercise_templates' ? [template] : [] }));
  } });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  await service.saveSettings({ apiKey: 'test-key-123' }); await service.sync();
  const proposal = await service.submitProposal({ requestId: ids[0], title: 'Live draft', rationale: 'A new routine.', routines: [{ key: 'local', routine: { title: 'Local', exercises: [{ exercise_template_id: template.id, sets: [{ type: 'normal', reps: 5 }] }] } }], programs: [{ key: 'p', program: { title: 'Plan', start_date: null, duration_weeks: null, days: [{ label: 'Mon', routineKey: 'local' }] } }] });
  const accepted = await service.reviewProposal(proposal.id, { action: 'accept', expectedRevision: 1 });
  const localId = accepted.result.routineIds.local;
  const published = await service.publishLocalRoutine(localId);
  assert.equal(published.routine.id, 'remote-new');
  assert.equal(posts, 1);
  assert.equal(service.getState().programs[0].days[0].routineId, 'remote-new');
  const replay = await service.publishLocalRoutine(localId);
  assert.equal(replay.routine.id, 'remote-new');
  assert.equal(posts, 1);
});

test('proposals and request ids do not cross demo and live modes', async (t) => {
  const { service } = await liveService(t);
  await service.setDemo(true);
  const proposal = await service.submitProposal(draft(ids[0]));
  await service.setDemo(false);
  await assert.rejects(Promise.resolve().then(() => service.getProposal(proposal.id)), { code: 'not_found' });
  await assert.rejects(service.reviewProposal(proposal.id, { action: 'decline', expectedRevision: 1 }), { code: 'not_found' });
  await assert.rejects(service.submitProposal({ requestId: ids[1], id: proposal.id, expectedRevision: 1, title: 'Live revision', rationale: 'Valid live content.', routines: [{ key: 'live', routine: { title: 'Live', exercises: [{ exercise_template_id: remoteTemplate.id, sets: [{ type: 'normal', reps: 5 }] }] } }], programs: [] }), { code: 'not_found' });
  await assert.rejects(service.submitProposal(draft(ids[0])), { code: 'request_conflict' });
  await service.setDemo(true);
  assert.equal(service.getProposal(proposal.id).status, 'draft');
});

test('proposal requests replay their original revision and reject changed content', async (t) => {
  const service = await demoService(t);
  const first = await service.submitProposal(draft(ids[0]));
  await service.reviewProposal(first.id, { action: 'request_revision', expectedRevision: 1 });
  const revised = await service.submitProposal(draft(ids[1], { id: first.id, expectedRevision: 1, title: 'Revision two' }));
  const replay = await service.submitProposal(draft(ids[0]));
  assert.equal(replay.revision, 1);
  assert.equal(revised.revision, 2);
  await assert.rejects(service.submitProposal(draft(ids[0], { title: 'Same id, altered body' })), { code: 'request_conflict' });
});

test('proposal history and rationale markdown survive a service restart', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-proposal-restart-'));
  let service = await createService({ dataDir });
  const first = await service.submitProposal(draft(ids[0]));
  await service.reviewProposal(first.id, { action: 'request_revision', expectedRevision: 1, feedback: 'Revise this.' });
  await service.submitProposal(draft(ids[1], { id: first.id, expectedRevision: 1, rationale: 'The second rationale.' }));
  service.close();
  service = await createService({ dataDir });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  const saved = service.getProposal(first.id);
  assert.equal(saved.revision, 2);
  assert.equal(saved.history.length, 2);
  assert.equal(saved.history[0].status, 'revision_requested');
  assert.equal(await readFile(path.join(dataDir, 'proposals', first.id, 'revision-1.md'), 'utf8'), 'Build confidence with a modest squat progression.\n');
  assert.equal(await readFile(path.join(dataDir, 'proposals', first.id, 'revision-2.md'), 'utf8'), 'The second rationale.\n');
});

test('a failed multi-entity accept rolls back all accepted local changes', async (t) => {
  const { service, setRoutines } = await liveService(t);
  const proposal = await service.submitProposal({ requestId: ids[0], title: 'Two entities', rationale: 'Both must apply.', routines: [{ key: 'new', routine: { title: 'AI Lower', exercises: [{ exercise_template_id: remoteTemplate.id, sets: [{ type: 'normal', reps: 5 }] }] } }], programs: [{ key: 'program', program: { title: 'Needs remote', start_date: null, duration_weeks: null, days: [{ label: 'Monday', routineId: remoteRoutine.id }] } }] });
  setRoutines([]); await service.sync();
  await assert.rejects(service.reviewProposal(proposal.id, { action: 'accept', expectedRevision: 1 }), { code: 'validation' });
  assert.equal(service.getState().routines.some((item) => item.title === 'AI Lower'), false);
  assert.equal(service.getState().programs.length, 0);
  assert.equal(service.getProposal(proposal.id).status, 'draft');
});

test('an accepted Hevy edit stays local until explicit PUT and preserves hidden metadata', async (t) => {
  let sent;
  const { service, calls } = await liveService(t, { handler: async (_url, options) => {
    sent = JSON.parse(options.body).routine;
    return new Response(JSON.stringify({ routine: { ...remoteRoutine, title: sent.title } }), { status: 200 });
  } });
  const target = service.getState().routines.find((item) => item.id === remoteRoutine.id);
  const proposal = await service.submitProposal(editRoutineDraft(ids[0], target));
  const accepted = await service.reviewProposal(proposal.id, { action: 'accept', expectedRevision: 1 });
  assert.equal(calls.filter(({ options }) => options.method === 'PUT').length, 0);
  assert.equal(service.getState().routines.find((item) => item.id === target.id).title, 'Edited lower');
  await service.publishLocalRoutine(accepted.result.routineIds.edit);
  assert.equal(calls.filter(({ options }) => options.method === 'PUT').length, 1);
  assert.equal(sent.folder_id, 7);
  assert.equal(sent.exercises[0].superset_id, 3);
  assert.equal(sent.exercises[0].sets[0].custom_metric, 12);
  assert.equal(sent.exercises[0].notes, null);
});

test('a second accepted edit of the same Hevy routine performs a second PUT', async (t) => {
  let puts = 0;
  const { service } = await liveService(t, { handler: async (_url, options) => {
    puts += 1;
    const title = JSON.parse(options.body).routine.title;
    return new Response(JSON.stringify({ routine: { ...remoteRoutine, title } }), { status: 200 });
  } });
  const firstTarget = service.getState().routines[0];
  const first = await service.submitProposal(editRoutineDraft(ids[0], firstTarget, 'First edit'));
  await service.publishLocalRoutine((await service.reviewProposal(first.id, { action: 'accept', expectedRevision: 1 })).result.routineIds.edit);
  const secondTarget = service.getState().routines.find((routine) => routine.id === remoteRoutine.id);
  const second = await service.submitProposal(editRoutineDraft(ids[1], secondTarget, 'Second edit'));
  await service.publishLocalRoutine((await service.reviewProposal(second.id, { action: 'accept', expectedRevision: 1 })).result.routineIds.edit);
  assert.equal(puts, 2);
  assert.equal(service.getState().routines.find((routine) => routine.id === remoteRoutine.id).title, 'Second edit');
});

test('editing an accepted but unpublished local routine still publishes it with one POST', async (t) => {
  let posts = 0; let puts = 0;
  const { service } = await liveService(t, { routines: [], handler: async (_url, options) => {
    if (options.method === 'POST') posts += 1;
    if (options.method === 'PUT') puts += 1;
    const sent = JSON.parse(options.body).routine;
    return new Response(JSON.stringify({ routine: { ...sent, id: 'remote-local-edit' } }), { status: options.method === 'POST' ? 201 : 200 });
  } });
  const first = await service.submitProposal({ requestId: ids[0], title: 'New local', rationale: 'Draft it.', routines: [{ key: 'local', routine: { title: 'First local', exercises: [{ exercise_template_id: remoteTemplate.id, sets: [{ type: 'normal', reps: 5 }] }] } }], programs: [] });
  const localId = (await service.reviewProposal(first.id, { action: 'accept', expectedRevision: 1 })).result.routineIds.local;
  const local = service.getState().routines.find((routine) => routine.id === localId);
  const second = await service.submitProposal(editRoutineDraft(ids[1], local, 'Second local'));
  await service.publishLocalRoutine((await service.reviewProposal(second.id, { action: 'accept', expectedRevision: 1 })).result.routineIds.edit);
  assert.equal(posts, 1);
  assert.equal(puts, 0);
});

test('accepting another edit is rejected while a Hevy edit publication is pending', async (t) => {
  const { service } = await liveService(t, { handler: async (_url, options) => new Response(JSON.stringify({ routine: { ...remoteRoutine, title: JSON.parse(options.body).routine.title } }), { status: 200 }) });
  const firstTarget = service.getState().routines[0];
  const first = await service.submitProposal(editRoutineDraft(ids[0], firstTarget, 'Publishing edit'));
  const firstLocalId = (await service.reviewProposal(first.id, { action: 'accept', expectedRevision: 1 })).result.routineIds.edit;
  const secondTarget = service.getState().routines.find((routine) => routine.id === remoteRoutine.id);
  const second = await service.submitProposal(editRoutineDraft(ids[1], secondTarget, 'Blocked edit'));
  // Queue the review while publication has claimed the overlay but before its
  // remote PUT is queued. This is the only interleaving the write serializer
  // permits, and it must not replace an in-flight local plan.
  const publishing = service.publishLocalRoutine(firstLocalId);
  await assert.rejects(service.reviewProposal(second.id, { action: 'accept', expectedRevision: 1 }), { code: 'publication_pending' });
  await publishing;
  assert.equal(service.getState().routines.find((routine) => routine.id === remoteRoutine.id).title, 'Publishing edit');
});

test('a sync change after accepting an Hevy edit prevents its publication', async (t) => {
  let puts = 0;
  const { service, setRoutines } = await liveService(t, { handler: async () => { puts += 1; return new Response('{}'); } });
  const target = service.getState().routines[0];
  const proposal = await service.submitProposal(editRoutineDraft(ids[0], target));
  const accepted = await service.reviewProposal(proposal.id, { action: 'accept', expectedRevision: 1 });
  setRoutines([{ ...remoteRoutine, title: 'Changed in Hevy' }]); await service.sync();
  await assert.rejects(service.publishLocalRoutine(accepted.result.routineIds.edit), { code: 'stale_target' });
  assert.equal(puts, 0);
});

test('an ambiguous local publication is never retried', async (t) => {
  let posts = 0;
  const { service } = await liveService(t, { routines: [], handler: async () => { posts += 1; throw new TypeError('offline'); } });
  const proposal = await service.submitProposal({ requestId: ids[0], title: 'Offline', rationale: 'Try later.', routines: [{ key: 'local', routine: { title: 'Offline local', exercises: [{ exercise_template_id: remoteTemplate.id, sets: [{ type: 'normal', reps: 5 }] }] } }], programs: [] });
  const accepted = await service.reviewProposal(proposal.id, { action: 'accept', expectedRevision: 1 });
  const localId = accepted.result.routineIds.local;
  await assert.rejects(service.publishLocalRoutine(localId), { code: 'publication_uncertain' });
  await assert.rejects(service.publishLocalRoutine(localId), { code: 'publication_uncertain' });
  assert.equal(posts, 1);
});

test('a publication cache warning is retained for an idempotent local publish replay', async (t) => {
  let posts = 0;
  const { service } = await liveService(t, { routines: [], handler: async () => {
    posts += 1;
    return new Response(JSON.stringify({ routine: { id: 'remote-warning', title: 'Cache warning', exercises: {} } }), { status: 201 });
  } });
  const proposal = await service.submitProposal({ requestId: ids[0], title: 'Warn', rationale: 'Cache response warning.', routines: [{ key: 'local', routine: { title: 'Cache warning', exercises: [{ exercise_template_id: remoteTemplate.id, sets: [{ type: 'normal', reps: 5 }] }] } }], programs: [] });
  const accepted = await service.reviewProposal(proposal.id, { action: 'accept', expectedRevision: 1 });
  const localId = accepted.result.routineIds.local;
  const first = await service.publishLocalRoutine(localId);
  assert.match(first.warning, /could not cache/i);
  const replay = await service.publishLocalRoutine(localId);
  assert.deepEqual(replay, first);
  assert.equal(posts, 1);
});
