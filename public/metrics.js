// Metrics views: the health Dashboard (#metrics) and Trends (#metrics-trends).
// Both are built entirely on the shared helpers from `context()` (heading,
// periodPicker, statCard, panelHeader, emptyState, miniMetric, format, period).
//
// Fetching: the widest window (MAX_FETCH_DAYS) is fetched once per data mode
// and cached, then every range is sliced client-side by metrics-analytics.js.
// A range change is therefore instant — the body never collapses to a loader.

import { CATEGORIES, METRICS, isMetricKey, metricByKey, metricsInCategory } from './metrics-catalog.js';
import { localDateKey } from './program-timeline.js';
import { dateRange, fillDays, previousRange, rollingMean, sleepStack, summarize, trainingDaySplit } from './metrics-analytics.js';
import { barChart, lineChart, mountChart, stackedBarChart } from './metric-charts.js';

/** The widest window the server will serve, and what `All` means here (D10). */
const MAX_FETCH_DAYS = 730;

let trendMetric = 'steps';
let cache = { key: null, data: null };
let inflight = { key: null, promise: null };

function cacheKey(ctx) { return ctx.state?.mode || 'demo'; }

/** Returns the cached response for the current data mode, or null. */
export function cachedMetrics(ctx) { return cache.key === cacheKey(ctx) ? cache.data : null; }

export function invalidateMetrics() { cache = { key: null, data: null }; }

/** Fetches the widest window, de-duplicating concurrent requests and caching the response. */
export async function loadMetrics(ctx) {
  const key = cacheKey(ctx);
  if (cache.key === key && cache.data) return cache.data;
  if (inflight.key !== key) {
    const promise = ctx.api(`/api/metrics?days=${MAX_FETCH_DAYS}`)
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

/* ------------------------------------------------------------------ windows */

function rangeDays(ctx) { return ctx.period.days(ctx.period.get()) ?? MAX_FETCH_DAYS; }

/** The selected window plus the one before it, so deltas have a baseline. */
function windows(ctx, data) {
  const to = data.range?.to || localDateKey(new Date());
  const current = dateRange(to, rangeDays(ctx));
  return { current, previous: previousRange(current.from, current.to) };
}

function workoutDates(state) {
  const dates = new Set();
  for (const workout of state.workouts || []) {
    const key = localDateKey(new Date(workout?.start_time));
    if (key) dates.add(key);
  }
  return dates;
}

/* --------------------------------------------------------------- formatting */

function displayUnit(ctx, metric) {
  if (metric.unit === 'kg') return ctx.state.settings?.unit === 'lb' ? 'lb' : 'kg';
  return metric.unit;
}

function displaySeries(ctx, metric, data) {
  const series = data.series[metric.key] || [];
  if (metric.unit !== 'kg') return series;
  const unit = displayUnit(ctx, metric);
  if (unit !== 'lb') return series;
  return series.map((point) => ({ ...point, value: ctx.format.convertKg(point.value, 'lb') }));
}

/** Tooltip and chip voice: the number with its unit. */
function valueFormat(ctx, metric, unit) {
  const { formatDuration, formatNumber, MISSING } = ctx.format;
  if (metric.category === 'sleep') return (value) => formatDuration(value);
  return (value) => (value == null ? MISSING : `${formatNumber(value, metric.decimals)} ${unit}`.trim());
}

/** Table voice: the bare number — the unit is in the column header (D21). */
function cellFormat(ctx, metric) {
  const { formatDuration, formatNumber } = ctx.format;
  if (metric.category === 'sleep') return (value) => formatDuration(value);
  return (value) => formatNumber(value, metric.decimals);
}

/** Chart axes are the one place large numbers abbreviate (D21). */
function axisFormat(ctx, metric, points) {
  const { formatCompact, formatDuration, formatNumber } = ctx.format;
  if (metric.category === 'sleep') return (value) => formatDuration(value);
  const max = Math.max(0, ...points.map((point) => Math.abs(point.value ?? 0)));
  return max >= 10000 ? formatCompact : (value) => formatNumber(value, metric.decimals);
}

/** A column header carries the unit unless the metric label already does. */
function columnLabel(metric, unit) {
  if (metric.category === 'sleep' || metric.unit === 'steps') return metric.label;
  return `${metric.label} (${unit})`;
}

/** `Jun 19 – Sep 10`, with the year once a window crosses one. */
function rangeLabel(ctx, range) {
  const options = String(range.from).slice(0, 4) === String(range.to).slice(0, 4)
    ? { month: 'short', day: 'numeric' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return `${ctx.format.formatDay(range.from, options)} – ${ctx.format.formatDay(range.to, options)}`;
}

function hasData(data, key) { return (data.series[key] || []).length > 0; }
function noSeriesData(data) { return METRICS.every((metric) => !hasData(data, metric.key)); }

function connectedSource(ctx, data) {
  return ctx.state.mode === 'demo' || Boolean(ctx.state.settings?.googleHealth?.connected) || data.sources.length > 0;
}

/* ------------------------------------------------------------------- panels */

function panel(ctx, ...children) { return ctx.add(ctx.node('section', 'panel'), ...children); }

function loadingPanel(ctx) {
  const { node, add } = ctx;
  const status = node('div', 'loading-block');
  status.setAttribute('role', 'status');
  add(status, node('span', 'loader'), node('p', '', 'Loading health metrics…'));
  return panel(ctx, status);
}

function failurePanel(ctx, error, retry) {
  return panel(ctx, ctx.emptyState({
    title: 'Couldn’t load metrics',
    copy: error.message || 'Check that the local server is still running.',
    icon: '!',
    action: ctx.button('Try again', { variant: 'secondary', onClick: retry }),
  }));
}

/** Imports the latest Google Health data straight from the empty state (D1: no header sync). */
function syncNowButton(ctx) {
  const control = ctx.button('Sync now', {
    variant: 'secondary',
    icon: '↻',
    title: 'Import the latest Google Health data',
    onClick: async () => {
      ctx.setBusy(control, true);
      try {
        const result = await ctx.api('/api/metrics/sync', { method: 'POST', body: '{}' });
        invalidateMetrics();
        const imported = Number(result?.imported) || 0;
        const warnings = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : [];
        const demo = (result?.mode || ctx.state.mode) === 'demo';
        await ctx.refresh();
        const extra = [...warnings];
        if (demo) extra.push('Switch to live data to see the changes.');
        ctx.toast('Google Health synced', [`${ctx.format.plural(imported, 'data point')} imported.`, ...extra].join(' '));
      } catch (error) {
        ctx.toast('Couldn’t sync Google Health', error.message || 'Please try again.', 'error');
      } finally {
        if (control.isConnected) ctx.setBusy(control, false);
      }
    },
  });
  return control;
}

/** Nothing to show: either the source is not connected, or it has never synced. */
function sourceEmptyState(ctx, data) {
  if (!connectedSource(ctx, data)) {
    return ctx.emptyState({
      title: 'Connect Google Health',
      copy: 'Add your Google OAuth client in Settings and connect your account to import steps, heart, sleep and body metrics.',
      icon: '∿',
      action: ctx.settingsLink('Open Settings', { asButton: true }),
    });
  }
  return ctx.emptyState({
    title: 'Sync to load your metrics',
    copy: ctx.state.mode === 'demo'
      ? 'No demo metrics were generated for this archive. Sync to import your own Google Health data instead.'
      : 'Import your recent steps, heart, sleep and body data from Google Health.',
    icon: '↻',
    action: syncNowButton(ctx),
  });
}

// Panel subtitles are scope metadata: "<category> · <what one mark covers>".
const CHART_SCOPE = {
  steps: () => 'steps per day',
  active_zone_minutes: () => 'minutes per day',
  sleep_minutes: () => 'per night, by stage',
  weight_kg: (unit) => `${unit} with 7-day mean`,
};

function chartSubtitle(metric, unit) {
  const category = CATEGORIES.find((entry) => entry.key === metric.category)?.label || metric.category;
  return `${category} · ${(CHART_SCOPE[metric.key] || ((value) => `${value} per day`))(unit)}`;
}

/**
 * A titled panel holding one chart. `build({ compact })` is called by
 * `mountChart`, which picks the geometry from the measured container — the
 * call site never passes `compact` (D12).
 */
function chartPanel(ctx, title, subtitle, build) {
  const { node } = ctx;
  const mount = node('div', 'chart-mount');
  mountChart(mount, build);
  return panel(ctx, ctx.panelHeader(title, subtitle), mount);
}

/* ------------------------------------------------------------ view plumbing */

/** Keeps the picker's pressed state in sync when only the body re-renders. */
function markPeriod(picker, value) {
  for (const control of picker.querySelectorAll('button')) {
    control.setAttribute('aria-pressed', String(control.dataset.period === value));
  }
}

/**
 * Fills `body` from cache when possible. On a first paint it shows a loader
 * panel; on a range change it keeps the rendered body, reserves its height and
 * dims it until the data lands, so the page never collapses (DASH-8).
 */
function loadBody(ctx, view, body, fill) {
  const cached = cachedMetrics(ctx);
  if (cached) { fill(cached); return; }
  if (body.childElementCount) {
    body.style.minHeight = `${body.offsetHeight}px`;
    body.setAttribute('aria-busy', 'true');
    body.classList.add('is-refreshing');
  } else {
    body.replaceChildren(loadingPanel(ctx));
  }
  const settle = () => {
    body.style.minHeight = '';
    body.removeAttribute('aria-busy');
    body.classList.remove('is-refreshing');
  };
  loadMetrics(ctx)
    .then((data) => { if (!view.isConnected) return; settle(); fill(data); })
    .catch((error) => {
      if (!view.isConnected) return;
      settle();
      body.replaceChildren(failurePanel(ctx, error, () => loadBody(ctx, view, body, fill)));
      ctx.toast('Couldn’t load metrics', error.message || 'Please try again.', 'error');
    });
}

/** The shell both metrics views share: heading + a `.panel-stack` body. */
function metricsView(ctx, title, description, buildBody, extraActions = []) {
  const { node, add } = ctx;
  const view = node('section', 'view section-page');
  const body = node('div', 'panel-stack');
  const fill = (data) => body.replaceChildren(...buildBody(ctx, data));
  const picker = ctx.periodPicker((value) => { markPeriod(picker, value); loadBody(ctx, view, body, fill); });
  add(view, ctx.heading('Metrics', title, description, ...extraActions, picker), body);
  loadBody(ctx, view, body, fill);
  return view;
}

/* ---------------------------------------------------------------- dashboard */

function dashboardBody(ctx, data) {
  const { node, add, state } = ctx;
  const { formatDay, formatDuration, formatNumber } = ctx.format;
  if (noSeriesData(data)) return [panel(ctx, sourceEmptyState(ctx, data))];

  const { current, previous } = windows(ctx, data);
  const markers = workoutDates(state);
  const filled = (metric) => fillDays(displaySeries(ctx, metric, data), current.from, current.to);
  const previousFilled = (metric) => fillDays(displaySeries(ctx, metric, data), previous.from, previous.to);
  const window = (metric) => summarize(filled(metric), previousFilled(metric));

  const stepsMetric = metricByKey('steps');
  const hrMetric = metricByKey('resting_hr');
  const sleepMetric = metricByKey('sleep_minutes');
  const weightMetric = metricByKey('weight_kg');
  const steps = window(stepsMetric);
  const hr = window(hrMetric);
  const sleep = window(sleepMetric);
  const weight = window(weightMetric);
  const weightUnit = displayUnit(ctx, weightMetric);

  const stats = node('div', 'stat-grid');
  add(stats,
    ctx.statCard('Steps per day', formatNumber(steps.mean), { change: steps.change }),
    ctx.statCard('Resting heart rate (bpm)', formatNumber(hr.mean), { change: hr.change }),
    ctx.statCard('Sleep per night', formatDuration(sleep.mean), { change: sleep.change, format: (value) => formatDuration(value) }),
    ctx.statCard(`Weight (${weightUnit})`, formatNumber(weight.latest, 1), {
      change: weight.change,
      format: (value) => formatNumber(value, 1),
      decimals: 1,
      suffix: weight.latestDate ? `latest ${formatDay(weight.latestDate)}` : '',
    }),
  );

  const card = (metric, build) => {
    const points = filled(metric);
    if (!points.some((point) => point.value != null)) return null;
    const unit = displayUnit(ctx, metric);
    const options = {
      points,
      unit,
      label: `${metric.label} by day`,
      decimals: metric.decimals,
      markers,
      format: valueFormat(ctx, metric, unit),
      axisFormat: axisFormat(ctx, metric, points),
    };
    return chartPanel(ctx, metric.label, chartSubtitle(metric, unit), ({ compact }) => build({ ...options, compact }));
  };
  const line = (metric) => card(metric, lineChart);
  const bars = (metric) => card(metric, barChart);

  const stack = sleepStack(data.series, current.from, current.to);
  const sleepCard = stack.some((row) => row.total != null)
    ? chartPanel(ctx, sleepMetric.label, chartSubtitle(sleepMetric, 'min'), ({ compact }) => stackedBarChart({
      rows: stack, unit: 'min', label: 'Sleep stages by night', markers, compact,
    }))
    : null;
  const weightCard = card(weightMetric, (options) => lineChart({
    ...options,
    mean: rollingMean(options.points),
    label: `Weight by day with 7-day mean in ${weightUnit}`,
  }));

  const grid = node('div', 'metrics-grid');
  add(grid,
    bars(stepsMetric), line(hrMetric), sleepCard, line(metricByKey('hrv_ms')), weightCard,
    hasData(data, 'body_fat_pct') ? line(metricByKey('body_fat_pct')) : null,
    hasData(data, 'vo2max') ? line(metricByKey('vo2max')) : null,
    bars(metricByKey('active_zone_minutes')),
  );
  return [stats, grid];
}

export function renderMetricsDashboard(ctx) {
  return metricsView(
    ctx,
    'Dashboard',
    'Daily activity, heart, sleep and body metrics alongside your training days.',
    dashboardBody,
  );
}

/* ------------------------------------------------------------------- trends */

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

function summaryPanel(ctx, stats, split, current, format) {
  const { node, add } = ctx;
  const { formatDay } = ctx.format;
  const row = node('div', 'trend-stats');
  add(row,
    ctx.miniMetric(stats.latestDate ? `Latest · ${formatDay(stats.latestDate)}` : 'Latest', format(stats.latest)),
    ctx.miniMetric('Average', format(stats.mean)),
    ctx.miniMetric('Minimum', format(stats.min)),
    ctx.miniMetric('Maximum', format(stats.max)),
    ctx.miniMetric('Training days', format(split.training)),
    ctx.miniMetric('Rest days', format(split.rest)),
  );
  return panel(ctx, ctx.panelHeader('Summary', rangeLabel(ctx, current)), row);
}

function tablePanel(ctx, metric, unit, rows, markers) {
  const { node, add } = ctx;
  const { formatDay, MISSING } = ctx.format;
  const cell = cellFormat(ctx, metric);
  const table = node('table', 'sets-table');
  const headRow = node('tr');
  for (const text of ['Date', columnLabel(metric, unit), '7-day mean', 'Day']) headRow.append(node('th', '', text));
  const tbody = node('tbody');
  for (const point of rows) {
    add(tbody, add(node('tr'),
      node('td', '', formatDay(point.date, { weekday: 'short', month: 'short', day: 'numeric' })),
      node('td', '', point.value == null ? MISSING : cell(point.value)),
      node('td', '', point.mean == null ? MISSING : cell(point.mean)),
      node('td', '', markers.has(point.date) ? 'Training' : 'Rest'),
    ));
  }
  add(table, add(node('thead'), headRow), tbody);
  return panel(ctx, ctx.panelHeader('Daily values', 'Last 30 days · newest first'), add(node('div', 'metrics-table'), table));
}

function trendsBody(ctx, data) {
  const { state } = ctx;
  const { plural } = ctx.format;
  if (noSeriesData(data)) return [panel(ctx, sourceEmptyState(ctx, data))];

  const metric = metricByKey(trendMetric) || METRICS[0];
  const { current, previous } = windows(ctx, data);
  const unit = displayUnit(ctx, metric);
  const format = valueFormat(ctx, metric, unit);
  const points = fillDays(displaySeries(ctx, metric, data), current.from, current.to);
  const means = rollingMean(points);
  const markers = workoutDates(state);
  const stats = summarize(points, fillDays(displaySeries(ctx, metric, data), previous.from, previous.to));
  const split = trainingDaySplit(points, markers);

  const scope = metric.category === 'sleep' ? 'per night' : unit;
  const subtitle = `${rangeLabel(ctx, current)} · ${scope}${stats.count ? ` · ${plural(stats.count, 'day')} with data` : ''}`;
  const build = metric.chart === 'bar' ? barChart : lineChart;
  const chart = chartPanel(ctx, metric.label, subtitle, ({ compact }) => build({
    points,
    mean: means,
    unit,
    label: `${metric.label} by day with 7-day mean`,
    decimals: metric.decimals,
    markers,
    format,
    axisFormat: axisFormat(ctx, metric, points),
    height: compact ? 0 : 300,
    compact,
  }));

  const recent = points.map((point, index) => ({ ...point, mean: means[index] })).slice(-30).reverse();
  return [chart, summaryPanel(ctx, stats, split, current, format), tablePanel(ctx, metric, unit, recent, markers)];
}

export function renderMetricsTrends(ctx) {
  const fromHash = trendsHashKey();
  if (fromHash) trendMetric = fromHash;
  else if (location.hash.slice(1).split('/')[0] === 'metrics-trends') history.replaceState(null, '', `#metrics-trends/${trendMetric}`);
  const select = metricSelect(ctx, (key) => { trendMetric = key; location.hash = `#metrics-trends/${key}`; });
  return metricsView(
    ctx,
    'Trends',
    'Follow one metric over time and compare training days with rest days.',
    trendsBody,
    [select],
  );
}
