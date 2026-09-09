// Planned routine coverage is derived only from the saved routine entries and
// their imported exercise-template metadata. It deliberately does not infer
// physiological activation from an exercise name or its prescribed sets.

export const MAPPED_MUSCLES = [
  'neck', 'shoulders', 'chest', 'biceps', 'triceps', 'forearms', 'abdominals',
  'abductors', 'adductors', 'quadriceps', 'calves', 'traps', 'upper_back',
  'lats', 'lower_back', 'glutes', 'hamstrings',
];

const MAPPED_SET = new Set(MAPPED_MUSCLES);

const LABELS = {
  abdominals: 'Abdominals', abductors: 'Abductors', adductors: 'Adductors',
  biceps: 'Biceps', calves: 'Calves', chest: 'Chest', forearms: 'Forearms',
  glutes: 'Glutes', hamstrings: 'Hamstrings', lats: 'Lats', lower_back: 'Lower back',
  neck: 'Neck', quadriceps: 'Quadriceps', shoulders: 'Shoulders', traps: 'Traps',
  triceps: 'Triceps', upper_back: 'Upper back', cardio: 'Cardio', full_body: 'Full body',
  other: 'Other',
};

export function normalizeMuscleId(value) {
  const id = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_').replace(/_+/g, '_');
  if (!id) return '';
  return id === 'abs' ? 'abdominals' : id;
}

export function muscleLabel(id) {
  const normalized = normalizeMuscleId(id);
  return LABELS[normalized] || normalized.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) || 'Unspecified';
}

function workingSets(exercise) {
  return (Array.isArray(exercise?.sets) ? exercise.sets : []).filter(set => String(set?.type || '').toLowerCase() !== 'warmup').length;
}

function emptyMuscle(id) {
  return {
    id,
    label: muscleLabel(id),
    primaryExercises: 0,
    secondaryExercises: 0,
    primarySets: 0,
    secondarySets: 0,
    contributions: [],
  };
}

/**
 * Count planned exercise entries once for every primary or secondary target.
 * A primary target wins when the same target also appears in secondary targets.
 */
export function buildMuscleCoverage({ routine, program, routines = [], exerciseTemplates = [] } = {}) {
  const isProgram = Boolean(program);
  const templateById = new Map((Array.isArray(exerciseTemplates) ? exerciseTemplates : []).map(template => [template?.id, template]));
  const routineById = new Map((Array.isArray(routines) ? routines : []).map(item => [item?.id, item]));
  const muscles = new Map(MAPPED_MUSCLES.map(id => [id, emptyMuscle(id)]));
  const dayEntries = isProgram
    ? (Array.isArray(program?.days) ? program.days : []).map((day, index) => ({ day, index, routine: routineById.get(day?.routineId) }))
    : routine ? [{ day: null, index: 0, routine }] : [];
  let exerciseCount = 0;
  let workingSetCount = 0;
  let missingRoutineCount = 0;
  let missingTemplateCount = 0;
  let missingMuscleCount = 0;

  const record = (id, role, exercise, context, sets) => {
    if (!id) return;
    if (!muscles.has(id)) muscles.set(id, emptyMuscle(id));
    const muscle = muscles.get(id);
    if (role === 'primary') {
      muscle.primaryExercises += 1;
      muscle.primarySets += sets;
    } else {
      muscle.secondaryExercises += 1;
      muscle.secondarySets += sets;
    }
    muscle.contributions.push({
      exerciseTitle: String(exercise?.title || context.template?.title || 'Untitled exercise'),
      routineTitle: String(context.routine?.title || 'Untitled routine'),
      dayLabel: context.dayLabel,
      role,
      sets,
    });
  };

  for (const entry of dayEntries) {
    if (!entry.routine) {
      missingRoutineCount += 1;
      continue;
    }
    const routineTitle = entry.routine.title || 'Untitled routine';
    const dayLabel = isProgram ? String(entry.day?.label || `Day ${entry.index + 1}`) : 'This routine';
    for (const exercise of Array.isArray(entry.routine.exercises) ? entry.routine.exercises : []) {
      exerciseCount += 1;
      const sets = workingSets(exercise);
      workingSetCount += sets;
      const template = templateById.get(exercise?.exercise_template_id);
      if (!template) {
        missingTemplateCount += 1;
        continue;
      }
      const primary = normalizeMuscleId(template.primary_muscle_group);
      const secondaries = new Set((Array.isArray(template.secondary_muscle_groups) ? template.secondary_muscle_groups : [])
        .map(normalizeMuscleId).filter(Boolean));
      secondaries.delete(primary);
      if (!primary && !secondaries.size) {
        missingMuscleCount += 1;
        continue;
      }
      const context = { routine: entry.routine, template, dayLabel, routineTitle };
      record(primary, 'primary', exercise, context, sets);
      for (const secondary of secondaries) record(secondary, 'secondary', exercise, context, sets);
    }
  }

  const unmapped = [...muscles.values()].filter(muscle => !MAPPED_SET.has(muscle.id)).sort((a, b) => a.id.localeCompare(b.id));
  return {
    scope: isProgram ? 'program' : 'routine',
    dayCount: isProgram ? dayEntries.length : routine ? 1 : 0,
    exerciseCount,
    workingSetCount,
    missingRoutineCount,
    missingTemplateCount,
    missingMuscleCount,
    muscles: [...MAPPED_MUSCLES.map(id => muscles.get(id)), ...unmapped],
  };
}
