const DAY_MS = 24 * 60 * 60 * 1000;

function calendarParts(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const daysInMonth = month === 2
    ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
    : [4, 6, 9, 11].includes(month) ? 30 : 31;
  return day <= daysInMonth ? { year, month, day } : null;
}

function dateKeyFromParts({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function ordinal(parts) {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  return date.getTime() / DAY_MS;
}

function keyFromOrdinal(value) {
  const date = new Date(value * DAY_MS);
  return dateKeyFromParts({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

function schedule(program) {
  const valid = validateProgramSchedule(program?.start_date, program?.duration_weeks);
  if (!valid?.startDate) return null;
  return { start: calendarParts(valid.startDate), durationWeeks: valid.durationWeeks };
}

/** Returns a YYYY-MM-DD key for a valid Date in the user's local calendar. */
export function localDateKey(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  if (year < 1 || year > 9999) return null;
  return dateKeyFromParts({ year, month: date.getMonth() + 1, day: date.getDate() });
}

/** Strictly validates the nullable schedule pair without string/number coercion. */
export function validateProgramSchedule(startDate, durationWeeks) {
  if (startDate === null && durationWeeks === null) return { startDate: null, durationWeeks: null };
  const start = calendarParts(startDate);
  if (!start || !Number.isInteger(durationWeeks) || durationWeeks < 1 || durationWeeks > 52) return null;
  const endYear = new Date((ordinal(start) + durationWeeks * 7 - 1) * DAY_MS).getUTCFullYear();
  if (endYear < 1 || endYear > 9999) return null;
  return { startDate: dateKeyFromParts(start), durationWeeks };
}

export function programTimeline(program, now = new Date()) {
  const programSchedule = schedule(program);
  if (!programSchedule) return {
    status: 'unscheduled', startDate: null, endDate: null, durationWeeks: null,
    currentWeek: null, elapsedDays: 0, totalDays: 0, progress: 0,
  };
  const startOrdinal = ordinal(programSchedule.start);
  const totalDays = programSchedule.durationWeeks * 7;
  const endOrdinal = startOrdinal + totalDays - 1;
  const today = calendarParts(localDateKey(now)) || calendarParts(localDateKey(new Date()));
  const todayOrdinal = ordinal(today);
  const startDate = dateKeyFromParts(programSchedule.start);
  const endDate = keyFromOrdinal(endOrdinal);
  if (todayOrdinal < startOrdinal) return {
    status: 'upcoming', startDate, endDate, durationWeeks: programSchedule.durationWeeks,
    currentWeek: null, elapsedDays: 0, totalDays, progress: 0,
  };
  if (todayOrdinal > endOrdinal) return {
    status: 'completed', startDate, endDate, durationWeeks: programSchedule.durationWeeks,
    currentWeek: null, elapsedDays: totalDays, totalDays, progress: 100,
  };
  const elapsedDays = todayOrdinal - startOrdinal + 1;
  return {
    status: 'active', startDate, endDate, durationWeeks: programSchedule.durationWeeks,
    currentWeek: Math.floor((todayOrdinal - startOrdinal) / 7) + 1,
    elapsedDays, totalDays, progress: (elapsedDays / totalDays) * 100,
  };
}

export function matchingPrograms(workout, programs) {
  if (!workout || !Array.isArray(programs) || typeof workout.routine_id !== 'string' || typeof workout.start_time !== 'string' || !workout.start_time) return [];
  const started = new Date(workout.start_time);
  const workoutKey = localDateKey(started);
  const workoutParts = calendarParts(workoutKey);
  if (!workoutParts) return [];
  const workoutOrdinal = ordinal(workoutParts);
  return programs.filter((program) => {
    const programSchedule = schedule(program);
    if (!programSchedule || !Array.isArray(program.days)) return false;
    const startOrdinal = ordinal(programSchedule.start);
    const endOrdinal = startOrdinal + programSchedule.durationWeeks * 7 - 1;
    return workoutOrdinal >= startOrdinal && workoutOrdinal <= endOrdinal
      && program.days.some((day) => day?.routineId === workout.routine_id);
  });
}

export function summarizeProgram(program, workouts, now = new Date()) {
  const timeline = programTimeline(program, now);
  const nowTime = now instanceof Date && !Number.isNaN(now.getTime()) ? now.getTime() : Date.now();
  const matchedWorkouts = (Array.isArray(workouts) ? workouts : []).filter((workout) => {
    const started = new Date(workout?.start_time);
    return !Number.isNaN(started.getTime()) && started.getTime() <= nowTime
      && matchingPrograms(workout, [program]).length > 0;
  });
  const weeks = timeline.durationWeeks == null ? [] : Array.from({ length: timeline.durationWeeks }, (_, index) => {
    const start = calendarParts(timeline.startDate);
    const weekStartOrdinal = ordinal(start) + index * 7;
    const weekEndOrdinal = weekStartOrdinal + 6;
    const count = matchedWorkouts.filter((workout) => {
      const key = localDateKey(new Date(workout.start_time));
      const parts = calendarParts(key);
      const workoutOrdinal = parts ? ordinal(parts) : null;
      return workoutOrdinal != null && workoutOrdinal >= weekStartOrdinal && workoutOrdinal <= weekEndOrdinal;
    }).length;
    return { week: index + 1, startDate: keyFromOrdinal(weekStartOrdinal), endDate: keyFromOrdinal(weekEndOrdinal), count };
  });
  return { ...timeline, workouts: matchedWorkouts, sessionCount: matchedWorkouts.length, weeks };
}
