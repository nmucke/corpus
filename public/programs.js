import { openRoutineBuilder } from './routine-builder.js';
import { openMuscleCoverage } from './muscle-map.js';
import { localDateKey, programTimeline, summarizeProgram } from './program-timeline.js';

/** A compact schedule summary that can also be used by the overview view. */
export function renderProgramProgress(ctx, program, now = new Date()) {
  const { state, node, add, titleCase } = ctx;
  const { formatDay, plural } = ctx.format;
  const summary = summarizeProgram(program, state.workouts, now);
  const result = node('section', 'program-progress');
  result.setAttribute('aria-label', `${program.title || 'Program'} schedule`);
  const badges = node('div', 'program-badges');
  badges.append(node('span', `pill status-${summary.status}`, titleCase(summary.status)));
  if (summary.currentWeek != null) badges.append(node('span', 'pill', `Week ${summary.currentWeek} of ${summary.durationWeeks}`));
  result.append(badges);
  const range = summary.startDate
    ? `${formatDay(summary.startDate)} – ${formatDay(summary.endDate)} · ${plural(summary.durationWeeks, 'week')}`
    : 'No dates set';
  result.append(node('p', 'note', range));
  if (summary.durationWeeks != null) {
    const time = node('div', 'program-time-progress');
    const roundedProgress = Math.round(summary.progress);
    const label = `${roundedProgress}% of program time · ${summary.elapsedDays} of ${summary.totalDays} calendar days`;
    const progress = node('progress', 'program-progress-bar'); progress.max = 100; progress.value = summary.progress; progress.setAttribute('aria-label', label);
    add(time, node('span', '', 'Time progress'), node('strong', '', `${roundedProgress}%`), progress, node('span', 'program-elapsed', `${summary.elapsedDays}/${summary.totalDays} days`), node('span', 'sr-only', label));
    result.append(time);
  }
  result.append(node('p', 'note', `${plural(summary.sessionCount, 'matched session')}`));
  if (summary.weeks.length) {
    const strip = node('div', 'program-week-strip'); strip.setAttribute('role', 'list'); strip.setAttribute('aria-label', 'Matched sessions by program week');
    for (const week of summary.weeks) {
      const future = summary.status === 'upcoming' || (summary.status === 'active' && week.week > summary.currentWeek);
      const item = node('span', `program-week-count${week.count ? ' has-sessions' : ''}${future ? ' future-week' : ''}${summary.currentWeek === week.week ? ' current-week' : ''}`);
      const count = future ? '–' : String(week.count);
      const matched = future ? 'upcoming' : plural(week.count, 'matched session');
      item.setAttribute('role', 'listitem');
      item.setAttribute('title', `Week ${week.week}: ${formatDay(week.startDate)} – ${formatDay(week.endDate)}, ${matched}`);
      item.setAttribute('aria-label', `Week ${week.week}, ${matched}`);
      if (summary.currentWeek === week.week) item.setAttribute('aria-current', 'step');
      add(item, node('span', 'program-week-label', `W${week.week}`), node('strong', '', count)); strip.append(item);
    }
    result.append(strip);
  }
  return result;
}

export function renderPrograms(ctx) {
  const { state, node, add, api, refresh, toast, openDialog, closeDialog, button, field, emptyState, heading, sectionHeading, settingsLink } = ctx;
  const { MISSING_ROUTINE, formatDay, formatSeconds, formatSet, plural } = ctx.format;
  const unit = state.settings.unit || 'kg';
  const routines = new Map(state.routines.map(r => [r.id, r]));
  const view = node('section', 'view');

  const newProgram = (variant = 'primary') => button('New program', {
    variant, icon: '+',
    onClick: () => {
      if (!routines.size) { toast('Sync Hevy first', 'Programs are built from your synced routines.'); return; }
      editProgram();
    },
  });
  view.append(heading('Workout', 'Programs', 'Plan a training block and follow your sessions week by week.', newProgram()));

  const grid = node('div', 'card-grid');
  for (const program of state.programs) {
    const card = node('article', 'card program-card');
    add(card,
      node('p', 'label-caps', 'Program'),
      node('h3', 'card-title', program.title),
      node('p', 'card-meta', plural(program.days.length, 'training day')),
      node('p', 'note', program.description || 'Your local training plan.'),
      renderProgramProgress(ctx, program));
    const list = node('ol', 'day-list');
    for (const day of program.days) list.append(node('li', '', `${day.label} · ${routines.get(day.routineId)?.title || MISSING_ROUTINE}`));
    const actions = node('div', 'card-actions');
    add(actions,
      button('Muscle coverage', { size: 'sm', onClick: () => openMuscleCoverage(ctx, { program }) }),
      button('Edit program', { size: 'sm', onClick: () => editProgram(program) }),
      button('Delete', { variant: 'danger', size: 'sm', onClick: () => deleteProgram(program) }));
    add(card, list, actions);
    grid.append(card);
  }
  if (state.programs.length) {
    add(view, grid, node('p', 'note', 'Matches are based on selected routines and session dates. Editing dates or routines recalculates them.'));
  } else {
    view.append(emptyState({
      title: 'No programs yet',
      copy: 'Create a program by choosing a routine for each training day. Your workouts are still logged in Hevy.',
      icon: '◫',
      action: routines.size ? newProgram('secondary') : settingsLink('Open Settings', { asButton: true }),
    }));
  }

  view.append(sectionHeading('Saved routines', 'Hevy routines and accepted local drafts',
    button('New Hevy routine', { variant: 'primary', icon: '+', onClick: () => openRoutineBuilder(ctx) })));

  const routineGrid = node('div', 'card-grid');
  for (const routine of state.routines) routineGrid.append(routineCard(routine));
  if (state.routines.length) view.append(routineGrid);
  else view.append(emptyState({
    title: 'No routines yet',
    copy: 'Connect Hevy in Settings, then sync to import your saved routines.',
    icon: '↻',
    action: settingsLink('Open Settings', { asButton: true }),
  }));
  return view;

  function routineCard(routine) {
    const card = node('article', 'card routine-card');
    const details = node('details'), summary = node('summary');
    const chevron = node('span', 'disclosure-chevron', '›'); chevron.setAttribute('aria-hidden', 'true');
    add(summary,
      node('h3', 'card-title', routine.title),
      node('span', 'card-meta', plural(routine.exercises?.length || 0, 'exercise')),
      chevron);
    const memberships = state.programs.filter((program) => program.days.some((day) => day.routineId === routine.id));
    if (memberships.length) {
      const badges = node('div', 'program-badges');
      for (const program of memberships) {
        const timeline = programTimeline(program);
        badges.append(node('span', `pill status-${timeline.status}`, `${program.title} · ${ctx.titleCase(timeline.status)}`));
      }
      summary.append(badges);
    }
    details.append(summary);

    const content = node('div', 'routine-detail');
    for (const exercise of routine.exercises || []) {
      const section = node('section', 'routine-exercise');
      add(section, node('h4', '', exercise.title), exercise.notes ? node('p', 'exercise-note', exercise.notes) : null);
      if (exercise.rest_seconds != null) section.append(node('p', 'note', `Rest · ${formatSeconds(exercise.rest_seconds)}`));
      const list = node('ol');
      for (const set of exercise.sets || []) list.append(node('li', '', formatSet(set, unit)));
      section.append(list); content.append(section);
    }
    if (!(routine.exercises || []).length) content.append(node('p', 'note', 'No exercises in this routine.'));
    details.append(content);

    const actions = node('div', 'card-actions');
    actions.append(button('Muscle coverage', { size: 'sm', onClick: () => openMuscleCoverage(ctx, { routine }) }));
    add(card, details, actions);
    if (routine.source === 'local') {
      const demo = state.mode === 'demo';
      const publish = button('Publish to Hevy', {
        variant: 'primary', size: 'sm',
        title: demo ? 'Publishing is unavailable in demo mode.' : 'Publish this accepted local routine to Hevy',
        onClick: async () => {
          if (publish.disabled) return;
          publish.disabled = true;
          try {
            const result = await api(`/api/local-routines/${encodeURIComponent(routine.id)}/publish`, { method: 'POST', body: '{}' });
            await refresh();
            toast('Routine published', result.warning || 'It is now available in Hevy.');
          } catch (error) {
            toast('Couldn’t publish routine', error.message, 'error');
            publish.disabled = false;
          }
        },
      });
      publish.disabled = demo;
      add(actions, publish, button('Request AI changes', { size: 'sm', onClick: () => { location.hash = '#proposals'; } }));
      add(card,
        node('p', 'note', 'Accepted locally · request AI changes from the drafts workspace.'),
        demo ? node('p', 'note', 'Publishing is unavailable in demo mode.') : null);
    } else {
      actions.append(button('Edit routine', { size: 'sm', onClick: () => openRoutineBuilder(ctx, routine) }));
    }
    return card;
  }

  function editProgram(program) {
    const form = node('form', 'dialog-form');
    const title = field('Program name', { value: program?.title || '', required: true, maxLength: 160 });
    const description = field('Notes', { tag: 'textarea', value: program?.description || '', maxLength: 4000 });

    const existingScheduled = program?.start_date != null && program?.duration_weeks != null;
    const scheduleInput = node('input'); scheduleInput.type = 'checkbox';
    scheduleInput.checked = program ? existingScheduled : true;
    const scheduled = add(node('label', 'checkbox-field'), scheduleInput, node('span', '', 'Schedule this program'));

    const scheduleFields = node('div', 'program-schedule-fields');
    const startDate = field('Start date', { type: 'date', value: program?.start_date || localDateKey(new Date()) });
    const duration = field('Duration (weeks)', { type: 'number', value: program?.duration_weeks ?? 8 });
    duration.control.min = '1'; duration.control.max = '52'; duration.control.step = '1';
    const quick = node('div', 'schedule-quick'); quick.setAttribute('aria-label', 'Set duration');
    const end = node('p', 'note'); end.setAttribute('role', 'status');
    const updateSchedule = () => {
      const enabled = scheduleInput.checked;
      scheduleFields.hidden = !enabled;
      startDate.control.disabled = !enabled; duration.control.disabled = !enabled;
      const timeline = programTimeline({ start_date: startDate.control.value, duration_weeks: Number(duration.control.value) });
      end.textContent = enabled && timeline.endDate
        ? `Inclusive end date: ${formatDay(timeline.endDate)}`
        : 'This program has no dates; sessions will not be matched automatically.';
    };
    for (const weeks of [8, 10, 12]) {
      quick.append(button(`${weeks} weeks`, { variant: 'secondary', size: 'sm', onClick: () => { duration.control.value = String(weeks); updateSchedule(); } }));
    }
    add(scheduleFields, startDate, duration, quick, end);
    scheduleInput.addEventListener('change', updateSchedule);
    startDate.control.addEventListener('input', updateSchedule);
    duration.control.addEventListener('input', updateSchedule);
    updateSchedule();
    add(form, title, description, scheduled, scheduleFields,
      node('p', 'note', 'Days follow the order below. Labels can be weekdays or session names.'));

    const dayList = node('div', 'program-days'); const rows = [];
    function addDay(day = {}) {
      if (rows.length >= 14) return;
      const row = node('div', 'day-row');
      const label = field('Day label', { value: day.label || `Day ${rows.length + 1}`, required: true, maxLength: 100 });
      const missing = day.routineId && !routines.has(day.routineId);
      const routine = field('Routine', {
        required: true,
        options: [
          ...(missing ? [{ value: '', label: 'Choose an available routine' }] : []),
          ...state.routines.map((item) => ({ value: item.id, label: item.title })),
        ],
      });
      if (day.routineId) routine.control.value = missing ? '' : day.routineId;
      const record = { row, label: label.control, routine: routine.control };
      const remove = button('', {
        size: 'sm', icon: '×', title: 'Remove training day',
        onClick: () => { rows.splice(rows.indexOf(record), 1); row.remove(); },
      });
      add(row, label, routine, remove); rows.push(record); dayList.append(row);
    }
    (program?.days || [{}]).forEach(addDay);
    const addRow = add(node('div', 'form-row'), button('Add training day', { icon: '+', onClick: () => addDay() }));
    add(form, dayList, addRow);

    const error = node('p', 'form-error'); error.setAttribute('role', 'alert'); form.append(error);
    const save = button('Save program', { variant: 'primary', type: 'submit' });
    form.append(add(node('div', 'dialog-actions'), button('Cancel', { onClick: closeDialog }), save));
    form.addEventListener('submit', async event => {
      event.preventDefault(); error.textContent = '';
      if (!rows.length) { error.textContent = 'Add at least one training day.'; return; }
      const schedule = scheduleInput.checked
        ? { start_date: startDate.control.value, duration_weeks: Number(duration.control.value) }
        : { start_date: null, duration_weeks: null };
      if (scheduleInput.checked && !programTimeline(schedule).startDate) {
        error.textContent = 'Enter a real start date and a duration from 1 to 52 weeks.'; return;
      }
      save.disabled = true;
      try {
        await api('/api/programs', { method: 'POST', body: JSON.stringify({
          ...(program ? { id: program.id } : {}),
          title: title.control.value, description: description.control.value, ...schedule,
          days: rows.map(row => ({ label: row.label.value, routineId: row.routine.value })),
        }) });
        closeDialog(); await refresh();
        toast('Program saved', 'Your plan is stored locally.');
      } catch (err) { error.textContent = err.message; } finally { save.disabled = false; }
    });
    openDialog('Program', program ? 'Edit program' : 'Create program', form);
  }

  function deleteProgram(program) {
    const content = node('div', 'dialog-stack');
    content.append(node('p', '', `Delete “${program.title}”? This removes the local plan. Your Hevy routines and sessions remain available.`));
    const error = node('p', 'form-error'); error.setAttribute('role', 'alert');
    const remove = button('Delete program', { variant: 'danger', onClick: async () => {
      error.textContent = ''; remove.disabled = true;
      try {
        await api(`/api/programs/${encodeURIComponent(program.id)}`, { method: 'DELETE' });
        closeDialog(); await refresh();
        toast('Program deleted', 'Your Hevy routines and sessions are unchanged.');
      } catch (err) { error.textContent = err.message; remove.disabled = false; }
    } });
    add(content, error, add(node('div', 'dialog-actions'), button('Cancel', { onClick: closeDialog }), remove));
    openDialog('Program', 'Delete program?', content);
  }
}
