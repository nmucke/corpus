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
  const { state, node, add, api, refresh, toast, openDialog, closeDialog } = ctx;
  const unit = state.settings.unit || 'kg';
  const form = node('form', 'dialog-form routine-builder');
  const requestId = crypto.randomUUID();
  const exercises = [];
  const templates = [...state.exerciseTemplates].sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)));
  const canPublish = state.mode === 'live' && state.settings.hasApiKey && templates.length > 0;
  const button = (text, action, style = 'button secondary') => {
    const el = node('button', style, text); el.type = 'button'; el.addEventListener('click', action); return el;
  };
  const field = (label, { value = '', type = 'text', required = false, maxLength, tag = 'input' } = {}) => {
    const wrapper = node('label', 'field'), input = node(tag, 'input');
    if (tag === 'input') input.type = type;
    input.value = value; input.required = required;
    if (maxLength) input.maxLength = maxLength;
    add(wrapper, node('span', '', label), input); return { wrapper, input };
  };
  add(form, node('p', '', existingRoutine ? 'Edit this routine in Hevy. Its folder and other saved targets stay attached while you change the routine.' : 'Build a workout here, then create it in Hevy’s My Routines folder. You can use it in the gym and add it to a Corpus program.'));
  if (!canPublish) {
    const info = node('p', 'demo-banner', state.mode === 'demo' ? 'Demo preview only. Switch to live data and sync Hevy to publish a routine using your exercise library.' : 'Add your Hevy key in Settings and sync once to load the exercise library.');
    form.append(info);
  }
  const title = field('Routine name', { value: existingRoutine?.title ?? '', required: true, maxLength: 160 });
  const notes = field('Routine notes', { value: existingRoutine?.notes ?? '', tag: 'textarea', maxLength: 4000 }); notes.input.rows = 2;
  add(form, title.wrapper, notes.wrapper);
  const picker = node('section', 'routine-picker');
  const search = field('Find an exercise', { type: 'search' }); search.input.placeholder = 'Search by name or muscle';
  const selectField = node('label', 'field'), select = node('select', 'select');
  add(selectField, node('span', '', 'Exercise'), select);
  function filterTemplates() {
    const previous = select.value, query = search.input.value.toLowerCase();
    select.replaceChildren();
    for (const template of templates.filter(t => `${t.title} ${t.primary_muscle_group || ''}`.toLowerCase().includes(query))) {
      const option = node('option', '', template.title); option.value = template.id; select.append(option);
    }
    if ([...select.options].some(o => o.value === previous)) select.value = previous;
    addExercise.disabled = !select.options.length || exercises.length >= 50;
  }
  const exerciseList = node('div', 'routine-exercise-list');
  const addExercise = button('+ Add exercise', () => {
    const template = templates.find(t => t.id === select.value);
    if (template && exercises.length < 50) { makeExercise(template); filterTemplates(); }
  });
  search.input.addEventListener('input', filterTemplates); filterTemplates();
  add(picker, search.wrapper, selectField, addExercise);
  add(form, picker, exerciseList, node('p', 'field-hint', 'Set targets are optional. Use “Reps” alone for a fixed count, or add “To” for a rep range. Loads use your display unit; time is seconds and distance is meters.'));
  const error = node('p', 'form-error'); error.setAttribute('role', 'alert'); form.append(error);
  const publish = node('button', 'button primary', existingRoutine ? 'Save changes to Hevy' : 'Create in Hevy'); publish.type = 'submit'; publish.disabled = !canPublish;
  const actions = node('div', 'dialog-actions'); add(actions, button('Cancel', closeDialog), publish); form.append(actions);
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
    const payload = routinePayload(title.input.value, existingRoutine?.notes === null && notes.input.value === '' ? null : notes.input.value, values, unit, existingRoutine);
    for (const exercise of payload.exercises) {
      if (!exercise.sets.length) { error.textContent = 'Each exercise needs at least one set.'; return; }
      if (exercise.sets.some(s => s.rep_range && (s.rep_range.start == null || s.rep_range.start < 1 || s.rep_range.end < s.rep_range.start))) {
        error.textContent = 'Rep ranges need a starting count and an ending count at least as large.'; return;
      }
    }
    publish.disabled = true; publish.textContent = existingRoutine ? 'Saving changes in Hevy…' : 'Creating in Hevy…';
    let completed = false;
    try {
      const endpoint = existingRoutine ? `/api/routines/${encodeURIComponent(existingRoutine.id)}` : '/api/routines';
      const result = await api(endpoint, { method: existingRoutine ? 'PUT' : 'POST', body: JSON.stringify({ requestId, ...payload }) });
      completed = true; closeDialog();
      toast(existingRoutine ? 'Routine updated in Hevy' : 'Routine created in Hevy', result.warning || (existingRoutine ? 'Your saved routine has been updated.' : 'It is ready in My Routines.'));
      try { await refresh(); } catch { toast(existingRoutine ? 'Routine updated' : 'Routine created', 'Refresh Corpus to see the new routine.', 'error'); }
    } catch (err) {
      error.textContent = err.message;
      if (['publication_uncertain', 'publication_pending', 'publish_uncertain'].includes(err.code)) {
        completed = true; publish.textContent = existingRoutine ? 'Check Hevy before saving again' : 'Check Hevy before creating again';
      }
    } finally {
      if (!completed) { publish.disabled = false; publish.textContent = existingRoutine ? 'Save changes to Hevy' : 'Create in Hevy'; }
    }
  });
  openDialog(existingRoutine ? 'Edit Hevy routine' : 'Publish a new workout', existingRoutine ? 'Edit routine' : 'Create a Hevy routine', form);

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
    const up = button('↑', () => move(-1)), down = button('↓', () => move(1));
    up.setAttribute('aria-label', `Move ${template.title} up`); down.setAttribute('aria-label', `Move ${template.title} down`);
    add(controls, up, down, button('Remove', () => { exercises.splice(exercises.indexOf(record), 1); block.remove(); filterTemplates(); }));
    add(top, node('h3', '', template.title), controls); block.append(top);
    const rest = field('Rest between sets (seconds)', { type: 'number', value: savedExercise ? savedExercise.rest_seconds ?? '' : '90' }); rest.input.min = '0'; rest.input.step = '1';
    const note = field('Exercise notes', { value: savedExercise?.notes ?? '', maxLength: 4000 }); record.rest = rest.input; record.notes = note.input;
    add(block, add(node('div', 'routine-exercise-options'), rest.wrapper, note.wrapper));
    const tableWrap = node('div', 'routine-set-scroll'), table = node('table', 'sets-table');
    const headings = node('tr');
    for (const label of ['Type', `Load (${unit})`, 'Reps', 'To', 'Time (s)', 'Distance (m)', '']) { const th = node('th', '', label); th.scope = 'col'; headings.append(th); }
    add(table, add(node('thead'), headings)); const tbody = node('tbody'); table.append(tbody); tableWrap.append(table); block.append(tableWrap);
    const addSet = button('+ Add set', () => makeSet()); block.append(addSet);
    function makeSet(savedSet = null) {
      if (record.sets.length >= 50 && !savedSet) return;
      const row = node('tr'), set = { fields: {} };
      const type = node('select', 'select'); type.setAttribute('aria-label', 'Set type');
      for (const value of ['normal', 'warmup', 'failure', 'dropset']) { const option = node('option', '', value); option.value = value; type.append(option); }
      if (savedSet?.type) type.value = savedSet.type;
      set.fields.type = type; row.append(add(node('td'), type));
      for (const [key, label] of [['weight', `Load in ${unit}`], ['reps', 'Repetitions'], ['repEnd', 'Rep range end'], ['duration', 'Duration in seconds'], ['distance', 'Distance in meters']]) {
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
      const remove = button('×', () => {
        record.sets.splice(record.sets.indexOf(set), 1); row.remove();
        if (record.oversized && record.sets.length <= 50) {
          record.oversized = false;
          block.querySelector('.form-error')?.remove();
        }
      }); remove.setAttribute('aria-label', 'Remove set');
      row.append(add(node('td'), remove)); record.sets.push(set); tbody.append(row);
    }
    exercises.push(record); exerciseList.append(block);
    if (savedExercise?.sets?.length) {
      record.oversized = savedExercise.sets.length > 50;
      savedExercise.sets.forEach(makeSet);
      if (record.oversized) block.append(node('p', 'form-error', 'This exercise has more than 50 saved sets. Remove sets before saving changes.'));
    } else makeSet();
  }
}
