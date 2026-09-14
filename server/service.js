import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { demoState } from './demo.js';
import { fetchRoutine, fetchSnapshot, postRoutine, updateRoutine as putRoutine, ROUTINE_UNCERTAIN_MESSAGE, ROUTINE_UPDATE_UNCERTAIN_MESSAGE } from './hevy.js';
import { programTimeline, validateProgramSchedule } from '../public/program-timeline.js';
import { METRICS, METRIC_KEYS, isMetricKey } from '../public/metrics-catalog.js';
import { entityHash, proposalDraft, publicProposal } from './proposals.js';
import { demoMetricSeries, demoWorkoutMetrics, demoWorkoutMetricsOverview } from './metrics-demo.js';
import { SCOPES, GoogleHealthError, pkcePair, authorizationUrl, exchangeCode, refreshAccessToken, revokeToken, fetchMetricPoints, fetchWorkoutSamples } from './google-health.js';
import { isWorkoutMetricKey } from '../public/workout-metrics-catalog.js';
import { DOSE_UNITS } from '../public/supplements-catalog.js';
import { workoutWindow, mergeWindows, needsFetch, summariseWorkout, overviewRow, coverageCounts, blankMetrics, parseTimeMs } from './workout-metrics.js';
import { validateSupplement, validateDose, frequencyLabel, supplementStatus, workoutDoses, scheduledDoses } from './supplements.js';

export { entityHash } from './proposals.js';

const SCHEMA_VERSION = 8;
const GOOGLE_SOURCE = 'google-health';
const OAUTH_PENDING_MS = 10 * 60 * 1000;
const METRICS_FIRST_SYNC_DAYS = 365;
const METRICS_RESYNC_DAYS = 7;
// Windows fetched per sync call, newest workouts first. Roughly four requests
// each, so a full sync stays well inside Google's per-minute budget.
const WORKOUT_WINDOW_BUDGET = 25;
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
function fail(code, message, status = 400) { throw new ServiceError(code, message, status); }
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
    CREATE INDEX IF NOT EXISTS metric_points_by_metric_date ON metric_points(metric, date);
    CREATE TABLE IF NOT EXISTS workout_samples (source TEXT NOT NULL REFERENCES metric_sources(id) ON DELETE CASCADE, metric TEXT NOT NULL, at_ms INTEGER NOT NULL, value REAL NOT NULL, duration_ms INTEGER, label TEXT, PRIMARY KEY (source, metric, at_ms)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS workout_sample_windows (source TEXT NOT NULL REFERENCES metric_sources(id) ON DELETE CASCADE, workout_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, status TEXT NOT NULL, detail_json TEXT, fetched_at TEXT NOT NULL, PRIMARY KEY (source, workout_id)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS supplements (id TEXT PRIMARY KEY, mode TEXT NOT NULL, name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', type TEXT NOT NULL, dose_amount REAL NOT NULL, dose_unit TEXT NOT NULL, frequency_json TEXT NOT NULL, timing TEXT NOT NULL DEFAULT '', start_date TEXT NOT NULL, end_date TEXT, purchase_url TEXT, package_size REAL, ingredients TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS supplement_doses (id TEXT PRIMARY KEY, supplement_id TEXT NOT NULL REFERENCES supplements(id) ON DELETE CASCADE, taken_at TEXT NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL, workout_id TEXT, slot TEXT, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS supplement_doses_workout ON supplement_doses(supplement_id, workout_id) WHERE workout_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS supplement_doses_by_date ON supplement_doses(supplement_id, date);`);
  const programColumns = new Set(db.prepare('PRAGMA table_info(programs)').all().map((column) => column.name));
  const mappingColumns = new Set(db.prepare('PRAGMA table_info(local_routine_mappings)').all().map((column) => column.name));
  // `slot` arrived inside version 8, so the version alone does not prove it is there.
  const doseColumns = new Set(db.prepare('PRAGMA table_info(supplement_doses)').all().map((column) => column.name));
  const needsMigration = !version || Number(version) < SCHEMA_VERSION || !programColumns.has('start_date') || !programColumns.has('duration_weeks') || !mappingColumns.has('result_json') || !doseColumns.has('slot');
  if (needsMigration) {
    try {
      db.exec('BEGIN IMMEDIATE');
      if (!programColumns.has('start_date')) db.exec('ALTER TABLE programs ADD COLUMN start_date TEXT');
      if (!programColumns.has('duration_weeks')) db.exec('ALTER TABLE programs ADD COLUMN duration_weeks INTEGER');
      if (!mappingColumns.has('result_json')) db.exec('ALTER TABLE local_routine_mappings ADD COLUMN result_json TEXT');
      if (!doseColumns.has('slot')) db.exec('ALTER TABLE supplement_doses ADD COLUMN slot TEXT');
      if (!version) db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
      else db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* no transaction to roll back */ }
      throw error;
    }
  }
  // After the column check, so a version-8 database that predates `slot` is altered before the index reads it.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS supplement_doses_slot ON supplement_doses(supplement_id, slot) WHERE slot IS NOT NULL');
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
      const result = { type: set.type, weight_kg, reps, duration_seconds, distance_meters };
      // Hevy's live PUT validator rejects `rep_range: null` even though the
      // published schema marks the field nullable. Keep the legacy POST shape
      // for request-id/hash compatibility, but omit an absent range on edits.
      if (!editing || rep_range !== null) result.rep_range = rep_range;
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

function routineWriteShape(routine) {
  const nullable = (value) => value == null ? null : value;
  const repRange = (value) => value == null || (value.start == null && value.end == null)
    ? null
    : { start: nullable(value.start), end: nullable(value.end) };
  return {
    title: nullable(routine?.title),
    folder_id: nullable(routine?.folder_id),
    exercises: (routine?.exercises ?? []).map((exercise) => ({
      exercise_template_id: nullable(exercise?.exercise_template_id),
      superset_id: nullable(exercise?.superset_id),
      rest_seconds: nullable(exercise?.rest_seconds),
      notes: nullable(exercise?.notes),
      sets: (exercise?.sets ?? []).map((set) => ({
        type: nullable(set?.type),
        weight_kg: nullable(set?.weight_kg),
        reps: nullable(set?.reps),
        rep_range: repRange(set?.rep_range),
        duration_seconds: nullable(set?.duration_seconds),
        distance_meters: nullable(set?.distance_meters),
        custom_metric: nullable(set?.custom_metric),
      })),
    })),
  };
}

function sameRoutineWrite(left, right) {
  return stableJson(routineWriteShape(left)) === stableJson(routineWriteShape(right));
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

const SUPPLEMENT_COLUMNS = 'id, name, brand, type, dose_amount, dose_unit, frequency_json, timing, start_date, end_date, purchase_url, package_size, ingredients, notes, created_at, updated_at';
const SUPPLEMENT_STATUS_ORDER = { active: 0, upcoming: 1, ended: 2 };
// A frequency that cannot be read is treated as unscheduled rather than
// failing the whole state read; nothing is expected of it.
function parseFrequency(value) { try { const frequency = parse(value); return frequency && typeof frequency === 'object' ? frequency : { kind: 'as_needed' }; } catch { return { kind: 'as_needed' }; } }
function publicSupplement(row, today) {
  const frequency = parseFrequency(row.frequency_json);
  return { id: row.id, name: row.name, brand: row.brand, type: row.type, dose_amount: row.dose_amount, dose_unit: row.dose_unit, frequency, frequency_label: frequencyLabel(frequency), timing: row.timing, start_date: row.start_date, end_date: row.end_date, status: supplementStatus(row, today), purchase_url: row.purchase_url, package_size: row.package_size, ingredients: row.ingredients, notes: row.notes, created_at: row.created_at, updated_at: row.updated_at };
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

// Matches the browser's formatDose: count units pluralise (`2 capsules`), measures do not (`5 g`).
function doseText(amount, unit) {
  const entry = DOSE_UNITS.find((candidate) => candidate.key === unit);
  return `${amount} ${entry ? (amount === 1 ? entry.label : entry.plural) : unit}`;
}

// Where the dose came from, in the same words the dialogs use: a scheduled dose
// is assumed taken, so the export has to say which rows the user chose.
function doseSource(dose) {
  if (dose.workout_title) return `with ${dose.workout_title}`;
  if (dose.source === 'workout') return 'with a workout';
  return dose.source === 'schedule' ? 'Scheduled' : 'Manual';
}

function supplementsMarkdown({ mode, range, doses }, list) {
  const lines = ['# Supplements', ''];
  if (mode === 'demo') lines.push('> **Demo data** — these supplements were entered against the demo mode.', '');
  if (!list.length) lines.push('- No supplements yet', '');
  for (const supplement of list) {
    lines.push(`## ${supplement.name}`, '');
    lines.push(`- Type: ${supplement.type}`, `- Brand: ${supplement.brand || 'Not set'}`, `- Dose: ${doseText(supplement.dose_amount, supplement.dose_unit)}`, `- Frequency: ${supplement.frequency_label}`, `- Status: ${supplement.status}`, `- Timing: ${supplement.timing || 'Not set'}`, `- Started: ${supplement.start_date}`, `- Ends: ${supplement.end_date || 'Ongoing'}`, `- Package: ${supplement.package_size == null ? 'Not set' : `${doseText(supplement.package_size, supplement.dose_unit)}`}`, `- Where to buy: ${supplement.purchase_url || 'Not set'}`);
    if (supplement.ingredients) lines.push('', '### Ingredients', '', supplement.ingredients);
    if (supplement.notes) lines.push('', '### Notes', '', supplement.notes);
    const recent = doses.filter((dose) => dose.supplement_id === supplement.id);
    lines.push('', `### Doses ${range.from} to ${range.to}`, '');
    if (!recent.length) lines.push('- None');
    // A scheduled dose belongs to its civil day, not to an hour: its stored
    // instant is a local midnight, which reads as the day before once it is
    // written in UTC. Only a real instant (manual, or a logged session) keeps one.
    for (const dose of recent) lines.push(`- ${dose.slot ? dose.date : dose.taken_at}: ${dose.skipped ? 'Skipped' : `${doseText(dose.amount, dose.unit)}`} (${doseSource(dose)})${dose.note ? ` — ${dose.note}` : ''}`);
    lines.push('');
  }
  return lines.join('\n');
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
  let workoutSyncPromise = null;
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
  // Shared Google token handling for every sync: refresh an access token that is
  // about to expire, then run the request with one refresh-and-retry after a 401
  // and a disconnect when the grant itself is gone (revoked, or the test-user
  // consent expired). A transient token failure keeps the grant.
  const googleSession = async () => {
    const client = googleClient();
    if (!client) throw new ServiceError('no_google_client', 'Add a Google OAuth client ID and secret in Settings before syncing.');
    let tokens = googleTokens();
    if (!tokens) throw notConnected();
    const disconnect = async () => { await saveGoogleTokens(null); return notConnected(); };
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
    const run = async (work) => {
      try { return await work(tokens.accessToken); } catch (error) {
        if (!(error instanceof GoogleHealthError) || error.code !== 'unauthorized') throw googleError(error);
        await refresh(true);
        try { return await work(tokens.accessToken); } catch (retryError) {
          if (retryError instanceof GoogleHealthError && retryError.code === 'unauthorized') throw await disconnect();
          throw googleError(retryError);
        }
      }
    };
    return { run };
  };
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
  // --- workout metrics -------------------------------------------------------
  const parseOrNull = (value) => { try { return value ? parse(value) : null; } catch { return null; } };
  const workoutNotFound = () => new ServiceError('workout_not_found', 'Workout was not found.', 404);
  const liveWorkouts = () => db.prepare('SELECT raw_json FROM workouts ORDER BY start_time DESC, id').all().map((row) => parse(row.raw_json));
  // Window building needs only the times, so the sync pass never parses a
  // workout payload it is not going to fetch.
  const liveWorkoutTimes = () => db.prepare('SELECT id, start_time, end_time FROM workouts ORDER BY start_time DESC, id').all();
  const liveWorkout = (id) => { const row = db.prepare('SELECT raw_json FROM workouts WHERE id = ?').get(id); return row ? parse(row.raw_json) : null; };
  const templateTypes = (currentMode) => new Map((currentMode === 'demo' ? demoState().exerciseTemplates : db.prepare('SELECT raw_json FROM exercise_templates').all().map((row) => parse(row.raw_json))).map((template) => [String(template?.id), template?.type ?? '']));
  // Routine rest values make the estimated exercise segments less wrong when the
  // workout came from a routine; without one, segments are equal per set.
  const restSecondsFor = (routineId) => {
    if (!safeId(routineId)) return null;
    const rows = db.prepare('SELECT exercise_index, rest_seconds FROM routine_exercises WHERE routine_id = ?').all(routineId);
    return rows.length ? new Map(rows.map((row) => [row.exercise_index, row.rest_seconds])) : null;
  };
  const windowRow = (workoutId) => db.prepare('SELECT workout_id, start_ms, end_ms, status, detail_json, fetched_at FROM workout_sample_windows WHERE source = ? AND workout_id = ?').get(GOOGLE_SOURCE, workoutId) ?? null;
  const storedSamples = (startMs, endMs) => db.prepare('SELECT metric, at_ms, value, duration_ms, label FROM workout_samples WHERE source = ? AND at_ms >= ? AND at_ms <= ? ORDER BY at_ms').all(GOOGLE_SOURCE, startMs, endMs)
    .map((row) => ({ metric: row.metric, atMs: row.at_ms, value: row.value, durationMs: row.duration_ms, label: row.label }));
  // The ledger row is the progress record: no row means the window was never
  // fetched (or its fetch failed and will be retried).
  const liveWorkoutMetrics = (workout, { detail = true } = {}) => {
    const window = workoutWindow(workout);
    const row = window ? windowRow(workout.id) : null;
    const status = row ? (row.status === 'empty' ? 'empty' : 'ready') : (googleTokens() ? 'unfetched' : 'not_connected');
    const stored = parseOrNull(row?.detail_json);
    const body = status === 'ready' && window
      ? summariseWorkout({ workout, samples: storedSamples(window.windowStartMs, window.windowEndMs), restSeconds: detail ? restSecondsFor(workout.routine_id) : null, detail })
      : blankMetrics(workout);
    return { status, fetchedAt: row?.fetched_at ?? null, source: typeof stored?.sourceLabel === 'string' ? stored.sourceLabel : null, body };
  };
  const workoutMetrics = (workoutId) => {
    if (!safeId(workoutId)) throw new ServiceError('validation', 'Workout id is invalid.');
    if (mode() === 'demo') {
      const demo = demoState().workouts.find((workout) => workout.id === workoutId);
      if (!demo) throw workoutNotFound();
      return demoWorkoutMetrics(demo);
    }
    const workout = liveWorkout(workoutId);
    if (!workout) throw workoutNotFound();
    const { status, fetchedAt, source, body } = liveWorkoutMetrics(workout);
    return {
      mode: 'live',
      workout: { id: workout.id, title: workout.title ?? null, start_time: workout.start_time ?? null, end_time: workout.end_time ?? null },
      status,
      fetched_at: fetchedAt,
      window: body.window,
      source,
      series: body.series,
      summary: body.summary,
      exercises: body.exercises,
      estimated_segments: true,
    };
  };
  const workoutMetricsOverview = ({ days = 90 } = {}) => {
    const count = clampDays(days);
    const to = localDate(); const from = addDays(to, -(count - 1));
    if (mode() === 'demo') return demoWorkoutMetricsOverview(demoState().workouts, { from, to });
    const types = templateTypes('live');
    const rows = [];
    for (const workout of liveWorkouts()) {
      const startMs = parseTimeMs(workout.start_time);
      if (startMs === null) continue;
      const date = localDate(new Date(startMs));
      if (date < from || date > to) continue;
      const { status, body } = liveWorkoutMetrics(workout, { detail: false });
      rows.push(overviewRow({ workout, status, summary: status === 'ready' ? body.summary : null, templateTypes: types }));
    }
    return { mode: 'live', range: { from, to }, coverage: coverageCounts(rows), workouts: rows };
  };
  // Fetches the padded windows that need one, newest workouts first. Not wrapped
  // in serialiseWrite: syncMetrics calls it from inside its own write turn.
  const syncWorkoutWindows = async ({ workoutIds = null, budget = WORKOUT_WINDOW_BUDGET } = {}) => {
    // Every window reports the same per-metric warnings, so they are collected
    // once: 25 windows must not put the same sentence on screen 25 times.
    const seenWarnings = new Set();
    const result = { fetched: 0, empty: 0, failed: [], warnings: [] };
    const warn = (warning) => { if (!seenWarnings.has(warning)) { seenWarnings.add(warning); result.warnings.push(warning); } };
    if (mode() !== 'live') { warn('Demo mode does not fetch workout metrics from Google Health.'); return result; }
    const ids = workoutIds == null ? null : new Set((Array.isArray(workoutIds) ? workoutIds : [workoutIds]).filter((value) => safeId(value)));
    if (ids && !ids.size) throw new ServiceError('validation', 'Workout id is invalid.');
    const limit = Math.min(100, Math.max(1, Math.trunc(Number(budget)) || WORKOUT_WINDOW_BUDGET));
    const pending = [];
    for (const workout of liveWorkoutTimes()) {
      if (ids && !ids.has(workout.id)) continue;
      const window = workoutWindow(workout);
      if (!window || !needsFetch(window, windowRow(workout.id))) continue;
      pending.push(window);
      if (pending.length >= limit) break;
    }
    if (!pending.length) return result;
    const google = await googleSession();
    const insertSource = 'INSERT INTO metric_sources(id, kind, label, cursor_json, last_sync, created_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?, ?) ON CONFLICT(id) DO NOTHING';
    const insertSample = 'INSERT INTO workout_samples(source, metric, at_ms, value, duration_ms, label) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source, metric, at_ms) DO UPDATE SET value=excluded.value, duration_ms=excluded.duration_ms, label=excluded.label';
    // A window that comes back with samples is rewritten, not merged into: a
    // re-fetch that picks a different primary source must not leave the old
    // source's samples interleaved with the new ones. Only this window's span is
    // cleared, and the response replacing it covers all of it. An empty answer
    // clears nothing, so a transient gap at Google cannot erase stored samples.
    const clearSamples = 'DELETE FROM workout_samples WHERE source = ? AND at_ms >= ? AND at_ms <= ?';
    const insertWindow = 'INSERT INTO workout_sample_windows(source, workout_id, start_ms, end_ms, status, detail_json, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, workout_id) DO UPDATE SET start_ms=excluded.start_ms, end_ms=excluded.end_ms, status=excluded.status, detail_json=excluded.detail_json, fetched_at=excluded.fetched_at';
    for (const group of mergeWindows(pending)) {
      let fetched;
      try {
        fetched = await google.run((accessToken) => fetchWorkoutSamples(fetchImpl, accessToken, { startMs: group.startMs, endMs: group.endMs }));
      } catch (error) {
        // Auth, rate limit, and network failures end the run; anything else
        // leaves these windows without a row so the next sync retries them.
        if (error instanceof ServiceError && ['not_connected', 'rate_limited', 'network'].includes(error.code)) throw error;
        for (const window of group.windows) result.failed.push(window.workoutId);
        warn(`workout window: ${error?.message ?? 'could not be fetched'}`);
        continue;
      }
      const warnings = Array.isArray(fetched?.warnings) ? fetched.warnings.map(String) : [];
      for (const warning of warnings) warn(warning);
      if (Array.isArray(fetched?.failed) && fetched.failed.length) {
        // A partial window would look complete forever; retry the whole thing.
        for (const window of group.windows) result.failed.push(window.workoutId);
        continue;
      }
      const samples = (Array.isArray(fetched?.samples) ? fetched.samples : [])
        .filter((sample) => sample && isWorkoutMetricKey(sample.metric) && Number.isFinite(sample.atMs) && typeof sample.value === 'number' && Number.isFinite(sample.value));
      const now = isoNow();
      for (const window of group.windows) {
        const inside = samples.filter((sample) => sample.atMs >= window.windowStartMs && sample.atMs <= window.windowEndMs);
        const sampleCounts = {};
        for (const sample of inside) sampleCounts[sample.metric] = (sampleCounts[sample.metric] ?? 0) + 1;
        const status = inside.length ? 'complete' : 'empty';
        const detail = { sampleCounts, sourceKey: fetched.sourceKey ?? null, sourceLabel: fetched.sourceLabel ?? null, warnings };
        try {
          db.exec('BEGIN IMMEDIATE');
          db.prepare(insertSource).run(GOOGLE_SOURCE, 'api', 'Google Health', now, now);
          if (inside.length) db.prepare(clearSamples).run(GOOGLE_SOURCE, window.windowStartMs, window.windowEndMs);
          const insert = db.prepare(insertSample);
          for (const sample of inside) insert.run(GOOGLE_SOURCE, sample.metric, Math.round(sample.atMs), sample.value, sample.durationMs == null ? null : Math.round(sample.durationMs), sample.label ?? null);
          db.prepare(insertWindow).run(GOOGLE_SOURCE, window.workoutId, window.windowStartMs, window.windowEndMs, status, json(detail), now);
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* no transaction to roll back */ }
          throw error;
        }
        if (status === 'empty') result.empty += 1; else result.fetched += 1;
      }
    }
    return result;
  };

  // --- supplements -----------------------------------------------------------
  const modeWorkouts = (currentMode) => (currentMode === 'demo' ? demoState().workouts : liveWorkouts());
  const supplements = (currentMode, today = localDate()) => db.prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE mode = ?`).all(currentMode)
    .map((row) => publicSupplement(row, today))
    .sort((a, b) => SUPPLEMENT_STATUS_ORDER[a.status] - SUPPLEMENT_STATUS_ORDER[b.status] || a.name.localeCompare(b.name));
  const supplementRow = (id, currentMode) => db.prepare(`SELECT ${SUPPLEMENT_COLUMNS} FROM supplements WHERE id = ? AND mode = ?`).get(id, currentMode) ?? null;
  // Overrides are read without a date filter: a skip recorded today can belong
  // to an older session, so the stored row's own date says nothing about the
  // derived dose it replaces.
  const supplementOverrides = (currentMode) => {
    const byWorkout = new Map(); const bySlot = new Map();
    for (const row of db.prepare('SELECT d.id, d.supplement_id, d.amount, d.workout_id, d.slot, d.note FROM supplement_doses d JOIN supplements s ON s.id = d.supplement_id WHERE s.mode = ? AND (d.workout_id IS NOT NULL OR d.slot IS NOT NULL)').all(currentMode)) {
      const target = row.workout_id ? byWorkout : bySlot;
      if (!target.has(row.supplement_id)) target.set(row.supplement_id, new Map());
      target.get(row.supplement_id).set(row.workout_id ?? row.slot, row);
    }
    return { byWorkout, bySlot };
  };
  // Stored manual rows plus the doses the schedule and the mode's current
  // workouts imply. An override for a workout that is gone, or for a slot the
  // schedule no longer generates, matches nothing and drops out.
  const doseRows = (currentMode, from, to, today = localDate()) => {
    const list = supplements(currentMode, today);
    const units = new Map(list.map((supplement) => [supplement.id, supplement.dose_unit]));
    const linked = list.filter((supplement) => supplement.frequency.kind === 'workout');
    const scheduled = list.filter((supplement) => supplement.frequency.kind === 'daily' || supplement.frequency.kind === 'weekly');
    const workouts = linked.length ? modeWorkouts(currentMode) : [];
    const overrides = linked.length || scheduled.length ? supplementOverrides(currentMode) : { byWorkout: new Map(), bySlot: new Map() };
    const doses = db.prepare('SELECT d.id, d.supplement_id, d.taken_at, d.date, d.amount, d.note FROM supplement_doses d JOIN supplements s ON s.id = d.supplement_id WHERE s.mode = ? AND d.workout_id IS NULL AND d.slot IS NULL AND d.date >= ? AND d.date <= ?').all(currentMode, from, to)
      .map((row) => ({ id: row.id, supplement_id: row.supplement_id, taken_at: row.taken_at, date: row.date, amount: row.amount, unit: units.get(row.supplement_id) ?? null, workout_id: null, slot: null, workout_title: null, source: 'manual', skipped: row.amount === 0, note: row.note }));
    for (const supplement of linked) {
      for (const dose of workoutDoses(supplement, workouts, overrides.byWorkout.get(supplement.id))) {
        if (dose.date < from || dose.date > to) continue;
        doses.push({ ...dose, unit: supplement.dose_unit });
      }
    }
    for (const supplement of scheduled) {
      for (const dose of scheduledDoses(supplement, { from, to, today }, overrides.bySlot.get(supplement.id))) doses.push({ ...dose, unit: supplement.dose_unit });
    }
    return doses.sort((a, b) => Date.parse(b.taken_at) - Date.parse(a.taken_at));
  };
  const supplementDoses = ({ days = 90 } = {}) => {
    const count = clampDays(days); const currentMode = mode();
    const to = localDate(); const from = addDays(to, -(count - 1));
    return { mode: currentMode, range: { from, to }, doses: doseRows(currentMode, from, to, to) };
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
    return { mode: currentMode, settings: publicSettings(), ...data, routines: visibleRoutines(currentMode), programs: programs(currentMode), supplements: supplements(currentMode), proposals: proposalRows(currentMode), trainingProfile: trainingProfile(currentMode) };
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
      if (body.clearApiKey === true) delete next.apiKey; // Explicit disconnect: forget the key, keep imported data.
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
    getWorkoutMetrics: workoutMetrics,
    getWorkoutMetricsOverview: workoutMetricsOverview,
    async syncWorkoutMetrics(options = {}) {
      // One in-flight full sync at a time; a single-workout fetch still queues
      // behind the other writes through serialiseWrite.
      if (options?.workoutIds == null) {
        if (workoutSyncPromise) return workoutSyncPromise;
        workoutSyncPromise = serialiseWrite(() => syncWorkoutWindows(options));
        try { return await workoutSyncPromise; } finally { workoutSyncPromise = null; }
      }
      return serialiseWrite(() => syncWorkoutWindows(options));
    },
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
        const google = await googleSession();
        const to = localDate();
        const cursor = metricSources().find((source) => source.id === GOOGLE_SOURCE)?.syncedThrough;
        const from = cursor ? addDays(cursor < to ? cursor : to, -METRICS_RESYNC_DAYS) : addDays(to, -METRICS_FIRST_SYNC_DAYS);
        const result = await google.run((accessToken) => fetchMetricPoints(fetchImpl, accessToken, { from, to }));
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
          // Merge rather than replace: the cursor object may hold other keys.
          else db.prepare('UPDATE metric_sources SET cursor_json = ?, last_sync = ?, updated_at = ? WHERE id = ?').run(json({ ...(parseOrNull(db.prepare('SELECT cursor_json FROM metric_sources WHERE id = ?').get(GOOGLE_SOURCE)?.cursor_json) ?? {}), syncedThrough: to }), now, now, GOOGLE_SOURCE);
          setMeta('mode', 'live');
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* no transaction to roll back */ }
          throw error;
        }
        // Workout windows are best effort: the daily series must not fail
        // because Google had nothing for one workout.
        let workoutWarnings = [];
        try {
          const workoutResult = await syncWorkoutWindows({ budget: WORKOUT_WINDOW_BUDGET });
          workoutWarnings = workoutResult.warnings;
        } catch (error) {
          workoutWarnings = [`workout metrics: ${error?.message ?? 'could not fetch workout metrics'}`];
        }
        return { ...metrics({ days: 90 }), imported: points.length, warnings: [...warnings, ...workoutWarnings] };
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
        const templateRows = db.prepare('SELECT id, title FROM exercise_templates').all();
        const templateIds = new Set(templateRows.map(({ id: templateId }) => templateId));
        const templateTitles = new Map(templateRows.map(({ id: templateId, title: templateTitle }) => [templateId, templateTitle]));
        const { requestId, payload } = buildRoutinePayload(body, templateIds, { existing, editing: true });
        const confirmedFallback = {
          ...existing,
          ...payload.routine,
          id,
          exercises: payload.routine.exercises.map((exercise, exerciseIndex) => ({
            ...exercise,
            index: exerciseIndex,
            title: templateTitles.get(exercise.exercise_template_id) ?? null,
            sets: exercise.sets.map((set, setIndex) => ({ ...set, index: setIndex })),
          })),
        };
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
          routine = await putRoutine(fetchImpl, apiKey, id, payload, confirmedFallback);
        } catch (error) {
          // A connection can fail after Hevy commits the PUT. Verify the target
          // with a read before declaring the write uncertain; never send a
          // second PUT to discover whether the first one succeeded.
          if (error?.code === 'routine_uncertain') {
            try {
              const remote = await fetchRoutine(fetchImpl, apiKey, id);
              if (sameRoutineWrite(remote, confirmedFallback)) routine = remote;
            } catch { /* the durable uncertain ledger remains the safe fallback */ }
          }
          if (routine) {
            // Continue through the ordinary success ledger/cache path below.
          } else {
          if (['routine_rejected', 'routine_not_found', 'routine_forbidden', 'invalid_key', 'rate_limited'].includes(error?.code)) {
            db.prepare('DELETE FROM routine_publications WHERE request_id = ?').run(requestId);
            throw new ServiceError(error.code, error.message, error.status);
          }
          try { db.prepare('UPDATE routine_publications SET status = ?, updated_at = ? WHERE request_id = ?').run('uncertain', isoNow(), requestId); } catch { /* preserve the no-retry safety boundary */ }
          throw new ServiceError('publication_uncertain', ROUTINE_UPDATE_UNCERTAIN_MESSAGE, 502);
          }
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
    getSupplementDoses: supplementDoses,
    async saveSupplement(body = {}) {
      return serialiseWrite(async () => {
        const currentMode = mode(); const today = localDate();
        const clean = validateSupplement(body, { today, fail });
        const existing = body.id && safeId(body.id) ? db.prepare('SELECT id, created_at FROM supplements WHERE id = ? AND mode = ?').get(body.id, currentMode) : null;
        if (body.id && !existing) throw new ServiceError('not_found', 'Supplement was not found.', 404);
        const id = existing?.id ?? randomUUID(); const now = isoNow(); const created = existing?.created_at ?? now;
        try {
          db.exec('BEGIN IMMEDIATE');
          db.prepare('INSERT INTO supplements(id, mode, name, brand, type, dose_amount, dose_unit, frequency_json, timing, start_date, end_date, purchase_url, package_size, ingredients, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, brand=excluded.brand, type=excluded.type, dose_amount=excluded.dose_amount, dose_unit=excluded.dose_unit, frequency_json=excluded.frequency_json, timing=excluded.timing, start_date=excluded.start_date, end_date=excluded.end_date, purchase_url=excluded.purchase_url, package_size=excluded.package_size, ingredients=excluded.ingredients, notes=excluded.notes, updated_at=excluded.updated_at').run(id, currentMode, clean.name, clean.brand, clean.type, clean.dose_amount, clean.dose_unit, json(clean.frequency), clean.timing, clean.start_date, clean.end_date, clean.purchase_url, clean.package_size, clean.ingredients, clean.notes, created, now);
          // An edit can move a dose off the schedule (a shorter window, fewer
          // doses a day, another kind); an override left behind would resurrect
          // a stale skip against a dose that is no longer derived at all. The
          // surviving set comes from the same pure helpers the reader uses.
          const edited = { id, ...clean };
          const removeDose = db.prepare('DELETE FROM supplement_doses WHERE id = ?');
          if (clean.frequency.kind !== 'workout') db.prepare('DELETE FROM supplement_doses WHERE supplement_id = ? AND workout_id IS NOT NULL').run(id);
          else {
            const sessions = new Set(workoutDoses(edited, modeWorkouts(currentMode)).map((dose) => dose.workout_id));
            for (const row of db.prepare('SELECT id, workout_id FROM supplement_doses WHERE supplement_id = ? AND workout_id IS NOT NULL').all(id)) {
              if (!sessions.has(row.workout_id)) removeDose.run(row.id);
            }
          }
          const slotRows = db.prepare('SELECT id, slot, date FROM supplement_doses WHERE supplement_id = ? AND slot IS NOT NULL').all(id);
          if (slotRows.length) {
            const dates = slotRows.map((row) => row.date).sort();
            const slots = new Set(scheduledDoses(edited, { from: dates[0], to: dates.at(-1), today }).map((dose) => dose.slot));
            for (const row of slotRows) if (!slots.has(row.slot)) removeDose.run(row.id);
          }
          db.exec('COMMIT');
        } catch (error) {
          try { db.exec('ROLLBACK'); } catch { /* no transaction to roll back */ }
          throw error;
        }
        return publicSupplement(supplementRow(id, currentMode), today);
      });
    },
    async deleteSupplement(id) {
      return serialiseWrite(async () => {
        if (!safeId(id)) throw new ServiceError('validation', 'Supplement id is invalid.');
        const result = db.prepare('DELETE FROM supplements WHERE id = ? AND mode = ?').run(id, mode());
        if (!result.changes) throw new ServiceError('not_found', 'Supplement was not found.', 404);
        return { id, deleted: true };
      });
    },
    async logDose(supplementId, body = {}) {
      return serialiseWrite(async () => {
        if (!safeId(supplementId)) throw new ServiceError('validation', 'Supplement id is invalid.');
        const currentMode = mode(); const row = supplementRow(supplementId, currentMode);
        if (!row) throw new ServiceError('not_found', 'Supplement was not found.', 404);
        const supplement = publicSupplement(row, localDate());
        const dose = validateDose(body, supplement, { now: new Date(), fail });
        let workoutTitle = null;
        if (dose.workout_id) {
          const workout = modeWorkouts(currentMode).find((item) => item.id === dose.workout_id);
          if (!workout) throw workoutNotFound();
          workoutTitle = workout.title ?? null;
        }
        // One override per session and per slot: the upsert keys on
        // (supplement_id, workout_id) or (supplement_id, slot) so the same
        // derived dose cannot collect two rows.
        const key = dose.workout_id ? 'workout_id' : 'slot';
        const existing = dose.workout_id || dose.slot ? db.prepare(`SELECT id, created_at FROM supplement_doses WHERE supplement_id = ? AND ${key} = ?`).get(supplementId, dose.workout_id ?? dose.slot) : null;
        const id = existing?.id ?? randomUUID(); const created = existing?.created_at ?? isoNow();
        db.prepare('INSERT INTO supplement_doses(id, supplement_id, taken_at, date, amount, workout_id, slot, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET taken_at=excluded.taken_at, date=excluded.date, amount=excluded.amount, note=excluded.note').run(id, supplementId, dose.taken_at, dose.date, dose.amount, dose.workout_id, dose.slot, dose.note, created);
        return { dose: { id, supplement_id: supplementId, taken_at: dose.taken_at, date: dose.date, amount: dose.amount, unit: supplement.dose_unit, workout_id: dose.workout_id, slot: dose.slot, workout_title: workoutTitle, source: dose.workout_id ? 'workout' : dose.slot ? 'schedule' : 'manual', skipped: dose.amount === 0, note: dose.note } };
      });
    },
    async deleteDose(id) {
      return serialiseWrite(async () => {
        if (!safeId(id)) throw new ServiceError('validation', 'Dose id is invalid.');
        const result = db.prepare('DELETE FROM supplement_doses WHERE id = ? AND supplement_id IN (SELECT id FROM supplements WHERE mode = ?)').run(id, mode());
        if (!result.changes) throw new ServiceError('not_found', 'Dose was not found.', 404);
        return { id, deleted: true };
      });
    },
    async exportMarkdown() {
      const exportDir = path.join(dataDir, 'exports');
      await mkdir(exportDir, { recursive: true });
      const contents = { ...markdownFor(state()), 'metrics.md': metricsMarkdown(metrics({ days: 90 })), 'supplements.md': supplementsMarkdown(supplementDoses({ days: 30 }), supplements(mode())) }; const files = [];
      for (const [name, contentsForFile] of Object.entries(contents)) {
        const target = path.join(exportDir, name); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temp, `${contentsForFile}\n`, 'utf8'); await rename(temp, target); files.push(`exports/${name}`);
      }
      return { files, mode: mode() };
    },
    close() { db.close(); },
  };
}
