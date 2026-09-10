import { openMuscleCoverage } from './muscle-map.js';
import { markdownBlock, markdownPreview } from './markdown.js';

// "Draft" is the user-facing noun (D23); `proposal` stays the API/code term.
const PENDING_STATUSES = new Set(['draft', 'revision_requested']);

const PROFILE_FIELDS = [
  ['goals', 'Goals', 'What are you training toward?'],
  ['equipment', 'Equipment', 'What equipment is available?'],
  ['constraints', 'Constraints', 'Injuries, limits, preferences, or exclusions.'],
  ['schedule', 'Schedule', 'Days, session length, or timing preferences.'],
];

const REVIEW_TOASTS = {
  accept: ['Draft accepted', 'Its routines and programs are now in your local training archive.'],
  decline: ['Draft declined', 'Nothing was added to your local training archive.'],
  request_revision: ['Revision requested', 'Your feedback is saved for the assistant’s next revision.'],
};

function statusLabel(status) {
  return String(status || 'draft').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function pendingCount(proposals = []) {
  return proposals.filter(proposal => PENDING_STATUSES.has(proposal?.status)).length;
}

function countSummary(proposal, format) {
  const routines = Array.isArray(proposal?.routines) ? proposal.routines.length : 0;
  const programs = Array.isArray(proposal?.programs) ? proposal.programs.length : 0;
  const parts = [format.plural(routines, 'routine')];
  if (programs) parts.push(format.plural(programs, 'program'));
  return parts.join(' · ');
}

function copyObject(value) {
  if (!value || typeof value !== 'object') return value;
  return Array.isArray(value) ? value.map(copyObject) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyObject(item)]));
}

function draftRoutines(proposal) {
  return (Array.isArray(proposal?.routines) ? proposal.routines : []).map((item, index) => {
    const after = item?.after || {};
    return {
      id: `proposal:${proposal.id}:routine:${item.key || index}`,
      title: after.title || item.key || 'Untitled draft routine',
      notes: after.notes ?? null,
      exercises: (Array.isArray(after.exercises) ? after.exercises : []).map(exercise => ({
        ...copyObject(exercise),
        exercise_template_id: exercise.exercise_template_id || exercise.id || '',
      })),
      source: 'local',
      proposalId: proposal.id,
      proposalKey: item.key,
    };
  });
}

/**
 * Open the existing coverage dialog for a draft. The temporary IDs are needed
 * because draft programs refer to routines by proposal key rather than local ID.
 */
export function openDraftCoverage(ctx, proposal, { routineKey, programKey } = {}) {
  const originalState = ctx.state;
  const routines = draftRoutines(proposal);
  const routineByKey = new Map((proposal.routines || []).map((item, index) => [item.key || String(index), routines[index]]));
  const routineByTargetId = new Map((proposal.routines || []).map((item, index) => [item.targetId, routines[index]]).filter(([key]) => key));
  const routine = routineKey ? routineByKey.get(routineKey) : null;
  const sourceProgram = (proposal.programs || []).find((item, index) => (item.key || String(index)) === programKey);
  const program = sourceProgram ? {
    ...(sourceProgram.after || {}),
    id: `proposal:${proposal.id}:program:${sourceProgram.key || programKey}`,
    days: (sourceProgram.after?.days || []).map((day, index) => ({
      ...day,
      label: day.label || `Day ${index + 1}`,
      routineId: routineByKey.get(day.routineKey)?.id || routineByKey.get(day.routineId)?.id || routineByTargetId.get(day.routineId)?.id || day.routineId || '',
    })),
  } : null;
  ctx.state = { ...originalState, routines: [...(originalState.routines || []), ...routines] };
  try {
    openMuscleCoverage(ctx, program ? { program } : { routine });
  } finally {
    ctx.state = originalState;
  }
}

/* --------------------------------------------------------------- draft list */

function statusPill(ctx, proposal) {
  return ctx.node('span', `pill status-${proposal.status || 'draft'}`, statusLabel(proposal.status));
}

function renderProposalCard(ctx, proposal, openDetail) {
  const { node, add, button, format, setBusy } = ctx;
  const card = node('article', 'card proposal-card');
  const top = add(node('div', 'proposal-card-top'),
    node('p', 'label-caps', (proposal.revision ?? 1) > 1 ? 'Revision' : 'AI draft'),
    statusPill(ctx, proposal));
  const updated = format.dateLabel(proposal.updated_at || proposal.created_at, { dateStyle: 'medium' });
  const meta = node('p', 'card-meta', `Revision ${proposal.revision ?? 1} · Updated ${updated} · ${countSummary(proposal, format)}`);
  const rationale = node('p', 'note proposal-rationale', markdownPreview(proposal.rationale) || 'No rationale was provided.');
  rationale.title = rationale.textContent;
  const review = button(proposal.status === 'draft' ? 'Review draft' : 'View status', {
    variant: 'primary',
    size: 'sm',
    onClick: async () => {
      if (review.disabled) return;
      setBusy(review, true);
      try { await openDetail(proposal); } finally { setBusy(review, false); }
    },
  });
  return add(card, top, node('h3', 'card-title', proposal.title || 'Untitled AI draft'), meta, rationale, add(node('div', 'card-actions'), review));
}

/* ------------------------------------------------------------ review dialog */

function valueLabel(ctx, label, value) {
  const { node, add, format } = ctx;
  return add(node('div', 'proposal-value'), node('span', '', label), node('strong', '', value == null || value === '' ? format.MISSING : value));
}

function renderRoutine(ctx, routine, title, coverageButton = null) {
  const { node, add, state, format } = ctx;
  const unit = state.settings?.unit || 'kg';
  const section = node('section', 'proposal-routine');
  const heading = add(node('div', 'proposal-section-heading'), node('h3', '', routine?.title || title), coverageButton);
  section.append(heading);
  if (routine?.notes) section.append(markdownBlock(routine.notes, 'exercise-note'));
  for (const exercise of routine?.exercises || []) {
    const block = node('div', 'proposal-exercise');
    add(block, node('strong', '', exercise.title || exercise.exercise_template_id || 'Untitled exercise'));
    if (exercise.notes) block.append(markdownBlock(exercise.notes, 'exercise-note'));
    if (exercise.rest_seconds != null) block.append(node('p', 'note', `Rest · ${format.formatSeconds(exercise.rest_seconds)}`));
    const list = node('ol');
    for (const set of exercise.sets || []) list.append(node('li', '', format.formatSet(set, unit)));
    if (list.children.length) block.append(list);
    section.append(block);
  }
  if (!(routine?.exercises || []).length) section.append(node('p', 'note', 'No exercises in this routine.'));
  return section;
}

function renderRoutineChange(ctx, proposal, item, index) {
  const { node, add, button } = ctx;
  const wrap = node('section', 'proposal-change');
  const after = item?.after || {};
  const before = item?.before;
  const routineKey = item?.key || String(index);
  const coverage = button('Muscle coverage', { size: 'sm', onClick: () => openDraftCoverage(ctx, proposal, { routineKey }) });
  if (before) {
    const beforeCol = add(node('div', 'proposal-comparison-column'), node('p', 'label-caps', 'Before'), renderRoutine(ctx, before, 'Previous routine'));
    const afterCol = add(node('div', 'proposal-comparison-column'), node('p', 'label-caps', 'Proposed'), renderRoutine(ctx, after, 'Proposed routine', coverage));
    wrap.append(add(node('div', 'proposal-comparison'), beforeCol, afterCol));
  } else wrap.append(renderRoutine(ctx, after, 'Proposed routine', coverage));
  return wrap;
}

function renderProgram(ctx, program, title, coverageButton = null, routineTitles = new Map()) {
  const { node, add, format } = ctx;
  const section = node('section', 'proposal-program');
  const heading = add(node('div', 'proposal-section-heading'), node('h3', '', program?.title || title), coverageButton);
  const starts = program?.start_date ? format.formatDay(program.start_date, { dateStyle: 'medium' }) : format.NOT_SET;
  const duration = program?.duration_weeks ? format.plural(program.duration_weeks, 'week') : format.NOT_SET;
  const schedule = add(node('div', 'proposal-meta-grid'), valueLabel(ctx, 'Starts', starts), valueLabel(ctx, 'Duration', duration));
  section.append(heading);
  if (program?.description) section.append(markdownBlock(program.description, 'exercise-note'));
  section.append(schedule);
  const days = node('ol', 'proposal-days');
  for (const day of program?.days || []) {
    const routineTitle = day.routineTitle || routineTitles.get(day.routineKey) || routineTitles.get(day.routineId) || format.MISSING_ROUTINE;
    days.append(node('li', '', `${day.label || 'Training day'} · ${routineTitle}`));
  }
  section.append(days.children.length ? days : node('p', 'note', 'No training days in this program.'));
  return section;
}

function renderProgramChange(ctx, proposal, item, index) {
  const { node, add, button } = ctx;
  const before = item?.before;
  const after = item?.after || {};
  const programKey = item?.key || String(index);
  const routineTitles = new Map((proposal.routines || []).map((routine, routineIndex) => [routine.key || String(routineIndex), routine.after?.title || routine.key || 'Untitled routine']));
  const coverage = button('Muscle coverage', { size: 'sm', onClick: () => openDraftCoverage(ctx, proposal, { programKey }) });
  const wrap = node('section', 'proposal-change');
  if (before) {
    wrap.append(add(node('div', 'proposal-comparison'),
      add(node('div', 'proposal-comparison-column'), node('p', 'label-caps', 'Before'), renderProgram(ctx, before, 'Previous program', null, routineTitles)),
      add(node('div', 'proposal-comparison-column'), node('p', 'label-caps', 'Proposed'), renderProgram(ctx, after, 'Proposed program', coverage, routineTitles)),
    ));
  } else wrap.append(renderProgram(ctx, after, 'Proposed program', coverage, routineTitles));
  return wrap;
}

function renderHistory(ctx, history = []) {
  const { node, add, format } = ctx;
  if (!Array.isArray(history) || !history.length) return null;
  const section = add(node('section', 'proposal-history'), node('h3', '', 'Review history'));
  const list = node('ol');
  for (const item of history) {
    const row = node('li');
    add(row,
      node('strong', '', `${statusLabel(item.action || item.status)} · revision ${item.revision ?? format.MISSING}`),
      node('span', '', format.dateLabel(item.created_at || item.updated_at, { dateStyle: 'medium' })));
    if (item.feedback) row.append(markdownBlock(item.feedback));
    list.append(row);
  }
  return add(section, list);
}

function detailContent(ctx, proposal, history, onRefresh) {
  const { node, add, api, toast, closeDialog, button, field, format, setBusy } = ctx;
  const content = node('div', 'dialog-stack');
  const meta = add(node('div', 'detail-meta'),
    valueLabel(ctx, 'Status', statusLabel(proposal.status)),
    valueLabel(ctx, 'Revision', proposal.revision ?? 1),
    valueLabel(ctx, 'Updated', format.dateLabel(proposal.updated_at || proposal.created_at, { dateStyle: 'medium' })));
  content.append(meta);
  if (proposal.rationale) {
    content.append(add(node('section', 'proposal-rationale-block'), node('h3', '', 'Why this draft'), markdownBlock(proposal.rationale)));
  }
  for (const [index, item] of (proposal.routines || []).entries()) content.append(renderRoutineChange(ctx, proposal, item, index));
  for (const [index, item] of (proposal.programs || []).entries()) content.append(renderProgramChange(ctx, proposal, item, index));
  if (proposal.feedback) {
    content.append(add(node('section', 'proposal-feedback'), node('h3', '', 'Latest feedback'), markdownBlock(proposal.feedback)));
  }
  const historySection = renderHistory(ctx, history);
  if (historySection) content.append(historySection);

  const close = button('Close', { onClick: () => closeDialog() });
  if (proposal.status !== 'draft') {
    const note = proposal.status === 'revision_requested'
      ? 'Feedback is saved and this draft is waiting for the training assistant to prepare a new revision.'
      : `This draft is ${statusLabel(proposal.status).toLowerCase()} and is read-only.`;
    return add(content, node('p', 'note', note), add(node('div', 'dialog-actions'), close));
  }

  const feedbackField = field('Feedback for a revision', { tag: 'textarea', rows: 3, maxLength: 2000, placeholder: 'Tell the assistant what to change…', hint: 'Required for Request changes.' });
  const feedback = feedbackField.control;
  const error = node('p', 'form-error');
  error.setAttribute('role', 'alert');
  const decline = button('Decline', { onClick: () => review('decline', decline) });
  const request = button('Request changes', { onClick: () => review('request_revision', request) });
  const accept = button('Accept draft', { variant: 'primary', onClick: () => review('accept', accept) });

  async function review(action, source) {
    if (source.disabled) return;
    if (action === 'request_revision' && !feedback.value.trim()) {
      error.textContent = 'Add feedback before requesting changes.';
      feedback.focus();
      return;
    }
    error.textContent = '';
    [accept, request, decline].forEach(item => { item.disabled = true; });
    setBusy(source, true);
    try {
      await api(`/api/proposals/${encodeURIComponent(proposal.id)}/review`, {
        method: 'POST',
        body: JSON.stringify({ action, expectedRevision: proposal.revision, ...(feedback.value.trim() ? { feedback: feedback.value.trim() } : {}) }),
      });
      closeDialog();
      await onRefresh();
      toast(...REVIEW_TOASTS[action]);
    } catch (err) {
      error.textContent = err.code === 'stale_revision' || err.code === 'revision_conflict'
        ? 'This draft changed elsewhere. Refresh and review the latest revision.'
        : err.message;
      setBusy(source, false);
      [accept, request, decline].forEach(item => { item.disabled = false; });
    }
  }

  return add(content, feedbackField, error, add(node('div', 'dialog-actions'), close, decline, request, accept));
}

async function openProposalDetail(ctx, proposal) {
  const { api, openDialog, toast } = ctx;
  let record = proposal;
  try {
    const result = await api(`/api/proposals/${encodeURIComponent(proposal.id)}`);
    record = result.proposal || result.record || result;
  } catch (error) {
    toast('Couldn’t review draft', error.message, 'error');
    return;
  }
  openDialog('AI draft', record.title || 'Untitled AI draft', detailContent(ctx, record, record.history || [], async () => { await ctx.refresh(); }));
}

/* ---------------------------------------------------------- training profile */

function profilePanel(ctx) {
  const { state, node, add, api, refresh, toast, field, button, panelHeader, setBusy } = ctx;
  const profile = state.trainingProfile || {};
  const form = node('form', 'profile-form');
  // The poller in app.js skips a re-render while this form has unsaved edits.
  form.dataset.dirty = 'false';
  const controls = {};
  for (const [key, label, placeholder] of PROFILE_FIELDS) {
    const wrapper = field(label, { tag: 'textarea', placeholder, maxLength: 2000, rows: 2, value: profile[key] || '' });
    wrapper.control.addEventListener('input', () => { form.dataset.dirty = 'true'; });
    controls[key] = wrapper.control;
    form.append(wrapper);
  }
  const error = node('p', 'form-error');
  error.setAttribute('role', 'alert');
  const save = button('Save training profile', { variant: 'primary', type: 'submit' });
  add(form, error, add(node('div', 'form-row'), save));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    setBusy(save, true);
    try {
      await api('/api/training-profile', { method: 'POST', body: JSON.stringify(Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, control.value.trim()]))) });
      form.dataset.dirty = 'false';
      await refresh();
      toast('Training profile saved', 'The assistant will use this context for future drafts.');
    } catch (err) {
      error.textContent = err.message;
    } finally {
      setBusy(save, false);
    }
  });
  const panel = node('section', 'panel profile-panel');
  return add(panel, panelHeader('Training profile', 'Goals, equipment, constraints, and schedule for future drafts.'), form);
}

/* ----------------------------------------------------------------- the view */

function assistantNotice(ctx) {
  const { node, add } = ctx;
  const body = add(node('div', 'notice-body'),
    node('strong', '', 'Run the training assistant in a second terminal.'),
    node('p', '', 'From the Corpus folder, run npm run assistant:codex or npm run assistant:claude. This opens a training session separate from developing Corpus. Review its drafts below.'),
    node('p', 'note', 'Training data requested by the assistant is sent to your chosen AI provider.'));
  return add(node('div', 'notice notice--info assistant-notice'), body);
}

export function renderProposals(ctx) {
  const { state, node, add, refresh, button, heading, sectionHeading, emptyState, toast, format, setBusy } = ctx;
  const proposals = Array.isArray(state.proposals) ? state.proposals : [];
  const view = node('section', 'view proposals-view');
  const refreshButton = button('Refresh', {
    icon: '↻',
    onClick: async () => {
      if (refreshButton.disabled) return;
      setBusy(refreshButton, true);
      try { await refresh(); }
      catch (error) { toast('Couldn’t refresh drafts', error.message, 'error'); }
      finally { setBusy(refreshButton, false); }
    },
  });
  add(view,
    heading('Workout', 'AI drafts', 'Review proposed routines and programs before anything is added to your local training archive.', refreshButton),
    assistantNotice(ctx),
    profilePanel(ctx),
    sectionHeading(format.plural(proposals.length, 'draft'), `${pendingCount(proposals)} awaiting review`));
  const sorted = [...proposals].sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  if (!sorted.length) {
    view.append(emptyState({
      title: 'No AI drafts yet',
      copy: 'Run the training assistant from the repository terminal to create a reviewable draft.',
      icon: '✎',
    }));
    return view;
  }
  const grid = node('div', 'card-grid');
  sorted.forEach(proposal => grid.append(renderProposalCard(ctx, proposal, item => openProposalDetail(ctx, item))));
  view.append(grid);
  return view;
}

export { pendingCount };
