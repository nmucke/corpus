// Metrics views: the health Dashboard (#metrics) and Trends (#metrics-trends).
// Both fetch /api/metrics through the shared api helper, cache the last
// response per (mode, days), and fill their panels asynchronously.

import { CATEGORIES, METRICS, isMetricKey, metricByKey, metricsInCategory } from './metrics-catalog.js';
import { localDateKey } from './program-timeline.js';
import { dateRange, fillDays, periodDays, previousRange, rollingMean, sleepStack, summarize, trainingDaySplit } from './metrics-analytics.js';
import { barChart, formatMinutes, formatValue, labelDate, lineChart, stackedBarChart } from './metric-charts.js';

const PERIODS = [['4w', '4 weeks'], ['12w', '12 weeks'], ['26w', '26 weeks'], ['1y', '1 year']];
const LB_PER_KG = 2.2046226218;
const MAX_FETCH_DAYS = 730;

let period = '12w';
let trendMetric = 'steps';
let cache = { key: null, data: null };
let inflight = { key: null, promise: null };

function cacheKey(ctx, days) { return `${ctx.state?.mode || 'demo'}:${days}`; }

/** Returns the cached response for (mode, days) or null. */
export function cachedMetrics(ctx, days) { return cache.key === cacheKey(ctx, days) ? cache.data : null; }

export function invalidateMetrics() { cache = { key: null, data: null }; }

/** Fetches `/api/metrics?days=N`, de-duplicating concurrent requests and caching the last response. */
export async function loadMetrics(ctx, days) {
  const key = cacheKey(ctx, days);
  if (cache.key === key && cache.data) return cache.data;
  if (inflight.key !== key) {
    const promise = ctx.api(`/api/metrics?days=${days}`)
      .then((data) => { cache = { key, data: normalize(data) }; return cache.data; })
      .finally(() => { if (inflight.key === key) inflight = { key: null, promise: null }; });
    inflight = { key, promise };
  }
  return inflight.promise;
}

function normalize(data) {
  const series = {};
  for (const metric of METRICS) series[metric.key] = Array.isArray(data?.series?.[metric.key]) ? data.series[metric.key] : [];
  return { ...data, sources: Array.isArray(data?.sources) ? data.sources : [], series, range: data?.range || {} };
}

// The current window plus the one before it, so change indicators have a baseline.
function fetchDays(days) { return Math.min(MAX_FETCH_DAYS, days * 2); }

function periodLabel(value) { return (PERIODS.find(([key]) => key === value) || PERIODS[1])[1]; }

function todayKey() { return localDateKey(new Date()); }

function windows(data) {
  const days = periodDays(period);
  const to = data.range?.to || todayKey();
  const current = dateRange(to, days);
  return { days, current, previous: previousRange(current.from, current.to) };
}

function workoutDates(state) {
  const dates = new Set();
  for (const workout of state.workouts || []) {
    const key = localDateKey(new Date(workout?.start_time));
    if (key) dates.add(key);
  }
  return dates;
}

function displayUnit(ctx, metric) {
  if (metric.unit === 'kg') return ctx.state.settings?.unit === 'lb' ? 'lb' : 'kg';
  return metric.unit;
}

function displaySeries(ctx, metric, data) {
  const series = data.series[metric.key] || [];
  if (metric.unit !== 'kg' || displayUnit(ctx, metric) !== 'lb') return series;
  return series.map((point) => ({ ...point, value: point.value == null ? null : Number(point.value) * LB_PER_KG }));
}

function formatterFor(metric, unit) {
  if (metric.category === 'sleep') return (value) => formatMinutes(value);
  return (value) => (value == null ? '—' : `${formatValue(value, metric.decimals)} ${unit}`.trim());
}

function hasData(data, key) { return (data.series[key] || []).length > 0; }

function connectedSource(ctx, data) {
  return ctx.state.mode === 'demo' || Boolean(ctx.state.settings?.googleHealth?.connected) || data.sources.length > 0;
}

function button(node, className, text) {
  const control = node('button', `button ${className}`, text);
  control.type = 'button';
  return control;
}

function viewHeader(ctx, title, description, ...actions) {
  const { node, add } = ctx;
  const header = node('header', 'view-header');
  const copy = node('div', 'view-heading');
  add(copy, node('p', 'eyebrow', 'Health metrics'), node('h1', '', title), node('p', '', description));
  const controls = node('div', 'metrics-actions');
  add(controls, ...actions);
  add(header, copy, controls);
  return header;
}

function periodPicker(ctx, onChange) {
  const { node } = ctx;
  const picker = node('div', 'period-picker');
  picker.setAttribute('aria-label', 'Date range');
  for (const [value, label] of PERIODS) {
    const control = node('button', '', label);
    control.type = 'button';
    control.dataset.period = value;
    control.setAttribute('aria-pressed', String(value === period));
    control.addEventListener('click', () => { if (period !== value) { period = value; onChange(); } });
    picker.append(control);
  }
  return picker;
}

function syncButton(ctx, view) {
  const { node, add, api, refresh, toast, state } = ctx;
  const control = button(node, 'secondary', '');
  add(control, node('span', 'sync-icon', '↻'), node('span', '', 'Sync Google Health'));
  const connected = Boolean(state.settings?.googleHealth?.connected);
  control.disabled = !connected;
  control.title = connected ? 'Import the latest Google Health data' : 'Connect Google Health in Settings to sync';
  control.addEventListener('click', async () => {
    control.disabled = true;
    control.classList.add('syncing');
    try {
      const result = await api('/api/metrics/sync', { method: 'POST', body: '{}' });
      invalidateMetrics();
      const imported = Number(result?.imported) || 0;
      const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : [];
      await refresh();
      const summary = `${formatValue(imported)} data point${imported === 1 ? '' : 's'} imported.`;
      toast(warnings.length ? 'Google Health sync finished with warnings' : 'Google Health sync complete', warnings.length ? `${summary} ${warnings.join(' ')}` : summary);
    } catch (error) {
      toast('Google Health sync failed', error.message || 'Please try again.', 'error');
    } finally {
      if (view.isConnected) { control.disabled = !connected; control.classList.remove('syncing'); }
    }
  });
  return control;
}

function loader(ctx, text) {
  const { node, add } = ctx;
  const panel = node('section', 'panel');
  const status = node('div', 'metrics-loading');
  status.setAttribute('role', 'status');
  add(status, node('span', 'loader'), node('p', '', text));
  panel.append(status);
  return panel;
}

function emptyState(ctx, title, copy, icon = '○', action = null) {
  const { node, add } = ctx;
  const empty = node('div', 'empty-state');
  add(empty, node('div', 'empty-state-icon', icon), node('h2', '', title), node('p', '', copy), action);
  return empty;
}

function panelHeader(ctx, title, subtitle, extra) {
  const { node, add } = ctx;
  const header = node('header', 'panel-header');
  const copy = node('div');
  add(copy, node('h2', '', title), subtitle ? node('p', '', subtitle) : null);
  add(header, copy, extra);
  return header;
}

function settingsLink(node, text = 'Open settings') {
  const link = node('a', 'button secondary', text);
  link.href = '#settings';
  return link;
}

function sourceEmptyState(ctx, data) {
  if (!connectedSource(ctx, data)) {
    return emptyState(ctx, 'Connect Google Health', 'Add your Google OAuth client in Settings and connect your account to import steps, heart, sleep, and body metrics.', '∿', settingsLink(ctx.node));
  }
  return emptyState(ctx, 'Sync to load your metrics', ctx.state.mode === 'demo' ? 'No demo metrics were generated for this range.' : 'Use “Sync Google Health” above to import your recent health data.', '↻');
}

function noSeriesData(data) { return METRICS.every((metric) => !hasData(data, metric.key)); }

/** Renders a view now, then swaps in fresh data when it arrives. */
function loadInto(ctx, view, body, days, fill) {
  const cached = cachedMetrics(ctx, days);
  if (cached) { fill(cached); return; }
  body.replaceChildren(loader(ctx, 'Loading health metrics…'));
  loadMetrics(ctx, days).then((data) => {
    if (!view.isConnected) return;
    fill(data);
  }).catch((error) => {
    if (!view.isConnected) return;
    const panel = ctx.node('section', 'panel');
    panel.append(emptyState(ctx, 'Couldn’t load metrics', error.message || 'Check that the local server is running.', '!'));
    body.replaceChildren(panel);
    ctx.toast('Couldn’t load metrics', error.message || 'Please try again.', 'error');
  });
}

/** Change indicator plus its comparison text; changes that round to zero read as flat. */
function delta(ctx, change, format, decimals) {
  const { node } = ctx;
  if (change == null) return node('span', 'stat-delta flat', 'no previous window');
  const rounded = Number(change.toFixed(decimals));
  if (rounded === 0) return node('span', 'stat-delta flat', `no change vs previous ${periodLabel(period)}`);
  const up = rounded > 0;
  const span = node('span', `stat-delta ${up ? 'up' : 'down'}`, `${up ? '▲' : '▼'} ${format(Math.abs(rounded))}`);
  span.setAttribute('aria-label', `${up ? 'Up' : 'Down'} ${format(Math.abs(rounded))}`);
  return [span, document.createTextNode(` vs previous ${periodLabel(period)}`)];
}

function statCard(ctx, label, value, change, format, decimals, suffix = '') {
  const { node, add } = ctx;
  const note = node('p', 'stat-note');
  add(note, delta(ctx, change, format, decimals), suffix ? document.createTextNode(` · ${suffix}`) : null);
  return add(node('article', 'stat-card'), node('p', 'stat-label', label), node('p', 'stat-value', value), note);
}

// Dashboard chart cards: one metric per panel with a "Category · unit" subtitle.
const CHART_NOTES = {
  steps: () => 'steps per day',
  active_zone_minutes: () => 'minutes per day',
  sleep_minutes: () => 'time asleep per night, dated by the morning you woke up',
  weight_kg: (unit) => `${unit} with 7-day mean`,
};

function chartPanel(ctx, metric, unit, chart) {
  const { node, add } = ctx;
  const category = CATEGORIES.find((entry) => entry.key === metric.category)?.label || metric.category;
  const note = (CHART_NOTES[metric.key] || ((value) => value))(unit);
  return add(node('section', 'panel metric-panel'), panelHeader(ctx, metric.label, `${category} · ${note}`), chart);
}

function rerender(view, next) { if (view.isConnected) view.replaceWith(next); }

export function renderMetricsDashboard(ctx) {
  const { node, add, state } = ctx;
  const view = node('section', 'view section-page metrics-view');
  const body = node('div', 'metrics-body');
  add(view, viewHeader(ctx, 'Dashboard', 'Daily activity, heart, sleep, and body metrics alongside your training days.', periodPicker(ctx, () => rerender(view, renderMetricsDashboard(ctx))), syncButton(ctx, view)), body);
  const days = periodDays(period);
  loadInto(ctx, view, body, fetchDays(days), (data) => {
    body.replaceChildren();
    if (noSeriesData(data)) { const panel = node('section', 'panel'); panel.append(sourceEmptyState(ctx, data)); body.append(panel); return; }
    const { current, previous } = windows(data);
    const markers = workoutDates(state);
    const filled = (metric) => fillDays(displaySeries(ctx, metric, data), current.from, current.to);
    const previousFilled = (metric) => fillDays(displaySeries(ctx, metric, data), previous.from, previous.to);

    const stepsMetric = metricByKey('steps'), hrMetric = metricByKey('resting_hr'), sleepMetric = metricByKey('sleep_minutes'), weightMetric = metricByKey('weight_kg');
    const stepsFilled = filled(stepsMetric), hrFilled = filled(hrMetric), sleepFilled = filled(sleepMetric), weightFilled = filled(weightMetric);
    const steps = summarize(stepsFilled, previousFilled(stepsMetric));
    const hr = summarize(hrFilled, previousFilled(hrMetric));
    const sleep = summarize(sleepFilled, previousFilled(sleepMetric));
    const weight = summarize(weightFilled, previousFilled(weightMetric));
    const weightUnit = displayUnit(ctx, weightMetric);
    const stats = node('div', 'stat-grid');
    add(stats,
      statCard(ctx, 'Steps per day', steps.mean == null ? '—' : formatValue(steps.mean), steps.change, (value) => formatValue(value), 0),
      statCard(ctx, 'Resting heart rate', hr.mean == null ? '—' : `${formatValue(hr.mean)} bpm`, hr.change, (value) => `${formatValue(value)} bpm`, 0),
      statCard(ctx, 'Sleep per night', sleep.mean == null ? '—' : formatMinutes(sleep.mean), sleep.change, (value) => formatMinutes(value), 0),
      statCard(ctx, 'Weight', weight.latest == null ? '—' : `${formatValue(weight.latest, 1)} ${weightUnit}`, weight.change, (value) => `${formatValue(value, 1)} ${weightUnit}`, 1, weight.latestDate ? `latest ${labelDate(weight.latestDate)}` : ''),
    );
    body.append(stats);

    const grid = node('div', 'dashboard-grid metrics-grid');
    const card = (metric, build) => {
      const points = filled(metric);
      if (!points.some((point) => point.value != null)) return null;
      const unit = displayUnit(ctx, metric);
      const options = { points, unit, label: `${metric.label} by day`, decimals: metric.decimals, markers, compact: true, format: formatterFor(metric, unit) };
      return chartPanel(ctx, metric, unit, build(options));
    };
    const line = (metric) => card(metric, lineChart);
    const bars = (metric) => card(metric, barChart);
    const stack = sleepStack(data.series, current.from, current.to);
    const sleepCard = stack.some((row) => row.total != null)
      ? chartPanel(ctx, sleepMetric, 'min', stackedBarChart({ rows: stack, unit: 'min', label: 'Sleep stages by night', markers, compact: true }))
      : null;
    const weightCard = card(weightMetric, (options) => lineChart({ ...options, mean: rollingMean(options.points), label: 'Weight by day with 7-day mean' }));
    add(grid,
      bars(stepsMetric), line(hrMetric), sleepCard, line(metricByKey('hrv_ms')), weightCard,
      hasData(data, 'body_fat_pct') ? line(metricByKey('body_fat_pct')) : null,
      hasData(data, 'vo2max') ? line(metricByKey('vo2max')) : null,
      bars(metricByKey('active_zone_minutes')),
    );
    body.append(grid);
  });
  return view;
}

function metricSelect(ctx, onChange) {
  const { node } = ctx;
  const select = node('select', 'select metrics-select');
  select.setAttribute('aria-label', 'Metric');
  for (const category of CATEGORIES) {
    const group = node('optgroup');
    group.label = category.label;
    for (const metric of metricsInCategory(category.key)) {
      const option = node('option', '', metric.label);
      option.value = metric.key;
      option.selected = metric.key === trendMetric;
      group.append(option);
    }
    select.append(group);
  }
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function trendsHashKey() {
  const key = location.hash.slice(1).split('/')[1];
  return isMetricKey(key) ? key : null;
}

export function renderMetricsTrends(ctx) {
  const { node, add, state } = ctx;
  const fromHash = trendsHashKey();
  if (fromHash) trendMetric = fromHash;
  else if (location.hash.slice(1).split('/')[0] === 'metrics-trends') history.replaceState(null, '', `#metrics-trends/${trendMetric}`);
  const metric = metricByKey(trendMetric) || METRICS[0];
  const view = node('section', 'view section-page metrics-view');
  const body = node('div', 'metrics-body');
  const select = metricSelect(ctx, (key) => { trendMetric = key; location.hash = `#metrics-trends/${key}`; });
  add(view, viewHeader(ctx, 'Trends', 'Follow one metric over time and compare training days with rest days.', select, periodPicker(ctx, () => rerender(view, renderMetricsTrends(ctx)))), body);
  const days = periodDays(period);
  loadInto(ctx, view, body, fetchDays(days), (data) => {
    body.replaceChildren();
    if (noSeriesData(data)) { const panel = node('section', 'panel'); panel.append(sourceEmptyState(ctx, data)); body.append(panel); return; }
    const { current, previous } = windows(data);
    const unit = displayUnit(ctx, metric);
    const format = formatterFor(metric, unit);
    const filled = fillDays(displaySeries(ctx, metric, data), current.from, current.to);
    const means = rollingMean(filled);
    const markers = workoutDates(state);
    const stats = summarize(filled, fillDays(displaySeries(ctx, metric, data), previous.from, previous.to));
    const split = trainingDaySplit(filled, markers);

    const panel = node('section', 'panel');
    add(panel, panelHeader(ctx, metric.label, `${labelDate(current.from)} – ${labelDate(current.to)} · ${unit}${stats.count ? ` · ${stats.count} day${stats.count === 1 ? '' : 's'} with data` : ''}`));
    const options = { points: filled, mean: means, unit, label: `${metric.label} by day with 7-day mean`, decimals: metric.decimals, markers, height: 300, format };
    panel.append(metric.chart === 'bar' ? barChart(options) : lineChart(options));
    body.append(panel);

    const row = node('div', 'trend-stats');
    const mini = (label, value) => add(node('div', 'mini-metric'), node('span', '', label), node('strong', '', value));
    add(row,
      mini(stats.latestDate ? `Latest · ${labelDate(stats.latestDate)}` : 'Latest', format(stats.latest)),
      mini('Average', format(stats.mean)),
      mini('Minimum', format(stats.min)),
      mini('Maximum', format(stats.max)),
      mini('Training / rest days', `${format(split.training)} / ${format(split.rest)}`),
    );
    body.append(row);

    const tablePanel = node('section', 'panel');
    add(tablePanel, panelHeader(ctx, 'Daily values', 'Last 30 days · newest first'));
    const wrap = node('div', 'metrics-table');
    const table = node('table', 'sets-table');
    const head = node('thead'), headRow = node('tr');
    for (const text of ['Date', metric.label, '7-day mean', 'Day']) headRow.append(node('th', '', text));
    head.append(headRow);
    const tbody = node('tbody');
    const recent = filled.map((point, index) => ({ ...point, mean: means[index] })).slice(-30).reverse();
    for (const point of recent) {
      const tr = node('tr');
      add(tr,
        node('td', '', labelDate(point.date, { weekday: 'short', month: 'short', day: 'numeric' })),
        node('td', '', point.value == null ? '—' : format(point.value)),
        node('td', '', point.mean == null ? '—' : format(point.mean)),
        node('td', '', markers.has(point.date) ? 'Training' : 'Rest'),
      );
      tbody.append(tr);
    }
    add(table, head, tbody);
    wrap.append(table);
    tablePanel.append(wrap);
    body.append(tablePanel);
  });
  return view;
}
