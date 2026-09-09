// Intentionally fixed dates make the demo useful in screenshots and tests.
const templateDefs = [
  ['demo-squat', 'Barbell Back Squat', 'quadriceps', 'Barbell', 'weight_reps'],
  ['demo-bench', 'Barbell Bench Press', 'chest', 'Barbell', 'weight_reps'],
  ['demo-row', 'Cable Row', 'upper_back', 'Cable', 'weight_reps'],
  ['demo-deadlift', 'Romanian Deadlift', 'hamstrings', 'Barbell', 'weight_reps'],
  ['demo-press', 'Dumbbell Shoulder Press', 'shoulders', 'Dumbbell', 'weight_reps'],
  ['demo-pulldown', 'Lat Pulldown', 'lats', 'Cable', 'weight_reps'],
  ['demo-run', 'Treadmill Run', 'cardio', 'Treadmill', 'distance_duration'],
];

export const demoExerciseTemplates = templateDefs.map(([id, title, primary_muscle_group, equipment, type]) => ({
  id, title, primary_muscle_group, equipment, type,
}));

const routineDefinitions = [
  ['demo-routine-lower', 'Lower Strength', ['demo-squat', 'demo-deadlift']],
  ['demo-routine-upper', 'Upper Strength', ['demo-bench', 'demo-row', 'demo-press']],
  ['demo-routine-pull', 'Pull & Core', ['demo-pulldown', 'demo-row']],
  ['demo-routine-cardio', 'Easy Conditioning', ['demo-run']],
];

export const demoRoutines = routineDefinitions.map(([id, title, exerciseIds]) => ({
  id,
  title,
  folder_id: null,
  exercises: exerciseIds.map((exercise_template_id, index) => ({
    index,
    title: demoExerciseTemplates.find((template) => template.id === exercise_template_id).title,
    exercise_template_id,
    notes: index === 0 ? 'Move smoothly and leave one rep in reserve.' : '',
    rest_seconds: 120,
    sets: exercise_template_id === 'demo-run'
      ? [{ index: 0, type: 'normal', distance_meters: 5000, duration_seconds: 1800 }]
      : [{ index: 0, type: 'warmup', rep_range: { start: 8, end: 10 } }, { index: 1, type: 'normal', rep_range: { start: 6, end: 10 } }, { index: 2, type: 'normal', rep_range: { start: 6, end: 10 } }],
  })),
}));

function currentWeekMonday() {
  const now = new Date();
  const local = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const mondayOffset = (local.getDay() + 6) % 7;
  local.setDate(local.getDate() - mondayOffset - 70); // ten completed calendar weeks
  return local;
}

function isoAt(day, hour) {
  const start = currentWeekMonday();
  const date = new Date(Date.UTC(start.getFullYear(), start.getMonth(), start.getDate() + day, hour, 0, 0));
  return date.toISOString();
}

export const demoWorkouts = Array.from({ length: 30 }, (_, workoutIndex) => {
  const routine = demoRoutines[workoutIndex % 4];
  const week = Math.floor(workoutIndex / 3);
  const day = week * 7 + [0, 2, 4][workoutIndex % 3];
  const start_time = isoAt(day, 17);
  const end = new Date(start_time);
  end.setUTCMinutes(end.getUTCMinutes() + 45 + (workoutIndex % 6) * 5);
  const end_time = end.toISOString();
  return {
    id: `demo-workout-${String(workoutIndex + 1).padStart(2, '0')}`,
    title: routine.title,
    routine_id: routine.id,
    start_time,
    end_time,
    exercises: routine.exercises.map((exercise, exerciseIndex) => ({
      index: exerciseIndex,
      title: exercise.title,
      exercise_template_id: exercise.exercise_template_id,
      notes: exercise.notes,
      sets: Array.from({ length: exercise.exercise_template_id === 'demo-run' ? 1 : 3 }, (_, setIndex) => ({
        index: setIndex,
        type: setIndex === 0 && exercise.exercise_template_id !== 'demo-run' ? 'warmup' : 'normal',
        weight_kg: exercise.exercise_template_id === 'demo-run' ? null : 35 + exerciseIndex * 12 + workoutIndex * 0.5,
        reps: exercise.exercise_template_id === 'demo-run' ? null : 10 - (setIndex % 2),
        distance_meters: exercise.exercise_template_id === 'demo-run' ? 3000 + workoutIndex * 50 : null,
        duration_seconds: exercise.exercise_template_id === 'demo-run' ? 1080 + workoutIndex * 5 : null,
        rpe: 7 + (setIndex % 2),
      })),
    })),
  };
});

export function demoState() {
  return {
    workouts: demoWorkouts,
    routines: demoRoutines,
    exerciseTemplates: demoExerciseTemplates,
  };
}
