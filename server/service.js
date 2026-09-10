import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { demoState } from './demo.js';
import { fetchSnapshot, postRoutine, updateRoutine as putRoutine, ROUTINE_UNCERTAIN_MESSAGE, ROUTINE_UPDATE_UNCERTAIN_MESSAGE } from './hevy.js';
import { programTimeline, validateProgramSchedule } from '../public/program-timeline.js';
import { METRICS, METRIC_KEYS, isMetricKey } from '../public/metrics-catalog.js';
import { entityHash, proposalDraft, publicProposal } from './proposals.js';
import { demoMetricSeries } from './metrics-demo.js';
import { SCOPES, GoogleHealthError, pkcePair, authorizationUrl, exchangeCode, refreshAccessToken, revokeToken, fetchMetricPoints } from './google-health.js';

export { entityHash } from './proposals.js';

const SCHEMA_VERSION = 6;
const GOOGLE_SOURCE = 'google-health';
const OAUTH_PENDING_MS = 10 * 60 * 1000;
const METRICS_FIRST_SYNC_DAYS = 365;
const METRICS_RESYNC_DAYS = 7;
const PROGRAM_TITLE_MAX = 160;
const PROGRAM_DESCRIPTION_MAX = 4000;

export class ServiceError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
  }
}

function json(value) { return JSON.stringify(value ?? null); }
function parse(value) { return JSON.parse(value); }
function cleanText(value, max, name, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new ServiceError('validation', `${name} must be text.`);
  const result = value.trim();
  if (required && !result) throw new ServiceError('validation', `${name} is required.`);
  if (result.length > max) throw new ServiceError('validation', `${name} is too long.`);
  return result;
}
function isoNow() { return new Date().toISOString(); }
function safeId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 255; }
const DAY_MS = 86_400_000;
// Metric dates are civil dates: the server's local calendar day, shifted in UTC
// arithmetic so daylight-saving changes cannot skip or repeat a day.
function localDate(now = new Date()) { return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; }
function isDateString(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function addDays(date, days) { return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10); }
function clampDays(days) {
  const value = Number(days);
  if (!Number.isFinite(value)) return 90;
  return Math.min(730, Math.max(7, Math.trunc(value)));
}

function programSchedule(startDate, durationWeeks) {
  const schedule = validateProgramSchedule(startDate, durationWeeks);
  if (!schedule) throw new ServiceError('validation', 'Program schedule needs a real YYYY-MM-DD start date and a duration from 1 to 52 weeks, or both values must be null.');
  return { start_date: schedule.startDate, duration_weeks: schedule.durationWeeks };
}

function programScheduleMarkdown(program, now = new Date()) {
  const timeline = programTimeline(program, now);
  if (!timeline.startDate) return ['- Schedule: Unscheduled'];
  return [`- Schedule: ${timeline.startDate} to ${timeline.endDate} (${timeline.durationWeeks} weeks)`, `- Status: ${timeline.status.slice(0, 1).toUpperCase()}${timeline.status.slice(1)}`];
}

function initialise(db) {
  db.exec('PRAGMA foreign_keys = ON;');
  // Read this before applying migrations: opening a newer data directory must
  // never make writes or schema changes with an older Corpus binary.
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const version = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')?.value;
  if (version && (!Number.isInteger(Number(version)) || Number(version) > SCHEMA_VERSION)) {
    throw new ServiceError('schema_version', 'This data was created by a newer version of Corpus.', 500);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_items (kind TEXT NOT NULL, source_id TEXT NOT NULL, raw_json TEXT NOT NULL, synced_at TEXT NOT NULL, PRIMARY KEY(kind, source_id));
    CREATE TABLE IF NOT EXISTS workouts (id TEXT PRIMARY KEY, title TEXT, routine_id TEXT, start_time TEXT, end_time TEXT, raw_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workout_exercises (workout_id TEXT NOT NULL REFERENCES workouts(id) ON DELETE CASCADE, exercise_index INTEGER NOT NULL, title TEXT, template_id TEXT, notes TEXT, raw_json TEXT NOT NULL, PRIMARY KEY(workout_id, exercise_index));
    CREATE TABLE IF NOT EXISTS workout_sets (workout_id TEXT NOT NULL, exercise_index INTEGER NOT NULL, set_index INTEGER NOT NULL, set_type TEXT, weight_kg REAL, reps REAL, distance_meters REAL, duration_seconds REAL, rpe REAL, raw_json TEXT NOT NULL, PRIMARY KEY(workout_id, exercise_index, set_index), FOREIGN KEY(workout_id, exercise_index) REFERENCES workout_exercises(workout_id, exercise_index) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS routines (id TEXT PRIMARY KEY, title TEXT, folder_id TEXT, raw_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS routine_exercises (routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE, exercise_index INTEGER NOT NULL, title TEXT, template_id TEXT, notes TEXT, rest_seconds REAL, raw_json TEXT NOT NULL, PRIMARY KEY(routine_id, exercise_index));
    CREATE TABLE IF NOT EXISTS routine_sets (routine_id TEXT NOT NULL, exercise_index INTEGER NOT NULL, set_index INTEGER NOT NULL, set_type TEXT, rep_range TEXT, raw_json TEXT NOT NULL, PRIMARY KEY(routine_id, exercise_index, set_index), FOREIGN KEY(routine_id, exercise_index) REFERENCES routine_exercises(routine_id, exercise_index) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS exercise_templates (id TEXT PRIMARY KEY, title TEXT, raw_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS programs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, days_json TEXT NOT NULL, start_date TEXT, duration_weeks INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS routine_publications (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'uncertain')), result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_routines (id TEXT PRIMARY KEY, mode TEXT NOT NULL, hevy_id TEXT, base_hash TEXT, raw_json TEXT NOT NULL, proposal_id TEXT NOT NULL, publish_request_id TEXT, publish_status TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS local_routine_mappings (local_id TEXT PRIMARY KEY, remote_id TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','revision_requested','accepted','declined')), title TEXT NOT NULL, rationale TEXT NOT NULL, routines_json TEXT NOT NULL, programs_json TEXT NOT NULL, feedback TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS proposal_history (proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE, revision INTEGER NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, rationale TEXT NOT NULL, routines_json TEXT NOT NULL, programs_json TEXT NOT NULL, feedback TEXT, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(proposal_id, revision));
    CREATE TABLE IF NOT EXISTS proposal_requests (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE, revision INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS training_profiles (mode TEXT PRIMARY KEY, goals TEXT NOT NULL, equipment TEXT NOT NULL, constraints TEXT NOT NULL, schedule TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metric_sources (id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT NOT NULL, cursor_json TEXT, last_sync TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS metric_points (source TEXT NOT NULL REFERENCES metric_sources(id) ON DELETE CASCADE, metric TEXT NOT NULL, source_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT, end_time TEXT, value REAL NOT NULL, raw_json TEXT, imported_at TEXT NOT NULL, PRIMARY KEY(source, metric, source_id));
    CREATE INDEX IF NOT EXISTS metric_points_by_metric_date ON metric_points(metric, date);`);
  const programColumns = new Set(db.prepare('PRAGMA table_info(programs)').all().map((column) => column.name));
  const mappingColumns = new Set(db.prepare('PRAGMA table_info(local_routine_mappings)').all().map((column) => column.name));
  const needsMigration = !version || Number(version) < SCHEMA_VERSION || !programColumns.has('start_date') || !programColumns.has('duration_weeks') || !mappingColumns.has('result_json');
  if (needsMigration) {
    try {
      db.exec('BEGIN IMMEDIATE');
      if (!programColumns.has('start_date')) db.exec('ALTER TABLE programs ADD COLUMN start_date TEXT');
      if (!programColumns.has('duration_weeks')) db.exec('ALTER TABLE programs ADD COLUMN duration_weeks INTEGER');
      if (!mappingColumns.has('result_json')) db.exec('ALTER TABLE local_routine_mappings ADD COLUMN result_json TEXT');
      if (!version) db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
      else db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction to roll back */ }
      throw error;
    }
  }
  if (!db.prepare('SELECT value FROM meta WHERE key = ?').get('mode')) db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('mode', 'demo');
}

async function readPrivateSettings(file) {
  try {
    const value = parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new ServiceError('settings_read', 'Could not read private settings.', 500);
  }
}

async function writePrivateSettings(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${json(value)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
  await chmod(file, 0o600);
}

function valueOrNull(value) { return value == null ? null : value; }

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function payloadHash(payload) { return createHash('sha256').update(stableJson(payload)).digest('hex'); }

function uuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function nonNegativeNumber(value, name, integer = false) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (integer && !Number.isInteger(value))) throw new ServiceError('validation', `${name} must be a finite non-negative${integer ? ' integer' : ' number'}.`);
  return value;
}

function optionalRoutineNotes(value, fallback = '') {
  if (value === undefined) return fallback == null ? null : cleanText(fallback, 4000, 'Notes');
  if (value === null) return null;
  return cleanText(value, 4000, 'Notes');
}

function metadataNumber(value, name) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ServiceError('validation', `${name} must be a non-negative integer or null.`);
  return value;
}

function validateEditMetadata(metadata, existing) {
  if (metadata == null) return null;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new ServiceError('validation', 'Routine metadata must be an object.');
  const allowed = new Set(['folder_id', 'exercises']);
  if (Object.keys(metadata).some((key) => !allowed.has(key))) throw new ServiceError('validation', 'Routine metadata contains an unsupported field.');
  const folder = metadata.folder_id === undefined ? undefined : metadataNumber(metadata.folder_id, 'folder_id');
  const existingFolder = metadataNumber(existing?.folder_id ?? null, 'folder_id');
  // Folder moves are intentionally outside this editor. This prevents a stale
  // or forged UI payload from silently moving a routine between Hevy folders.
  if (folder !== undefined && folder !== existingFolder) throw new ServiceError('validation', 'Routine folder metadata does not match the saved routine.');
  if (metadata.exercises !== undefined) {
    if (!Array.isArray(metadata.exercises)) throw new ServiceError('validation', 'Routine exercise metadata must be an array.');
    for (const exercise of metadata.exercises) {
      if (!exercise || typeof exercise !== 'object' || Array.isArray(exercise)) throw new ServiceError('validation', 'Routine exercise metadata is invalid.');
      if (Object.keys(exercise).some((key) => !['superset_id', 'sets'].includes(key))) throw new ServiceError('validation', 'Routine exercise metadata contains an unsupported field.');
      if (exercise.superset_id !== undefined) metadataNumber(exercise.superset_id, 'superset_id');
      if (exercise.sets !== undefined) {
        if (!Array.isArray(exercise.sets)) throw new ServiceError('validation', 'Routine set metadata must be an array.');
        for (const set of exercise.sets) {
          if (!set || typeof set !== 'object' || Array.isArray(set) || Object.keys(set).some((key) => key !== 'custom_metric')) throw new ServiceError('validation', 'Routine set metadata is invalid.');
          if (set.custom_metric !== undefined && set.custom_metric !== null && (typeof set.custom_metric !== 'number' || !Number.isFinite(set.custom_metric) || set.custom_metric < 0)) throw new ServiceError('validation', 'custom_metric must be a finite non-negative number or null.');
        }
      }
    }
  }
  return metadata;
}

function buildRoutinePayload(body, templateIds, { existing = null, editing = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError('validation', 'Routine must be an object.');
  if (!uuid(body.requestId)) throw new ServiceError('validation', 'requestId must be a UUID.');
  const title = cleanText(body.title ?? existing?.title, 160, 'Title', true);
  const notes = editing ? optionalRoutineNotes(body.notes, existing?.notes) : cleanText(body.notes, 4000, 'Notes');
  const metadata = editing ? validateEditMetadata(body.metadata, existing) : null;
  const sourceExercises = Array.isArray(body.exercises) ? body.exercises : (editing ? existing?.exercises : null);
  if (!Array.isArray(sourceExercises) || sourceExercises.length < 1 || sourceExercises.length > 50) throw new ServiceError('validation', 'Routine needs between 1 and 50 exercises.');
  const exercises = sourceExercises.map((exercise, exerciseIndex) => {
    if (!exercise || typeof exercise !== 'object' || Array.isArray(exercise)) throw new ServiceError('validation', 'Each exercise must be an object.');
    if (!safeId(exercise.exercise_template_id) || !templateIds.has(exercise.exercise_template_id)) throw new ServiceError('validation', 'Each exercise must use an imported Hevy exercise template.');
    const rest_seconds = nonNegativeNumber(exercise.rest_seconds, 'rest_seconds', true);
    const savedExercise = existing?.exercises?.[exerciseIndex] ?? {};
    const metadataExercise = metadata?.exercises?.[exerciseIndex] ?? {};
    const exerciseNotes = editing ? optionalRoutineNotes(exercise.notes, savedExercise.notes) : cleanText(exercise.notes, 4000, 'Exercise notes');
    if (!Array.isArray(exercise.sets) || exercise.sets.length < 1 || exercise.sets.length > 50) throw new ServiceError('validation', 'Each exercise needs between 1 and 50 sets.');
    const supersetValue = Object.prototype.hasOwnProperty.call(exercise, 'superset_id') ? exercise.superset_id
      : Object.prototype.hasOwnProperty.call(metadataExercise, 'superset_id') ? metadataExercise.superset_id
        : savedExercise.superset_id;
    const superset_id = editing ? metadataNumber(supersetValue ?? null, 'superset_id') : null;
    const sets = exercise.sets.map((set, setIndex) => {
      if (!set || typeof set !== 'object' || Array.isArray(set)) throw new ServiceError('validation', 'Each set must be an object.');
      if (!['warmup', 'normal', 'failure', 'dropset'].includes(set.type)) throw new ServiceError('validation', 'Set type is not supported.');
      const weight_kg = nonNegativeNumber(set.weight_kg, 'weight_kg');
      const reps = nonNegativeNumber(set.reps, 'reps', true);
      const duration_seconds = nonNegativeNumber(set.duration_seconds, 'duration_seconds', true);
      const distance_meters = nonNegativeNumber(set.distance_meters, 'distance_meters', true);
      let rep_range = null;
      if (set.rep_range != null) {
        if (!set.rep_range || typeof set.rep_range !== 'object' || Array.isArray(set.rep_range)) throw new ServiceError('validation', 'rep_range must be an object or null.');
        const start = set.rep_range.start; const end = set.rep_range.end;
        // Hevy can return an empty nullable range as {start:null,end:null}.
        // Treat that as absent so a title-only edit does not manufacture an
        // invalid range or discard the saved reps value.
        if (!(start == null && end == null)) {
          if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= 0 || start > end) throw new ServiceError('validation', 'rep_range must have ordered positive integer bounds.');
          rep_range = { start, end };
        }
      }
      if (reps != null && rep_range) throw new ServiceError('validation', 'A set cannot contain both reps and rep_range.');
      const result = { type: set.type, weight_kg, reps, rep_range, duration_seconds, distance_meters };
      if (editing) {
        const savedSet = savedExercise.sets?.[setIndex] ?? {};
        const metadataSet = metadataExercise.sets?.[setIndex] ?? {};
        const customMetric = set.custom_metric !== undefined ? set.custom_metric : metadataSet.custom_metric !== undefined ? metadataSet.custom_metric : savedSet.custom_metric;
        if (customMetric !== undefined) {
          if (customMetric !== null && (typeof customMetric !== 'number' || !Number.isFinite(customMetric) || customMetric < 0)) throw new ServiceError('validation', 'custom_metric must be a finite non-negative number or null.');
          result.custom_metric = customMetric;
        } else result.custom_metric = null;
      }
      return result;
    });
    return { exercise_template_id: exercise.exercise_template_id, superset_id, rest_seconds, notes: exerciseNotes, sets };
  });
  const folder_id = editing ? metadataNumber(existing?.folder_id ?? null, 'folder_id') : null;
  return { requestId: body.requestId, payload: { routine: { title, notes, folder_id, exercises } } };
}

function cacheRoutine(db, item) {
  if (!safeId(item?.id)) throw new ServiceError('bad_response', 'Hevy returned a routine without a valid id.', 502);
  const syncedAt = isoNow();
  db.prepare('INSERT INTO source_items(kind, source_id, raw_json, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, source_id) DO UPDATE SET raw_json=excluded.raw_json, synced_at=excluded.synced_at').run('routine', item.id, json(item), syncedAt);
  db.prepare('INSERT INTO routines(id, title, folder_id, raw_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,folder_id=excluded.folder_id,raw_json=excluded.raw_json').run(item.id, valueOrNull(item.title), valueOrNull(item.folder_id), json(item));
  db.prepare('DELETE FROM routine_exercises WHERE routine_id = ?').run(item.id);
  const exerciseStatement = db.prepare('INSERT INTO routine_exercises(routine_id, exercise_index, title, template_id, notes, rest_seconds, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const setStatement = db.prepare('INSERT INTO routine_sets(routine_id, exercise_index, set_index, set_type, rep_range, raw_json) VALUES (?, ?, ?, ?, ?, ?)');
  for (const [exerciseIndex, exercise] of (item.exercises ?? []).entries()) {
    const index = Number.isInteger(exercise?.index) ? exercise.index : exerciseIndex;
    exerciseStatement.run(item.id, index, valueOrNull(exercise?.title), valueOrNull(exercise?.exercise_template_id), valueOrNull(exercise?.notes), valueOrNull(exercise?.rest_seconds), json(exercise));
    for (const [setIndex, set] of (exercise?.sets ?? []).entries()) {
      const setNumber = Number.isInteger(set?.index) ? set.index : setIndex;
      setStatement.run(item.id, index, setNumber, valueOrNull(set?.type), set?.rep_range == null ? null : json(set.rep_range), json(set));
    }
  }
}

function upsertSnapshot(db, snapshot) {
  const syncedAt = isoNow();
  const source = db.prepare('INSERT INTO source_items(kind, source_id, raw_json, synced_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, source_id) DO UPDATE SET raw_json=excluded.raw_json, synced_at=excluded.synced_at');
  const workout = db.prepare('INSERT INTO workouts(id, title, routine_id, start_time, end_time, raw_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,routine_id=excluded.routine_id,start_time=excluded.start_time,end_time=excluded.end_time,raw_json=excluded.raw_json');
  const deleteWorkoutExercises = db.prepare('DELETE FROM workout_exercises WHERE workout_id = ?');
  const workoutExercise = db.prepare('INSERT INTO workout_exercises(workout_id, exercise_index, title, template_id, notes, raw_json) VALUES (?, ?, ?, ?, ?, ?)');
  const workoutSet = db.prepare('INSERT INTO workout_sets(workout_id, exercise_index, set_index, set_type, weight_kg, reps, distance_meters, duration_seconds, rpe, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const routine = db.prepare('INSERT INTO routines(id, title, folder_id, raw_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,folder_id=excluded.folder_id,raw_json=excluded.raw_json');
  const deleteRoutineExercises = db.prepare('DELETE FROM routine_exercises WHERE routine_id = ?');
  const routineExercise = db.prepare('INSERT INTO routine_exercises(routine_id, exercise_index, title, template_id, notes, rest_seconds, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const routineSet = db.prepare('INSERT INTO routine_sets(routine_id, exercise_index, set_index, set_type, rep_range, raw_json) VALUES (?, ?, ?, ?, ?, ?)');
  const template = db.prepare('INSERT INTO exercise_templates(id, title, raw_json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,raw_json=excluded.raw_json');

  const seen = { workout: new Set(), routine: new Set(), exercise_template: new Set() };
  for (const item of snapshot.workouts) {
    if (!safeId(item?.id)) throw new ServiceError('bad_response', 'Hevy returned a workout without a valid id.', 502);
    seen.workout.add(item.id); source.run('workout', item.id, json(item), syncedAt);
    workout.run(item.id, valueOrNull(item.title), valueOrNull(item.routine_id), valueOrNull(item.start_time), valueOrNull(item.end_time), json(item));
    deleteWorkoutExercises.run(item.id);
    for (const [exerciseIndex, exercise] of (item.exercises ?? []).entries()) {
      const index = Number.isInteger(exercise?.index) ? exercise.index : exerciseIndex;
      workoutExercise.run(item.id, index, valueOrNull(exercise?.title), valueOrNull(exercise?.exercise_template_id), valueOrNull(exercise?.notes), json(exercise));
      for (const [setIndex, set] of (exercise?.sets ?? []).entries()) {
        const setNumber = Number.isInteger(set?.index) ? set.index : setIndex;
        workoutSet.run(item.id, index, setNumber, valueOrNull(set?.type), valueOrNull(set?.weight_kg), valueOrNull(set?.reps), valueOrNull(set?.distance_meters), valueOrNull(set?.duration_seconds), valueOrNull(set?.rpe), json(set));
      }
    }
  }
  for (const item of snapshot.routines) {
    if (!safeId(item?.id)) throw new ServiceError('bad_response', 'Hevy returned a routine without a valid id.', 502);
    seen.routine.add(item.id); source.run('routine', item.id, json(item), syncedAt);
    routine.run(item.id, valueOrNull(item.title), valueOrNull(item.folder_id), json(item));
    deleteRoutineExercises.run(item.id);
    for (const [exerciseIndex, exercise] of (item.exercises ?? []).entries()) {
      const index = Number.isInteger(exercise?.index) ? exercise.index : exerciseIndex;
      routineExercise.run(item.id, index, valueOrNull(exercise?.title), valueOrNull(exercise?.exercise_template_id), valueOrNull(exercise?.notes), valueOrNull(exercise?.rest_seconds), json(exercise));
      for (const [setIndex, set] of (exercise?.sets ?? []).entries()) {
        const setNumber = Number.isInteger(set?.index) ? set.index : setIndex;
        routineSet.run(item.id, index, setNumber, valueOrNull(set?.type), set?.rep_range == null ? null : json(set.rep_range), json(set));
      }
    }
  }
  for (const item of snapshot.exerciseTemplates) {
    if (!safeId(item?.id)) throw new ServiceError('bad_response', 'Hevy returned an exercise template without a valid id.', 502);
    seen.exercise_template.add(item.id); source.run('exercise_template', item.id, json(item), syncedAt);
    template.run(item.id, valueOrNull(item.title), json(item));
  }
  for (const [kind, ids] of Object.entries(seen)) {
    const table = kind === 'workout' ? 'workouts' : kind === 'routine' ? 'routines' : 'exercise_templates';
    const current = db.prepare('SELECT source_id FROM source_items WHERE kind = ?').all(kind);
    const removeSource = db.prepare('DELETE FROM source_items WHERE kind = ? AND source_id = ?');
    const removeData = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    for (const { source_id } of current) if (!ids.has(source_id)) { removeData.run(source_id); removeSource.run(kind, source_id); }
  }
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('last_sync', syncedAt);
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('mode', 'live');
}

function markdownValue(value) {
  if (value == null || value === '') return null;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function markdownFields(object, omit = []) {
  return Object.entries(object ?? {}).filter(([key, value]) => !omit.includes(key) && value != null && value !== '').map(([key, value]) => `  - ${key}: ${markdownValue(value)}`);
}

function markdownFor(state) {
  const demo = state.mode === 'demo' ? '> **Demo data** — this export contains deterministic sample workouts.\n\n' : '';
  const workoutLines = [ '# Workouts', '', demo ];
  for (const workout of state.workouts) {
    workoutLines.push(`## ${workout.title || 'Untitled workout'}`, '', ...markdownFields(workout, ['exercises']), '');
    for (const exercise of workout.exercises ?? []) {
      workoutLines.push(`### ${exercise.title || 'Exercise'}`, ...markdownFields(exercise, ['sets']));
      for (const set of exercise.sets ?? []) {
        workoutLines.push(`- Set ${(set.index ?? 0) + 1}:`, ...markdownFields(set, ['index']).map((line) => `  ${line}`));
      }
      workoutLines.push('');
    }
  }
  const routineLines = ['# Routines', '', demo];
  for (const routine of state.routines) {
    routineLines.push(`## ${routine.title || 'Untitled routine'}`, '', ...markdownFields(routine, ['exercises']), '');
    for (const exercise of routine.exercises ?? []) {
      routineLines.push(`### ${exercise.title || 'Exercise'}`, ...markdownFields(exercise, ['sets']));
      for (const set of exercise.sets ?? []) routineLines.push(`- Set ${(set.index ?? 0) + 1}:`, ...markdownFields(set, ['index']).map((line) => `  ${line}`));
      routineLines.push('');
    }
    routineLines.push('');
  }
  const overviewLines = ['# Corpus training overview', '', demo, `- Workouts: ${state.workouts.length}`, `- Routines: ${state.routines.length}`, `- Exercise templates: ${state.exerciseTemplates.length}`, `- Programs: ${state.programs.length}`, `- Last sync: ${state.settings.lastSync || 'Never'}`, ''];
  const programLines = ['# Programs', '', demo];
  for (const program of state.programs) {
    programLines.push(`## ${program.title}`, '', program.description, '');
    programLines.push(...programScheduleMarkdown(program), '');
    for (const day of program.days) programLines.push(`- ${day.label}: ${day.routineId}`);
    programLines.push('');
  }
  return { 'workouts.md': workoutLines.join('\n'), 'routines.md': routineLines.join('\n'), 'overview.md': overviewLines.join('\n'), 'programs.md': programLines.join('\n') };
}

function metricsMarkdown(metrics) {
  const lines = ['# Health metrics', ''];
  if (metrics.mode === 'demo') lines.push('> **Demo data** — this export contains deterministic sample health metrics.', '');
  lines.push(`- Range: ${metrics.range.from} to ${metrics.range.to}`, '- Sources:');
  if (!metrics.sources.length) lines.push('  - None connected');
  for (const source of metrics.sources) lines.push(`  - ${source.label} (${source.kind}): last sync ${source.lastSync || 'never'}, synced through ${source.syncedThrough || 'n/a'}`);
  const present = METRICS.filter((metric) => metrics.series[metric.key].length);
  const format = (metric, value) => value.toFixed(metric.decimals);
  lines.push('', '## Latest', '');
  if (!present.length) lines.push('- No data yet');
  for (const metric of present) { const last = metrics.series[metric.key].at(-1); lines.push(`- ${metric.label}: ${format(metric, last.value)} ${metric.unit} (${last.date})`); }
  lines.push('', '## Daily', '');
  if (present.length) {
    const byDate = new Map();
    for (const metric of present) for (const point of metrics.series[metric.key]) { if (!byDate.has(point.date)) byDate.set(point.date, {}); byDate.get(point.date)[metric.key] = point.value; }
    lines.push(`| Date | ${present.map((metric) => `${metric.label} (${metric.unit})`).join(' | ')} |`, `| --- | ${present.map(() => '---').join(' | ')} |`);
    for (const date of [...byDate.keys()].sort()) lines.push(`| ${date} | ${present.map((metric) => byDate.get(date)[metric.key] == null ? '' : format(metric, byDate.get(date)[metric.key])).join(' | ')} |`);
  }
  return lines.join('\n');
}

export async function createService({ dataDir, fetchImpl = globalThis.fetch } = {}) {
  if (!dataDir || typeof dataDir !== 'string') throw new TypeError('dataDir is required.');
  const createdDataDir = await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (createdDataDir) await chmod(dataDir, 0o700);
  const dbPath = path.join(dataDir, 'corpus.sqlite');
  const db = new DatabaseSync(dbPath);
  await chmod(dbPath, 0o600);
  initialise(db);
  const settingsFile = path.join(dataDir, 'settings.json');
  let privateSettings = await readPrivateSettings(settingsFile);
  let syncPromise = null;
  let metricsSyncPromise = null;
  let pendingOauth = null; // { state, verifier, redirectUri, expires } for the single in-flight Google sign-in
  let writeQueue = Promise.resolve();
  const serialiseWrite = (work) => {
    const result = writeQueue.then(work, work);
    writeQueue = result.catch(() => {});
    return result;
  };

  const getMeta = (key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  const setMeta = (key, value) => db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  const activeKey = () => process.env.HEVY_API_KEY || privateSettings.apiKey || null;
  const mode = () => getMeta('mode') === 'live' ? 'live' : 'demo';
  const googleClient = () => (privateSettings.googleClientId && privateSettings.googleClientSecret ? { clientId: privateSettings.googleClientId, clientSecret: privateSettings.googleClientSecret } : null);
  const googleTokens = () => (privateSettings.googleHealth?.accessToken && privateSettings.googleHealth?.refreshToken ? privateSettings.googleHealth : null);
  const publicSettings = () => ({ unit: privateSettings.unit === 'lb' ? 'lb' : 'kg', hasApiKey: Boolean(activeKey()), lastSync: getMeta('last_sync'), googleHealth: { hasClient: Boolean(googleClient()), connected: Boolean(googleTokens()), lastSync: db.prepare('SELECT last_sync FROM metric_sources WHERE id = ?').get(GOOGLE_SOURCE)?.last_sync ?? null } });
  const saveGoogleTokens = async (tokens) => {
    const next = { ...privateSettings };
    if (tokens) next.googleHealth = tokens; else delete next.googleHealth;
    await writePrivateSettings(settingsFile, next);
    privateSettings = next;
  };
  const googleError = (error) => (error instanceof GoogleHealthError
    ? new ServiceError(error.code, error.message, { unauthorized: 401, rate_limited: 429, network: 503 }[error.code] ?? 502)
    : error);
  const notConnected = () => new ServiceError('not_connected', 'Google Health needs to be reconnected.', 401);
  const metricSources = () => db.prepare('SELECT id, kind, label, cursor_json, last_sync FROM metric_sources ORDER BY created_at, id').all().map((row) => {
    let cursor = null;
    try { cursor = row.cursor_json ? parse(row.cursor_json) : null; } catch { /* treat an unreadable cursor as no cursor */ }
    return { id: row.id, kind: row.kind, label: row.label, lastSync: row.last_sync, syncedThrough: isDateString(cursor?.syncedThrough) ? cursor.syncedThrough : null };
  });
  const metrics = ({ days = 90 } = {}) => {
    const count = clampDays(days); const currentMode = mode();
    const to = localDate(); const from = addDays(to, -(count - 1));
    let series;
    if (currentMode === 'demo') series = demoMetricSeries(from, to);
    else {
      series = Object.fromEntries(METRIC_KEYS.map((key) => [key, []]));
      const aggregate = new Map(METRICS.map((metric) => [metric.key, metric.aggregate]));
      for (const row of db.prepare('SELECT metric, date, SUM(value) AS total, AVG(value) AS mean FROM metric_points WHERE date >= ? AND date <= ? GROUP BY metric, date ORDER BY metric, date').all(from, to)) {
        if (!series[row.metric]) continue;
        series[row.metric].push({ date: row.date, value: Math.round((aggregate.get(row.metric) === 'mean' ? row.mean : row.total) * 1000) / 1000 });
      }
    }
    return { mode: currentMode, range: { from, to }, sources: metricSources(), series };
  };
  const programs = (currentMode) => db.prepare('SELECT id, title, description, days_json, start_date, duration_weeks, created_at, updated_at FROM programs WHERE mode = ? ORDER BY created_at').all(currentMode).map(({ days_json, ...program }) => ({ ...program, days: parse(days_json) }));
  const visibleRoutines = (currentMode) => {
    const base = currentMode === 'demo' ? demoState().routines : db.prepare('SELECT raw_json FROM routines ORDER BY title, id').all().map((row) => parse(row.raw_json));
    const overlays = db.prepare('SELECT id, raw_json FROM local_routines WHERE mode = ? ORDER BY created_at').all(currentMode);
    const byId = new Map(base.map((routine) => [routine.id, routine]));
    for (const row of overlays) byId.set(row.id, parse(row.raw_json));
    return [...byId.values()];
  };
  const trainingProfile = (currentMode) => {
    const row = db.prepare('SELECT goals, equipment, constraints, schedule, updated_at FROM training_profiles WHERE mode = ?').get(currentMode);
    return row ?? { goals: '', equipment: '', constraints: '', schedule: '', updated_at: null };
  };
  const proposalRows = (currentMode) => db.prepare('SELECT * FROM proposals WHERE mode = ? ORDER BY updated_at DESC').all(currentMode).map((row) => publicProposal(row));
  const state = () => {
    const currentMode = mode();
    const data = currentMode === 'demo'
      ? demoState()
      : { workouts: db.prepare('SELECT raw_json FROM workouts ORDER BY start_time DESC, id').all().map((row) => parse(row.raw_json)), routines: db.prepare('SELECT raw_json FROM routines ORDER BY title, id').all().map((row) => parse(row.raw_json)), exerciseTemplates: db.prepare('SELECT raw_json FROM exercise_templates ORDER BY title, id').all().map((row) => parse(row.raw_json)) };
    return { mode: currentMode, settings: publicSettings(), ...data, routines: visibleRoutines(currentMode), programs: programs(currentMode), proposals: proposalRows(currentMode), trainingProfile: trainingProfile(currentMode) };
  };

  return {
    getState: state,
    async saveSettings(body = {}) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError('validation', 'Settings must be an object.');
      const next = { ...privateSettings };
      if (body.unit !== undefined) {
        if (body.unit !== 'kg' && body.unit !== 'lb') throw new ServiceError('validation', 'Unit must be kg or lb.');
        next.unit = body.unit;
      }
      if (body.apiKey !== undefined) {
        if (typeof body.apiKey !== 'string') throw new ServiceError('validation', 'API key must be text.');
        const key = body.apiKey.trim();
        if (key && (key.length < 8 || key.length > 1024)) throw new ServiceError('validation', 'API key has an invalid length.');
        if (key) next.apiKey = key; // An empty field deliberately preserves a stored key.
      }
      for (const [field, label] of [['googleClientId', 'Google client ID'], ['googleClientSecret', 'Google client secret']]) {
        if (body[field] === undefined) continue;
        const value = cleanText(body[field], 512, label);
        if (value) next[field] = value; // Empty fields preserve stored credentials, like the API key.
      }
      await writePrivateSettings(settingsFile, next);
      privateSettings = next;
      return publicSettings();
    },
    getMetrics: metrics,
    async googleHealthConnect({ redirectUri } = {}) {
      const client = googleClient();
      if (!client) throw new ServiceError('no_google_client', 'Add a Google OAuth client ID and secret in Settings before connecting.');
      if (typeof redirectUri !== 'string' || !/^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/api\/metrics\/google\/callback$/.test(redirectUri)) throw new ServiceError('validation', 'The Google redirect URI must be this local Corpus callback.');
      const { verifier, challenge } = pkcePair();
      const state = randomUUID();
      pendingOauth = { state, verifier, redirectUri, expires: Date.now() + OAUTH_PENDING_MS };
      return { url: authorizationUrl({ clientId: client.clientId, redirectUri, state, codeChallenge: challenge }) };
    },
    async googleHealthCallback({ code, state } = {}) {
      return serialiseWrite(async () => {
        if (pendingOauth && pendingOauth.expires < Date.now()) pendingOauth = null;
        if (!pendingOauth || typeof state !== 'string' || state !== pendingOauth.state) throw new ServiceError('oauth_state', 'This Google sign-in link is invalid or has expired. Start again from Settings.', 400);
        const pending = pendingOauth; pendingOauth = null; // the state is single-use
        if (typeof code !== 'string' || !code) throw new ServiceError('validation', 'Google did not return an authorization code.', 400);
        const client = googleClient();
        if (!client) throw new ServiceError('no_google_client', 'Add a Google OAuth client ID and secret in Settings before connecting.');
        let tokens;
        try { tokens = await exchangeCode(fetchImpl, { ...client, code, codeVerifier: pending.verifier, redirectUri: pending.redirectUri }); } catch (error) { throw googleError(error); }
        const refreshToken = tokens?.refreshToken || privateSettings.googleHealth?.refreshToken;
        if (!tokens?.accessToken || !refreshToken) throw new ServiceError('oauth', 'Google did not return usable tokens. Remove Corpus from your Google account and connect again.', 502);
        await saveGoogleTokens({ accessToken: tokens.accessToken, refreshToken, expiresAt: tokens.expiresAt ?? null, scope: tokens.scope ?? SCOPES.join(' '), connectedAt: isoNow() });
        const now = isoNow();
        db.prepare('INSERT INTO metric_sources(id, kind, label, cursor_json, last_sync, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, label=excluded.label, updated_at=excluded.updated_at').run(GOOGLE_SOURCE, 'api', 'Google Health', now, now);
        return { connected: true };
      });
    },
    async googleHealthDisconnect() {
      return serialiseWrite(async () => {
        const tokens = privateSettings.googleHealth;
        if (tokens?.refreshToken || tokens?.accessToken) { try { await revokeToken(fetchImpl, tokens.refreshToken || tokens.accessToken); } catch { /* best effort */ } }
        await saveGoogleTokens(null);
        return publicSettings();
      });
    },
    async syncMetrics() {
      if (metricsSyncPromise) return metricsSyncPromise;
      if (!googleTokens()) throw new ServiceError('not_connected', 'Connect Google Health in Settings before syncing.', 400);
      metricsSyncPromise = serialiseWrite(async () => {
        const client = googleClient();
        if (!client) throw new ServiceError('no_google_client', 'Add a Google OAuth client ID and secret in Settings before syncing.');
        let tokens = googleTokens();
        if (!tokens) throw notConnected();
        const disconnect = async () => { await saveGoogleTokens(null); return notConnected(); };
        // A refresh that Google rejects means the grant is gone (revoked, or the
        // test-user consent expired); a transient token failure keeps the grant.
        const refresh = async (afterUnauthorized = false) => {
          let fresh;
          try { fresh = await refreshAccessToken(fetchImpl, { ...client, refreshToken: tokens.refreshToken }); } catch (error) {
            if (error instanceof GoogleHealthError && (error.code === 'unauthorized' || (error.code === 'oauth' && (afterUnauthorized || /invalid_grant/.test(error.message))))) throw await disconnect();
            throw googleError(error);
          }
          if (!fresh?.accessToken) throw await disconnect();
          tokens = { ...tokens, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken || tokens.refreshToken, expiresAt: fresh.expiresAt ?? null, scope: fresh.scope ?? tokens.scope };
          await saveGoogleTokens(tokens);
        };
        if (!tokens.expiresAt || Date.parse(tokens.expiresAt) - Date.now() < 60_000) await refresh();
        const to = localDate();
        const cursor = metricSources().find((source) => source.id === GOOGLE_SOURCE)?.syncedThrough;
        const from = cursor ? addDays(cursor < to ? cursor : to, -METRICS_RESYNC_DAYS) : addDays(to, -METRICS_FIRST_SYNC_DAYS);
        let result;
        try { result = await fetchMetricPoints(fetchImpl, tokens.accessToken, { from, to }); } catch (error) {
          if (!(error instanceof GoogleHealthError) || error.code !== 'unauthorized') throw googleError(error);
          await refresh(true);
          try { result = await fetchMetricPoints(fetchImpl, tokens.accessToken, { from, to }); } catch (retryError) {
            if (retryError instanceof GoogleHealthError && retryError.code === 'unauthorized') throw await disconnect();
            throw googleError(retryError);
          }
        }
        const points = (Array.isArray(result?.points) ? result.points : []).filter((point) => point && isMetricKey(point.metric) && safeId(point.sourceId) && isDateString(point.date) && typeof point.value === 'number' && Number.isFinite(point.value));
        const warnings = Array.isArray(result?.warnings) ? result.warnings.map(String) : [];
        const failed = Array.isArray(result?.failed) ? result.failed.map(String) : [];
        const now = isoNow();
        try {
          db.exec('BEGIN IMMEDIATE');
          db.prepare('INSERT INTO metric_sources(id, kind, label, cursor_json, last_sync, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?) ON CONFLICT(id) DO NOTHING').run(GOOGLE_SOURCE, 'api', 'Google Health', now, now);
          const upsert = db.prepare('INSERT INTO metric_points(source, metric, source_id, date, start_time, end_time, value, raw_json, imported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, metric, source_id) DO UPDATE SET date=excluded.date, start_time=excluded.start_time, end_time=excluded.end_time, value=excluded.value, raw_json=excluded.raw_json, imported_at=excluded.imported_at');
          for (const point of points) upsert.run(GOOGLE_SOURCE, point.metric, point.sourceId, point.date, valueOrNull(point.startTime), valueOrNull(point.endTime), point.value, point.raw == null ? null : json(point.raw), now);
          // A sync in which any data type's request failed keeps its cursor, so
          // the next sync re-fetches the same range instead of leaving gaps behind.
          if (failed.length) db.prepare('UPDATE metric_sources SET last_sync = ?, updated_at = ? WHERE id = ?').run(now, now, GOOGLE_SOURCE);
          else db.prepare('UPDATE metric_sources SET cursor_json = ?, last_sync = ?, updated_at = ? WHERE id = ?').run(json({ syncedThrough: to }), now, now, GOOGLE_SOURCE);
          setMeta('mode', 'live');
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* no transaction to roll back */ }
          throw error;
        }
        return { ...metrics({ days: 90 }), imported: points.length, warnings };
      });
      try { return await metricsSyncPromise; } finally { metricsSyncPromise = null; }
    },
    async sync() {
      if (syncPromise) return syncPromise;
      const apiKey = activeKey();
      if (!apiKey) throw new ServiceError('no_api_key', 'Add a Hevy API key before syncing.');
      syncPromise = serialiseWrite(async () => {
        const snapshot = await fetchSnapshot(fetchImpl, apiKey);
        try {
          db.exec('BEGIN IMMEDIATE');
          upsertSnapshot(db, snapshot);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* no transaction to roll back */ }
          throw error;
        }
        return state();
      });
      try { return await syncPromise; } finally { syncPromise = null; }
    },
    async submitProposal(body = {}) {
      return serialiseWrite(async () => {
        const currentMode = mode();
        if (!body || typeof body !== 'object' || Array.isArray(body) || !uuid(body.requestId)) throw new ServiceError('validation', 'requestId must be a UUID.');
        const hash = payloadHash(body);
        const request = db.prepare('SELECT r.payload_hash, r.proposal_id, r.revision, p.mode AS proposal_mode FROM proposal_requests r JOIN proposals p ON p.id = r.proposal_id WHERE r.request_id = ?').get(body.requestId);
        if (request) {
          if (request.proposal_mode !== currentMode) throw new ServiceError('request_conflict', 'This request id belongs to a proposal in another data mode.', 409);
          if (request.payload_hash !== hash) throw new ServiceError('request_conflict', 'This request id was already used for a different proposal.', 409);
          const saved = db.prepare('SELECT proposal_id AS id, revision, status, title, rationale, routines_json, programs_json, feedback, result_json, created_at, updated_at FROM proposal_history WHERE proposal_id = ? AND revision = ?').get(request.proposal_id, request.revision);
          return publicProposal(saved);
        }
        const visible = visibleRoutines(currentMode);
        const templates = currentMode === 'demo'
          ? demoState().exerciseTemplates
          : db.prepare('SELECT id, title FROM exercise_templates').all();
        const templateIds = new Set(templates.map((template) => template.id));
        const templateTitles = new Map(templates.map((template) => [template.id, template.title]));
        const fail = (code, message, status = 400) => { throw new ServiceError(code, message, status); };
        const draft = proposalDraft(body, { routines: visible, programs: programs(currentMode), templateIds, templateTitles, buildRoutine: buildRoutinePayload, fail });
        const now = isoNow(); let id; let revision; let created;
        try {
          db.exec('BEGIN IMMEDIATE');
          if (draft.id) {
            const previous = db.prepare('SELECT * FROM proposals WHERE id = ? AND mode = ?').get(draft.id, currentMode);
            if (!previous) throw new ServiceError('not_found', 'Proposal was not found.', 404);
            if (previous.status !== 'revision_requested') throw new ServiceError('proposal_immutable', 'Only a requested revision can replace a proposal.', 409);
            if (draft.expectedRevision !== previous.revision) throw new ServiceError('revision_conflict', 'This proposal has a newer revision.', 409);
            id = previous.id; revision = previous.revision + 1; created = previous.created_at;
            db.prepare('UPDATE proposals SET revision=?, status=?, title=?, rationale=?, routines_json=?, programs_json=?, feedback=NULL, result_json=NULL, updated_at=? WHERE id=?').run(revision, 'draft', draft.title, draft.rationale, json(draft.routines), json(draft.programs), now, id);
          } else {
            if (draft.expectedRevision !== undefined) throw new ServiceError('validation', 'expectedRevision requires a proposal id.');
            id = randomUUID(); revision = 1; created = now;
            db.prepare('INSERT INTO proposals(id, revision, mode, status, title, rationale, routines_json, programs_json, feedback, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, revision, currentMode, 'draft', draft.title, draft.rationale, json(draft.routines), json(draft.programs), null, null, created, now);
          }
          db.prepare('INSERT INTO proposal_history(proposal_id, revision, status, title, rationale, routines_json, programs_json, feedback, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, revision, 'draft', draft.title, draft.rationale, json(draft.routines), json(draft.programs), null, null, created, now);
          db.prepare('INSERT INTO proposal_requests(request_id, payload_hash, proposal_id, revision, created_at) VALUES (?, ?, ?, ?, ?)').run(draft.requestId, hash, id, revision, now);
          db.exec('COMMIT');
        } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
        const proposalDir = path.join(dataDir, 'proposals', id);
        await mkdir(proposalDir, { recursive: true, mode: 0o700 });
        await writeFile(path.join(proposalDir, `revision-${revision}.md`), `${draft.rationale}\n`, { mode: 0o600 });
        return publicProposal(db.prepare('SELECT * FROM proposals WHERE id = ?').get(id));
      });
    },
    getProposal(id) {
      if (!uuid(id)) throw new ServiceError('validation', 'Proposal id is invalid.');
      const row = db.prepare('SELECT * FROM proposals WHERE id = ? AND mode = ?').get(id, mode());
      if (!row) throw new ServiceError('not_found', 'Proposal was not found.', 404);
      const history = db.prepare('SELECT proposal_id AS id, revision, status, title, rationale, routines_json, programs_json, feedback, result_json, created_at, updated_at FROM proposal_history WHERE proposal_id = ? ORDER BY revision').all(id).map((entry) => publicProposal(entry));
      return publicProposal(row, history);
    },
    async reviewProposal(id, body = {}) {
      return serialiseWrite(async () => {
        if (!uuid(id)) throw new ServiceError('validation', 'Proposal id is invalid.');
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['action', 'expectedRevision', 'feedback'].includes(key))) throw new ServiceError('validation', 'Review contains an unsupported field.');
        if (!['accept', 'decline', 'request_revision'].includes(body.action)) throw new ServiceError('validation', 'Review action is invalid.');
        if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 1) throw new ServiceError('validation', 'expectedRevision must be a positive integer.');
        const feedback = body.feedback === undefined ? null : cleanText(body.feedback, 4000, 'Feedback');
        const currentMode = mode(); const proposal = db.prepare('SELECT * FROM proposals WHERE id = ? AND mode = ?').get(id, currentMode);
        if (!proposal) throw new ServiceError('not_found', 'Proposal was not found.', 404);
        if (proposal.revision !== body.expectedRevision) throw new ServiceError('revision_conflict', 'This proposal has a newer revision.', 409);
        if (proposal.status !== 'draft') throw new ServiceError('proposal_immutable', 'Only a draft proposal can be reviewed.', 409);
        const now = isoNow(); let result = null; let status = body.action === 'accept' ? 'accepted' : body.action === 'decline' ? 'declined' : 'revision_requested';
        try {
          db.exec('BEGIN IMMEDIATE');
          if (body.action === 'accept') {
            const currentRoutines = visibleRoutines(currentMode); const currentPrograms = programs(currentMode);
            const draftedRoutines = parse(proposal.routines_json); const draftedPrograms = parse(proposal.programs_json);
            for (const entry of draftedRoutines) if (entry.targetId && (!currentRoutines.find((value) => value.id === entry.targetId) || entityHash(currentRoutines.find((value) => value.id === entry.targetId)) !== entry.baseHash)) throw new ServiceError('stale_target', 'A routine changed since this proposal was drafted.', 409);
            for (const entry of draftedPrograms) if (entry.targetId && (!currentPrograms.find((value) => value.id === entry.targetId) || entityHash(currentPrograms.find((value) => value.id === entry.targetId)) !== entry.baseHash)) throw new ServiceError('stale_target', 'A program changed since this proposal was drafted.', 409);
            const routineIds = {}; const programIds = {};
            for (const entry of draftedRoutines) {
              const existingOverlay = entry.targetId ? db.prepare('SELECT hevy_id, base_hash, created_at, publish_status FROM local_routines WHERE id = ? AND mode = ?').get(entry.targetId, currentMode) : null;
              if (existingOverlay?.publish_status === 'pending') throw new ServiceError('publication_pending', 'This routine is being published. Wait before accepting another edit.', 409);
              if (existingOverlay?.publish_status === 'uncertain') throw new ServiceError('publication_uncertain', 'This routine publication is uncertain. Check Hevy before accepting another edit.', 502);
              const idForRoutine = entry.targetId ?? `local-${randomUUID()}`;
              const imported = entry.targetId && currentMode === 'live' ? db.prepare('SELECT raw_json FROM routines WHERE id = ?').get(entry.targetId) : null;
              const after = { ...entry.after, id: idForRoutine, source: 'local', hevy_id: existingOverlay ? existingOverlay.hevy_id : (imported ? entry.targetId : null) };
              db.prepare('INSERT INTO local_routines(id, mode, hevy_id, base_hash, raw_json, proposal_id, publish_request_id, publish_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET hevy_id=excluded.hevy_id, base_hash=excluded.base_hash, raw_json=excluded.raw_json, proposal_id=excluded.proposal_id, updated_at=excluded.updated_at').run(idForRoutine, currentMode, after.hevy_id, existingOverlay?.base_hash ?? (imported ? entityHash(parse(imported.raw_json)) : null), json(after), proposal.id, null, null, existingOverlay?.created_at ?? now, now);
              // An edited Hevy routine keeps its remote id as the local overlay
              // id. A prior publication mapping for that id belongs to an older
              // edit and must not short-circuit this newly accepted change.
              if (entry.targetId) db.prepare('DELETE FROM local_routine_mappings WHERE local_id = ?').run(idForRoutine);
              routineIds[entry.key] = idForRoutine;
            }
            const available = new Set([...currentRoutines.map((routine) => routine.id), ...Object.values(routineIds)]);
            for (const entry of draftedPrograms) {
              const days = entry.after.days.map((day) => ({ label: day.label, routineId: day.routineKey ? routineIds[day.routineKey] : day.routineId }));
              if (days.some((day) => !available.has(day.routineId))) throw new ServiceError('validation', 'A proposed program refers to an unavailable routine.');
              const existing = entry.targetId ? db.prepare('SELECT id, created_at FROM programs WHERE id = ? AND mode = ?').get(entry.targetId, currentMode) : null;
              const programId = existing?.id ?? randomUUID(); const created = existing?.created_at ?? now;
              db.prepare('INSERT INTO programs(id, mode, title, description, days_json, start_date, duration_weeks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, days_json=excluded.days_json, start_date=excluded.start_date, duration_weeks=excluded.duration_weeks, updated_at=excluded.updated_at').run(programId, currentMode, entry.after.title, entry.after.description, json(days), entry.after.start_date, entry.after.duration_weeks, created, now);
              programIds[entry.key] = programId;
            }
            result = { routineIds, programIds };
          }
          db.prepare('UPDATE proposals SET status=?, feedback=?, result_json=?, updated_at=? WHERE id=?').run(status, feedback, result ? json(result) : null, now, id);
          db.prepare('UPDATE proposal_history SET status=?, feedback=?, result_json=?, updated_at=? WHERE proposal_id=? AND revision=?').run(status, feedback, result ? json(result) : null, now, id, proposal.revision);
          db.exec('COMMIT');
        } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
        return publicProposal(db.prepare('SELECT * FROM proposals WHERE id = ?').get(id));
      });
    },
    async saveTrainingProfile(body = {}) {
      return serialiseWrite(async () => {
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !['goals', 'equipment', 'constraints', 'schedule'].includes(key))) throw new ServiceError('validation', 'Training profile contains an unsupported field.');
        const goals = cleanText(body.goals, 4000, 'Goals'); const equipment = cleanText(body.equipment, 4000, 'Equipment'); const constraints = cleanText(body.constraints, 4000, 'Constraints'); const schedule = cleanText(body.schedule, 4000, 'Schedule'); const updated_at = isoNow(); const currentMode = mode();
        db.prepare('INSERT INTO training_profiles(mode, goals, equipment, constraints, schedule, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(mode) DO UPDATE SET goals=excluded.goals,equipment=excluded.equipment,constraints=excluded.constraints,schedule=excluded.schedule,updated_at=excluded.updated_at').run(currentMode, goals, equipment, constraints, schedule, updated_at);
        return { goals, equipment, constraints, schedule, updated_at };
      });
    },
    async createRoutine(body = {}) {
      return serialiseWrite(async () => {
        if (mode() !== 'live') throw new ServiceError('live_mode_required', 'Switch to live data before creating a Hevy routine.', 409);
        const apiKey = activeKey();
        if (!apiKey) throw new ServiceError('no_api_key', 'Add a Hevy API key before creating a routine.');
        const templateIds = new Set(db.prepare('SELECT id FROM exercise_templates').all().map(({ id }) => id));
        const { requestId, payload } = buildRoutinePayload(body, templateIds);
        // Keep the original create hash so ledgers written by older Corpus
        // versions remain idempotent across an upgrade. Updates namespace the
        // operation and target below.
        const hash = payloadHash(payload);
        const existing = db.prepare('SELECT payload_hash, status, result_json FROM routine_publications WHERE request_id = ?').get(requestId);
        if (existing) {
          if (existing.payload_hash !== hash) throw new ServiceError('request_conflict', 'This request id was already used for a different routine.', 409);
          if (existing.status === 'succeeded' && existing.result_json) return { routine: parse(existing.result_json) };
          if (existing.status === 'pending') throw new ServiceError('publication_pending', 'This routine publication is still pending. Wait before trying again.', 409);
          throw new ServiceError('publication_uncertain', ROUTINE_UNCERTAIN_MESSAGE, 502);
        }
        const now = isoNow();
        db.prepare('INSERT INTO routine_publications(request_id, payload_hash, status, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, hash, 'pending', null, now, now);
        let routine;
        try {
          routine = await postRoutine(fetchImpl, apiKey, payload);
        } catch (error) {
          if (['routine_rejected', 'invalid_key', 'routine_limit', 'rate_limited'].includes(error?.code)) {
            db.prepare('DELETE FROM routine_publications WHERE request_id = ?').run(requestId);
            throw new ServiceError(error.code, error.message, error.status);
          }
          try { db.prepare('UPDATE routine_publications SET status = ?, updated_at = ? WHERE request_id = ?').run('uncertain', isoNow(), requestId); } catch { /* do not turn an ambiguous remote result into a retryable error */ }
          throw new ServiceError('publication_uncertain', ROUTINE_UNCERTAIN_MESSAGE, 502);
        }
        // Mark success before the optional local cache update: a post-crash retry
        // must never create the remote routine twice.
        try {
          db.prepare('UPDATE routine_publications SET status = ?, result_json = ?, updated_at = ? WHERE request_id = ?').run('succeeded', json(routine), isoNow(), requestId);
          db.exec('BEGIN IMMEDIATE');
          cacheRoutine(db, routine);
          db.exec('COMMIT');
          return { routine };
        } catch {
          try { db.exec('ROLLBACK'); } catch { /* cache transaction never opened */ }
          return { routine, warning: 'Hevy created the routine, but Corpus could not cache it locally. Sync to refresh your archive.' };
        }
      });
    },
    async updateRoutine(id, body = {}) {
      return serialiseWrite(async () => {
        if (mode() !== 'live') throw new ServiceError('live_mode_required', 'Switch to live data before editing a Hevy routine.', 409);
        if (!safeId(id)) throw new ServiceError('validation', 'Routine id is invalid.');
        const saved = db.prepare('SELECT raw_json FROM routines WHERE id = ?').get(id);
        if (!saved) throw new ServiceError('not_found', 'Routine was not found locally. Sync to refresh your routines.', 404);
        let existing;
        try { existing = parse(saved.raw_json); } catch { throw new ServiceError('bad_response', 'The saved routine cache is invalid. Sync before editing.', 502); }
        const apiKey = activeKey();
        if (!apiKey) throw new ServiceError('no_api_key', 'Add a Hevy API key before editing a routine.');
        const templateIds = new Set(db.prepare('SELECT id FROM exercise_templates').all().map(({ id: templateId }) => templateId));
        const { requestId, payload } = buildRoutinePayload(body, templateIds, { existing, editing: true });
        const hash = payloadHash({ operation: 'update', target: id, payload });
        const ledger = db.prepare('SELECT payload_hash, status, result_json FROM routine_publications WHERE request_id = ?').get(requestId);
        if (ledger) {
          if (ledger.payload_hash !== hash) throw new ServiceError('request_conflict', 'This request id was already used for a different routine update.', 409);
          if (ledger.status === 'succeeded' && ledger.result_json) return { routine: parse(ledger.result_json) };
          if (ledger.status === 'pending') throw new ServiceError('publication_pending', 'This routine update is still pending. Wait before trying again.', 409);
          throw new ServiceError('publication_uncertain', ROUTINE_UPDATE_UNCERTAIN_MESSAGE, 502);
        }
        const now = isoNow();
        db.prepare('INSERT INTO routine_publications(request_id, payload_hash, status, result_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(requestId, hash, 'pending', null, now, now);
        let routine;
        try {
          routine = await putRoutine(fetchImpl, apiKey, id, payload);
        } catch (error) {
          if (['routine_rejected', 'routine_not_found', 'routine_forbidden', 'invalid_key', 'rate_limited'].includes(error?.code)) {
            db.prepare('DELETE FROM routine_publications WHERE request_id = ?').run(requestId);
            throw new ServiceError(error.code, error.message, error.status);
          }
          try { db.prepare('UPDATE routine_publications SET status = ?, updated_at = ? WHERE request_id = ?').run('uncertain', isoNow(), requestId); } catch { /* preserve the no-retry safety boundary */ }
          throw new ServiceError('publication_uncertain', ROUTINE_UPDATE_UNCERTAIN_MESSAGE, 502);
        }
        // Record success before local caching so a retry cannot repeat the PUT.
        try {
          db.prepare('UPDATE routine_publications SET status = ?, result_json = ?, updated_at = ? WHERE request_id = ?').run('succeeded', json(routine), isoNow(), requestId);
          db.exec('BEGIN IMMEDIATE');
          cacheRoutine(db, routine);
          db.exec('COMMIT');
          return { routine };
        } catch {
          try { db.exec('ROLLBACK'); } catch { /* cache transaction never opened */ }
          return { routine, warning: 'Hevy updated the routine, but Corpus could not cache it locally. Sync to refresh your archive.' };
        }
      });
    },
    async publishLocalRoutine(id) {
      if (!safeId(id)) throw new ServiceError('validation', 'Routine id is invalid.');
      // Claim publication before the remote call. The routine_publications ledger
      // used by createRoutine/updateRoutine is the durable no-duplicate boundary.
      const claim = await serialiseWrite(async () => {
        if (mode() !== 'live') throw new ServiceError('live_mode_required', 'Switch to live data before publishing a local routine.', 409);
        const mapped = db.prepare('SELECT remote_id, result_json FROM local_routine_mappings WHERE local_id = ?').get(id);
        if (mapped) {
          if (mapped.result_json) return { mapped: parse(mapped.result_json) };
          const saved = db.prepare('SELECT raw_json FROM routines WHERE id = ?').get(mapped.remote_id);
          if (saved) return { mapped: parse(saved.raw_json) };
          throw new ServiceError('publication_pending', 'This routine was published and is waiting for a sync.', 409);
        }
        const row = db.prepare("SELECT l.* FROM local_routines l JOIN proposals p ON p.id=l.proposal_id WHERE l.id=? AND l.mode='live' AND p.status='accepted'").get(id);
        if (!row) throw new ServiceError('not_found', 'Accepted local routine was not found.', 404);
        if (row.publish_status === 'uncertain') throw new ServiceError('publication_uncertain', 'Corpus cannot safely retry this routine publication. Check Hevy before syncing.', 502);
        if (row.publish_status === 'pending') throw new ServiceError('publication_pending', 'This routine publication is still pending.', 409);
        if (row.hevy_id) {
          const imported = db.prepare('SELECT raw_json FROM routines WHERE id = ?').get(row.hevy_id);
          if (!imported || !row.base_hash || entityHash(parse(imported.raw_json)) !== row.base_hash) throw new ServiceError('stale_target', 'The Hevy routine changed since this local edit was accepted. Sync and review a new proposal.', 409);
        }
        const requestId = row.publish_request_id ?? randomUUID();
        db.prepare('UPDATE local_routines SET publish_request_id=?, publish_status=?, updated_at=? WHERE id=?').run(requestId, 'pending', isoNow(), id);
        return { row: { ...row, publish_request_id: requestId } };
      });
      if (claim.mapped) return claim.mapped.routine ? claim.mapped : { routine: claim.mapped };
      const local = parse(claim.row.raw_json);
      const payload = { requestId: claim.row.publish_request_id, title: local.title, notes: local.notes, exercises: local.exercises };
      let published;
      try {
        published = claim.row.hevy_id ? await this.updateRoutine(claim.row.hevy_id, payload) : await this.createRoutine(payload);
      } catch (error) {
        await serialiseWrite(async () => {
          const status = error?.code === 'publication_uncertain' ? 'uncertain' : null;
          db.prepare('UPDATE local_routines SET publish_status=?, updated_at=? WHERE id=?').run(status, isoNow(), id);
        });
        throw error;
      }
      await serialiseWrite(async () => {
        const remoteId = published.routine.id;
        db.prepare('INSERT INTO local_routine_mappings(local_id, remote_id, result_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(local_id) DO UPDATE SET remote_id=excluded.remote_id, result_json=excluded.result_json').run(id, remoteId, json(published), isoNow());
        if (!claim.row.hevy_id) {
          const affected = db.prepare('SELECT id, days_json FROM programs WHERE mode = ?').all('live');
          const update = db.prepare('UPDATE programs SET days_json=?, updated_at=? WHERE id=?');
          for (const program of affected) {
            const days = parse(program.days_json); const remapped = days.map((day) => day.routineId === id ? { ...day, routineId: remoteId } : day);
            if (JSON.stringify(days) !== JSON.stringify(remapped)) update.run(json(remapped), isoNow(), program.id);
          }
        }
        db.prepare('DELETE FROM local_routines WHERE id = ?').run(id);
      });
      return published;
    },
    async setDemo(enabled) {
      if (typeof enabled !== 'boolean') throw new ServiceError('validation', 'Demo mode must be true or false.');
      setMeta('mode', enabled ? 'demo' : 'live');
      return state();
    },
    async saveProgram(body = {}) {
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ServiceError('validation', 'Program must be an object.');
      const currentMode = mode();
      const title = cleanText(body.title, PROGRAM_TITLE_MAX, 'Title', true);
      const description = cleanText(body.description, PROGRAM_DESCRIPTION_MAX, 'Description');
      if (!Array.isArray(body.days) || body.days.length < 1 || body.days.length > 14) throw new ServiceError('validation', 'Program needs between 1 and 14 days.');
      const routineIds = new Set(visibleRoutines(currentMode).map((routine) => routine.id));
      const days = body.days.map((day) => {
        if (!day || typeof day !== 'object') throw new ServiceError('validation', 'Each program day must be an object.');
        const label = cleanText(day.label, 100, 'Day label', true);
        if (!safeId(day.routineId) || !routineIds.has(day.routineId)) throw new ServiceError('validation', `Unknown routine: ${String(day.routineId ?? '')}.`);
        return { label, routineId: day.routineId };
      });
      const existing = body.id && safeId(body.id) ? db.prepare('SELECT id, created_at, start_date, duration_weeks FROM programs WHERE id = ? AND mode = ?').get(body.id, currentMode) : null;
      if (body.id && !existing) throw new ServiceError('not_found', 'Program was not found.', 404);
      const hasStartDate = Object.prototype.hasOwnProperty.call(body, 'start_date');
      const hasDurationWeeks = Object.prototype.hasOwnProperty.call(body, 'duration_weeks');
      if (hasStartDate !== hasDurationWeeks) throw new ServiceError('validation', 'Program schedule requires both start_date and duration_weeks, or neither field.');
      const schedule = hasStartDate
        ? programSchedule(body.start_date, body.duration_weeks)
        : programSchedule(existing?.start_date ?? null, existing?.duration_weeks ?? null);
      const id = existing?.id ?? randomUUID(); const now = isoNow(); const created = existing?.created_at ?? now;
      db.prepare('INSERT INTO programs(id, mode, title, description, days_json, start_date, duration_weeks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, days_json=excluded.days_json, start_date=excluded.start_date, duration_weeks=excluded.duration_weeks, updated_at=excluded.updated_at').run(id, currentMode, title, description, json(days), schedule.start_date, schedule.duration_weeks, created, now);
      return { id, title, description, days, ...schedule, created_at: created, updated_at: now };
    },
    async deleteProgram(id) {
      if (!safeId(id)) throw new ServiceError('validation', 'Program id is invalid.');
      const result = db.prepare('DELETE FROM programs WHERE id = ? AND mode = ?').run(id, mode());
      if (!result.changes) throw new ServiceError('not_found', 'Program was not found.', 404);
      return { id, deleted: true };
    },
    async exportMarkdown() {
      const exportDir = path.join(dataDir, 'exports');
      await mkdir(exportDir, { recursive: true });
      const contents = { ...markdownFor(state()), 'metrics.md': metricsMarkdown(metrics({ days: 90 })) }; const files = [];
      for (const [name, contentsForFile] of Object.entries(contents)) {
        const target = path.join(exportDir, name); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temp, `${contentsForFile}\n`, 'utf8'); await rename(temp, target); files.push(`exports/${name}`);
      }
      return { files, mode: mode() };
    },
    close() { db.close(); },
  };
}
