import { openMuscleCoverage } from './muscle-map.js';
import { markdownBlock, markdownPreview } from './markdown.js';

const PENDING_STATUSES = new Set(['draft', 'revision_requested']);

function statusLabel(status) {
  return String(status || 'draft').replaceAll('_', ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function dateLabel(value) {
  if (!value) return 'Unknown date';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function formatDateOnly(value) {
  if (!value) return 'No start date';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function pendingCount(proposals = []) {
  return proposals.filter(proposal => PENDING_STATUSES.has(proposal?.status)).length;
}

function countSummary(proposal) {
  const routines = Array.isArray(proposal?.routines) ? proposal.routines.length : 0;
  const programs = Array.isArray(proposal?.programs) ? proposal.programs.length : 0;
  const parts = [`${routines} ${routines === 1 ? 'routine' : 'routines'}`];
  if (programs) parts.push(`${programs} ${programs === 1 ? 'program' : 'programs'}`);
  return parts.join(' · ');
}

function text(node, value) {
  node.textContent = value == null ? '' : String(value);
  return node;
}

function add(parent, ...children) {
  for (const child of children.flat()) if (child) parent.append(child);
  return parent;
}

function button(node, label, handler, className = 'button secondary') {
  const element = node('button', className, label);
  element.type = 'button';
  element.addEventListener('click', handler);
  return element;
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

function statusBadge(node, proposal) {
  const badge = node('span', `program-badge status-${proposal.status || 'draft'}`, statusLabel(proposal.status));
  badge.setAttribute('role', 'status');
  return badge;
}

function renderProposalCard(ctx, proposal, openDetail) {
  const { node } = ctx;
  const card = node('article', 'proposal-card');
  const top = node('div', 'proposal-card-top');
  add(top, node('p', 'card-kicker', proposal.mode === 'revision' ? 'Revision' : 'AI draft'), statusBadge(node, proposal));
  const title = node('h2', '', proposal.title || 'Untitled AI draft');
  const meta = node('p', 'proposal-meta', `Revision ${proposal.revision ?? 1} · Updated ${dateLabel(proposal.updated_at || proposal.created_at)}`);
  const summary = node('p', 'proposal-summary', countSummary(proposal));
  const rationale = node('p', 'proposal-rationale', markdownPreview(proposal.rationale) || 'No rationale was provided.');
  rationale.title = rationale.textContent;
  const actions = node('div', 'card-actions');
  let opening = false;
  const reviewButton = button(node, proposal.status === 'draft' ? 'Review draft' : 'View status', async () => {
    if (opening) return;
    opening = true; reviewButton.disabled = true;
    try { await openDetail(proposal); } finally { opening = false; reviewButton.disabled = false; }
  }, 'button primary');
  actions.append(reviewButton);
  add(card, top, title, meta, summary, rationale, actions);
  return card;
}

function valueLabel(node, label, value) {
  const block = node('div', 'proposal-value');
  add(block, node('span', '', label), node('strong', '', value == null || value === '' ? '—' : value));
  return block;
}

function setText(set, unit = 'kg') {
  const range = set?.rep_range;
  const parts = [];
  if (range && typeof range === 'object') parts.push(`${range.start ?? '—'}–${range.end ?? '—'} reps`);
  else if (set?.reps != null) parts.push(`${set.reps} reps`);
  if (set?.weight_kg != null) {
    const weight = Number(set.weight_kg);
    const display = unit === 'lb' && Number.isFinite(weight) ? weight * 2.2046226218 : weight;
    parts.push(`${Number.isFinite(display) ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(display) : set.weight_kg} ${unit}`);
  }
  if (set?.duration_seconds != null) parts.push(`${set.duration_seconds} sec`);
  if (set?.distance_meters != null) parts.push(`${set.distance_meters} m`);
  if (set?.type && set.type !== 'normal') parts.push(set.type);
  return parts.join(' · ') || 'Target not specified';
}

function renderRoutine(node, routine, title = 'Proposed routine', showCoverage = null, unit = 'kg') {
  const section = node('section', 'proposal-routine');
  const heading = node('div', 'proposal-section-heading');
  add(heading, node('h3', '', routine?.title || title));
  if (showCoverage) heading.append(showCoverage);
  section.append(heading);
  if (routine?.notes) section.append(markdownBlock(routine.notes, 'exercise-note'));
  for (const exercise of routine?.exercises || []) {
    const exerciseBlock = node('div', 'proposal-exercise');
    add(exerciseBlock, node('strong', '', exercise.title || exercise.exercise_template_id || 'Untitled exercise'));
    if (exercise.notes) exerciseBlock.append(markdownBlock(exercise.notes, 'exercise-note'));
    if (exercise.rest_seconds != null) exerciseBlock.append(node('p', 'field-hint', `Rest: ${exercise.rest_seconds} seconds`));
    const list = node('ol');
    for (const set of exercise.sets || []) list.append(node('li', '', setText(set, unit)));
    if (list.children.length) exerciseBlock.append(list);
    section.append(exerciseBlock);
  }
  if (!(routine?.exercises || []).length) section.append(node('p', 'field-hint', 'No exercises in this routine.'));
  return section;
}

function renderRoutineChange(ctx, proposal, item, index) {
  const { state, node, add } = ctx;
  const wrap = node('section', 'proposal-change');
  const after = item?.after || {};
  const before = item?.before;
  const routineKey = item?.key || String(index);
  const coverage = button(node, 'Muscle coverage', () => openDraftCoverage(ctx, proposal, { routineKey }), 'button ghost');
  if (before) {
    const comparison = node('div', 'proposal-comparison');
    const beforeCol = node('div', 'proposal-comparison-column');
    const afterCol = node('div', 'proposal-comparison-column');
    add(beforeCol, node('p', 'card-kicker', 'Before'), renderRoutine(node, before, 'Previous routine', null, state.settings?.unit || 'kg'));
    add(afterCol, node('p', 'card-kicker', 'Proposed'), renderRoutine(node, after, 'Proposed routine', coverage, state.settings?.unit || 'kg'));
    add(comparison, beforeCol, afterCol); wrap.append(comparison);
  } else wrap.append(renderRoutine(node, after, 'Proposed routine', coverage, state.settings?.unit || 'kg'));
  return wrap;
}

function renderProgram(node, program, title = 'Proposed program', coverageButton = null, routineTitles = new Map()) {
  const section = node('section', 'proposal-program');
  const heading = node('div', 'proposal-section-heading');
  add(heading, node('h3', '', program?.title || title), coverageButton);
  const schedule = node('div', 'proposal-meta-grid');
  add(schedule, valueLabel(node, 'Starts', formatDateOnly(program?.start_date)), valueLabel(node, 'Duration', program?.duration_weeks ? `${program.duration_weeks} weeks` : 'Unscheduled'));
  section.append(heading);
  if (program?.description) section.append(markdownBlock(program.description, 'exercise-note'));
  section.append(schedule);
  const days = node('ol', 'proposal-days');
  for (const day of program?.days || []) {
    const routineTitle = day.routineTitle || routineTitles.get(day.routineKey) || routineTitles.get(day.routineId) || day.routineKey || day.routineId || 'Routine not specified';
    days.append(node('li', '', `${day.label || 'Training day'} · ${routineTitle}`));
  }
  if (days.children.length) section.append(days); else section.append(node('p', 'field-hint', 'No training days in this program.'));
  return section;
}

function renderProgramChange(ctx, proposal, item, index) {
  const { node, add } = ctx;
  const before = item?.before;
  const after = item?.after || {};
  const programKey = item?.key || String(index);
  const routineTitles = new Map((proposal.routines || []).map((routine, routineIndex) => [routine.key || String(routineIndex), routine.after?.title || routine.key || 'Untitled routine']));
  const coverage = button(node, 'Muscle coverage', () => openDraftCoverage(ctx, proposal, { programKey }), 'button ghost');
  const wrap = node('section', 'proposal-change');
  if (before) {
    const comparison = node('div', 'proposal-comparison');
    add(comparison,
      add(node('div', 'proposal-comparison-column'), node('p', 'card-kicker', 'Before'), renderProgram(node, before, 'Previous program', null, routineTitles)),
      add(node('div', 'proposal-comparison-column'), node('p', 'card-kicker', 'Proposed'), renderProgram(node, after, 'Proposed program', coverage, routineTitles)),
    );
    wrap.append(comparison);
  } else wrap.append(renderProgram(node, after, 'Proposed program', coverage, routineTitles));
  return wrap;
}

function renderHistory(ctx, history = []) {
  const { node, add } = ctx;
  if (!Array.isArray(history) || !history.length) return null;
  const section = node('section', 'proposal-history');
  add(section, node('h3', '', 'Review history'));
  const list = node('ol');
  for (const item of history) {
    const row = node('li');
    add(row, node('strong', '', `${statusLabel(item.action || item.status)} · revision ${item.revision ?? '—'}`), node('span', '', dateLabel(item.created_at || item.updated_at)));
    if (item.feedback) row.append(markdownBlock(item.feedback));
    list.append(row);
  }
  section.append(list); return section;
}

function detailContent(ctx, proposal, history, onRefresh) {
  const { node, add, api, toast, closeDialog } = ctx;
  const form = node('div', 'proposal-detail');
  const meta = node('div', 'detail-meta');
  add(meta, valueLabel(node, 'Status', statusLabel(proposal.status)), valueLabel(node, 'Revision', proposal.revision ?? 1), valueLabel(node, 'Updated', dateLabel(proposal.updated_at || proposal.created_at)));
  form.append(meta);
  if (proposal.rationale) {
    const rationale = node('section', 'proposal-rationale-block');
    add(rationale, node('h3', '', 'Why this draft'), markdownBlock(proposal.rationale));
    form.append(rationale);
  }
  for (const [index, item] of (proposal.routines || []).entries()) form.append(renderRoutineChange(ctx, proposal, item, index));
  for (const [index, item] of (proposal.programs || []).entries()) form.append(renderProgramChange(ctx, proposal, item, index));
  if (proposal.feedback) {
    const feedback = node('section', 'proposal-feedback');
    add(feedback, node('h3', '', 'Latest feedback'), markdownBlock(proposal.feedback));
    form.append(feedback);
  }
  const historySection = renderHistory(ctx, history);
  if (historySection) form.append(historySection);

  const actions = node('div', 'dialog-actions proposal-review-actions');
  if (proposal.status === 'draft') {
    const feedbackField = node('label', 'field proposal-feedback-field');
    const feedback = node('textarea', 'textarea');
    feedback.rows = 3; feedback.maxLength = 2000; feedback.placeholder = 'Tell the assistant what to change…'; feedback.id = 'proposal-feedback';
    add(feedbackField, node('span', '', 'Feedback for a revision (required for Request changes)'), feedback);
    const feedbackError = node('p', 'form-error'); feedbackError.setAttribute('role', 'alert');
    const request = button(node, 'Request changes', async () => review('request_revision', request), 'button secondary');
    const accept = button(node, 'Accept draft', async () => review('accept', accept), 'button primary');
    const decline = button(node, 'Decline', async () => review('decline', decline), 'button danger');
    form.append(feedbackField, feedbackError, actions);
    add(actions, decline, request, accept);
    async function review(action, sourceButton) {
      if (sourceButton.disabled) return;
      if (action === 'request_revision' && !feedback.value.trim()) { feedbackError.textContent = 'Add feedback before requesting changes.'; feedback.focus(); return; }
      feedbackError.textContent = '';
      [accept, request, decline].forEach(item => { item.disabled = true; });
      try {
        await api(`/api/proposals/${encodeURIComponent(proposal.id)}/review`, { method: 'POST', body: JSON.stringify({ action, expectedRevision: proposal.revision, ...(feedback.value.trim() ? { feedback: feedback.value.trim() } : {}) }) });
        closeDialog();
        await onRefresh();
        toast(action === 'accept' ? 'AI draft accepted' : action === 'decline' ? 'AI draft declined' : 'Revision request saved', action === 'request_revision' ? 'The feedback is saved. Ask the training assistant to prepare the next revision.' : 'The local proposal state is up to date.');
      } catch (error) {
        feedbackError.textContent = error.code === 'stale_revision' || error.code === 'revision_conflict' ? 'This draft changed elsewhere. Refresh and review the latest revision.' : error.message;
        [accept, request, decline].forEach(item => { item.disabled = false; });
      }
    }
  } else {
    const note = proposal.status === 'revision_requested'
      ? 'Feedback is saved and this draft is waiting for the training assistant to prepare a new revision.'
      : `This proposal is ${statusLabel(proposal.status).toLowerCase()} and is read-only.`;
    form.append(actions, node('p', 'field-hint', note));
  }
  return form;
}

async function openProposalDetail(ctx, proposal) {
  const { api, openDialog } = ctx;
  let record = proposal;
  try {
    const result = await api(`/api/proposals/${encodeURIComponent(proposal.id)}`);
    record = result.proposal || result.record || result;
  } catch (error) {
    ctx.toast('Could not load draft detail', error.message, 'error');
    return;
  }
  const history = record.history || [];
  openDialog('AI draft review', record.title || 'Untitled AI draft', detailContent(ctx, record, history, async () => { await ctx.refresh(); }));
}

function profileForm(ctx) {
  const { state, node, add, api, refresh, toast } = ctx;
  const profile = state.trainingProfile || {};
  const form = node('form', 'panel profile-form');
  form.dataset.dirty = 'false';
  const fields = {};
  for (const [key, label, hint] of [
    ['goals', 'Goals', 'What are you training toward?'],
    ['equipment', 'Equipment', 'What equipment is available?'],
    ['constraints', 'Constraints', 'Injuries, limits, preferences, or exclusions.'],
    ['schedule', 'Schedule', 'Days, session length, or timing preferences.'],
  ]) {
    const field = node('label', 'field'); const input = node('textarea', 'textarea'); input.rows = 2; input.maxLength = 2000; input.value = profile[key] || ''; input.placeholder = hint; input.id = `training-profile-${key}`;
    input.addEventListener('input', () => { form.dataset.dirty = 'true'; });
    add(field, node('span', '', label), input); add(form, field); fields[key] = input;
  }
  const status = node('p', 'form-error'); status.setAttribute('role', 'alert');
  const save = node('button', 'button primary', 'Save training profile'); save.type = 'submit';
  add(form, status, save);
  form.addEventListener('submit', async event => {
    event.preventDefault(); status.textContent = ''; save.disabled = true;
    try { await api('/api/training-profile', { method: 'POST', body: JSON.stringify(Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value.trim()]))) }); await refresh(); toast('Training profile saved', 'The assistant will use this context for future drafts.'); }
    catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  return form;
}

export function renderProposals(ctx) {
  const { state, node, add, refresh } = ctx;
  const proposals = Array.isArray(state.proposals) ? state.proposals : [];
  const view = node('section', 'view section-page proposals-view');
  const refreshButton = button(node, 'Refresh drafts', async () => {
    if (refreshButton.disabled) return;
    refreshButton.disabled = true;
    try { await refresh(); ctx.toast('Drafts refreshed', 'Proposal status is up to date.'); }
    catch (error) { ctx.toast('Could not refresh drafts', error.message, 'error'); }
    finally { refreshButton.disabled = false; }
  }, 'button secondary');
  add(view, add(node('header', 'view-header'), add(node('div', 'view-heading'), node('p', 'eyebrow', 'Training assistant workspace'), node('h1', '', 'AI drafts'), node('p', '', 'Review proposed routines and programs before anything is added to your local training archive.')), refreshButton));
  const note = node('div', 'ai-workspace-note');
  add(note, node('strong', '', 'Run the training assistant in a second terminal.'), node('p', '', 'From the Corpus folder, run npm run assistant:codex or npm run assistant:claude. This opens a training session separate from developing Corpus. Review its proposals below.'), node('p', 'field-hint', 'Training data requested by the assistant is sent to your chosen AI provider.'));
  view.append(note);
  const profilePanel = node('section', 'panel profile-panel');
  add(profilePanel, add(node('header', 'panel-header'), add(node('div'), node('h2', '', 'Training profile'), node('p', '', 'Goals, equipment, constraints, and schedule for future drafts.'))), profileForm(ctx));
  view.append(profilePanel);
  const heading = node('header', 'panel-header proposals-heading');
  add(heading, add(node('div'), node('h2', '', `${proposals.length} ${proposals.length === 1 ? 'draft' : 'drafts'}`), node('p', '', `${pendingCount(proposals)} awaiting review`)));
  view.append(heading);
  const grid = node('div', 'proposal-grid');
  const sorted = [...proposals].sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
  if (!sorted.length) grid.append(add(node('div', 'panel'), node('h2', '', 'No AI drafts yet'), node('p', '', 'Run the training assistant from the repository terminal to create a reviewable proposal.')));
  else sorted.forEach(proposal => grid.append(renderProposalCard(ctx, proposal, item => openProposalDetail(ctx, item))));
  view.append(grid);
  return view;
}

export { pendingCount };
