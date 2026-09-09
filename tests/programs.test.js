import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';
import { createService } from '../server/service.js';

async function setup(t) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-programs-'));
  let service;
  t.after(async () => { service?.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { dataDir, open: async () => { service = await createService({ dataDir, fetchImpl: async () => { throw new Error('Hevy must not be called'); } }); return service; } };
}

test('program schedules persist, export, preserve omitted dates, and can be cleared', async t => {
  const fixture = await setup(t);
  let service = await fixture.open();
  const input = { title: 'Twelve week block', days: [{ label: 'A', routineId: service.getState().routines[0].id }], start_date: '2026-09-07', duration_weeks: 12 };
  const saved = await service.saveProgram(input);
  assert.equal(saved.start_date, input.start_date);
  assert.equal(saved.duration_weeks, 12);
  service.close(); service = await fixture.open();
  assert.deepEqual(service.getState().programs[0], saved);
  const edited = await service.saveProgram({ id: saved.id, title: 'Renamed', days: input.days });
  assert.equal(edited.start_date, input.start_date);
  assert.equal(edited.duration_weeks, 12);
  await service.exportMarkdown();
  const markdown = await readFile(path.join(fixture.dataDir, 'exports/programs.md'), 'utf8');
  assert.match(markdown, /2026-09-07/);
  assert.match(markdown, /2026-11-29/);
  assert.match(markdown, /12/);
  await service.setDemo(false); assert.equal(service.getState().programs.length, 0);
  await service.setDemo(true);
  const cleared = await service.saveProgram({ id: saved.id, ...input, start_date: null, duration_weeks: null });
  assert.equal(cleared.start_date, null);
  assert.equal(cleared.duration_weeks, null);
});

test('invalid or incomplete schedule submissions leave stored programs intact', async t => {
  const fixture = await setup(t), service = await fixture.open();
  const input = { title: 'Plan', days: [{ label: 'A', routineId: service.getState().routines[0].id }], start_date: '2028-02-29', duration_weeks: 8 };
  const saved = await service.saveProgram(input);
  for (const invalid of [{start_date:'2026-02-29'}, {start_date:'2026-04-31'}, {start_date:'2026-9-01'}, {start_date:'2026-09-01T00:00:00Z'}, {start_date:123}, {duration_weeks:0}, {duration_weeks:53}, {duration_weeks:1.5}, {duration_weeks:'8'}, {duration_weeks:true}, {start_date:null}, {duration_weeks:null}]) {
    await assert.rejects(async () => service.saveProgram({ ...input, id: saved.id, ...invalid }), { code: 'validation' });
  }
  await assert.rejects(async () => service.saveProgram({ title: 'Half', days: input.days, start_date: '2026-09-07' }), { code: 'validation' });
  assert.deepEqual(service.getState().programs, [saved]);
});

test('schema 2 migrates existing programs to unscheduled without losing imported data', async t => {
  const fixture = await setup(t);
  const db = new DatabaseSync(path.join(fixture.dataDir, 'corpus.sqlite'));
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version','2'), ('mode','demo');
    CREATE TABLE programs (id TEXT PRIMARY KEY, mode TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, days_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE workouts (id TEXT PRIMARY KEY, title TEXT, routine_id TEXT, start_time TEXT, end_time TEXT, raw_json TEXT NOT NULL);`);
  const days = [{ label: 'Day 1', routineId: 'old-routine' }];
  db.prepare('INSERT INTO programs VALUES (?,?,?,?,?,?,?)').run('old', 'demo', 'Existing', 'Notes', JSON.stringify(days), '2026-01-01', '2026-01-02');
  db.prepare('INSERT INTO workouts VALUES (?,?,?,?,?,?)').run('w1', 'Preserved', null, null, null, JSON.stringify({ id:'w1', title:'Preserved' }));
  db.close();
  const service = await fixture.open();
  assert.deepEqual(service.getState().programs[0], { id: 'old', title: 'Existing', description: 'Notes', days, created_at: '2026-01-01', updated_at: '2026-01-02', start_date: null, duration_weeks: null });
  await service.setDemo(false);
  assert.equal(service.getState().workouts[0].title, 'Preserved');
});
