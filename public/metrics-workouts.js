// Metrics › Workouts (#metrics-workouts): what the watch recorded across every
// session, and which sessions are still missing their samples.
//
// Fetching follows the other metrics views (metrics.js): the widest window is
// fetched once per data mode and cached, then the range picker slices it client
// side, so changing the range is instant and the deltas always have a baseline.

import { HEART_RATE_ZONES } from './workout-metrics-catalog.js';
import { lineChart, stackedBarChart } from './metric-charts.js';
import { chartPanel, loadBody, markPeriod, panel } from './metrics.js';
import { localDateKey } from './program-timeline.js';
import {
  activeZoneMinutes,
  hasMetrics,
  overviewChange,
  overviewSummary,
  partitionWindows,
  zoneClass,
} from './workout-metrics-analytics.js';

/** The widest window the server will serve, and what `All` means here. */
const MAX_FETCH_DAYS = 730;
/** Sessions fetched by one press of "Fetch metrics" (the server's own budget). */
const FETCH_BUDGET = 25;
/** Newest-first rows in the sessions table. */
const TABLE_ROWS = 40;

let cache = { key: null, data: null };
let inflight = null;
/** Bumped by every invalidation, so a reply already in flight cannot re-fill a
 *  cache that a fetch has just made stale. */
let generation = 0;

function cacheKey(ctx) { return ctx.state?.mode || 'demo'; }

function cachedOverview(ctx) { return cache.key === cacheKey(ctx) ? cache.data : null; }

export function invalidateWorkoutMetrics() {
  generation += 1;
  cache = { key: null, data: null };
  inflight = null;
}

function normalize(data) {
  return {
    ...data,
    workouts: Array.isArray(data?.workouts) ? data.workouts : [],
    coverage: data?.coverage || {},
    range: data?.range || {},
  };
}

/** Fetches the widest window once per data mode, de-duplicating concurrent calls. */
function loadOverview(ctx) {
  const key = cacheKey(ctx);
  const ready = cachedOverview(ctx);
  if (ready) return Promise.resolve(ready);
  if (!inflight || inflight.key !== key) {
    const era = generation;
    const promise = ctx.api(`/api/metrics/workouts?days=${MAX_FETCH_DAYS}`)
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

/* ------------------------------------------------------------------ counting */

/** Coverage for the rows in view, so the line always matches the range picker. */
function coverageOf(rows) {
  const counts = { sessions: rows.length, ready: 0, unfetched: 0, empty: 0 };
  for (const row of rows) {
    if (row.status === 'ready') counts.ready += 1;
    else if (row.status === 'empty') counts.empty += 1;
    else counts.unfetched += 1;
  }
  return counts;
}

function connected(ctx) {
  return ctx.state.mode === 'demo' || Boolean(ctx.state.settings?.googleHealth?.connected);
}

/* -------------------------------------------------------------------- panels */

/** Nothing to show at all: the source is missing, or the archive has no sessions. */
function emptyPanel(ctx, rows, actions) {
  if (!connected(ctx)) {
    return panel(ctx, ctx.emptyState({
      title: 'Connect Google Health',
      copy: 'Add your Google OAuth client in Settings and connect your account to read the heart rate, calories and zone minutes recorded during each workout.',
      icon: '∿',
      action: ctx.settingsLink('Open Settings', { asButton: true }),
    }));
  }
  if (!rows.length) {
    return panel(ctx, ctx.emptyState({
      title: 'No sessions in this range',
      copy: 'Workout metrics follow your Hevy sessions. Widen the range, or sync Hevy to import more.',
      icon: '○',
      action: ctx.period.get() === 'all' ? null : ctx.button('Show all time', { onClick: actions.showAll }),
    }));
  }
  return null;
}

/* -------------------------------------------------------------------- fetching */

/**
 * Fetches the sessions that have never been requested, newest first, one at a
 * time so a rate limit stops at one failure rather than all of them.
 */
function fetchMissingButton(ctx, rows, actions) {
  const pending = rows.filter((row) => row.status !== 'ready' && row.status !== 'empty').slice(0, FETCH_BUDGET);
  const control = ctx.button('Fetch metrics', {
    variant: 'secondary',
    icon: '↻',
    title: `Read Google Health for ${ctx.format.plural(pending.length, 'session')}`,
    onClick: async () => {
      ctx.setBusy(control, true);
      let fetched = 0, empty = 0;
      let failure = null;
      for (const row of pending) {
        try {
          const result = await ctx.api(`/api/workouts/${encodeURIComponent(row.id)}/metrics/sync`, { method: 'POST', body: '{}' });
          if (result?.status === 'empty') empty += 1; else fetched += 1;
        } catch (error) {
          failure = error;
          break;
        }
      }
      invalidateWorkoutMetrics();
      if (failure) ctx.toast('Couldn’t fetch session metrics', failure.message || 'Please try again.', 'error');
      else {
        const extra = [];
        if (empty) extra.push(`${ctx.format.plural(empty, 'session')} had no samples.`);
        // Demo data is generated and never written, so nothing actually changed.
        if (ctx.state.mode === 'demo') extra.push('Switch to live data to see the changes.');
        ctx.toast('Session metrics fetched', [`${ctx.format.plural(fetched, 'session')} read from Google Health.`, ...extra].join(' '));
      }
      if (control.isConnected) ctx.setBusy(control, false);
      actions.reload();
    },
  });
  return control;
}

/** `27 of 31 sessions have metrics · 3 not fetched yet`, plus the action that fixes it. */
function coveragePanel(ctx, rows, actions) {
  const { node, add } = ctx;
  const { plural } = ctx.format;
  const counts = coverageOf(rows);
  const parts = [`${plural(counts.ready, 'session')} of ${counts.sessions} have metrics`];
  if (counts.unfetched) parts.push(`${counts.unfetched} not fetched yet`);
  if (counts.empty) parts.push(`${counts.empty} with no samples on Google Health`);
  const row = node('div', 'status-row');
  add(row, node('p', 'note', parts.join(' · ')), counts.unfetched ? fetchMissingButton(ctx, rows, actions) : null);
  return panel(ctx, row);
}

/* ---------------------------------------------------------------------- body */

function statRow(ctx, current, previous) {
  const { node, add } = ctx;
  const { formatNumber, formatDuration, MISSING } = ctx.format;
  const now = overviewSummary(current, HEART_RATE_ZONES);
  const change = overviewChange(now, overviewSummary(previous, HEART_RATE_ZONES));
  const value = (input, decimals = 0) => (input == null ? MISSING : formatNumber(input, decimals));
  const stats = node('div', 'stat-grid');
  const suffix = now.measured ? `${ctx.format.plural(now.measured, 'session')} with metrics` : 'no sessions with metrics yet';
  add(stats,
    ctx.statCard('Avg HR per session (bpm)', value(now.avgHr), { change: change.avgHr, suffix }),
    ctx.statCard('Avg peak HR (bpm)', value(now.peakHr), { change: change.peakHr }),
    ctx.statCard('Zone minutes per session', formatDuration(now.zoneMinutes), { change: change.zoneMinutes, format: (input) => formatDuration(input) }),
    ctx.statCard('Calories per session (kcal)', value(now.calories), { change: change.calories }),
  );
  return stats;
}

/** Oldest-first points, one per session, for the two per-session charts. */
function seriesRows(rows) {
  return [...rows].reverse().map((row) => ({
    id: row.id,
    date: localDateKey(new Date(row.start_time)),
    title: row.title || 'Untitled workout',
    avg: hasMetrics(row) ? row.heart_rate.avg : null,
    max: hasMetrics(row) ? row.heart_rate.max ?? null : null,
    zones: row.zones || null,
  }));
}

function heartPanel(ctx, rows) {
  const { formatDay, formatNumber } = ctx.format;
  const points = seriesRows(rows);
  const xLabel = (point) => formatDay(point.date);
  return chartPanel(ctx, 'Heart rate per session', 'Average and peak bpm · one mark per session', ({ compact }) => lineChart({
    points: points.map((point) => ({ date: point.date, value: point.avg })),
    extras: [{
      values: points.map((point) => point.max),
      label: 'Peak',
      className: 'chart-line chart-line--peak',
      dotClass: 'chart-dot--peak',
      legendClass: 'legend-line legend-line--peak',
    }],
    unit: 'bpm',
    seriesLabel: 'Average',
    label: 'Average and peak heart rate per session in beats per minute',
    format: (value) => `${formatNumber(value)} bpm`,
    xLabel,
    xLabels: compact ? 3 : 6,
    compact,
  }));
}

function zonePanel(ctx, rows) {
  const { formatDay, formatDuration } = ctx.format;
  const points = seriesRows(rows).map((point) => {
    const row = { date: point.date, total: point.zones ? activeZoneMinutes(point.zones, HEART_RATE_ZONES) : null };
    for (const zone of HEART_RATE_ZONES) row[zone.key] = point.zones ? point.zones[zone.key] ?? 0 : null;
    return row;
  });
  const segments = HEART_RATE_ZONES.map((zone) => ({ key: zone.key, label: zone.label, className: zoneClass(zone.key) }));
  return chartPanel(ctx, 'Zone minutes per session', 'Minutes in each heart-rate zone · one bar per session', ({ compact }) => stackedBarChart({
    rows: points,
    segments,
    // One hue, light to dark: the slices need a seam to read as three bands.
    segmentGap: 2,
    unit: 'min',
    label: 'Minutes in each heart-rate zone per session',
    seriesNoun: 'in zones',
    emptyTitle: 'No zone minutes in this range',
    format: formatDuration,
    xLabel: (point) => formatDay(point.date),
    xLabels: compact ? 3 : 6,
    compact,
  }));
}

function sessionsPanel(ctx, rows) {
  const { node, add } = ctx;
  const { MISSING, dateLabel, formatDuration, formatNumber, plural } = ctx.format;
  const shown = rows.slice(0, TABLE_ROWS);
  const table = node('table', 'sets-table workout-metrics-table');
  const headRow = node('tr');
  for (const text of ['Date', 'Session', 'Duration', 'Avg HR (bpm)', 'Max HR (bpm)', 'Zones (min)', 'Calories (kcal)']) headRow.append(node('th', '', text));
  const tbody = node('tbody');
  for (const row of shown) {
    const workout = (ctx.state.workouts || []).find((item) => item.id === row.id);
    const open = node('button', 'text-button', row.title || 'Untitled workout');
    open.type = 'button';
    open.title = 'Open this session';
    open.addEventListener('click', () => ctx.showSession(workout));
    const heart = hasMetrics(row) ? row.heart_rate : null;
    const zones = row.zones ? activeZoneMinutes(row.zones, HEART_RATE_ZONES) : null;
    add(tbody, add(node('tr'),
      node('td', '', dateLabel(row.start_time, { weekday: 'short', month: 'short', day: 'numeric' })),
      add(node('td', 'workout-metrics-name'), workout ? open : node('span', '', row.title || 'Untitled workout')),
      node('td', '', formatDuration(row.duration_min)),
      node('td', '', heart ? formatNumber(heart.avg) : MISSING),
      node('td', '', heart?.max == null ? MISSING : formatNumber(heart.max)),
      node('td', '', zones == null ? MISSING : formatNumber(zones)),
      node('td', '', row.calories == null ? MISSING : formatNumber(row.calories)),
    ));
  }
  add(table, add(node('thead'), headRow), tbody);
  const subtitle = rows.length > shown.length
    ? `Newest first · ${plural(shown.length, 'session')} of ${rows.length}`
    : `Newest first · ${plural(rows.length, 'session')}`;
  return panel(ctx, ctx.panelHeader('Sessions', subtitle), add(node('div', 'metrics-table'), table));
}

function workoutsBody(ctx, data, actions) {
  const days = ctx.period.days(ctx.period.get());
  const { current, previous } = partitionWindows(data.workouts, days, Date.now());
  const blank = emptyPanel(ctx, current, actions);
  if (blank) return [blank];
  const measured = current.filter(hasMetrics);
  return [
    statRow(ctx, current, previous),
    coveragePanel(ctx, current, actions),
    ...(measured.length ? [heartPanel(ctx, current), zonePanel(ctx, current)] : [noMetricsPanel(ctx)]),
    sessionsPanel(ctx, current),
  ];
}

/** Sessions exist, but none of them has samples yet. */
function noMetricsPanel(ctx) {
  return panel(ctx, ctx.emptyState({
    title: 'No session metrics yet',
    copy: ctx.state.mode === 'demo'
      ? 'No demo metrics were generated for these sessions.'
      : 'Fetch metrics above to read heart rate, calories and zone minutes from Google Health for the sessions in this range.',
    icon: '∿',
    compact: true,
  }));
}

/* ------------------------------------------------------------------- the view */

export function renderMetricsWorkouts(ctx) {
  const { node, add } = ctx;
  const view = node('section', 'view section-page metrics-workouts-view');
  const body = node('div', 'panel-stack');
  const actions = {
    reload: () => loadBody(ctx, options),
    showAll: () => { ctx.period.set('all'); markPeriod(picker, 'all'); actions.reload(); },
  };
  const options = {
    view,
    body,
    fill: (data) => body.replaceChildren(...workoutsBody(ctx, data, actions)),
    cached: () => cachedOverview(ctx),
    load: () => loadOverview(ctx),
    loadingCopy: 'Loading workout metrics…',
    failTitle: 'Couldn’t load workout metrics',
  };
  const picker = ctx.periodPicker((value) => { markPeriod(picker, value); actions.reload(); });
  add(view, ctx.heading(
    'Metrics',
    'Workouts',
    'Heart rate, zone minutes and calories recorded during your sessions.',
    picker,
  ), body);
  actions.reload();
  return view;
}
