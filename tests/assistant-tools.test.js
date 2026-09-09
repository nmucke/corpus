import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ASSISTANT_TOOLS, AssistantToolError, callAssistantTool, entityHash } from '../server/assistant-tools.js';
import { createService } from '../server/service.js';

const routine = {
  id: 'r1', title: 'Lower', notes: 'Private notes that are still bounded.', exercises: [{ index: 0, title: 'Squat', exercise_template_id: 'e1', notes: 'brace', rest_seconds: 120, sets: Array.from({ length: 12 }, (_, index) => ({ index, type: 'normal', weight_kg: 100, reps: 5 })) }],
};
const program = { id: 'p1', title: 'Three days', description: 'Consistent work', start_date: null, duration_weeks: null, days: [{ label: 'Monday', routineId: 'r1' }] };
const state = {
  mode: 'live', settings: { hasApiKey: true, privateToken: 'do-not-leak' }, trainingProfile: { summary: 'Intermediate lifter', goals: ['strength'] }, exerciseTemplates: [{ id: 'e1', title: 'Barbell Squat', primary_muscle_group: 'quadriceps', secondary_muscle_groups: ['glutes'], equipment: 'Barbell', type: 'weight_reps' }], routines: [routine], programs: [program], workouts: [{ id: 'w1', routine_id: 'r1', start_time: new Date().toISOString(), exercises: [{ exercise_template_id: 'e1', sets: [{ weight_kg: 100, reps: 5, type: 'normal' }] }] }], proposals: [{ id: '11111111-1111-4111-8111-111111111111', revision: 1, status: 'draft', title: 'Draft' }],
};
function service(overrides = {}) { return { getState: () => state, getProposal: async (id) => id === 'x' ? { id: 'x', revision: 2, feedback: 'keep it easy' } : null, submitProposal: async (draft) => ({ id: draft.id ?? '22222222-2222-4222-8222-222222222222', revision: 1, status: 'draft', title: draft.title, internal: 'excluded' }), ...overrides }; }

test('assistant tools expose bounded data and no settings secrets', async () => {
  const summary = await callAssistantTool(service(), 'corpus_summary', {});
  assert.equal(summary.profile.summary, 'Intermediate lifter');
  assert.equal(JSON.stringify(summary).includes('do-not-leak'), false);
  const detail = await callAssistantTool(service(), 'corpus_get_routine', { id: 'r1', setLimit: 10 });
  assert.equal(detail.exercises[0].sets.length, 10);
  assert.equal(detail.exercises[0].setPage.nextOffset, 10);
  assert.equal(detail.baseHash, entityHash(routine));
});

test('assistant tools reject unknown arguments and never expose approval tools', async () => {
  await assert.rejects(callAssistantTool(service(), 'corpus_list_routines', { nope: true }), AssistantToolError);
  assert.deepEqual(ASSISTANT_TOOLS.filter((tool) => /approve|decline|publish|settings|sync/i.test(tool.name)), []);
  await assert.rejects(callAssistantTool(service(), 'corpus_submit_proposal', { requestId: 'not-a-uuid', title: 'x', rationale: 'y', routines: [], programs: [] }), AssistantToolError);
});

test('proposal submission returns only a review acknowledgement and fixed workflows cannot read paths', async () => {
  const result = await callAssistantTool(service(), 'corpus_submit_proposal', { requestId: '33333333-3333-4333-8333-333333333333', title: 'Draft', rationale: 'Use available data.', routines: [], programs: [{ key: 'p', program: {} }] });
  assert.deepEqual(result, { id: '22222222-2222-4222-8222-222222222222', revision: 1, status: 'draft', title: 'Draft' });
  const workflow = await callAssistantTool(service(), 'corpus_workflow', { name: 'corpus-analyze-training' });
  assert.match(workflow.instructions, /corpus_summary/);
  await assert.rejects(callAssistantTool(service(), 'corpus_workflow', { name: '../private' }), AssistantToolError);
});

test('workout summary uses the same working external-load volume definition as analytics', async () => {
  const now = new Date().toISOString();
  const scopedState = {
    ...state,
    exerciseTemplates: [
      { id: 'load', title: 'Loaded', type: 'weight_reps' },
      { id: 'assist', title: 'Assisted', type: 'assisted' },
      { id: 'cardio', title: 'Cardio', type: 'cardio' },
    ],
    workouts: [{ id: 'summary', start_time: now, exercises: [
      { exercise_template_id: 'load', sets: [{ type: 'warmup', weight_kg: 100, reps: 5 }, { type: 'normal', weight_kg: 100, reps: 5 }] },
      { exercise_template_id: 'assist', sets: [{ type: 'normal', weight_kg: 200, reps: 10 }] },
      { exercise_template_id: 'cardio', sets: [{ type: 'normal', weight_kg: 200, reps: 10 }] },
    ] }],
  };
  const result = await callAssistantTool({ getState: () => scopedState }, 'corpus_workout_summary', { weeks: 1 });
  assert.equal(result.workouts, 1);
  assert.equal(result.workingSets, 3);
  assert.equal(result.externalLoadSets, 1);
  assert.equal(result.volumeKg, 500);
  assert.equal(result.progress.length, 1);
  assert.equal(result.progress[0].workouts, 1);
  assert.equal(result.progress[0].volumeKg, 500);
});

test('profile fields and large proposal entities are retrieved in bounded pages', async () => {
  const constraints = 'x'.repeat(1800);
  const after = { title: 'Large draft', notes: 'n'.repeat(3000), exercises: Array.from({ length: 2 }, (_, index) => ({ title: `Exercise ${index}`, exercise_template_id: 'e1', notes: 'e'.repeat(3000), sets: Array.from({ length: 12 }, () => ({ type: 'normal', weight_kg: 20, reps: 8 })) })) };
  const proposal = { id: 'proposal', revision: 2, status: 'revision_requested', title: 'Draft', rationale: 'r'.repeat(1800), feedback: 'Use less volume.', routines: [{ key: 'new', before: null, after }], programs: [], history: [] };
  const paged = { ...state, trainingProfile: { constraints, goals: '', equipment: '', schedule: '' } };
  const fake = { getState: () => paged, getProposal: async () => proposal };
  const preview = await callAssistantTool(fake, 'corpus_get_profile', {});
  assert.equal(preview.profile.constraintsTruncated, true);
  const profile = await callAssistantTool(fake, 'corpus_get_profile', { field: 'constraints', offset: 1200, limit: 1000 });
  assert.equal(profile.value.length, 600);
  const summary = await callAssistantTool(fake, 'corpus_get_proposal', { id: 'proposal' });
  assert.equal(summary.routineChanges[0].key, 'new');
  const detail = await callAssistantTool(fake, 'corpus_get_proposal', { id: 'proposal', kind: 'routine', index: 0, offset: 1, setOffset: 10, setLimit: 10 });
  assert.equal(detail.entity.after.exercises.length, 1);
  assert.equal(detail.entity.after.exercises[0].sets.length, 2);
  assert.equal(detail.entity.after.exercises[0].setPage.nextOffset, null);
  assert.ok(Buffer.byteLength(JSON.stringify(detail)) <= 12 * 1024);
  const unicode = await callAssistantTool({ getState: () => ({ ...paged, trainingProfile: { constraints: '😀'.repeat(2000) } }) }, 'corpus_get_profile', { field: 'constraints', limit: 2000 });
  assert.equal(unicode.value.length, 2000);
  assert.ok(Buffer.byteLength(JSON.stringify(unicode)) <= 12 * 1024);
  const submit = ASSISTANT_TOOLS.find((tool) => tool.name === 'corpus_submit_proposal').inputSchema;
  assert.equal(submit.properties.routines.items.properties.routine.properties.exercises.items.properties.sets.items.properties.type.type, 'string');
});

test('muscle coverage preserves primary and secondary roles from the shared UI helper', async () => {
  const coverageState = {
    ...state,
    exerciseTemplates: [{ id: 'e1', title: 'Row', primary_muscle_group: 'upper_back', secondary_muscle_groups: ['biceps', 'upper_back'] }],
    routines: [{ id: 'coverage', title: 'Coverage', exercises: [{ exercise_template_id: 'e1', title: 'Row', sets: [{ type: 'warmup' }, { type: 'normal' }, { type: 'normal' }] }] }],
  };
  const result = await callAssistantTool({ getState: () => coverageState }, 'corpus_muscle_coverage', { routineId: 'coverage' });
  assert.deepEqual(result.muscles, [
    { id: 'biceps', label: 'Biceps', primaryExercises: 0, secondaryExercises: 1, primaryWorkingSets: 0, secondaryWorkingSets: 2 },
    { id: 'upper_back', label: 'Upper back', primaryExercises: 1, secondaryExercises: 0, primaryWorkingSets: 2, secondaryWorkingSets: 0 },
  ]);
});

test('paged routine detail supplies the exact target hash required for a real proposal edit', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-assistant-tools-'));
  const real = await createService({ dataDir });
  t.after(async () => { real.close(); await rm(dataDir, { recursive: true, force: true }); });
  await real.saveSettings({ apiKey: 'assistant-tools-private-key' });
  const target = real.getState().routines[0];
  const detail = await callAssistantTool(real, 'corpus_get_routine', { id: target.id, limit: 10, setLimit: 10 });
  assert.equal(detail.baseHash, entityHash(target));
  const proposal = await callAssistantTool(real, 'corpus_submit_proposal', {
    requestId: '44444444-4444-4444-8444-444444444444', title: 'A bounded edit', rationale: 'Keep the same routine after reviewing its bounded detail.', programs: [],
    routines: [{ key: 'edit', targetId: detail.id, baseHash: detail.baseHash, routine: {
      title: detail.title,
      exercises: detail.exercises.map((exercise) => ({ exercise_template_id: exercise.exercise_template_id, notes: exercise.notes, rest_seconds: exercise.rest_seconds, sets: exercise.sets })),
    } }],
  });
  assert.equal(proposal.status, 'draft');
  assert.equal(JSON.stringify(await callAssistantTool(real, 'corpus_summary', {})).includes('assistant-tools-private-key'), false);
});
