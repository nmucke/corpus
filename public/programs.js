import { openRoutineBuilder } from './routine-builder.js';
import { localDateKey, programTimeline, summarizeProgram } from './program-timeline.js';

function dateLabel(value) {
  if (!value) return 'No date range';
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0); date.setHours(0, 0, 0, 0); date.setFullYear(year, month - 1, day);
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function statusLabel(status) { return `${status.slice(0, 1).toUpperCase()}${status.slice(1)}`; }

/** A compact schedule summary that can also be used by the overview view. */
export function renderProgramProgress(ctx, program, now = new Date()) {
  const { state, node, add } = ctx;
  const summary = summarizeProgram(program, state.workouts, now);
  const result = node('section', 'program-progress');
  result.setAttribute('aria-label', `${program.title || 'Program'} schedule`);
  const badges = node('div', 'program-badges');
  const status = node('span', `program-badge status-${summary.status}`, statusLabel(summary.status));
  status.setAttribute('role', 'status');
  badges.append(status);
  if (summary.currentWeek != null) badges.append(node('span', 'program-badge', `Week ${summary.currentWeek} of ${summary.durationWeeks}`));
  result.append(badges);
  const range = summary.startDate ? `${dateLabel(summary.startDate)} – ${dateLabel(summary.endDate)}` : 'No dates set';
  result.append(node('p', 'program-range', summary.startDate ? `${range} · ${summary.durationWeeks} weeks` : range));
  if (summary.durationWeeks != null) {
    const time = node('div', 'program-time-progress');
    const roundedProgress = Math.round(summary.progress);
    const label = `${roundedProgress}% of program time · ${summary.elapsedDays} of ${summary.totalDays} calendar days`;
    const progress = node('progress', 'program-progress-bar'); progress.max = 100; progress.value = summary.progress; progress.setAttribute('aria-label', label);
    add(time, node('span', '', 'Time progress'), node('strong', '', `${roundedProgress}%`), progress, node('span', 'program-elapsed', `${summary.elapsedDays}/${summary.totalDays} days`), node('span', 'sr-only', label));
    result.append(time);
  }
  result.append(node('p', 'program-session-count', `${summary.sessionCount} matched ${summary.sessionCount === 1 ? 'session' : 'sessions'}`));
  if (summary.weeks.length) {
    const strip = node('div', 'program-week-strip'); strip.setAttribute('role', 'list'); strip.setAttribute('aria-label', 'Matched sessions by program week');
    for (const week of summary.weeks) {
      const future = summary.status === 'upcoming' || (summary.status === 'active' && week.week > summary.currentWeek);
      const item = node('span', `program-week-count${week.count ? ' has-sessions' : ''}${future ? ' future-week' : ''}${summary.currentWeek === week.week ? ' current-week' : ''}`);
      const count = future ? '–' : String(week.count);
      item.setAttribute('role', 'listitem'); item.setAttribute('title', `Week ${week.week}: ${dateLabel(week.startDate)} – ${dateLabel(week.endDate)}, ${future ? 'upcoming' : `${week.count} matched ${week.count === 1 ? 'session' : 'sessions'}`}`);
      item.setAttribute('aria-label', `Week ${week.week}, ${future ? 'upcoming' : `${week.count} matched ${week.count === 1 ? 'session' : 'sessions'}`}`);
      if (summary.currentWeek === week.week) item.setAttribute('aria-current', 'step');
      add(item, node('span', 'program-week-label', `W${week.week}`), node('strong', '', count)); strip.append(item);
    }
    result.append(strip);
  }
  return result;
}

export function renderPrograms(ctx) {
  const { state, node, add, api, refresh, toast, openDialog, closeDialog } = ctx;
  const routines = new Map(state.routines.map(r => [r.id, r]));
  const view = node('section', 'view section-page');
  const button = (text, handler, className = 'button secondary') => {
    const el = node('button', className, text); el.type = 'button'; el.addEventListener('click', handler); return el;
  };
  const header = node('header', 'view-header');
  add(header, add(node('div', 'view-heading'), node('p', 'eyebrow', 'Your training structure'), node('h1', '', 'Programs'), node('p', '', 'Plan a training block and follow your sessions week by week.')));
  const create = button('+ New program', () => editProgram(), 'button primary'); create.disabled = !routines.size;
  header.append(create); view.append(header);
  if (state.mode === 'demo') view.append(node('p', 'demo-banner', 'Demo programs stay separate from your real training plans.'));
  const grid = node('div', 'program-grid');
  for (const program of state.programs) {
    const card = node('article', 'program-card');
    add(card, node('p', 'card-kicker', `${program.days.length} training days`), node('h2', '', program.title), node('p', '', program.description || 'Your local training plan.'), renderProgramProgress(ctx, program));
    const list = node('ol', 'day-list');
    for (const day of program.days) list.append(node('li', '', `${day.label} · ${routines.get(day.routineId)?.title || 'Routine no longer available in Hevy'}`));
    const actions = node('div', 'dialog-actions'); add(actions, button('Edit program', () => editProgram(program)), button('Delete', () => deleteProgram(program), 'button ghost'));
    add(card, list, actions); grid.append(card);
  }
  if (!state.programs.length) grid.append(add(node('div', 'panel'), node('h2', '', 'Give your training a structure'), node('p', '', 'Create a program by choosing a routine for each training day. Your workouts are still logged in Hevy.')));
  view.append(grid);
  view.append(node('p', 'field-hint', 'Matches are based on selected routines and session dates. Editing dates or routines recalculates them.'));
  const routineHeading = node('header', 'panel-header'); routineHeading.style.marginTop = '36px';
  add(routineHeading, add(node('div'), node('h2', '', 'Saved routines'), node('p', '', 'Imported from Hevy · expand a routine to see the prescribed sets.')));
  routineHeading.append(button('+ New Hevy routine', () => openRoutineBuilder(ctx), 'button primary')); view.append(routineHeading);
  const routineGrid = node('div', 'routine-grid');
  for (const routine of state.routines) {
    const card = node('article', 'routine-card'), details = node('details'), summary = node('summary');
    add(summary, node('h3', '', routine.title), node('span', 'routine-count', `${routine.exercises?.length || 0} exercises +`)); details.append(summary);
    const memberships = state.programs.filter((program) => program.days.some((day) => day.routineId === routine.id));
    if (memberships.length) {
      const membership = node('div', 'routine-programs'); membership.append(node('p', 'field-hint', 'Programs'));
      const badges = node('div', 'program-badges');
      for (const program of memberships) { const timeline = programTimeline(program); badges.append(node('span', `program-badge status-${timeline.status}`, `${program.title} · ${statusLabel(timeline.status)}`)); }
      membership.append(badges); card.append(membership);
    }
    const content = node('div', 'routine-detail');
    for (const exercise of routine.exercises || []) {
      const section = node('section', 'exercise-detail'); add(section, node('h3', '', exercise.title), exercise.notes ? node('p', 'exercise-note', exercise.notes) : null);
      if (exercise.rest_seconds != null) section.append(node('p', 'field-hint', `Rest: ${exercise.rest_seconds} seconds`));
      const list = node('ol');
      for (const set of exercise.sets || []) {
        const range = set.rep_range; const parts = [];
        if (range && typeof range === 'object') parts.push(`${range.start ?? '—'}–${range.end ?? '—'} reps`); else if (set.reps != null) parts.push(`${set.reps} reps`);
        if (set.weight_kg != null) parts.push(`${formatLoad(set.weight_kg)} ${state.settings.unit}`);
        if (set.duration_seconds != null) parts.push(`${set.duration_seconds} sec`);
        if (set.distance_meters != null) parts.push(`${set.distance_meters} m`);
        if (set.rpe != null) parts.push(`RPE ${set.rpe}`);
        if (set.type && set.type !== 'normal') parts.push(set.type);
        list.append(node('li', '', parts.join(' · ') || 'Target not specified'));
      }
      section.append(list); content.append(section);
    }
    details.append(content); const actions = node('div', 'dialog-actions'); actions.append(button('Edit routine', () => openRoutineBuilder(ctx, routine), 'button secondary'));
    card.append(details, actions); routineGrid.append(card);
  }
  if (!state.routines.length) routineGrid.append(add(node('div', 'panel'), node('h3', '', 'No routines yet'), node('p', '', 'Connect Hevy in Settings, then sync to import your saved workouts.')));
  view.append(routineGrid);
  return view;

  function formatLoad(kg) { return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(state.settings.unit === 'lb' ? kg * 2.2046226218 : kg); }

  function editProgram(program) {
    const form = node('form', 'dialog-form');
    function field(label, tag = 'input', value = '') {
      const wrapper = node('label', 'field'), control = node(tag, tag === 'select' ? 'select' : 'input'); add(wrapper, node('span', '', label), control); control.value = value; return { wrapper, control };
    }
    const title = field('Program name', 'input', program?.title || ''); title.control.required = true; title.control.maxLength = 160;
    const description = field('Notes', 'textarea', program?.description || ''); description.control.maxLength = 4000; description.control.rows = 3;
    const existingScheduled = program?.start_date != null && program?.duration_weeks != null;
    const scheduled = node('label', 'schedule-toggle'); const scheduleInput = node('input'); scheduleInput.type = 'checkbox'; scheduleInput.checked = program ? existingScheduled : true; add(scheduled, scheduleInput, node('span', '', 'Schedule this program'));
    const scheduleFields = node('div', 'program-schedule-fields');
    const startDate = field('Start date', 'input', program?.start_date || localDateKey(new Date())); startDate.control.type = 'date';
    const duration = field('Duration (weeks)', 'input', program?.duration_weeks ?? 8); duration.control.type = 'number'; duration.control.min = '1'; duration.control.max = '52'; duration.control.step = '1';
    const quick = node('div', 'schedule-quick'); quick.setAttribute('aria-label', 'Set duration'); const end = node('p', 'field-hint'); end.setAttribute('role', 'status');
    const updateSchedule = () => {
      const enabled = scheduleInput.checked; scheduleFields.hidden = !enabled; startDate.control.disabled = !enabled; duration.control.disabled = !enabled;
      const timeline = programTimeline({ start_date: startDate.control.value, duration_weeks: Number(duration.control.value) });
      end.textContent = enabled && timeline.endDate ? `Inclusive end date: ${dateLabel(timeline.endDate)}` : 'This program has no dates; sessions will not be matched automatically.';
    };
    for (const weeks of [8, 10, 12]) quick.append(button(`${weeks} weeks`, () => { duration.control.value = String(weeks); updateSchedule(); }, 'button ghost'));
    add(scheduleFields, startDate.wrapper, duration.wrapper, quick, end); scheduleInput.addEventListener('change', updateSchedule); startDate.control.addEventListener('input', updateSchedule); duration.control.addEventListener('input', updateSchedule); updateSchedule();
    add(form, title.wrapper, description.wrapper, scheduled, scheduleFields, node('p', 'field-hint', 'Days follow the order below. Labels can be weekdays or session names.'));
    const dayList = node('div', 'program-days'); const rows = [];
    function addDay(day = {}) {
      if (rows.length >= 14) return;
      const row = node('div', 'day-row'); const label = field('Day label', 'input', day.label || `Day ${rows.length + 1}`); label.control.required = true; label.control.maxLength = 100;
      const routine = field('Routine', 'select');
      if (day.routineId && !routines.has(day.routineId)) { const missing = node('option', '', 'Choose an available routine'); missing.value = ''; routine.control.append(missing); }
      for (const item of state.routines) { const option = node('option', '', item.title); option.value = item.id; routine.control.append(option); }
      if (day.routineId) routine.control.value = routines.has(day.routineId) ? day.routineId : ''; routine.control.required = true;
      const record = { row, label: label.control, routine: routine.control }; const remove = button('×', () => { rows.splice(rows.indexOf(record), 1); row.remove(); }, 'button secondary'); remove.setAttribute('aria-label', 'Remove training day');
      add(row, label.wrapper, routine.wrapper, remove); rows.push(record); dayList.append(row);
    }
    (program?.days || [{}]).forEach(addDay); add(form, dayList, button('+ Add training day', () => addDay()));
    const error = node('p', 'form-error'); error.setAttribute('role', 'alert'); form.append(error);
    const actions = node('div', 'dialog-actions'), save = node('button', 'button primary', 'Save program'); save.type = 'submit'; add(actions, button('Cancel', closeDialog), save); form.append(actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); error.textContent = '';
      if (!rows.length) { error.textContent = 'Add at least one training day.'; return; }
      const schedule = scheduleInput.checked ? { start_date: startDate.control.value, duration_weeks: Number(duration.control.value) } : { start_date: null, duration_weeks: null };
      if (scheduleInput.checked && !programTimeline(schedule).startDate) { error.textContent = 'Enter a real start date and a duration from 1 to 52 weeks.'; return; }
      save.disabled = true;
      try { await api('/api/programs', { method: 'POST', body: JSON.stringify({ ...(program ? { id: program.id } : {}), title: title.control.value, description: description.control.value, ...schedule, days: rows.map(row => ({ label: row.label.value, routineId: row.routine.value })) }) }); closeDialog(); await refresh(); toast('Program saved', 'Your plan is stored locally.'); }
      catch (err) { error.textContent = err.message; } finally { save.disabled = false; }
    });
    openDialog('Local training plan', program ? 'Edit program' : 'Create a program', form);
  }

  function deleteProgram(program) {
    const content = node('div'); add(content, node('p', '', `Delete “${program.title}”? This removes the local plan. Your Hevy routines and sessions remain available.`));
    const actions = node('div', 'dialog-actions'); const remove = button('Delete program', async () => {
      remove.disabled = true;
      try { await api(`/api/programs/${encodeURIComponent(program.id)}`, { method: 'DELETE' }); closeDialog(); await refresh(); toast('Program deleted'); }
      catch (err) { toast('Could not delete program', err.message, 'error'); remove.disabled = false; }
    }, 'button primary');
    add(actions, button('Cancel', closeDialog), remove); content.append(actions); openDialog('Local training plan', 'Delete program?', content);
  }
}
