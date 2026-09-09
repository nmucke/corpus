import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { matchingPrograms, programTimeline, summarizeProgram } from '../public/program-timeline.js';

const program = { id: 'block', title: 'Strength', start_date: '2026-03-23', duration_weeks: 2, days: [{ label: 'A', routineId: 'r1' }, { label: 'B', routineId: 'r1' }] };
const workout = (date, routineId = 'r1') => ({ id: date, routine_id: routineId, start_time: `${date}T12:00:00` });

test('program status and week boundaries use an inclusive calendar date range', () => {
  assert.equal(programTimeline({ ...program, start_date: null, duration_weeks: null }).status, 'unscheduled');
  const before = programTimeline(program, new Date('2026-03-22T23:59:59'));
  assert.equal(before.status, 'upcoming');
  assert.equal(before.progress, 0);
  assert.equal(before.endDate, '2026-04-05');
  const first = programTimeline(program, new Date('2026-03-23T00:00:00'));
  assert.equal(first.status, 'active');
  assert.equal(first.currentWeek, 1);
  assert.equal(first.totalDays, 14);
  assert.equal(first.elapsedDays, 1);
  assert.equal(programTimeline(program, new Date('2026-03-29T23:59:59')).currentWeek, 1);
  assert.equal(programTimeline(program, new Date('2026-03-30T00:00:00')).currentWeek, 2);
  assert.equal(programTimeline(program, new Date('2026-04-05T23:59:59')).status, 'active');
  const after = programTimeline(program, new Date('2026-04-06T00:00:00'));
  assert.equal(after.status, 'completed');
  assert.equal(after.progress, 100);
  assert.equal(after.currentWeek, null);
  assert.equal(programTimeline({ ...program, start_date: '2028-02-28', duration_weeks: 1 }).endDate, '2028-03-05');
});

test('session associations require routine IDs and dates, allow overlaps, and deduplicate repeated program days', () => {
  const overlapping = { ...program, id: 'second' };
  assert.deepEqual(matchingPrograms(workout('2026-03-23'), [program, overlapping]).map(p => p.id), ['block', 'second']);
  assert.equal(matchingPrograms(workout('2026-04-05'), [program]).length, 1);
  const epochProgram = { ...program, start_date: '1970-01-01' };
  assert.equal(matchingPrograms({ routine_id: 'r1', start_time: null }, [epochProgram]).length, 0);
  for (const session of [workout('2026-03-22'), workout('2026-04-06'), workout('2026-03-25', null), workout('2026-03-25', 'unrelated'), { routine_id: 'r1', start_time: null }, { routine_id: 'r1', start_time: 'invalid' }]) {
    assert.equal(matchingPrograms(session, [program]).length, 0);
  }
  const result = summarizeProgram(program, [workout('2026-03-23'), workout('2026-03-29'), workout('2026-03-30'), workout('2026-04-01'), workout('2026-04-06'), workout('2026-03-25', 'other')], new Date('2026-03-31T12:00:00'));
  assert.equal(result.sessionCount, 3);
  assert.equal(result.workouts.length, 3);
  assert.deepEqual(result.weeks.map(week => week.count), [2, 1]);
  assert.deepEqual(result.weeks.map(week => [week.startDate, week.endDate]), [['2026-03-23', '2026-03-29'], ['2026-03-30', '2026-04-05']]);
});

test('calendar weeks survive daylight saving transitions and session matching uses local dates', () => {
  const moduleUrl = new URL('../public/program-timeline.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import { programTimeline, matchingPrograms, summarizeProgram } from ${JSON.stringify(moduleUrl)};
    for (const [start, secondWeek, last] of [['2026-03-23','2026-03-30','2026-04-05'], ['2026-10-19','2026-10-26','2026-11-01']]) {
      const p = {start_date:start,duration_weeks:2,days:[{routineId:'r'}]};
      const info = programTimeline(p,new Date(secondWeek+'T00:01:00'));
      assert.equal(info.currentWeek,2);
      assert.equal(info.elapsedDays,8);
      assert.equal(info.endDate,last);
      assert.equal(summarizeProgram(p,[{routine_id:'r',start_time:secondWeek+'T00:01:00'}],new Date(last+'T12:00:00')).weeks[1].count,1);
    }
    const p={start_date:'2026-03-23',duration_weeks:1,days:[{routineId:'r'}]};
    assert.equal(matchingPrograms({routine_id:'r',start_time:'2026-03-22T23:30:00Z'},[p]).length,1);
    assert.equal(matchingPrograms({routine_id:'r',start_time:'2026-03-29T22:30:00Z'},[p]).length,0);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: 'Europe/Amsterdam' } });
});
