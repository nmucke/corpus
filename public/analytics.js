export function validDate(value) {
  if (value == null || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function workoutDate(workout) {
  return validDate(workout?.start_time);
}

export function durationMinutes(workout) {
  const start = validDate(workout?.start_time);
  const end = validDate(workout?.end_time);
  if (!start || !end || end <= start) return 0;
  return Math.round((end - start) / 60_000);
}

export function templateMap(templates = []) {
  return new Map(templates.map((template) => [String(template.id), template]));
}

export function isExternalLoadExercise(exercise, templatesById = new Map()) {
  const template = templatesById.get(String(exercise?.exercise_template_id));
  const type = String(template?.type || "").toLowerCase();
  return !/(bodyweight|assisted|cardio|distance|duration|time|reps_only)/.test(type);
}

export function isWorkingSet(set) {
  return set?.type !== "warmup";
}

export function setVolume(set, exercise, templatesById = new Map()) {
  if (!isWorkingSet(set) || !isExternalLoadExercise(exercise, templatesById)) return 0;
  const weight = Number(set?.weight_kg);
  const reps = Number(set?.reps);
  if (!Number.isFinite(weight) || !Number.isFinite(reps) || weight <= 0 || reps <= 0) return 0;
  return weight * reps;
}

export function workoutVolume(workout, templatesById = new Map()) {
  return (workout?.exercises || []).reduce(
    (total, exercise) => total + (exercise.sets || []).reduce(
      (sum, set) => sum + setVolume(set, exercise, templatesById),
      0,
    ),
    0,
  );
}

export function periodStart(period, now = new Date()) {
  if (period === "all") return null;
  const weeks = Number(period);
  if (!Number.isFinite(weeks) || weeks <= 0) return null;
  const start = startOfWeek(now);
  start.setDate(start.getDate() - (weeks - 1) * 7);
  return start;
}

export function filterByPeriod(workouts = [], period = "8", now = new Date()) {
  const start = periodStart(period, now);
  return workouts.filter((workout) => {
    const date = workoutDate(workout);
    return date && date <= now && (!start || date >= start);
  });
}

export function startOfWeek(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  const mondayOffset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - mondayOffset);
  return date;
}

export function weeklySeries(workouts = [], period = "8", now = new Date(), templatesById = new Map()) {
  const filtered = filterByPeriod(workouts, period, now);
  const thisWeek = startOfWeek(now);
  let firstWeek;
  if (period === "all") {
    const dated = filtered.map(workoutDate).filter(Boolean).sort((a, b) => a - b);
    firstWeek = dated.length ? startOfWeek(dated[0]) : thisWeek;
  } else {
    firstWeek = periodStart(period, now) || thisWeek;
  }

  const points = [];
  for (let cursor = new Date(firstWeek); cursor <= thisWeek; cursor.setDate(cursor.getDate() + 7)) {
    points.push({ start: new Date(cursor), workouts: 0, volumeKg: 0, minutes: 0 });
  }

  const byWeek = new Map(points.map((point) => [startOfWeek(point.start).getTime(), point]));
  for (const workout of filtered) {
    const date = workoutDate(workout);
    const point = date && byWeek.get(startOfWeek(date).getTime());
    if (!point) continue;
    point.workouts += 1;
    point.volumeKg += workoutVolume(workout, templatesById);
    point.minutes += durationMinutes(workout);
  }
  return points;
}

export function summarize(workouts = [], period = "8", now = new Date(), templatesById = new Map()) {
  const filtered = filterByPeriod(workouts, period, now);
  const weeks = weeklySeries(workouts, period, now, templatesById);
  const activeWeeks = weeks.filter((week) => week.workouts > 0).length;
  return {
    workouts: filtered.length,
    volumeKg: filtered.reduce((sum, workout) => sum + workoutVolume(workout, templatesById), 0),
    minutes: filtered.reduce((sum, workout) => sum + durationMinutes(workout), 0),
    activeWeeks,
    totalWeeks: weeks.length,
    consistency: weeks.length ? Math.round((activeWeeks / weeks.length) * 100) : 0,
  };
}

export function muscleDistribution(workouts = [], templatesById = new Map()) {
  const counts = new Map();
  for (const workout of workouts) {
    for (const exercise of workout.exercises || []) {
      const template = templatesById.get(String(exercise.exercise_template_id));
      const muscle = template?.primary_muscle_group || "Other";
      const sets = (exercise.sets || []).filter(isWorkingSet).length;
      if (sets) counts.set(muscle, (counts.get(muscle) || 0) + sets);
    }
  }
  return [...counts.entries()]
    .map(([muscle, sets]) => ({ muscle, sets }))
    .sort((a, b) => b.sets - a.sets);
}

export function exerciseProgress(workouts = [], exerciseId = "", templatesById = new Map()) {
  const entries = [];
  for (const workout of workouts) {
    const date = workoutDate(workout);
    const sessionLoads = [];
    let sessionVolumeKg = 0;
    for (const exercise of workout.exercises || []) {
      const matches = String(exercise.exercise_template_id) === String(exerciseId)
        || (!templatesById.has(String(exerciseId)) && exercise.title === exerciseId);
      if (!matches || !isExternalLoadExercise(exercise, templatesById)) continue;
      const sets = (exercise.sets || []).filter(isWorkingSet);
      const loads = sets.map((set) => Number(set.weight_kg)).filter((weight) => Number.isFinite(weight) && weight > 0);
      const volumeKg = sets.reduce((sum, set) => sum + setVolume(set, exercise, templatesById), 0);
      sessionLoads.push(...loads);
      sessionVolumeKg += volumeKg;
    }
    if (date && sessionLoads.length) entries.push({ date, bestKg: Math.max(...sessionLoads), volumeKg: sessionVolumeKg });
  }
  return entries.sort((a, b) => a.date - b.date);
}
