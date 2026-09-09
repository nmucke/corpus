import { createHash } from 'node:crypto';
import { validateProgramSchedule } from '../public/program-timeline.js';

// Deliberately use the visible JSON representation.  A proposal is reviewed
// against exactly what the person saw, rather than an internal normalisation.
export function entityHash(entity) {
  return createHash('sha256').update(JSON.stringify(entity)).digest('hex');
}

const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

function only(value, names, fail, label) {
  if (!object(value) || Object.keys(value).some((key) => !names.includes(key))) fail('validation', `${label} contains an unsupported field.`);
}
function text(value, maximum, fail, label, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') fail('validation', `${label} must be text.`);
  const result = value.trim();
  if (required && !result) fail('validation', `${label} is required.`);
  if (result.length > maximum) fail('validation', `${label} is too long.`);
  return result;
}
function safeId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 255; }
function schedule(value, fail) {
  if (!object(value) || Object.keys(value).some((key) => !['title', 'description', 'start_date', 'duration_weeks', 'days'].includes(key))) fail('validation', 'Program contains an unsupported field.');
  const title = text(value.title, 160, fail, 'Program title', true);
  const description = text(value.description, 4000, fail, 'Program description');
  const start_date = value.start_date === undefined ? null : value.start_date;
  const duration_weeks = value.duration_weeks === undefined ? null : value.duration_weeks;
  const validSchedule = validateProgramSchedule(start_date, duration_weeks);
  if (!validSchedule) fail('validation', 'Program schedule needs a YYYY-MM-DD start date and duration from 1 to 52 weeks, or both null.');
  if (!Array.isArray(value.days) || value.days.length < 1 || value.days.length > 14) fail('validation', 'Program needs between 1 and 14 days.');
  const days = value.days.map((day) => {
    only(day, ['label', 'routineId', 'routineKey'], fail, 'Program day');
    const label = text(day.label, 100, fail, 'Day label', true);
    const hasId = day.routineId !== undefined; const hasKey = day.routineKey !== undefined;
    if (hasId === hasKey || (hasId && !safeId(day.routineId)) || (hasKey && (!safeId(day.routineKey)))) fail('validation', 'Each program day needs exactly one routineId or routineKey.');
    return hasId ? { label, routineId: day.routineId } : { label, routineKey: day.routineKey };
  });
  return { title, description, start_date, duration_weeks, days };
}

// The routine editor's hidden Hevy metadata is positional. AI drafts may
// reorder exercises, so line each draft exercise up with one saved occurrence
// of the same template before reusing that metadata. Replacements get no
// inherited notes, supersets, or custom metrics.
function alignExistingExercises(target, draftRoutine) {
  const available = new Map();
  for (const exercise of target.exercises ?? []) {
    const entries = available.get(exercise?.exercise_template_id) ?? [];
    entries.push(exercise);
    available.set(exercise?.exercise_template_id, entries);
  }
  return {
    ...target,
    exercises: draftRoutine.exercises.map((exercise) => {
      const entries = available.get(exercise.exercise_template_id);
      return entries?.shift() ?? {};
    }),
  };
}

function routineShape(value, fail) {
  only(value, ['title', 'notes', 'exercises'], fail, 'Routine');
  if (!Array.isArray(value.exercises)) fail('validation', 'Routine exercises must be an array.');
  for (const exercise of value.exercises) {
    only(exercise, ['exercise_template_id', 'notes', 'rest_seconds', 'sets'], fail, 'Routine exercise');
    if (!Array.isArray(exercise.sets)) fail('validation', 'Routine exercise sets must be an array.');
    for (const set of exercise.sets) only(set, ['type', 'weight_kg', 'reps', 'rep_range', 'duration_seconds', 'distance_meters'], fail, 'Routine set');
  }
}

/** Validate and canonicalise an untrusted AI draft before it reaches storage. */
export function proposalDraft(body, { routines, programs, templateIds, templateTitles, buildRoutine, fail }) {
  only(body, ['requestId', 'id', 'expectedRevision', 'title', 'rationale', 'routines', 'programs'], fail, 'Proposal');
  if (!uuid(body.requestId)) fail('validation', 'requestId must be a UUID.');
  if (body.id !== undefined && !uuid(body.id)) fail('validation', 'Proposal id must be a UUID.');
  if (body.expectedRevision !== undefined && (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1)) fail('validation', 'expectedRevision must be a positive integer.');
  const title = text(body.title, 160, fail, 'Title', true);
  const rationale = text(body.rationale, 12000, fail, 'Rationale', true);
  if (!Array.isArray(body.routines) || !Array.isArray(body.programs) || body.routines.length + body.programs.length < 1 || body.routines.length > 10 || body.programs.length > 10) fail('validation', 'A proposal needs 1 to 10 routines and 0 to 10 programs.');
  const routineKeys = new Set(); const routineTargets = new Set();
  const canonicalRoutines = body.routines.map((entry) => {
    only(entry, ['key', 'targetId', 'baseHash', 'routine'], fail, 'Proposed routine');
    if (!safeId(entry.key) || routineKeys.has(entry.key)) fail('validation', 'Routine keys must be unique.');
    routineKeys.add(entry.key);
    const target = entry.targetId === undefined ? null : routines.find((routine) => routine.id === entry.targetId);
    if (entry.targetId !== undefined && (!safeId(entry.targetId) || !target || routineTargets.has(entry.targetId) || typeof entry.baseHash !== 'string' || entry.baseHash !== entityHash(target))) fail('stale_target', 'A proposed routine target changed or is unavailable.', 409);
    if (target) routineTargets.add(entry.targetId);
    routineShape(entry.routine, fail);
    const routineInput = { ...entry.routine, requestId: body.requestId };
    const existing = target ? alignExistingExercises(target, entry.routine) : null;
    const result = buildRoutine(routineInput, templateIds, existing ? { existing, editing: true } : {}).payload.routine;
    const after = {
      ...result,
      exercises: result.exercises.map((exercise, exerciseIndex) => ({
        ...exercise,
        index: exerciseIndex,
        title: templateTitles.get(exercise.exercise_template_id),
        sets: exercise.sets.map((set, setIndex) => ({ ...set, index: setIndex })),
      })),
    };
    return { key: entry.key, ...(target ? { targetId: target.id, baseHash: entry.baseHash, before: target } : { before: null }), after };
  });
  const programKeys = new Set(); const programTargets = new Set();
  const knownRoutineIds = new Set(routines.map((routine) => routine.id));
  const canonicalPrograms = body.programs.map((entry) => {
    only(entry, ['key', 'targetId', 'baseHash', 'program'], fail, 'Proposed program');
    if (!safeId(entry.key) || programKeys.has(entry.key)) fail('validation', 'Program keys must be unique.');
    programKeys.add(entry.key);
    const target = entry.targetId === undefined ? null : programs.find((program) => program.id === entry.targetId);
    if (entry.targetId !== undefined && (!safeId(entry.targetId) || !target || programTargets.has(entry.targetId) || typeof entry.baseHash !== 'string' || entry.baseHash !== entityHash(target))) fail('stale_target', 'A proposed program target changed or is unavailable.', 409);
    if (target) programTargets.add(entry.targetId);
    const after = schedule(entry.program, fail);
    for (const day of after.days) if (day.routineId && !knownRoutineIds.has(day.routineId)) fail('validation', `Unknown routine: ${day.routineId}.`);
    for (const day of after.days) if (day.routineKey && !routineKeys.has(day.routineKey)) fail('validation', `Unknown proposed routine key: ${day.routineKey}.`);
    return { key: entry.key, ...(target ? { targetId: target.id, baseHash: entry.baseHash, before: target } : { before: null }), after };
  });
  return { requestId: body.requestId, id: body.id, expectedRevision: body.expectedRevision, title, rationale, routines: canonicalRoutines, programs: canonicalPrograms };
}

export function publicProposal(row, history = undefined) {
  const value = { ...row, routines: JSON.parse(row.routines_json), programs: JSON.parse(row.programs_json), feedback: row.feedback ?? null, result: row.result_json ? JSON.parse(row.result_json) : undefined };
  delete value.routines_json; delete value.programs_json; delete value.result_json;
  if (history) value.history = history;
  return value;
}
