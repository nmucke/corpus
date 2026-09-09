import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { demoState } from './demo.js';
import { fetchSnapshot, postRoutine, updateRoutine as putRoutine, ROUTINE_UNCERTAIN_MESSAGE, ROUTINE_UPDATE_UNCERTAIN_MESSAGE } from './hevy.js';

const SCHEMA_VERSION = 2;
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
    CREATE TABLE IF NOT EXISTS programs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, days_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS routine_publications (request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending', 'succeeded', 'uncertain')), result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  if (!version) db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  else if (Number(version) < SCHEMA_VERSION) db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(SCHEMA_VERSION), 'schema_version');
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
    for (const day of program.days) programLines.push(`- ${day.label}: ${day.routineId}`);
    programLines.push('');
  }
  return { 'workouts.md': workoutLines.join('\n'), 'routines.md': routineLines.join('\n'), 'overview.md': overviewLines.join('\n'), 'programs.md': programLines.join('\n') };
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
  const publicSettings = () => ({ unit: privateSettings.unit === 'lb' ? 'lb' : 'kg', hasApiKey: Boolean(activeKey()), lastSync: getMeta('last_sync') });
  const programs = (currentMode) => db.prepare('SELECT id, title, description, days_json, created_at, updated_at FROM programs WHERE mode = ? ORDER BY created_at').all(currentMode).map(({ days_json, ...program }) => ({ ...program, days: parse(days_json) }));
  const state = () => {
    const currentMode = mode();
    const data = currentMode === 'demo'
      ? demoState()
      : { workouts: db.prepare('SELECT raw_json FROM workouts ORDER BY start_time DESC, id').all().map((row) => parse(row.raw_json)), routines: db.prepare('SELECT raw_json FROM routines ORDER BY title, id').all().map((row) => parse(row.raw_json)), exerciseTemplates: db.prepare('SELECT raw_json FROM exercise_templates ORDER BY title, id').all().map((row) => parse(row.raw_json)) };
    return { mode: currentMode, settings: publicSettings(), ...data, programs: programs(currentMode) };
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
      await writePrivateSettings(settingsFile, next);
      privateSettings = next;
      return publicSettings();
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
      const routineIds = new Set((currentMode === 'demo' ? demoState().routines : db.prepare('SELECT id FROM routines').all()).map((routine) => routine.id));
      const days = body.days.map((day) => {
        if (!day || typeof day !== 'object') throw new ServiceError('validation', 'Each program day must be an object.');
        const label = cleanText(day.label, 100, 'Day label', true);
        if (!safeId(day.routineId) || !routineIds.has(day.routineId)) throw new ServiceError('validation', `Unknown routine: ${String(day.routineId ?? '')}.`);
        return { label, routineId: day.routineId };
      });
      const existing = body.id && safeId(body.id) ? db.prepare('SELECT id, created_at FROM programs WHERE id = ? AND mode = ?').get(body.id, currentMode) : null;
      if (body.id && !existing) throw new ServiceError('not_found', 'Program was not found.', 404);
      const id = existing?.id ?? randomUUID(); const now = isoNow(); const created = existing?.created_at ?? now;
      db.prepare('INSERT INTO programs(id, mode, title, description, days_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description, days_json=excluded.days_json, updated_at=excluded.updated_at').run(id, currentMode, title, description, json(days), created, now);
      return { id, title, description, days, created_at: created, updated_at: now };
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
      const contents = markdownFor(state()); const files = [];
      for (const [name, contentsForFile] of Object.entries(contents)) {
        const target = path.join(exportDir, name); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temp, `${contentsForFile}\n`, 'utf8'); await rename(temp, target); files.push(`exports/${name}`);
      }
      return { files, mode: mode() };
    },
    close() { db.close(); },
  };
}
