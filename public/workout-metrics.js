// The session dialog's metrics section: the heart-rate trace for one workout,
// its zone split and the per-exercise estimate.
//
// The dialog is built synchronously, so this module hands `showSession` an
// element plus a `start()` it calls once the dialog is open — `.dialog` has no
// width before `showModal()`, and `mountChart` measures its container.
//
// Every state the contract defines has a body here: `ready`, `empty`,
// `unfetched`, `not_connected`, and a failed request.

import { HEART_RATE_ZONES } from './workout-metrics-catalog.js';
import { mountChart, timeSeriesChart, zoneBar } from './metric-charts.js';
import { invalidateWorkoutMetrics } from './metrics-workouts.js';
import { activeZoneMinutes, gapThreshold, layoutSegments, traceWindow, zoneRows } from './workout-metrics-analytics.js';

/** Hevy stores no per-set times, so every segment below is an estimate (contract). */
const ESTIMATE_NOTE = 'Exercise windows are estimated from set counts — Hevy logs no per-set times, so treat the per-exercise figures as indicative.';

function metricsPath(workout) { return `/api/workouts/${encodeURIComponent(workout.id)}/metrics`; }

/* ----------------------------------------------------------------- sections */

function sectionShell(ctx, title, subtitle) {
  const { node, add } = ctx;
  const section = node('section', 'session-metrics');
  const header = node('header', 'session-metrics-head');
  add(header, node('h3', 'card-title', title), subtitle ? node('p', 'note', subtitle) : null);
  const body = node('div', 'session-metrics-body');
  add(section, header, body);
  return { section, body };
}

function loadingBody(ctx) {
  const { node, add } = ctx;
  const status = node('div', 'loading-block');
  status.setAttribute('role', 'status');
  return add(status, node('span', 'loader'), node('p', '', 'Loading session metrics…'));
}

/** `Pixel Watch 4 · 3,301 samples · 94% coverage`, with whatever parts exist. */
function sourceLine(ctx, data) {
  const { formatNumber, formatDateTime, plural } = ctx.format;
  const heart = data?.summary?.heart_rate || {};
  const parts = [data?.source || 'Google Health'];
  if (heart.sample_count) parts.push(plural(heart.sample_count, 'sample'));
  if (heart.coverage != null) parts.push(`${formatNumber(heart.coverage * 100)}% coverage`);
  if (data?.fetched_at) parts.push(`fetched ${formatDateTime(data.fetched_at)}`);
  return parts.join(' · ');
}

function statRow(ctx, data) {
  const { node, add } = ctx;
  const { formatNumber, formatDuration, MISSING } = ctx.format;
  const summary = data.summary || {};
  const heart = summary.heart_rate || {};
  const row = node('div', 'metric-row');
  const value = (input, decimals = 0) => (input == null ? MISSING : formatNumber(input, decimals));
  add(row,
    ctx.miniMetric('Avg HR (bpm)', value(heart.avg)),
    ctx.miniMetric('Max HR (bpm)', value(heart.max)),
    ctx.miniMetric('In zones', summary.zones ? formatDuration(activeZoneMinutes(summary.zones, HEART_RATE_ZONES)) : MISSING),
    ctx.miniMetric('Calories (kcal)', value(summary.calories)),
    ctx.miniMetric('Steps', value(summary.steps)),
  );
  return row;
}

function tracePanel(ctx, data) {
  const { node } = ctx;
  const { formatBpm, formatElapsed } = ctx.format;
  const samples = data.series?.heart_rate?.samples || [];
  if (!samples.length) return null;
  const workoutStart = new Date(data.workout?.start_time).getTime();
  const workoutEnd = new Date(data.workout?.end_time).getTime();
  const domain = traceWindow(data.window, samples, { startMs: workoutStart, endMs: workoutEnd });
  if (!domain) return null;
  const origin = Number.isFinite(workoutStart) ? workoutStart : domain.startMs;
  const segments = layoutSegments(data.exercises, domain);
  const byTime = (at) => segments.find((segment) => at >= segment.fromMs && at <= segment.toMs);
  const mount = node('div', 'chart-mount');
  mountChart(mount, ({ compact }) => timeSeriesChart({
    samples,
    window: domain,
    origin,
    bounds: { startMs: workoutStart, endMs: workoutEnd },
    segments,
    gapMs: gapThreshold(samples, { medianMs: data.summary?.heart_rate?.median_interval_ms }),
    label: `Heart rate in beats per minute over ${data.workout?.title || 'this session'}`,
    unit: 'bpm',
    hint: segments.length
      ? 'Shaded bands are the estimated exercise windows; the rules mark the logged start and end.'
      : 'The rules mark the logged start and end of the session.',
    compact,
    readout: (point, elapsed) => {
      const segment = byTime(point[0]);
      return [formatElapsed(elapsed), formatBpm(point[1]), segment?.title].filter(Boolean).join(' · ');
    },
  }));
  return mount;
}

function zonePanel(ctx, data) {
  const { node, add } = ctx;
  const rows = zoneRows(data.summary?.zones, HEART_RATE_ZONES);
  if (!rows.some((row) => row.minutes > 0)) return null;
  const block = node('div', 'zone-block');
  add(block, node('p', 'label-caps', 'Time in heart-rate zones'), zoneBar({ rows, format: ctx.format.formatDuration }));
  return block;
}

function exerciseTable(ctx, data) {
  const { node, add } = ctx;
  const { formatNumber, formatElapsed, MISSING } = ctx.format;
  const rows = Array.isArray(data.exercises) ? data.exercises : [];
  if (!rows.length) return null;
  const origin = new Date(data.workout?.start_time).getTime();
  const table = node('table', 'sets-table');
  const headRow = node('tr');
  // The section title already says "heart rate", so the columns only carry the unit.
  for (const text of ['#', 'Exercise', 'Sets', 'Window', 'Avg (bpm)', 'Max (bpm)']) headRow.append(node('th', '', text));
  const tbody = node('tbody');
  const elapsed = (value) => (value == null || !Number.isFinite(Number(value)) || !Number.isFinite(origin) ? null : Number(value) - origin);
  rows.forEach((row, position) => {
    const from = elapsed(row.from_ms);
    const to = elapsed(row.to_ms);
    const window = from == null || to == null ? MISSING : `${formatElapsed(from)}–${formatElapsed(to)}`;
    add(tbody, add(node('tr'),
      node('td', 'exercise-hr-number', String(position + 1)),
      node('td', '', row.title || 'Untitled exercise'),
      node('td', '', formatNumber(row.sets)),
      node('td', '', window),
      node('td', '', row.heart_rate?.avg == null ? MISSING : formatNumber(row.heart_rate.avg)),
      node('td', '', row.heart_rate?.max == null ? MISSING : formatNumber(row.heart_rate.max)),
    ));
  });
  add(table, add(node('thead'), headRow), tbody);
  const block = node('div', 'exercise-hr');
  add(block, node('p', 'label-caps', 'Heart rate by exercise'), table, node('p', 'note', ESTIMATE_NOTE));
  return block;
}

/* ------------------------------------------------------------------- actions */

/**
 * Fetches this one workout's samples. Success re-renders in place — the section
 * itself is the outcome, and a dialog never toasts while it is open (ui.md).
 * A request that stores nothing (demo data, which never writes) and a failed one
 * both report under the button, so the user is never left guessing.
 */
function fetchAction(ctx, workout, label, render) {
  const { node, add } = ctx;
  const outcome = node('p', 'note');
  outcome.setAttribute('role', 'status');
  const failure = node('p', 'form-error');
  failure.setAttribute('role', 'alert');
  const control = ctx.button(label, {
    variant: 'secondary',
    icon: '↻',
    onClick: async () => {
      outcome.textContent = '';
      failure.textContent = '';
      ctx.setBusy(control, true);
      try {
        const data = await ctx.api(`${metricsPath(workout)}/sync`, { method: 'POST', body: '{}' });
        // The Workouts overview counts this session, so its cache is now stale.
        invalidateWorkoutMetrics();
        if (data?.status !== 'unfetched') { render(data); return; }
        // Nothing was stored: demo data is generated and never written.
        if (control.isConnected) ctx.setBusy(control, false);
        outcome.textContent = ctx.state.mode === 'demo'
          ? 'Demo sessions are generated, so nothing is read. Switch to your own data to fetch from Google Health.'
          : 'Google Health returned nothing to store for this session.';
      } catch (error) {
        if (control.isConnected) ctx.setBusy(control, false);
        failure.textContent = error.message || 'Please try again.';
      }
    },
  });
  return add(node('div', 'fetch-action'), control, outcome, failure);
}

/* --------------------------------------------------------------------- state */

function stateBody(ctx, workout, data, render) {
  switch (data.status) {
    case 'not_connected':
      return ctx.emptyState({
        title: 'Connect Google Health',
        copy: 'Connect your Google account in Settings to read the heart rate, calories and zone minutes recorded during this session.',
        icon: '∿',
        compact: true,
        action: ctx.settingsLink('Open Settings', { asButton: true }),
      });
    case 'empty':
      return ctx.emptyState({
        title: 'Google Health has no samples for this session yet',
        copy: 'Your watch may not have been worn, or the data has not synced to Google yet. Late samples can arrive up to two days later.',
        icon: '○',
        compact: true,
        action: fetchAction(ctx, workout, 'Check again', render),
      });
    case 'unfetched':
      return ctx.emptyState({
        title: 'Metrics not fetched yet',
        copy: 'Corpus reads heart rate, calories, steps and zone minutes from Google Health for the minutes around this workout. Nothing has been requested for this session yet.',
        icon: '∿',
        compact: true,
        action: fetchAction(ctx, workout, 'Fetch from Google Health', render),
      });
    default:
      return null;
  }
}

/** The stat row always renders; the trace, zone bar and table appear when present. */
function readyBody(ctx, data) {
  return [statRow(ctx, data), tracePanel(ctx, data), zonePanel(ctx, data), exerciseTable(ctx, data)].filter(Boolean);
}

/**
 * The session dialog's metrics section.
 *
 * @param {object} ctx the shared `context()`
 * @param {{id:string,title?:string}} workout the workout the dialog is showing
 * @returns {{element: HTMLElement, start: () => void}} `start()` must be called
 *   after `showModal()`, so the chart measures a dialog that has a width.
 */
export function workoutMetricsSection(ctx, workout) {
  const { node, add } = ctx;
  const { section, body } = sectionShell(ctx, 'Session metrics', 'Google Health');
  const subtitle = section.querySelector('.note');

  const render = (data) => {
    if (!section.isConnected) return;
    subtitle.textContent = sourceLine(ctx, data) || 'Google Health';
    const state = stateBody(ctx, workout, data, render);
    body.replaceChildren(...(state ? [state] : readyBody(ctx, data)));
  };

  const fail = (error, retry) => {
    if (!section.isConnected) return;
    subtitle.textContent = 'Google Health';
    body.replaceChildren(ctx.emptyState({
      title: 'Couldn’t load session metrics',
      copy: error.message || 'Check that the local server is still running.',
      icon: '!',
      compact: true,
      action: ctx.button('Try again', { onClick: retry }),
    }));
  };

  const load = () => {
    body.replaceChildren(loadingBody(ctx));
    ctx.api(metricsPath(workout)).then(render).catch((error) => fail(error, load));
  };

  add(body, loadingBody(ctx));
  return { element: section, start: load };
}
