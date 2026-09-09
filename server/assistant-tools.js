import { readFile } from 'node:fs/promises';
import { entityHash as canonicalEntityHash } from './proposals.js';
import { filterByPeriod, isExternalLoadExercise, isWorkingSet, setVolume, templateMap, weeklySeries } from '../public/analytics.js';
import { buildMuscleCoverage } from '../public/muscle-coverage.js';

const MAX_RESULT_BYTES = 12 * 1024;
const MAX_NOTE_LENGTH = 400;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKFLOW_FILES = Object.freeze({
  'corpus-analyze-training': new URL('../assistant/.agents/skills/corpus-analyze-training/SKILL.md', import.meta.url),
  'corpus-design-routine': new URL('../assistant/.agents/skills/corpus-design-routine/SKILL.md', import.meta.url),
  'corpus-design-program': new URL('../assistant/.agents/skills/corpus-design-program/SKILL.md', import.meta.url),
  'corpus-revise-proposal': new URL('../assistant/.agents/skills/corpus-revise-proposal/SKILL.md', import.meta.url),
});

export class AssistantToolError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AssistantToolError';
    this.code = code;
    this.status = status;
  }
}

/** Hash the representation exposed to an assistant, never a private database row. */
export function entityHash(entity) {
  return canonicalEntityHash(entity);
}

function object(value, label = 'Arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AssistantToolError('validation', `${label} must be an object.`);
  return value;
}
function only(value, keys, label = 'Arguments') {
  object(value, label);
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new AssistantToolError('validation', `${label} contains an unsupported field.`);
}
function text(value, label, { required = false, max = 160 } = {}) {
  if (value == null && !required) return null;
  if (typeof value !== 'string') throw new AssistantToolError('validation', `${label} must be text.`);
  const result = value.trim();
  if (required && !result) throw new AssistantToolError('validation', `${label} is required.`);
  if (result.length > max) throw new AssistantToolError('validation', `${label} is too long.`);
  return result;
}
function integer(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new AssistantToolError('validation', `${label} must be an integer from ${min} to ${max}.`);
  return value;
}
function boundedPage(args, { limit = 10, maximum = 20 } = {}) {
  return { offset: integer(args.offset, 'offset', { fallback: 0 }), limit: integer(args.limit, 'limit', { min: 1, max: maximum, fallback: limit }) };
}
function matching(value, query) { return !query || String(value ?? '').toLocaleLowerCase().includes(query.toLocaleLowerCase()); }
function page(items, offset, limit) {
  const selected = items.slice(offset, offset + limit);
  return { items: selected, page: { offset, limit, total: items.length, nextOffset: offset + selected.length < items.length ? offset + selected.length : null } };
}
function localDateKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function stateFor(service) {
  if (!service || typeof service.getState !== 'function') throw new AssistantToolError('unavailable', 'Assistant data is unavailable.', 503);
  const value = service.getState();
  if (!value || typeof value !== 'object') throw new AssistantToolError('unavailable', 'Assistant data is unavailable.', 503);
  return value;
}
function array(value) { return Array.isArray(value) ? value : []; }
function publicProfile(state, previewLimit = 400) {
  const profile = state.trainingProfile;
  if (!profile || typeof profile !== 'object') return null;
  // A profile is user-owned prose. Exclude internal ids and unbounded unknown fields.
  const result = {};
  for (const key of ['summary', 'goals', 'experience', 'preferences', 'equipment', 'constraints', 'schedule', 'updatedAt', 'updated_at']) {
    if (typeof profile[key] === 'string') {
      result[key] = profile[key].slice(0, previewLimit);
      if (profile[key].length > previewLimit) result[`${key}Truncated`] = true;
    }
    else if (Array.isArray(profile[key])) {
      const values = profile[key].filter((item) => typeof item === 'string');
      result[key] = values.slice(0, 5).map((item) => item.slice(0, 100));
      if (values.length > 5 || values.some((item) => item.length > 100)) result[`${key}Truncated`] = true;
    }
  }
  return result;
}
function visibleRoutine(routine) {
  return {
    id: routine.id,
    title: routine.title ?? '',
    notes: routine.notes ?? null,
    folder_id: routine.folder_id ?? null,
    exercises: array(routine.exercises).map((exercise) => ({
      index: Number.isInteger(exercise.index) ? exercise.index : null,
      title: exercise.title ?? '',
      exercise_template_id: exercise.exercise_template_id ?? null,
      notes: exercise.notes ?? null,
      rest_seconds: exercise.rest_seconds ?? null,
      sets: array(exercise.sets).map((set) => ({
        index: Number.isInteger(set.index) ? set.index : null,
        type: set.type ?? null,
        weight_kg: set.weight_kg ?? null,
        reps: set.reps ?? null,
        rep_range: set.rep_range ?? null,
        duration_seconds: set.duration_seconds ?? null,
        distance_meters: set.distance_meters ?? null,
      })),
    })),
  };
}
function routineSummary(routine) { return { id: routine.id, title: routine.title ?? '', exerciseCount: array(routine.exercises).length, baseHash: entityHash(routine) }; }
function visibleProgram(program) {
  return { id: program.id, title: program.title, description: program.description ?? '', start_date: program.start_date ?? null, duration_weeks: program.duration_weeks ?? null, days: array(program.days).map((day) => ({ label: day.label, routineId: day.routineId })) };
}
function programSummary(program) { return { id: program.id, title: program.title ?? '', dayCount: array(program.days).length, start_date: program.start_date ?? null, duration_weeks: program.duration_weeks ?? null, baseHash: entityHash(program) }; }
function templates(state) { return array(state.exerciseTemplates); }
function templateFor(state, id) { return templates(state).find((template) => template.id === id); }
function exerciseSummary(state, template) {
  return { id: template.id, title: template.title ?? '', type: template.type ?? null, primary: template.primary_muscle_group ?? null, secondary: array(template.secondary_muscle_groups), equipment: template.equipment ?? null };
}
function setSummary(set) {
  return { type: set.type ?? null, weight_kg: set.weight_kg ?? null, reps: set.reps ?? null, rep_range: set.rep_range ?? null, duration_seconds: set.duration_seconds ?? null, distance_meters: set.distance_meters ?? null };
}
function compactRoutine(state, routine, offset, limit, setOffset, setLimit) {
  const source = array(routine.exercises);
  const exercisePage = page(source, offset, limit);
  const exercises = exercisePage.items.map((exercise, position) => {
    const sets = page(array(exercise.sets), setOffset, setLimit);
    return {
      index: Number.isInteger(exercise.index) ? exercise.index : offset + position,
      title: exercise.title ?? '', exercise_template_id: exercise.exercise_template_id ?? null,
      primary: templateFor(state, exercise.exercise_template_id)?.primary_muscle_group ?? null,
      notes: typeof exercise.notes === 'string' ? exercise.notes.slice(0, MAX_NOTE_LENGTH) : null,
      notesTruncated: typeof exercise.notes === 'string' && exercise.notes.length > MAX_NOTE_LENGTH,
      rest_seconds: exercise.rest_seconds ?? null,
      sets: sets.items.map(setSummary),
      setPage: sets.page,
    };
  });
  return { id: routine.id, title: routine.title ?? '', notes: typeof routine.notes === 'string' ? routine.notes.slice(0, MAX_NOTE_LENGTH) : null, notesTruncated: typeof routine.notes === 'string' && routine.notes.length > MAX_NOTE_LENGTH, baseHash: entityHash(routine), exercises, page: exercisePage.page };
}
function trainingAggregate(workouts, weeks, templatesById, now = new Date()) {
  const selected = filterByPeriod(workouts, String(weeks), now);
  let workingSets = 0; let externalLoadSets = 0; let volumeKg = 0;
  for (const workout of selected) for (const exercise of array(workout.exercises)) for (const set of array(exercise.sets)) {
    if (isWorkingSet(set)) workingSets += 1;
    const volume = setVolume(set, exercise, templatesById);
    if (volume > 0) { externalLoadSets += 1; volumeKg += volume; }
  }
  return { weeks, workouts: selected.length, workingSets, externalLoadSets, volumeKg: Math.round(volumeKg * 100) / 100 };
}
function proposalSummary(proposal) {
  return { id: proposal.id, revision: proposal.revision, status: proposal.status, title: proposal.title ?? '', createdAt: proposal.createdAt ?? proposal.created_at ?? null, updatedAt: proposal.updatedAt ?? proposal.updated_at ?? null };
}
function proposalHeader(proposal) {
  return {
    ...proposalSummary(proposal),
    rationalePreview: typeof proposal.rationale === 'string' ? proposal.rationale.slice(0, 400) : '',
    rationaleTruncated: typeof proposal.rationale === 'string' && proposal.rationale.length > 400,
    feedback: typeof proposal.feedback === 'string' ? proposal.feedback.slice(0, 400) : proposal.feedback ?? null,
    feedbackTruncated: typeof proposal.feedback === 'string' && proposal.feedback.length > 400,
    routineChanges: array(proposal.routines).slice(0, 10).map((entry) => ({ key: entry.key, targetId: entry.targetId ?? null, title: String(entry.after?.title ?? entry.before?.title ?? '').slice(0, 80) })),
    programChanges: array(proposal.programs).slice(0, 10).map((entry) => ({ key: entry.key, targetId: entry.targetId ?? null, title: String(entry.after?.title ?? entry.before?.title ?? '').slice(0, 80) })),
    history: array(proposal.history).slice(0, 10).map((entry) => ({ revision: entry.revision, status: entry.status })),
  };
}
function textDetail(value, offset, limit) {
  const source = typeof value === 'string' ? value : '';
  const chunk = source.slice(offset, offset + limit);
  return { value: chunk, page: { offset, limit, total: source.length, nextOffset: offset + chunk.length < source.length ? offset + chunk.length : null } };
}
function proposalRoutineDetail(entry, offset, limit, setOffset, setLimit, textOffset, textLimit) {
  const after = entry?.after;
  if (!after || typeof after !== 'object') throw new AssistantToolError('bad_record', 'Proposal routine is invalid.', 502);
  const exercisePage = page(array(after.exercises), offset, limit);
  const exercises = exercisePage.items.map((exercise, position) => {
    const sets = page(array(exercise.sets), setOffset, setLimit);
    return { index: offset + position, title: exercise.title ?? '', exercise_template_id: exercise.exercise_template_id ?? null, notes: textDetail(exercise.notes, textOffset, textLimit), rest_seconds: exercise.rest_seconds ?? null, sets: sets.items.map(setSummary), setPage: sets.page };
  });
  return { key: entry.key, targetId: entry.targetId ?? null, baseHash: entry.baseHash ?? null, before: entry.before ? routineSummary(entry.before) : null, after: { title: after.title ?? '', notes: textDetail(after.notes, textOffset, textLimit), exercises, page: exercisePage.page } };
}
function proposalProgramDetail(entry, offset, limit, textOffset, textLimit) {
  const after = entry?.after;
  if (!after || typeof after !== 'object') throw new AssistantToolError('bad_record', 'Proposal program is invalid.', 502);
  const days = page(array(after.days), offset, limit);
  return { key: entry.key, targetId: entry.targetId ?? null, baseHash: entry.baseHash ?? null, before: entry.before ? programSummary(entry.before) : null, after: { title: after.title ?? '', description: textDetail(after.description, textOffset, textLimit), start_date: after.start_date ?? null, duration_weeks: after.duration_weeks ?? null, days: days.items, page: days.page } };
}
function bounded(value) {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) <= MAX_RESULT_BYTES) return value;
  if (value && typeof value === 'object' && Number.isInteger(value.revision) && Array.isArray(value.routines) && Array.isArray(value.programs)) {
    return {
      ...proposalSummary(value),
      feedback: typeof value.feedback === 'string' ? value.feedback.slice(0, 1000) : value.feedback ?? null,
      routines: value.routines.map((entry) => ({ key: entry.key, targetId: entry.targetId ?? null, title: entry.after?.title ?? entry.before?.title ?? '' })).slice(0, 10),
      programs: value.programs.map((entry) => ({ key: entry.key, targetId: entry.targetId ?? null, title: entry.after?.title ?? entry.before?.title ?? '' })).slice(0, 10),
      truncated: true,
      message: 'Proposal detail exceeded the assistant response budget. Retrieve target routines or programs separately before revising.',
    };
  }
  // Callers use already-paged structures. Keep an explicit signal if an unusual
  // title/note payload still exceeds the transport budget.
  return { truncated: true, message: 'Result exceeded the assistant response budget. Use the supplied pagination fields to request a smaller page.' };
}

const schemas = {
  empty: { type: 'object', additionalProperties: false },
  page: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 }, offset: { type: 'integer', minimum: 0 } } },
};
const proposalSetSchema = {
  type: 'object', additionalProperties: false, required: ['type'], properties: {
    type: { type: 'string', enum: ['warmup', 'normal', 'failure', 'dropset'] }, weight_kg: { type: ['number', 'null'], minimum: 0 }, reps: { type: ['integer', 'null'], minimum: 0 }, duration_seconds: { type: ['integer', 'null'], minimum: 0 }, distance_meters: { type: ['number', 'null'], minimum: 0 },
    rep_range: { type: ['object', 'null'], additionalProperties: false, required: ['start', 'end'], properties: { start: { type: ['integer', 'null'], minimum: 1 }, end: { type: ['integer', 'null'], minimum: 1 } } },
  },
};
const proposalExerciseSchema = {
  type: 'object', additionalProperties: false, required: ['exercise_template_id', 'sets'], properties: {
    exercise_template_id: { type: 'string', minLength: 1, maxLength: 255 }, notes: { type: ['string', 'null'], maxLength: 4000 }, rest_seconds: { type: ['integer', 'null'], minimum: 0 }, sets: { type: 'array', minItems: 1, maxItems: 50, items: proposalSetSchema },
  },
};
const proposalRoutineSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'exercises'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 160 }, notes: { type: ['string', 'null'], maxLength: 4000 }, exercises: { type: 'array', minItems: 1, maxItems: 50, items: proposalExerciseSchema },
  },
};
const proposalRoutineEntrySchema = {
  type: 'object', additionalProperties: false, required: ['key', 'routine'], properties: {
    key: { type: 'string', minLength: 1, maxLength: 255 }, targetId: { type: 'string', minLength: 1, maxLength: 255 }, baseHash: { type: 'string', minLength: 64, maxLength: 64 }, routine: proposalRoutineSchema,
  },
};
const proposalProgramDaySchema = {
  type: 'object', additionalProperties: false, required: ['label'], oneOf: [{ required: ['routineId'] }, { required: ['routineKey'] }], properties: {
    label: { type: 'string', minLength: 1, maxLength: 100 }, routineId: { type: 'string', minLength: 1, maxLength: 255 }, routineKey: { type: 'string', minLength: 1, maxLength: 255 },
  },
};
const proposalProgramSchema = {
  type: 'object', additionalProperties: false, required: ['title', 'days'], properties: {
    title: { type: 'string', minLength: 1, maxLength: 160 }, description: { type: 'string', maxLength: 4000 }, start_date: { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, duration_weeks: { type: ['integer', 'null'], minimum: 1, maximum: 52 }, days: { type: 'array', minItems: 1, maxItems: 14, items: proposalProgramDaySchema },
  },
};
const proposalProgramEntrySchema = {
  type: 'object', additionalProperties: false, required: ['key', 'program'], properties: {
    key: { type: 'string', minLength: 1, maxLength: 255 }, targetId: { type: 'string', minLength: 1, maxLength: 255 }, baseHash: { type: 'string', minLength: 64, maxLength: 64 }, program: proposalProgramSchema,
  },
};
const proposalInputSchema = {
  type: 'object', additionalProperties: false, required: ['requestId', 'title', 'rationale', 'routines', 'programs'], properties: {
    requestId: { type: 'string', format: 'uuid' }, id: { type: 'string', format: 'uuid' }, expectedRevision: { type: 'integer', minimum: 1 }, title: { type: 'string', minLength: 1, maxLength: 160 }, rationale: { type: 'string', minLength: 1, maxLength: 12000 }, routines: { type: 'array', maxItems: 10, items: proposalRoutineEntrySchema }, programs: { type: 'array', maxItems: 10, items: proposalProgramEntrySchema },
  },
};

export const ASSISTANT_TOOLS = [
  { name: 'corpus_summary', description: 'Return a compact training profile and recent aggregate, without raw workout history.', inputSchema: schemas.empty },
  { name: 'corpus_search_exercises', description: 'Search imported exercise templates by title, muscle, or equipment.', inputSchema: { type: 'object', additionalProperties: false, required: ['query'], properties: { query: { type: 'string', minLength: 1, maxLength: 160 }, muscle: { type: 'string', maxLength: 100 }, equipment: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 20 }, offset: { type: 'integer', minimum: 0 } } } },
  { name: 'corpus_list_routines', description: 'List bounded routine summaries and review hashes.', inputSchema: schemas.page },
  { name: 'corpus_get_routine', description: 'Get a paged routine detail. Exercise and set pages are deliberately bounded.', inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 255 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 10 }, setOffset: { type: 'integer', minimum: 0 }, setLimit: { type: 'integer', minimum: 1, maximum: 10 } } } },
  { name: 'corpus_list_programs', description: 'List bounded program summaries and review hashes.', inputSchema: schemas.page },
  { name: 'corpus_get_program', description: 'Get a paged program detail.', inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 255 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 14 } } } },
  { name: 'corpus_workout_summary', description: 'Return date-filtered aggregate training progress and volume, never raw workout sets.', inputSchema: { type: 'object', additionalProperties: false, required: ['weeks'], properties: { weeks: { type: 'integer', minimum: 1, maximum: 52 }, exerciseId: { type: 'string', maxLength: 255 }, routineId: { type: 'string', maxLength: 255 } } } },
  { name: 'corpus_muscle_coverage', description: 'Summarize routine or program muscle coverage from exercise metadata.', inputSchema: { type: 'object', additionalProperties: false, properties: { routineId: { type: 'string', maxLength: 255 }, programId: { type: 'string', maxLength: 255 } } } },
  { name: 'corpus_list_proposals', description: 'List bounded proposal summaries awaiting review or with a status filter.', inputSchema: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', maxLength: 32 }, limit: { type: 'integer', minimum: 1, maximum: 10 }, offset: { type: 'integer', minimum: 0 } } } },
  { name: 'corpus_get_proposal', description: 'Get a bounded proposal summary, rationale page, or one paged proposed routine/program entity for revision.', inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string', minLength: 1, maxLength: 255 }, kind: { type: 'string', enum: ['summary', 'rationale', 'routine', 'program'] }, index: { type: 'integer', minimum: 0 }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 10 }, setOffset: { type: 'integer', minimum: 0 }, setLimit: { type: 'integer', minimum: 1, maximum: 10 }, textOffset: { type: 'integer', minimum: 0 }, textLimit: { type: 'integer', minimum: 1, maximum: 1000 } } } },
  { name: 'corpus_submit_proposal', description: 'Save a reviewable draft proposal. This does not approve, publish, or sync it.', inputSchema: proposalInputSchema },
  { name: 'corpus_get_profile', description: 'Return a compact profile preview or one paged goals, equipment, constraints, or schedule field without credentials.', inputSchema: { type: 'object', additionalProperties: false, properties: { field: { type: 'string', enum: ['goals', 'equipment', 'constraints', 'schedule'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 2000 } } } },
  { name: 'corpus_workflow', description: 'Read one fixed Corpus assistant workflow when workspace skill instructions are unavailable.', inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', enum: Object.keys(WORKFLOW_FILES) } } } },
];

export async function callAssistantTool(service, name, args = {}) {
  const tool = ASSISTANT_TOOLS.find((item) => item.name === name);
  if (!tool) throw new AssistantToolError('not_found', 'Assistant tool was not found.', 404);
  object(args); // Do not rely on an MCP client respecting JSON Schema.
  const state = stateFor(service);
  let result;
  switch (name) {
    case 'corpus_summary': {
      only(args, []);
      result = { mode: state.mode === 'live' ? 'live' : 'demo', timestamp: new Date().toISOString(), counts: { workouts: array(state.workouts).length, routines: array(state.routines).length, exerciseTemplates: templates(state).length, programs: array(state.programs).length, proposals: array(state.proposals).length }, profile: publicProfile(state, 200), programs: array(state.programs).slice(0, 5).map(programSummary), recent8Weeks: trainingAggregate(array(state.workouts), 8, templateMap(templates(state))) };
      break;
    }
    case 'corpus_search_exercises': {
      only(args, ['query', 'muscle', 'equipment', 'limit', 'offset']); const query = text(args.query, 'query', { required: true }); const muscle = text(args.muscle, 'muscle', { max: 100 }); const equipment = text(args.equipment, 'equipment', { max: 100 }); const { offset, limit } = boundedPage(args, { limit: 10, maximum: 20 });
      result = page(templates(state).filter((item) => matching(item.title, query) && (!muscle || matching(item.primary_muscle_group, muscle) || array(item.secondary_muscle_groups).some((value) => matching(value, muscle))) && (!equipment || matching(item.equipment, equipment))).map((item) => exerciseSummary(state, item)), offset, limit); break;
    }
    case 'corpus_list_routines': {
      only(args, ['query', 'limit', 'offset']); const query = text(args.query, 'query'); const { offset, limit } = boundedPage(args, { limit: 10, maximum: 10 }); result = page(array(state.routines).filter((routine) => matching(routine.title, query)).map(routineSummary), offset, limit); break;
    }
    case 'corpus_get_routine': {
      only(args, ['id', 'offset', 'limit', 'setOffset', 'setLimit']); const id = text(args.id, 'id', { required: true, max: 255 }); const routine = array(state.routines).find((item) => item.id === id); if (!routine) throw new AssistantToolError('not_found', 'Routine was not found.', 404); result = compactRoutine(state, routine, integer(args.offset, 'offset', { fallback: 0 }), integer(args.limit, 'limit', { min: 1, max: 10, fallback: 10 }), integer(args.setOffset, 'setOffset', { fallback: 0 }), integer(args.setLimit, 'setLimit', { min: 1, max: 10, fallback: 10 })); break;
    }
    case 'corpus_list_programs': {
      only(args, ['query', 'limit', 'offset']); const query = text(args.query, 'query'); const { offset, limit } = boundedPage(args, { limit: 10, maximum: 10 }); result = page(array(state.programs).filter((program) => matching(program.title, query)).map(programSummary), offset, limit); break;
    }
    case 'corpus_get_program': {
      only(args, ['id', 'offset', 'limit']); const id = text(args.id, 'id', { required: true, max: 255 }); const program = array(state.programs).find((item) => item.id === id); if (!program) throw new AssistantToolError('not_found', 'Program was not found.', 404); const { offset, limit } = boundedPage(args, { limit: 14, maximum: 14 }); result = { ...visibleProgram(program), baseHash: entityHash(program), ...page(array(program.days), offset, limit), days: undefined }; result.days = result.items; delete result.items; break;
    }
    case 'corpus_workout_summary': {
      only(args, ['weeks', 'exerciseId', 'routineId']); const weeks = integer(args.weeks, 'weeks', { min: 1, max: 52 }); const exerciseId = text(args.exerciseId, 'exerciseId', { max: 255 }); const routineId = text(args.routineId, 'routineId', { max: 255 }); const now = new Date(); const templatesById = templateMap(templates(state));
      const scoped = filterByPeriod(array(state.workouts), String(weeks), now)
        .filter((workout) => !routineId || workout.routine_id === routineId)
        .map((workout) => ({ ...workout, exercises: array(workout.exercises).filter((exercise) => !exerciseId || String(exercise.exercise_template_id) === exerciseId) }))
        .filter((workout) => !exerciseId || workout.exercises.length > 0);
      const aggregate = trainingAggregate(scoped, weeks, templatesById, now);
      const progress = weeklySeries(scoped, String(weeks), now, templatesById).map((point) => ({ weekStart: localDateKey(point.start), workouts: point.workouts, volumeKg: Math.round(point.volumeKg * 100) / 100, strengthBestKg: null }));
      if (exerciseId) {
        const byWeek = new Map(progress.map((point) => [point.weekStart, point]));
        for (const workout of scoped) for (const exercise of array(workout.exercises)) if (isExternalLoadExercise(exercise, templatesById)) for (const set of array(exercise.sets)) {
          if (!isWorkingSet(set) || !setVolume(set, exercise, templatesById)) continue;
          const week = new Date(workout.start_time); week.setHours(0, 0, 0, 0); week.setDate(week.getDate() - ((week.getDay() + 6) % 7));
          const point = byWeek.get(localDateKey(week)); const weight = Number(set.weight_kg);
          if (point && Number.isFinite(weight) && weight > 0) point.strengthBestKg = Math.max(point.strengthBestKg ?? 0, weight);
        }
      }
      result = { ...aggregate, routineId, exerciseId, aggregation: 'calendar weeks beginning Monday; volumeKg uses working external-load sets only', progress, ...(exerciseId ? {} : { strengthBestKg: 'Provide exerciseId for a comparable strength progression.' }) }; break;
    }
    case 'corpus_muscle_coverage': {
      only(args, ['routineId', 'programId']); const routineId = text(args.routineId, 'routineId', { max: 255 }); const programId = text(args.programId, 'programId', { max: 255 }); if (Boolean(routineId) === Boolean(programId)) throw new AssistantToolError('validation', 'Provide exactly one of routineId or programId.'); let routines = [];
      let coverage;
      if (routineId) { const routine = array(state.routines).find((item) => item.id === routineId); if (!routine) throw new AssistantToolError('not_found', 'Routine was not found.', 404); coverage = buildMuscleCoverage({ routine, routines: array(state.routines), exerciseTemplates: templates(state) }); } else { const program = array(state.programs).find((item) => item.id === programId); if (!program) throw new AssistantToolError('not_found', 'Program was not found.', 404); coverage = buildMuscleCoverage({ program, routines: array(state.routines), exerciseTemplates: templates(state) }); }
      result = { routineId: routineId ?? null, programId: programId ?? null, scope: coverage.scope, dayCount: coverage.dayCount, exerciseCount: coverage.exerciseCount, workingSetCount: coverage.workingSetCount, missing: { routines: coverage.missingRoutineCount, templates: coverage.missingTemplateCount, muscles: coverage.missingMuscleCount }, muscles: coverage.muscles.filter((muscle) => muscle.primaryExercises || muscle.secondaryExercises).map((muscle) => ({ id: muscle.id, label: muscle.label, primaryExercises: muscle.primaryExercises, secondaryExercises: muscle.secondaryExercises, primaryWorkingSets: muscle.primarySets, secondaryWorkingSets: muscle.secondarySets })) }; break;
    }
    case 'corpus_list_proposals': {
      only(args, ['status', 'limit', 'offset']); const status = text(args.status, 'status', { max: 32 }); const { offset, limit } = boundedPage(args, { limit: 10, maximum: 10 }); result = page(array(state.proposals).filter((proposal) => !status || proposal.status === status).map(proposalSummary), offset, limit); break;
    }
    case 'corpus_get_proposal': {
      only(args, ['id', 'kind', 'index', 'offset', 'limit', 'setOffset', 'setLimit', 'textOffset', 'textLimit']); const id = text(args.id, 'id', { required: true, max: 255 }); const kind = args.kind === undefined ? 'summary' : args.kind; if (!['summary', 'rationale', 'routine', 'program'].includes(kind)) throw new AssistantToolError('validation', 'Proposal detail kind is invalid.'); if (typeof service.getProposal !== 'function') throw new AssistantToolError('unavailable', 'Proposal details are unavailable.', 503); const proposal = await service.getProposal(id); if (!proposal) throw new AssistantToolError('not_found', 'Proposal was not found.', 404);
      if (kind === 'summary') { if (args.index !== undefined || args.offset !== undefined || args.limit !== undefined || args.setOffset !== undefined || args.setLimit !== undefined || args.textOffset !== undefined || args.textLimit !== undefined) throw new AssistantToolError('validation', 'Summary does not accept pagination fields.'); result = proposalHeader(proposal); break; }
      const offset = integer(args.offset, 'offset', { fallback: 0 }); const limit = integer(args.limit, 'limit', { min: 1, max: kind === 'routine' ? 1 : 10, fallback: kind === 'routine' ? 1 : 10 });
      const textOffset = integer(args.textOffset, 'textOffset', { fallback: 0 }); const textLimit = integer(args.textLimit, 'textLimit', { min: 1, max: 1000, fallback: 1000 });
      if (kind === 'rationale') { if (args.index !== undefined || args.setOffset !== undefined || args.setLimit !== undefined || args.textOffset !== undefined || args.textLimit !== undefined) throw new AssistantToolError('validation', 'Rationale uses offset and limit only.'); const rationale = typeof proposal.rationale === 'string' ? proposal.rationale : ''; const chunk = rationale.slice(offset, offset + Math.min(limit * 100, 1000)); result = { ...proposalSummary(proposal), rationale: chunk, page: { offset, limit: Math.min(limit * 100, 1000), total: rationale.length, nextOffset: offset + chunk.length < rationale.length ? offset + chunk.length : null } }; break; }
      const index = integer(args.index, 'index', { fallback: -1, min: 0 }); if (index < 0) throw new AssistantToolError('validation', 'Entity detail needs an index.');
      if (kind === 'routine') { const entry = array(proposal.routines)[index]; if (!entry) throw new AssistantToolError('not_found', 'Proposed routine was not found.', 404); result = { ...proposalSummary(proposal), kind, index, entity: proposalRoutineDetail(entry, offset, limit, integer(args.setOffset, 'setOffset', { fallback: 0 }), integer(args.setLimit, 'setLimit', { min: 1, max: 10, fallback: 10 }), textOffset, textLimit) }; break; }
      if (args.setOffset !== undefined || args.setLimit !== undefined) throw new AssistantToolError('validation', 'Program detail does not accept set pagination.'); const entry = array(proposal.programs)[index]; if (!entry) throw new AssistantToolError('not_found', 'Proposed program was not found.', 404); result = { ...proposalSummary(proposal), kind, index, entity: proposalProgramDetail(entry, offset, limit, textOffset, textLimit) }; break;
    }
    case 'corpus_submit_proposal': {
      only(args, ['requestId', 'id', 'expectedRevision', 'title', 'rationale', 'routines', 'programs']); if (!UUID.test(args.requestId ?? '') || (args.id !== undefined && !UUID.test(args.id))) throw new AssistantToolError('validation', 'Proposal ids must be UUIDs.'); if (typeof service.submitProposal !== 'function') throw new AssistantToolError('unavailable', 'Proposal submission is unavailable.', 503); const proposal = await service.submitProposal(args); result = { id: proposal.id, revision: proposal.revision, status: proposal.status, title: proposal.title }; break;
    }
    case 'corpus_get_profile': {
      only(args, ['field', 'offset', 'limit']);
      if (args.field === undefined) { if (args.offset !== undefined || args.limit !== undefined) throw new AssistantToolError('validation', 'Profile pagination needs a field.'); result = { profile: publicProfile(state) }; break; }
      if (!['goals', 'equipment', 'constraints', 'schedule'].includes(args.field)) throw new AssistantToolError('validation', 'Profile field is invalid.');
      const profile = state.trainingProfile && typeof state.trainingProfile === 'object' ? state.trainingProfile : {}; const source = typeof profile[args.field] === 'string' ? profile[args.field] : ''; const offset = integer(args.offset, 'offset', { fallback: 0 }); const limit = integer(args.limit, 'limit', { min: 1, max: 2000, fallback: 1000 }); const value = source.slice(offset, offset + limit);
      result = { field: args.field, value, page: { offset, limit, total: source.length, nextOffset: offset + value.length < source.length ? offset + value.length : null } }; break;
    }
    case 'corpus_workflow': {
      only(args, ['name']);
      if (typeof args.name !== 'string' || !Object.hasOwn(WORKFLOW_FILES, args.name)) throw new AssistantToolError('validation', 'Unknown Corpus workflow.');
      // The enum maps to fixed server-owned files. The argument is never a path.
      const instructions = await readFile(WORKFLOW_FILES[args.name], 'utf8');
      result = { name: args.name, instructions: instructions.slice(0, 4096) };
      break;
    }
    default: throw new AssistantToolError('not_found', 'Assistant tool was not found.', 404);
  }
  return bounded(result);
}
