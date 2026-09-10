// The UI works in the selected display unit; Hevy always receives kilograms.
export function routinePayload(title, notes, exercises, unit, existingRoutine = null) {
  const number = value => value === '' || value == null ? null : Number(value);
  const payload = {
    title, notes,
    exercises: exercises.map(exercise => ({
      exercise_template_id: exercise.id,
      rest_seconds: number(exercise.rest), notes: exercise.notes,
      sets: exercise.sets.map(set => {
        const load = number(set.weight), reps = number(set.reps), end = number(set.repEnd);
        return { type: set.type, weight_kg: load == null ? null : unit === 'lb' ? load / 2.2046226218 : load,
          reps: end == null ? reps : null, rep_range: end == null ? null : { start: reps, end },
          duration_seconds: number(set.duration), distance_meters: number(set.distance) };
      }),
    })),
  };
  if (existingRoutine) {
    payload.metadata = {
      folder_id: existingRoutine.folder_id ?? null,
      exercises: exercises.map(exercise => ({
        superset_id: exercise.superset_id ?? null,
        sets: exercise.sets.map(set => ({ custom_metric: set.customMetric ?? null })),
      })),
    };
  }
  return payload;
}

export function openRoutineBuilder(ctx, existingRoutine = null) {
  const { state, node, add, api, refresh, toast, openDialog, closeDialog, button, field, settingsLink } = ctx;
  const unit = state.settings.unit || 'kg';
  const form = node('form', 'dialog-form routine-builder');
  const requestId = crypto.randomUUID();
  const exercises = [];
  const templates = [...state.exerciseTemplates].sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)));
  const missingKey = state.mode === 'live' && !state.settings.hasApiKey;
  const canPublish = state.mode === 'live' && state.settings.hasApiKey && templates.length > 0;

  form.append(node('p', 'note', existingRoutine
    ? 'Edit this routine in Hevy. Its folder and other saved targets stay attached while you change the routine.'
    : 'Build a workout here, then create it in Hevy’s My Routines folder. You can use it in the gym and add it to a Corpus program.'));
  if (!canPublish) {
    const notice = node('div', 'notice notice--info');
    const body = add(node('div', 'notice-body'), node('p', '', state.mode === 'demo'
      ? 'Demo preview only. Switch to live data and sync Hevy to publish a routine using your exercise library.'
      : missingKey
        ? 'Add your Hevy key in Settings, then sync once to load the exercise library.'
        : 'Sync Hevy once to load your exercise library, then create a routine.'));
    add(notice, body, missingKey ? add(node('div', 'notice-action'), settingsLink()) : null);
    form.append(notice);
  }

  const title = field('Routine name', { value: existingRoutine?.title ?? '', required: true, maxLength: 160 });
  const notes = field('Routine notes', { tag: 'textarea', value: existingRoutine?.notes ?? '', maxLength: 4000, rows: 2 });
  add(form, title, notes);

  const picker = node('section', 'routine-picker');
  const search = field('Find an exercise', { type: 'search', placeholder: 'Search by name or muscle' });
  const exercise = field('Exercise', { options: [] });
  const select = exercise.control;
  function filterTemplates() {
    const previous = select.value, query = search.control.value.toLowerCase();
    select.replaceChildren();
    for (const template of templates.filter(t => `${t.title} ${t.primary_muscle_group || ''}`.toLowerCase().includes(query))) {
      const option = node('option', '', template.title); option.value = template.id; select.append(option);
    }
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    addExercise.disabled = !select.options.length || exercises.length >= 50;
  }
  const exerciseList = node('div', 'routine-exercise-list');
  const addExercise = button('Add exercise', { icon: '+', onClick: () => {
    const template = templates.find(t => t.id === select.value);
    if (template && exercises.length < 50) { makeExercise(template); filterTemplates(); }
  } });
  search.control.addEventListener('input', filterTemplates); filterTemplates();
  add(picker, search, exercise, addExercise);
  add(form, picker, exerciseList,
    node('p', 'note', 'Set targets are optional. Use Reps alone for a fixed count, or add Reps (to) for a range.'));

  const error = node('p', 'form-error'); error.setAttribute('role', 'alert'); form.append(error);
  const publish = button(existingRoutine ? 'Save changes to Hevy' : 'Create in Hevy', { variant: 'primary', type: 'submit' });
  const publishLabel = publish.querySelector('span');
  publish.disabled = !canPublish;
  form.append(add(node('div', 'dialog-actions'), button('Cancel', { onClick: closeDialog }), publish));

  if (existingRoutine) {
    for (const savedExercise of existingRoutine.exercises || []) {
      const template = templates.find(item => item.id === savedExercise.exercise_template_id)
        || { id: savedExercise.exercise_template_id, title: savedExercise.title || savedExercise.exercise_template_id, type: '' };
      makeExercise(template, savedExercise);
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault(); error.textContent = '';
    if (!canPublish) return;
    if (!exercises.length) { error.textContent = 'Add at least one exercise.'; return; }
    if (exercises.some(ex => ex.oversized)) { error.textContent = 'This saved routine has more than 50 sets in one exercise. Remove sets before saving changes.'; return; }
    const values = exercises.map(ex => ({ id: ex.id, rest: ex.rest.value, notes: ex.savedNotes === null && ex.notes.value === '' ? null : ex.notes.value, superset_id: ex.superset_id,
      sets: ex.sets.map(set => ({ ...Object.fromEntries(Object.entries(set.fields).map(([key, input]) => [key, input.value])), customMetric: set.customMetric })) }));
    const payload = routinePayload(title.control.value, existingRoutine?.notes === null && notes.control.value === '' ? null : notes.control.value, values, unit, existingRoutine);
    for (const exercise of payload.exercises) {
      if (!exercise.sets.length) { error.textContent = 'Each exercise needs at least one set.'; return; }
      if (exercise.sets.some(s => s.rep_range && (s.rep_range.start == null || s.rep_range.start < 1 || s.rep_range.end < s.rep_range.start))) {
        error.textContent = 'Rep ranges need a starting count and an ending count at least as large.'; return;
      }
    }
    publish.disabled = true; publishLabel.textContent = existingRoutine ? 'Saving changes in Hevy…' : 'Creating in Hevy…';
    let completed = false;
    try {
      const endpoint = existingRoutine ? `/api/routines/${encodeURIComponent(existingRoutine.id)}` : '/api/routines';
      const result = await api(endpoint, { method: existingRoutine ? 'PUT' : 'POST', body: JSON.stringify({ requestId, ...payload }) });
      completed = true; closeDialog();
      toast(existingRoutine ? 'Routine updated' : 'Routine created', result.warning || (existingRoutine ? 'Your saved routine has been updated in Hevy.' : 'It is ready in My Routines.'));
      try { await refresh(); } catch { toast('Couldn’t refresh Corpus', 'The routine was saved in Hevy. Reload to see it.', 'error'); }
    } catch (err) {
      error.textContent = err.message;
      if (['publication_uncertain', 'publication_pending', 'publish_uncertain'].includes(err.code)) {
        completed = true; publishLabel.textContent = existingRoutine ? 'Check Hevy before saving again' : 'Check Hevy before creating again';
      }
    } finally {
      if (!completed) { publish.disabled = false; publishLabel.textContent = existingRoutine ? 'Save changes to Hevy' : 'Create in Hevy'; }
    }
  });
  openDialog('Hevy routine', existingRoutine ? 'Edit routine' : 'Create routine', form);

  function makeExercise(template, savedExercise = null) {
    const block = node('section', 'routine-draft-exercise'), top = node('div', 'routine-draft-heading');
    const record = { id: template.id, block, sets: [], savedNotes: savedExercise ? savedExercise.notes : undefined, superset_id: savedExercise ? savedExercise.superset_id ?? null : null, oversized: false };
    const move = direction => {
      const from = exercises.indexOf(record), to = from + direction;
      if (to < 0 || to >= exercises.length) return;
      [exercises[from], exercises[to]] = [exercises[to], exercises[from]];
      exerciseList.replaceChildren(...exercises.map(e => e.block));
    };
    const controls = node('div', 'routine-order-controls');
    const up = button('', { size: 'sm', icon: '↑', title: 'Move up', onClick: () => move(-1) });
    const down = button('', { size: 'sm', icon: '↓', title: 'Move down', onClick: () => move(1) });
    up.setAttribute('aria-label', `Move ${template.title} up`); down.setAttribute('aria-label', `Move ${template.title} down`);
    add(controls, up, down, button('Remove', { variant: 'danger', size: 'sm', title: `Remove ${template.title}`, onClick: () => {
      exercises.splice(exercises.indexOf(record), 1); block.remove(); filterTemplates();
    } }));
    add(top, node('h3', '', template.title), controls); block.append(top);
    const rest = field('Rest (s)', { type: 'number', value: savedExercise ? savedExercise.rest_seconds ?? '' : '90' });
    rest.control.min = '0'; rest.control.step = '1';
    const note = field('Exercise notes', { tag: 'textarea', value: savedExercise?.notes ?? '', maxLength: 4000, rows: 2 });
    record.rest = rest.control; record.notes = note.control;
    add(block, add(node('div', 'routine-exercise-options'), rest, note));
    const tableWrap = node('div', 'routine-set-scroll'), table = node('table', 'sets-table');
    const headings = node('tr');
    for (const label of ['Type', `Load (${unit})`, 'Reps', 'Reps (to)', 'Time (s)', 'Distance (m)', '']) { const th = node('th', '', label); th.scope = 'col'; headings.append(th); }
    add(table, add(node('thead'), headings)); const tbody = node('tbody'); table.append(tbody); tableWrap.append(table); block.append(tableWrap);
    const warning = node('p', 'form-warning');
    block.append(add(node('div', 'form-row'), button('Add set', { size: 'sm', icon: '+', onClick: () => makeSet() })));
    block.append(warning);
    function makeSet(savedSet = null) {
      if (record.sets.length >= 50 && !savedSet) return;
      const row = node('tr'), set = { fields: {} };
      const type = node('select', 'select'); type.setAttribute('aria-label', 'Set type');
      for (const value of ['normal', 'warmup', 'failure', 'dropset']) { const option = node('option', '', value); option.value = value; type.append(option); }
      if (savedSet?.type) type.value = savedSet.type;
      set.fields.type = type; row.append(add(node('td'), type));
      for (const [key, label] of [['weight', `Load (${unit})`], ['reps', 'Reps'], ['repEnd', 'Reps (to)'], ['duration', 'Time (s)'], ['distance', 'Distance (m)']]) {
        const input = node('input', 'input'); input.type = 'number'; input.min = key === 'repEnd' ? '1' : '0'; input.step = key === 'weight' ? 'any' : '1'; input.placeholder = '—'; input.setAttribute('aria-label', label);
        if (key === 'reps' && /reps/.test(template.type || '')) input.value = '8';
        if (savedSet) {
          const range = savedSet.rep_range;
          const hasRange = range && range.start != null && range.end != null;
          const sourceValue = key === 'weight' ? savedSet.weight_kg == null ? '' : unit === 'lb' ? savedSet.weight_kg * 2.2046226218 : savedSet.weight_kg
            : key === 'reps' ? hasRange ? range.start : savedSet.reps == null ? '' : savedSet.reps
              : key === 'repEnd' ? hasRange ? range.end : ''
                : key === 'duration' ? savedSet.duration_seconds == null ? '' : savedSet.duration_seconds
                  : savedSet.distance_meters == null ? '' : savedSet.distance_meters;
          input.value = sourceValue;
        }
        set.fields[key] = input; row.append(add(node('td'), input));
      }
      set.customMetric = savedSet?.custom_metric;
      const remove = button('', { size: 'sm', icon: '×', title: 'Remove set', onClick: () => {
        record.sets.splice(record.sets.indexOf(set), 1); row.remove();
        if (record.oversized && record.sets.length <= 50) { record.oversized = false; warning.textContent = ''; }
      } });
      row.append(add(node('td'), remove)); record.sets.push(set); tbody.append(row);
    }
    exercises.push(record); exerciseList.append(block);
    if (savedExercise?.sets?.length) {
      record.oversized = savedExercise.sets.length > 50;
      savedExercise.sets.forEach(makeSet);
      if (record.oversized) warning.textContent = 'This exercise has more than 50 saved sets. Remove sets before saving changes.';
    } else makeSet();
  }
}
