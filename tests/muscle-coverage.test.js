import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMuscleCoverage, MAPPED_MUSCLES } from '../public/muscle-coverage.js';
import { FRONT_REGIONS, BACK_REGIONS } from '../public/body-anatomy.js';

const exerciseTemplates = [
  { id: 'back', title: 'Back Extension', primary_muscle_group: 'lower_back', secondary_muscle_groups: ['hamstrings', 'glutes', 'Lower Back', 'glutes'] },
  { id: 'hinge', title: 'Romanian Deadlift', primary_muscle_group: 'hamstrings', secondary_muscle_groups: ['glutes', 'lower_back'] },
  { id: 'bridge', title: 'Glute Bridge', primary_muscle_group: 'glutes', secondary_muscle_groups: [] },
  { id: 'cardio', title: 'Run', primary_muscle_group: 'cardio' },
];
const exercise = (id, title, sets) => ({ exercise_template_id: id, title, sets });
const routine = { id: 'lower', title: 'Lower', exercises: [
  exercise('back', 'Back Extension', [{ type: 'warmup' }, { type: 'normal' }, { type: 'normal' }, { type: 'failure' }]),
  exercise('hinge', 'Romanian Deadlift', [{ type: 'normal' }, { type: 'dropset' }]),
  exercise('bridge', 'Glute Bridge', []),
] };
const row = (result, id) => result.muscles.find(muscle => muscle.id === id);
const counts = (muscle) => [muscle.primaryExercises, muscle.secondaryExercises, muscle.primarySets, muscle.secondarySets];

test('routine coverage distinguishes direct and secondary work without double counting muscle tags', () => {
  const result = buildMuscleCoverage({ routine, exerciseTemplates });
  assert.equal(result.scope, 'routine');
  assert.equal(result.dayCount, 1);
  assert.equal(result.exerciseCount, 3);
  assert.equal(result.workingSetCount, 5);
  assert.equal(result.missingRoutineCount, 0);
  assert.equal(result.missingTemplateCount, 0);
  assert.deepEqual(counts(row(result, 'lower_back')), [1, 1, 3, 2]);
  assert.deepEqual(counts(row(result, 'hamstrings')), [1, 1, 2, 3]);
  assert.deepEqual(counts(row(result, 'glutes')), [1, 2, 0, 5]);
  assert.equal(row(result, 'glutes').contributions.length, 3);
  assert.deepEqual(row(result, 'lower_back').contributions.map(c => [c.exerciseTitle, c.role, c.sets]), [['Back Extension', 'primary', 3], ['Romanian Deadlift', 'secondary', 2]]);
});

test('program coverage counts each listed day once including repeated routines, independent of block duration', () => {
  const cardio = { id: 'run', title: 'Conditioning', exercises: [exercise('cardio', 'Run', [{ type: 'normal' }])] };
  const program = { title: 'Plan', duration_weeks: 8, days: [
    { label: 'Monday', routineId: 'lower' }, { label: 'Thursday', routineId: 'lower' },
    { label: 'Saturday', routineId: 'run' }, { label: 'Missing', routineId: 'gone' },
  ] };
  const result = buildMuscleCoverage({ program, routines: [routine, cardio], exerciseTemplates });
  assert.equal(result.scope, 'program');
  assert.equal(result.dayCount, 4);
  assert.equal(result.exerciseCount, 7);
  assert.equal(result.workingSetCount, 11);
  assert.equal(result.missingRoutineCount, 1);
  assert.deepEqual(counts(row(result, 'glutes')), [2, 4, 0, 10]);
  assert.deepEqual([...new Set(row(result, 'glutes').contributions.map(c => c.dayLabel))], ['Monday', 'Thursday']);
  assert.deepEqual(buildMuscleCoverage({ program: { ...program, duration_weeks: 12 }, routines: [routine, cardio], exerciseTemplates }), result);
});

test('template matching uses IDs, repeated exercise entries count separately, and warmups do not count as working sets', () => {
  const result = buildMuscleCoverage({ routine: { title: 'Repeated', exercises: [
    exercise('back', 'Different display title', [{type:'warmup'}]),
    exercise('back', 'Second block', [{type:'normal'}]),
    exercise('missing', 'Back Extension', [{type:'normal'}]),
  ] }, exerciseTemplates });
  assert.equal(result.exerciseCount, 3);
  assert.equal(result.workingSetCount, 2);
  assert.equal(result.missingTemplateCount, 1);
  assert.deepEqual(counts(row(result, 'lower_back')), [2, 0, 1, 0]);
  assert.equal(row(result, 'lower_back').contributions.length, 2);
});

test('non-anatomical and unknown categories remain in the breakdown rather than becoming guessed body regions', () => {
  const ids = ['cardio', 'full_body', 'other', 'rotator_cuff'];
  const templates = ids.map(id => ({id, primary_muscle_group:id}));
  const result = buildMuscleCoverage({ routine: { exercises: ids.map(id => exercise(id, id, [{type:'normal'}])) }, exerciseTemplates: templates });
  for (const id of ids) {
    assert.equal(row(result, id).primaryExercises, 1);
    assert.equal(MAPPED_MUSCLES.includes(id), false);
  }
  assert.equal(new Set(MAPPED_MUSCLES).size, 17);
  for (const id of ['triceps', 'neck', 'abductors', 'adductors', 'lower_back']) assert.equal(MAPPED_MUSCLES.includes(id), true);
});

test('empty routines and programs return usable zero coverage', () => {
  for (const input of [{routine:{exercises:[]}}, {program:{days:[]}}]) {
    const result = buildMuscleCoverage(input);
    assert.equal(result.exerciseCount, 0);
    assert.equal(result.workingSetCount, 0);
    assert.equal(result.missingTemplateCount, 0);
    assert.equal(result.muscles.every(muscle => counts(muscle).every(count => count === 0) && muscle.contributions.length === 0), true);
  }
});

test('templates without muscle metadata are reported separately from missing templates', () => {
  const result = buildMuscleCoverage({ routine: { exercises: [
    exercise('untagged', 'Untagged', [{type:'normal'}]),
    exercise('missing', 'Missing', []),
  ] }, exerciseTemplates: [{id:'untagged',title:'Untagged',secondary_muscle_groups:[]}] });
  assert.equal(result.missingTemplateCount, 1);
  assert.equal(result.missingMuscleCount, 1);
  assert.equal(result.exerciseCount, 2);
  assert.equal(result.workingSetCount, 1);
  assert.equal(result.muscles.every(muscle => counts(muscle).every(count => count === 0)), true);
});

test('every anatomical category has a front or back region', () => {
  const drawn = new Set([...Object.keys(FRONT_REGIONS), ...Object.keys(BACK_REGIONS)]);
  assert.deepEqual([...drawn].sort(), [...MAPPED_MUSCLES].sort());
});
