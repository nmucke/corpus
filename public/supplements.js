// Supplements: the Stack (#supplements) and the dose History
// (#supplements-history), plus the read dialog and the editor form.
//
// The supplement list rides on `/api/state`, so only the doses are fetched:
// the widest window is read once per data mode and cached (the same shape and
// timing as metrics-workouts.js), then sliced client side by the range picker.
// After every write the module invalidates that cache and calls `refresh()`,
// which re-renders the view from fresh state.
//
// Scheduled doses are assumed taken: the list already holds one row per slot
// and per logged session, so every view removes doses rather than adding them.
// "Didn't take" writes a `0` override for that slot or session, "Undo" deletes
// the override, and only `as_needed` supplements are logged by hand.

import { DOSE_UNITS, FREQUENCY_KINDS, SUPPLEMENT_TYPES, WEEKDAYS } from './supplements-catalog.js';
import { loadBody, markPeriod, panel } from './metrics.js';
import { markdownBlock } from './markdown.js';
import {
  addDays,
  adherence,
  doseCalendar,
  doseDate,
  dosesInRange,
  dosesPerPackage,
  dueToday,
  expectedOnDay,
  formatDose,
  groupByDate,
  isActiveOn,
  isCounted,
  isDerived,
  isSkipped,
  packageDays,
  slotKey,
  takenToday,
  todayKey,
} from './supplements-analytics.js';

/** The widest window the server will serve, and what `All` means here. */
const MAX_FETCH_DAYS = 730;
/** The strip on a card is always the last 30 days, whatever the range picker says. */
const CALENDAR_DAYS = 30;
/** Newest-first rows in the History table, and one press of "Show more". */
const TABLE_ROWS = 60;
/** Doses listed in the read dialog. */
const RECENT_DOSES = 10;

let cache = { key: null, data: null };
let inflight = null;
/** Bumped by every invalidation, so a reply already in flight cannot re-fill a
 *  cache that a write has just made stale. */
let generation = 0;

function cacheKey(ctx) { return ctx.state?.mode || 'demo'; }

function cachedDoses(ctx) { return cache.key === cacheKey(ctx) ? cache.data : null; }

export function invalidateSupplementDoses() {
  generation += 1;
  cache = { key: null, data: null };
  inflight = null;
}

function normalize(data) {
  return { ...data, doses: Array.isArray(data?.doses) ? data.doses : [], range: data?.range || {} };
}

/** Fetches the widest window once per data mode, de-duplicating concurrent calls. */
function loadDoses(ctx) {
  const key = cacheKey(ctx);
  const ready = cachedDoses(ctx);
  if (ready) return Promise.resolve(ready);
  if (!inflight || inflight.key !== key) {
    const era = generation;
    const promise = ctx.api(`/api/supplements/doses?days=${MAX_FETCH_DAYS}`)
      .then((data) => {
        const fresh = normalize(data);
        if (era === generation) cache = { key, data: fresh };
        return fresh;
      })
      .finally(() => { if (inflight?.promise === promise) inflight = null; });
    inflight = { key, promise };
  }
  return inflight.promise;
}

/* ------------------------------------------------------------------ reading */

function stack(ctx) { return Array.isArray(ctx.state?.supplements) ? ctx.state.supplements : []; }
function sessions(ctx) { return Array.isArray(ctx.state?.workouts) ? ctx.state.workouts : []; }

function typeLabel(key) { return SUPPLEMENT_TYPES.find((item) => item.key === key)?.label || 'Other'; }
function unitEntry(key) { return DOSE_UNITS.find((item) => item.key === key); }
function kindOf(supplement) { return supplement?.frequency?.kind || 'daily'; }

/** The server's label wins so cards, dialogs and the export agree. */
function frequencyText(supplement) {
  return supplement?.frequency_label || FREQUENCY_KINDS.find((item) => item.key === kindOf(supplement))?.label || '';
}

const PILL_TONE = { active: 'pill--positive', upcoming: 'pill--info', ended: 'pill--neutral' };

function statusPill(ctx, supplement) {
  return ctx.node('span', `pill ${PILL_TONE[supplement.status] || 'pill--neutral'}`, ctx.titleCase(supplement.status || 'active'));
}

/** Derived rows are computed from the schedule and can only be skipped, not deleted. */
function stored(dose) { return Boolean(dose?.id) && !isDerived(dose); }

/** A skipped row shows the dose that was not taken, not its `0` amount. */
function doseAmount(dose, supplement) {
  if (isSkipped(dose)) return formatDose(supplement?.dose_amount, supplement?.dose_unit);
  return formatDose(dose?.amount, dose?.unit || supplement?.dose_unit);
}

function amountText(ctx, dose, supplement) {
  return ctx.node('span', isSkipped(dose) ? 'dose-amount is-skipped' : 'dose-amount', doseAmount(dose, supplement));
}

function sourceText(dose) {
  if (isSkipped(dose)) return 'Skipped';
  if (dose?.workout_id) return `With ${dose.workout_title || 'workout'}`;
  if (dose?.slot || dose?.source === 'schedule') return 'Scheduled';
  return 'Manual';
}

/** Today's sessions, oldest first, so a two-a-day reads in the order it happened. */
function sessionsToday(ctx, today) {
  return sessions(ctx)
    .filter((workout) => localDay(workout?.start_time) === today)
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
}

function localDay(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : todayKey(date);
}

/* ------------------------------------------------------------------- writing */

/**
 * One write path: busy on the pressed control, invalidate, refresh (which
 * re-renders), then one outcome toast. On failure the control comes back.
 */
async function write(ctx, control, { run, title, message = '', errorTitle }) {
  ctx.setBusy(control, true);
  try {
    await run();
    invalidateSupplementDoses();
    await ctx.refresh();
    ctx.toast(title, message);
  } catch (error) {
    ctx.toast(errorTitle, error.message || 'Please try again.', 'error');
    if (control?.isConnected) ctx.setBusy(control, false);
  }
}

function logDose(ctx, supplement, body = {}) {
  return ctx.api(`/api/supplements/${encodeURIComponent(supplement.id)}/doses`, { method: 'POST', body: JSON.stringify(body) });
}

function removeDose(ctx, id) {
  return ctx.api(`/api/supplements/doses/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/** Skipping a scheduled dose is a `0` override for its own slot or session. */
function skipBody(dose) {
  if (dose?.slot) return { slot: dose.slot, amount: 0 };
  if (dose?.workout_id) return { workout_id: dose.workout_id, amount: 0 };
  return null;
}

/**
 * The one action a dose row offers, wherever it is shown: **Undo** restores a
 * skipped dose, **Didn't take** writes the `0` override for a scheduled one
 * (this is the retroactive removal in History), **Remove** deletes a manual
 * one. Null when the row offers nothing, which only a derived row without a
 * slot or a session can be.
 */
function doseActionSpec(ctx, dose, supplement, when = ctx.format.formatDay(doseDate(dose))) {
  const where = `${supplement?.name || 'Supplement'} · ${when}`;
  if (isSkipped(dose)) {
    if (!stored(dose)) return null;
    return {
      label: 'Undo',
      hint: 'Count this dose again',
      run: () => removeDose(ctx, dose.id),
      title: 'Dose restored',
      message: where,
      errorTitle: 'Couldn’t restore dose',
    };
  }
  const body = skipBody(dose);
  if (body) {
    return {
      label: 'Didn’t take',
      variant: 'ghost',
      hint: 'Take this dose out of the log',
      run: () => logDose(ctx, supplement, body),
      title: 'Dose skipped',
      message: where,
      errorTitle: 'Couldn’t skip dose',
    };
  }
  if (!stored(dose)) return null;
  return {
    label: 'Remove',
    variant: 'ghost',
    hint: 'Remove this dose',
    run: () => removeDose(ctx, dose.id),
    title: 'Dose removed',
    message: where,
    errorTitle: 'Couldn’t remove dose',
  };
}

/** The row action on a page: busy on the pressed control, then a refresh. */
function doseActionButton(ctx, dose, supplement, when) {
  const spec = doseActionSpec(ctx, dose, supplement, when);
  if (!spec) return null;
  const control = ctx.button(spec.label, {
    variant: spec.variant || 'secondary',
    size: 'sm',
    title: spec.hint,
    onClick: () => write(ctx, control, spec),
  });
  return control;
}

/** The same action inside the read dialog: it closes first and reports inline. */
function dialogDoseButton(ctx, dose, supplement, error) {
  const spec = doseActionSpec(ctx, dose, supplement);
  if (!spec) return null;
  const control = ctx.button(spec.label, {
    variant: spec.variant || 'secondary',
    size: 'sm',
    title: spec.hint,
    onClick: async () => {
      error.textContent = '';
      ctx.setBusy(control, true);
      try {
        await spec.run();
        ctx.closeDialog();
        invalidateSupplementDoses();
        await ctx.refresh();
        ctx.toast(spec.title, spec.message);
      } catch (failure) {
        error.textContent = failure.message;
        ctx.setBusy(control, false);
      }
    },
  });
  return control;
}

function saveSupplement(ctx, body) {
  return ctx.api('/api/supplements', { method: 'POST', body: JSON.stringify(body) });
}

/** The full row again with one field changed: the route is a create-or-update. */
function supplementBody(supplement, changes = {}) {
  return {
    id: supplement.id,
    name: supplement.name,
    brand: supplement.brand || '',
    type: supplement.type,
    dose_amount: supplement.dose_amount,
    dose_unit: supplement.dose_unit,
    frequency: supplement.frequency,
    timing: supplement.timing || '',
    start_date: supplement.start_date,
    end_date: supplement.end_date ?? null,
    purchase_url: supplement.purchase_url ?? null,
    package_size: supplement.package_size ?? null,
    ingredients: supplement.ingredients || '',
    notes: supplement.notes || '',
    ...changes,
  };
}

/* ------------------------------------------------------------------- pieces */

/** A safe external link: only explicit web destinations ever become an href. */
function buyLink(ctx, url, text = 'Buy') {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  const link = ctx.node('a', 'text-button', text);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

/** One cell per day: filled when taken, outlined when missed, blank otherwise. */
function calendarStrip(ctx, supplement, doses, { from, to, wide = false }) {
  const { node } = ctx;
  const { formatDay, plural } = ctx.format;
  const strip = node('div', `dose-calendar${wide ? ' dose-calendar--wide' : ''}`);
  strip.setAttribute('role', 'list');
  strip.setAttribute('aria-label', `Doses from ${formatDay(from)} to ${formatDay(to)}`);
  for (const cell of doseCalendar(supplement, doses, { from, to, workouts: sessions(ctx) })) {
    const state = cell.taken > 0 ? ' is-taken' : cell.expected > 0 ? ' is-missed' : '';
    const item = node('span', `dose-cell${state}`);
    item.setAttribute('role', 'listitem');
    const reading = cell.taken > 0 ? plural(cell.taken, 'dose') : cell.expected > 0 ? 'Missed' : 'Nothing expected';
    item.title = `${formatDay(cell.date)} · ${reading}`;
    item.setAttribute('aria-label', item.title);
    strip.append(item);
  }
  return strip;
}

/** `87% · 26 of 30 doses`, or a plain count where nothing is expected. */
function adherenceText(ctx, supplement, usage) {
  const { formatNumber, plural, MISSING } = ctx.format;
  if (kindOf(supplement) === 'as_needed' || usage.ratio == null) return plural(usage.taken, 'dose');
  const percent = Number.isFinite(usage.ratio) ? `${formatNumber(Math.min(usage.ratio, 1) * 100)}%` : MISSING;
  return `${percent} · ${usage.taken} of ${usage.expected} doses`;
}

/* ---------------------------------------------------------------- the today panel */

function todayRow(ctx, { title, meta, status, control, chips = null, state = '' }) {
  const { node, add } = ctx;
  const row = node('div', `today-row${state ? ` ${state}` : ''}`);
  const main = node('div', 'today-row-main');
  add(main, node('strong', '', title), node('p', 'note', meta));
  const side = node('div', 'today-row-actions');
  add(side, status ? node('span', 'today-status', status) : null, [].concat(control || []));
  return add(row, main, side, chips);
}

/** The dose the schedule implies for one slot, when no row has come back yet. */
function derivedSlotDose(supplement, date, index) {
  return {
    id: `slot:${supplement.id}:${date}:${index}`,
    supplement_id: supplement.id,
    date,
    taken_at: `${date}T00:00:00`,
    amount: supplement.dose_amount,
    slot: slotKey(date, index),
    source: 'schedule',
    skipped: false,
  };
}

/** The dose one logged session implies, when no row has come back yet. */
function derivedWorkoutDose(supplement, workout, date) {
  return {
    id: `workout:${supplement.id}:${workout.id}`,
    supplement_id: supplement.id,
    date,
    taken_at: workout.end_time || workout.start_time,
    amount: supplement.dose_amount,
    workout_id: workout.id,
    workout_title: workout.title,
    source: 'workout',
    skipped: false,
  };
}

/** Today's rows for one supplement, keyed by slot, derived rows included. */
function slotsToday(supplement, doses, today) {
  const expected = Math.max(1, expectedOnDay(supplement, today, 0));
  const rows = new Map();
  for (const dose of doses) {
    if (dose.supplement_id === supplement.id && dose.slot) rows.set(dose.slot, dose);
  }
  return Array.from({ length: expected }, (_, index) => {
    const dose = rows.get(slotKey(today, index)) || derivedSlotDose(supplement, today, index);
    return { index, dose, skipped: isSkipped(dose) };
  });
}

const TAKEN = 'Taken ✓';

/** One chip per slot when a supplement is taken more than once a day. */
function doseChip(ctx, supplement, slot) {
  const { node, add } = ctx;
  // The base chip already reads as taken; only a removed dose changes its look.
  const chip = node('div', `dose-chip${slot.skipped ? ' is-skipped' : ''}`);
  return add(chip,
    node('span', 'dose-chip-label', `Dose ${slot.index + 1} · ${slot.skipped ? 'Skipped' : TAKEN}`),
    doseActionButton(ctx, slot.dose, supplement, 'today'));
}

/** `daily` and `weekly`: the schedule logged the dose, so the row removes it. */
function scheduledRow(ctx, supplement, doses, today) {
  const { node, add } = ctx;
  const slots = slotsToday(supplement, doses, today);
  const expected = slots.length;
  const taken = slots.filter((slot) => !slot.skipped).length;
  const state = taken === expected ? 'is-taken' : taken === 0 ? 'is-skipped' : '';
  const many = expected > 1;
  const chips = many ? add(node('div', 'dose-chips'), slots.map((slot) => doseChip(ctx, supplement, slot))) : null;
  return {
    expected,
    taken,
    element: todayRow(ctx, {
      title: supplement.name,
      meta: rowMeta(ctx, supplement),
      status: many ? `${taken} of ${expected} taken` : slots[0].skipped ? 'Skipped' : TAKEN,
      control: many ? null : doseActionButton(ctx, slots[0].dose, supplement, 'today'),
      chips,
      state,
    }),
  };
}

/** `workout`: the session logged the dose; the row removes that one session. */
function workoutRow(ctx, supplement, doses, workout, today) {
  const { dateLabel } = ctx.format;
  const dose = doses.find((item) => item.supplement_id === supplement.id && item.workout_id === workout.id)
    || derivedWorkoutDose(supplement, workout, today);
  const missed = isSkipped(dose);
  const title = workout.title || 'Untitled workout';
  const time = dateLabel(dose.taken_at || workout.end_time || workout.start_time, { timeStyle: 'short' });
  return {
    expected: 1,
    taken: missed ? 0 : 1,
    element: todayRow(ctx, {
      title: supplement.name,
      meta: missed ? `Not taken · ${title}` : `Logged with ${title} · ${time}`,
      status: missed ? 'Skipped' : TAKEN,
      control: doseActionButton(ctx, dose, supplement, title),
      state: missed ? 'is-skipped' : 'is-taken',
    }),
  };
}

/** `as_needed`: nothing is scheduled, so this is the one row logged by hand. */
function asNeededRow(ctx, supplement, doses, today) {
  const { plural } = ctx.format;
  const taken = takenToday(doses, supplement.id, today);
  const latest = dosesInRange(doses, supplement.id, today, today).find((dose) => isCounted(dose) && stored(dose));
  const log = ctx.button('Log dose', {
    size: 'sm',
    title: 'Log one dose now',
    onClick: () => write(ctx, log, {
      run: () => logDose(ctx, supplement),
      title: 'Dose logged',
      message: `${supplement.name} · ${doseText(supplement)}`,
      errorTitle: 'Couldn’t log dose',
    }),
  });
  const remove = latest
    ? ctx.button('', {
      variant: 'ghost',
      size: 'sm',
      icon: '×',
      title: 'Remove the last dose logged today',
      onClick: () => write(ctx, remove, {
        run: () => removeDose(ctx, latest.id),
        title: 'Dose removed',
        message: `${supplement.name} · today`,
        errorTitle: 'Couldn’t remove dose',
      }),
    })
    : null;
  return {
    expected: taken,
    taken,
    element: todayRow(ctx, {
      title: supplement.name,
      meta: rowMeta(ctx, supplement),
      status: taken ? plural(taken, 'dose') : '',
      control: [remove, log],
      state: taken ? 'is-taken' : '',
    }),
  };
}

function doseText(supplement) { return formatDose(supplement.dose_amount, supplement.dose_unit); }

function rowMeta(ctx, supplement) {
  return [doseText(supplement), supplement.timing].filter(Boolean).join(' · ');
}

function todayPanel(ctx, doses) {
  const { node, add } = ctx;
  const today = todayKey();
  const active = stack(ctx).filter((supplement) => isActiveOn(supplement, today));
  const rows = [];
  const onDemand = [];
  const list = node('div', 'today-list');

  for (const supplement of active) {
    const kind = kindOf(supplement);
    if (kind === 'daily' || kind === 'weekly') {
      if (dueToday(supplement, today)) rows.push(scheduledRow(ctx, supplement, doses, today));
    } else if (kind === 'workout') {
      for (const workout of sessionsToday(ctx, today)) rows.push(workoutRow(ctx, supplement, doses, workout, today));
    } else if (kind === 'as_needed') {
      onDemand.push(asNeededRow(ctx, supplement, doses, today));
    }
  }
  for (const row of rows) list.append(row.element);
  if (onDemand.length) {
    add(list, node('p', 'label-caps', 'When needed'));
    for (const row of onDemand) list.append(row.element);
  }

  // Scheduled doses count as taken until they are removed; a dose logged by
  // hand counts on both sides, so the reading never passes its own total.
  const counts = [...rows, ...onDemand];
  const expected = counts.reduce((sum, row) => sum + row.expected, 0);
  const taken = counts.reduce((sum, row) => sum + row.taken, 0);
  const subtitle = expected ? `${taken} of ${expected} taken` : 'Nothing scheduled today';
  const header = ctx.panelHeader('Today', subtitle);
  if (!rows.length && !onDemand.length) {
    return panel(ctx, header, ctx.emptyState({
      title: 'Nothing to take today',
      copy: 'None of your active supplements are scheduled for today. Scheduled doses appear here on their own.',
      icon: '◍',
      compact: true,
    }));
  }
  return panel(ctx, header, list);
}

/* -------------------------------------------------------------------- cards */

function supplementCard(ctx, supplement, doses) {
  const { node, add } = ctx;
  const to = todayKey();
  const from = addDays(to, -(CALENDAR_DAYS - 1));
  const usage = adherence(supplement, doses, { from, to, workouts: sessions(ctx) });

  const card = node('article', 'card supplement-card');
  const meta = node('div', 'card-meta');
  const parts = [supplement.brand, doseText(supplement), frequencyText(supplement)].filter(Boolean);
  add(meta, node('span', '', parts.join(' · ')), buyLink(ctx, supplement.purchase_url));

  const actions = node('div', 'card-actions');
  add(actions,
    ctx.button('Details', { size: 'sm', onClick: () => showSupplement(ctx, supplement, doses) }),
    ctx.button('Edit', { size: 'sm', onClick: () => editSupplement(ctx, supplement) }),
    // A scheduled supplement is logged by its schedule; only `as_needed` is logged by hand.
    kindOf(supplement) === 'as_needed' ? logDoseButton(ctx, supplement) : null);

  add(card,
    node('p', 'label-caps', typeLabel(supplement.type)),
    node('h3', 'card-title', supplement.name),
    meta,
    statusPill(ctx, supplement),
    ctx.miniMetric(`Last ${CALENDAR_DAYS} days`, adherenceText(ctx, supplement, usage)),
    calendarStrip(ctx, supplement, doses, { from, to }),
    supplement.package_size ? node('p', 'note', packageText(ctx, supplement, usage)) : null,
    actions);
  return card;
}

function logDoseButton(ctx, supplement) {
  const control = ctx.button('Log dose', {
    size: 'sm',
    onClick: () => write(ctx, control, {
      run: () => logDose(ctx, supplement),
      title: 'Dose logged',
      message: `${supplement.name} · ${doseText(supplement)}`,
      errorTitle: 'Couldn’t log dose',
    }),
  });
  return control;
}

function packageText(ctx, supplement, usage) {
  const { plural, NOT_SET } = ctx.format;
  const perPackage = dosesPerPackage(supplement);
  if (perPackage == null) return NOT_SET;
  const size = formatDose(supplement.package_size, supplement.dose_unit);
  const days = packageDays(supplement, usage);
  return `${size} = ${plural(perPackage, 'dose')}${days == null ? '' : ` ≈ ${plural(days, 'day')}`}`;
}

function cardSections(ctx, doses) {
  const { node, add } = ctx;
  const { plural } = ctx.format;
  const list = stack(ctx);
  const live = list.filter((supplement) => supplement.status !== 'ended');
  const ended = list.filter((supplement) => supplement.status === 'ended');
  const grid = (items) => {
    const wrap = node('div', 'card-grid');
    for (const supplement of items) wrap.append(supplementCard(ctx, supplement, doses));
    return wrap;
  };
  const sections = [];
  if (live.length) sections.push(grid(live));
  if (ended.length) {
    const details = node('details', 'supplement-ended');
    const summary = node('summary');
    const chevron = node('span', 'disclosure-chevron', '›');
    chevron.setAttribute('aria-hidden', 'true');
    add(summary, node('h3', 'card-title', 'Ended'), node('span', 'card-meta', plural(ended.length, 'supplement')), chevron);
    add(details, summary, grid(ended));
    sections.push(details);
  }
  return sections;
}

/* -------------------------------------------------------------- read dialog */

function fact(ctx, label, value) {
  return [ctx.node('dt', '', label), ctx.node('dd', '', value)];
}

function markdownSection(ctx, title, source) {
  const { node, add } = ctx;
  const section = node('section', 'supplement-prose');
  add(section, node('h3', '', title), String(source || '').trim() ? markdownBlock(source) : node('p', 'note', ctx.format.NOT_SET));
  return section;
}

function recentDoses(ctx, supplement, doses, error) {
  const { node, add } = ctx;
  const { formatDateTime, formatDay } = ctx.format;
  const section = node('section', 'supplement-prose');
  add(section, node('h3', '', 'Recent doses'));
  const rows = doses.filter((dose) => dose.supplement_id === supplement.id).slice(0, RECENT_DOSES);
  if (!rows.length) {
    add(section, node('p', 'note', 'No doses logged yet.'));
    return section;
  }
  const list = node('div', 'dose-list');
  for (const dose of rows) {
    const row = node('div', 'dose-row');
    // A scheduled dose happens on its day, not at an hour; only a real instant shows a time.
    const when = dose.slot ? formatDay(dose.date) : formatDateTime(dose.taken_at);
    add(row,
      node('span', '', when),
      add(node('span', 'note'), amountText(ctx, dose, supplement), node('span', '', ` · ${sourceText(dose)}`)),
      dialogDoseButton(ctx, dose, supplement, error));
    list.append(row);
  }
  section.append(list);
  return section;
}

function showSupplement(ctx, supplement, doses) {
  const { node, add } = ctx;
  const { formatDay, NOT_SET } = ctx.format;
  const today = todayKey();
  const content = node('div', 'dialog-stack');
  const error = node('p', 'form-error');
  error.setAttribute('role', 'alert');

  const pills = node('div', 'supplement-pills');
  add(pills,
    node('span', 'pill pill--neutral', typeLabel(supplement.type)),
    statusPill(ctx, supplement),
    supplement.brand ? node('span', 'pill pill--neutral', supplement.brand) : null);

  const usage = adherence(supplement, doses, { from: addDays(today, -(CALENDAR_DAYS - 1)), to: today, workouts: sessions(ctx) });
  const facts = node('dl', 'supplement-facts');
  add(facts,
    fact(ctx, 'Dose', doseText(supplement)),
    fact(ctx, 'Frequency', frequencyText(supplement)),
    fact(ctx, 'Timing', supplement.timing || NOT_SET),
    fact(ctx, 'Started', formatDay(supplement.start_date)),
    fact(ctx, 'Ends', supplement.end_date ? formatDay(supplement.end_date) : NOT_SET),
    fact(ctx, 'Package', packageText(ctx, supplement, usage)));

  const link = buyLink(ctx, supplement.purchase_url, 'Buy this supplement');
  add(content,
    pills,
    facts,
    link ? add(node('p', 'note'), link) : null,
    markdownSection(ctx, 'Ingredients', supplement.ingredients),
    markdownSection(ctx, 'Notes', supplement.notes),
    recentDoses(ctx, supplement, doses, error),
    error,
    dialogActions(ctx, supplement, error));
  ctx.openDialog('Supplement', supplement.name, content);
}

/** Close · Delete (two-step, in the button) · Stop taking/Resume · Edit. */
function dialogActions(ctx, supplement, error) {
  const { node, add } = ctx;
  const today = todayKey();
  const ended = supplement.status === 'ended';

  const remove = ctx.button('Delete', { variant: 'danger' });
  const label = remove.querySelector('span');
  let armed = false;
  remove.addEventListener('click', async () => {
    if (!armed) { armed = true; label.textContent = 'Really delete?'; return; }
    error.textContent = '';
    ctx.setBusy(remove, true);
    try {
      await ctx.api(`/api/supplements/${encodeURIComponent(supplement.id)}`, { method: 'DELETE' });
      ctx.closeDialog();
      invalidateSupplementDoses();
      await ctx.refresh();
      ctx.toast('Supplement deleted', 'Its doses were removed with it.');
    } catch (failure) {
      error.textContent = failure.message;
      ctx.setBusy(remove, false);
    }
  });

  const stop = ctx.button(ended ? 'Resume' : 'Stop taking', {
    onClick: async () => {
      error.textContent = '';
      ctx.setBusy(stop, true);
      try {
        await saveSupplement(ctx, supplementBody(supplement, { end_date: ended ? null : today }));
        ctx.closeDialog();
        invalidateSupplementDoses();
        await ctx.refresh();
        ctx.toast('Supplement saved', ended ? 'It is back on your stack.' : 'Today is its last counted day.');
      } catch (failure) {
        error.textContent = failure.message;
        ctx.setBusy(stop, false);
      }
    },
  });

  // An upcoming supplement has nothing to stop yet: its end date cannot precede its start.
  return add(node('div', 'dialog-actions'),
    ctx.button('Close', { onClick: ctx.closeDialog }),
    remove,
    ...(supplement.status === 'upcoming' ? [] : [stop]),
    ctx.button('Edit', { variant: 'primary', onClick: () => reopen(ctx, () => editSupplement(ctx, supplement)) }));
}

/**
 * A dialog cannot be re-opened while it is open, and the shell clears the body
 * on the `close` event, which fires as its own task — so the next dialog is
 * built after that task has run.
 */
function reopen(ctx, run) {
  ctx.closeDialog();
  window.setTimeout(run, 0);
}

/* ------------------------------------------------------------ editor dialog */

function newSupplementButton(ctx, variant = 'primary') {
  return ctx.button('New supplement', { variant, icon: '+', onClick: () => editSupplement(ctx) });
}

function weekdayGroup(ctx, selected) {
  const { node, add } = ctx;
  const group = node('fieldset', 'field');
  const legend = node('legend', 'field-label', 'Days');
  const row = node('div', 'weekday-group');
  const toggles = WEEKDAYS.map((day) => {
    const control = node('button', 'weekday', day.label);
    control.type = 'button';
    control.setAttribute('aria-pressed', String(selected.includes(day.key)));
    control.setAttribute('aria-label', day.long);
    control.addEventListener('click', () => {
      control.setAttribute('aria-pressed', String(control.getAttribute('aria-pressed') !== 'true'));
    });
    row.append(control);
    return control;
  });
  add(group, legend, row);
  const pressed = () => WEEKDAYS.filter((_, index) => toggles[index].getAttribute('aria-pressed') === 'true').map((day) => day.key);
  const press = (keys) => toggles.forEach((control, index) => control.setAttribute('aria-pressed', String(keys.includes(WEEKDAYS[index].key))));
  return { element: group, pressed, press };
}

function editSupplement(ctx, supplement = null) {
  const { node, add, field } = ctx;
  const today = todayKey();
  const form = node('form', 'dialog-form');

  const name = field('Name', { value: supplement?.name || '', required: true, maxLength: 120 });
  const brand = field('Brand', { value: supplement?.brand || '', maxLength: 120 });
  const type = field('Type', {
    options: SUPPLEMENT_TYPES.map((item) => ({ value: item.key, label: item.label })),
    value: supplement?.type || 'other',
  });

  const amount = field('Dose amount', { type: 'number', value: supplement?.dose_amount ?? 1, required: true });
  amount.control.min = '0';
  amount.control.step = 'any';
  const unit = field('Dose unit', {
    options: DOSE_UNITS.map((item) => ({ value: item.key, label: item.label })),
    value: supplement?.dose_unit || 'g',
  });
  const doseRow = add(node('div', 'field-row'), amount, unit);

  const frequency = field('Frequency', {
    options: FREQUENCY_KINDS.map((item) => ({ value: item.key, label: item.label })),
    value: kindOf(supplement || { frequency: { kind: 'daily' } }),
  });
  const perDay = field('Times per day', { type: 'number', value: supplement?.frequency?.per_day ?? 1 });
  perDay.control.min = '1';
  perDay.control.max = '6';
  perDay.control.step = '1';
  const weekdays = weekdayGroup(ctx, Array.isArray(supplement?.frequency?.weekdays) ? supplement.frequency.weekdays : []);
  const workoutHint = node('p', 'note', FREQUENCY_KINDS.find((item) => item.key === 'workout').hint);

  const timing = field('Timing', { value: supplement?.timing || '', placeholder: 'Morning with breakfast', maxLength: 100 });

  const startDate = field('Start date', { type: 'date', value: supplement?.start_date || today });
  const startHint = node('p', 'field-hint');
  startDate.append(startHint);
  const endDate = field('End date', { type: 'date', value: supplement?.end_date || '', hint: 'Leave empty while you keep taking it' });
  const dateRow = add(node('div', 'field-row'), startDate, endDate);

  const purchase = field('Where to buy', { type: 'url', value: supplement?.purchase_url || '', placeholder: 'https://' });
  const packageSize = field('Package size', { type: 'number', value: supplement?.package_size ?? '' });
  packageSize.control.min = '0';
  packageSize.control.step = 'any';
  const packageLabel = packageSize.querySelector('.field-label');

  const ingredients = field('Ingredients', { tag: 'textarea', value: supplement?.ingredients || '', maxLength: 4000, hint: 'Markdown, e.g. one line per ingredient' });
  const notes = field('Notes', { tag: 'textarea', value: supplement?.notes || '', maxLength: 4000 });

  const updateUnit = () => {
    const entry = unitEntry(unit.control.value);
    packageLabel.textContent = `Package size (${entry?.plural || entry?.label || unit.control.value})`;
  };
  const updateStartHint = () => {
    const past = Boolean(startDate.control.value) && startDate.control.value < today;
    const show = frequency.control.value === 'workout' && past;
    startHint.textContent = show ? 'Every session logged since this date already counts as a dose.' : '';
    startHint.hidden = !show;
  };
  const updateFrequency = ({ initial = false } = {}) => {
    const kind = frequency.control.value;
    perDay.hidden = kind !== 'daily';
    weekdays.element.hidden = kind !== 'weekly';
    workoutHint.hidden = kind !== 'workout';
    if (kind === 'weekly' && !initial && !weekdays.pressed().length) weekdays.press([0, 2, 4]);
    updateStartHint();
  };
  unit.control.addEventListener('change', updateUnit);
  frequency.control.addEventListener('change', () => updateFrequency());
  startDate.control.addEventListener('input', updateStartHint);
  updateUnit();
  updateFrequency({ initial: true });

  const error = node('p', 'form-error');
  error.setAttribute('role', 'alert');
  const save = ctx.button(supplement ? 'Save supplement' : 'Add supplement', { variant: 'primary', type: 'submit' });
  add(form,
    name, brand, type, doseRow,
    frequency, perDay, weekdays.element, workoutHint,
    timing, dateRow, purchase, packageSize, ingredients, notes,
    error,
    add(node('div', 'dialog-actions'), ctx.button('Cancel', { onClick: ctx.closeDialog }), save));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    const kind = frequency.control.value;
    const chosen = weekdays.pressed();
    if (kind === 'weekly' && !chosen.length) { error.textContent = 'Pick at least one weekday.'; return; }
    const body = {
      ...(supplement ? { id: supplement.id } : {}),
      name: name.control.value.trim(),
      brand: brand.control.value.trim(),
      type: type.control.value,
      dose_amount: Number(amount.control.value),
      dose_unit: unit.control.value,
      frequency: kind === 'daily' ? { kind, per_day: Number(perDay.control.value) || 1 }
        : kind === 'weekly' ? { kind, weekdays: chosen }
          : { kind },
      timing: timing.control.value.trim(),
      start_date: startDate.control.value,
      end_date: endDate.control.value || null,
      purchase_url: purchase.control.value.trim() || null,
      package_size: packageSize.control.value === '' ? null : Number(packageSize.control.value),
      ingredients: ingredients.control.value,
      notes: notes.control.value,
    };
    ctx.setBusy(save, true);
    try {
      await saveSupplement(ctx, body);
      ctx.closeDialog();
      invalidateSupplementDoses();
      await ctx.refresh();
      ctx.toast(supplement ? 'Supplement saved' : 'Supplement added', 'It is stored locally with your training data.');
    } catch (failure) {
      error.textContent = failure.message;
      ctx.setBusy(save, false);
    }
  });

  ctx.openDialog('Supplement', supplement ? supplement.name : 'New supplement', form);
  name.control.focus();
}

/* --------------------------------------------------------------- stack view */

function stackBody(ctx, data) {
  if (!stack(ctx).length) {
    return [panel(ctx, ctx.emptyState({
      title: 'Add your first supplement',
      copy: 'Record what you take, how much and how often. Corpus logs the scheduled doses for you, and you remove the ones you did not take.',
      icon: '◍',
      action: newSupplementButton(ctx, 'secondary'),
    }))];
  }
  return [todayPanel(ctx, data.doses), ...cardSections(ctx, data.doses)];
}

export function renderSupplements(ctx) {
  const { node, add } = ctx;
  const view = node('section', 'view section-page supplements-view');
  const body = node('div', 'panel-stack');
  const options = {
    view,
    body,
    fill: (data) => body.replaceChildren(...stackBody(ctx, data)),
    cached: () => cachedDoses(ctx),
    load: () => loadDoses(ctx),
    loadingCopy: 'Loading your stack…',
    failTitle: 'Couldn’t load doses',
  };
  add(view, ctx.heading(
    'Supplements',
    'Stack',
    'What you take, and whether you took it today.',
    newSupplementButton(ctx),
  ), body);
  loadBody(ctx, options);
  return view;
}

/* ------------------------------------------------------------- history view */

function historyRange(ctx, data) {
  const to = data.range?.to || todayKey();
  const days = ctx.period.days(ctx.period.get());
  const widest = data.range?.from || addDays(to, -(MAX_FETCH_DAYS - 1));
  const from = days ? addDays(to, -(days - 1)) : widest;
  return { from: from > widest ? from : widest, to };
}

function historyStats(ctx, rows, range) {
  const { formatNumber, plural, MISSING } = ctx.format;
  const taken = rows.filter(isCounted);
  const totals = stack(ctx).reduce((sum, supplement) => {
    const usage = adherence(supplement, rows, { ...range, workouts: sessions(ctx) });
    return { expected: sum.expected + usage.expected, taken: sum.taken + Math.min(usage.taken, usage.expected) };
  }, { expected: 0, taken: 0 });
  const ratio = totals.expected ? `${formatNumber((totals.taken / totals.expected) * 100)}%` : MISSING;
  const withWorkouts = rows.filter((dose) => dose.workout_id).length;
  const stats = ctx.node('div', 'stat-grid');
  return ctx.add(stats,
    ctx.statCard('Doses logged', formatNumber(taken.length), { suffix: `${plural(rows.length - taken.length, 'skipped dose')}` }),
    ctx.statCard('Adherence', ratio, { suffix: totals.expected ? `${totals.taken} of ${totals.expected} scheduled doses` : 'nothing scheduled in this range' }),
    ctx.statCard('With workouts', formatNumber(withWorkouts), { suffix: 'doses tied to a session' }),
  );
}

function adherencePanel(ctx, rows, range) {
  const { node, add } = ctx;
  const { formatNumber, plural } = ctx.format;
  const list = node('div', 'adherence-list');
  let shown = 0;
  for (const supplement of stack(ctx)) {
    const usage = adherence(supplement, rows, { ...range, workouts: sessions(ctx) });
    if (!usage.days && !usage.taken) continue;
    shown += 1;
    const row = node('div', 'adherence-row');
    const head = node('div', 'adherence-head');
    const reading = usage.ratio == null ? plural(usage.taken, 'dose') : `${usage.taken} of ${usage.expected} doses`;
    add(head, node('strong', '', supplement.name), node('span', 'note', reading));
    add(row, head);
    if (usage.ratio != null) {
      const percent = Math.min(100, usage.ratio * 100);
      const bar = node('progress', 'adherence-bar');
      bar.max = 100;
      bar.value = percent;
      bar.setAttribute('aria-label', `${supplement.name}: ${formatNumber(percent)}% of scheduled doses taken`);
      add(row, bar, node('span', 'adherence-figure', `${formatNumber(percent)}%`));
    }
    add(row, add(node('div', 'dose-calendar-scroll'), calendarStrip(ctx, supplement, rows, { ...range, wide: true })));
    list.append(row);
  }
  const header = ctx.panelHeader('Adherence', 'Scheduled doses taken, day by day');
  if (!shown) {
    return panel(ctx, header, ctx.emptyState({ title: 'No supplements in this range', copy: 'Nothing on your stack was active in these dates.', icon: '◍', compact: true }));
  }
  return panel(ctx, header, list);
}

function dosesPanel(ctx, rows, actions) {
  const { node, add } = ctx;
  const { dateLabel, formatDay, plural } = ctx.format;
  const header = ctx.panelHeader('Doses', `Newest first · ${plural(rows.length, 'dose')}`);
  if (!rows.length) {
    return panel(ctx, header, ctx.emptyState({
      title: 'No doses in this range',
      copy: 'Nothing was scheduled or logged in these dates. Widen the date range to see more.',
      icon: '○',
      action: ctx.period.get() === 'all' ? null : ctx.button('Show all time', { onClick: actions.showAll }),
    }));
  }
  const byId = new Map(stack(ctx).map((supplement) => [supplement.id, supplement]));
  const table = node('table', 'sets-table dose-table');
  const headRow = node('tr');
  for (const text of ['Time', 'Supplement', 'Amount', 'Source', 'Note']) headRow.append(node('th', '', text));
  headRow.append(add(node('th'), node('span', 'sr-only', 'Actions')));
  const tbody = node('tbody');
  const more = ctx.button('Show more', { size: 'sm', onClick: () => { limit += TABLE_ROWS; fill(); } });
  let limit = TABLE_ROWS;

  const fill = () => {
    const shown = rows.slice(0, limit);
    const body = [];
    for (const group of groupByDate(shown)) {
      const groupRow = node('tr', 'dose-group');
      const cell = node('th', '', formatDay(group.date, { weekday: 'short', month: 'short', day: 'numeric' }));
      cell.colSpan = 6;
      cell.scope = 'colgroup';
      body.push(add(groupRow, cell));
      for (const dose of group.doses) {
        const supplement = byId.get(dose.supplement_id);
        // A scheduled dose belongs to its day, not to an hour.
        const time = dose.slot ? ctx.format.MISSING : dateLabel(dose.taken_at, { timeStyle: 'short' });
        body.push(add(node('tr'),
          node('td', '', time),
          node('td', '', supplement?.name || 'Removed supplement'),
          add(node('td'), amountText(ctx, dose, supplement)),
          node('td', '', sourceText(dose)),
          node('td', '', dose.note || ctx.format.MISSING),
          add(node('td', 'dose-table-action'), doseActionButton(ctx, dose, supplement))));
      }
    }
    tbody.replaceChildren(...body);
    more.hidden = limit >= rows.length;
  };
  fill();
  add(table, add(node('thead'), headRow), tbody);
  return panel(ctx, header, add(node('div', 'dose-table-scroll'), table), more);
}

function historyBody(ctx, data, actions) {
  const range = historyRange(ctx, data);
  const rows = dosesInRange(data.doses, null, range.from, range.to);
  return [historyStats(ctx, rows, range), adherencePanel(ctx, rows, range), dosesPanel(ctx, rows, actions)];
}

export function renderSupplementsHistory(ctx) {
  const { node, add } = ctx;
  const view = node('section', 'view section-page supplements-view');
  const body = node('div', 'panel-stack');
  const actions = {
    reload: () => loadBody(ctx, options),
    showAll: () => { ctx.period.set('all'); markPeriod(picker, 'all'); actions.reload(); },
  };
  const options = {
    view,
    body,
    fill: (data) => body.replaceChildren(...historyBody(ctx, data, actions)),
    cached: () => cachedDoses(ctx),
    load: () => loadDoses(ctx),
    loadingCopy: 'Loading doses…',
    failTitle: 'Couldn’t load doses',
  };
  const picker = ctx.periodPicker((value) => { markPeriod(picker, value); actions.reload(); });
  add(view, ctx.heading(
    'Supplements',
    'History',
    'Every dose, and how consistent you have been.',
    picker,
  ), body);
  actions.reload();
  return view;
}
