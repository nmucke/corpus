// The one chart engine. Each builder returns a `.chart-wrap` element and uses
// the shared chart classes (chart-grid-line, chart-axis, chart-bar, chart-line,
// chart-dot). Inputs are point arrays `{ date, value }`; null values leave
// gaps. Geometry is FULL or COMPACT — pick it from the measured container with
// `mountChart()` rather than from the call site.

import { formatDay, formatDuration, formatNumber } from './format.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const FULL = { width: 760, left: 50, right: 22, top: 18, bottom: 38, height: 250, divisions: 4, maxLabels: 8 };
const COMPACT = { width: 420, left: 40, right: 12, top: 12, bottom: 30, height: 200, divisions: 2, maxLabels: 4 };
const MARKER_TOP = 4, MARKER_LENGTH = 6;
const MAX_DOTS = 90;
/** Container width (px) below which a chart uses the COMPACT geometry. */
export const COMPACT_WIDTH = 560;
const MEASURE_DEBOUNCE = 120;

// Formatting is shared with the rest of the front end; these aliases keep the
// existing metric-charts import surface working.
export const formatValue = formatNumber;
export const formatMinutes = formatDuration;
export const labelDate = formatDay;

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
}

function svgEl(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function withTitle(element, text) {
  const title = svgEl('title');
  title.textContent = text;
  element.append(title);
  return element;
}

function defaultFormat(unit, decimals) {
  return (value) => (unit ? `${formatValue(value, decimals)} ${unit}` : formatValue(value, decimals));
}

/**
 * Renders `build({ compact })` into `wrap`, choosing the geometry from the
 * measured container width. Re-renders only when the geometry actually flips,
 * and stops observing once `wrap` leaves the document.
 * @param {HTMLElement} wrap container to render into
 * @param {(options: { compact: boolean }) => Node} build chart factory
 */
export function mountChart(wrap, build) {
  let compact = null;
  const draw = (next) => {
    if (next === compact) return;
    compact = next;
    wrap.replaceChildren(build({ compact }));
  };
  // Render once from a best guess so the panel is never empty, then correct it
  // on the first real measurement.
  draw((wrap.clientWidth || COMPACT_WIDTH + 200) < COMPACT_WIDTH);

  let timer = 0;
  let stop = () => {};
  const measure = () => {
    if (!wrap.isConnected) { stop(); return; }
    const width = wrap.clientWidth || wrap.getBoundingClientRect().width;
    if (width) draw(width < COMPACT_WIDTH);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; measure(); }, MEASURE_DEBOUNCE);
  };
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(schedule);
    stop = () => { if (timer) clearTimeout(timer); timer = 0; observer.disconnect(); };
    observer.observe(wrap);
  } else if (typeof window !== 'undefined') {
    stop = () => { if (timer) clearTimeout(timer); timer = 0; window.removeEventListener('resize', schedule); };
    window.addEventListener('resize', schedule);
    schedule();
  }
  return wrap;
}

function frame({ label, height, count, compact = false, extraRight = 0 }) {
  const base = compact ? COMPACT : FULL;
  const geo = { ...base, right: base.right + extraRight };
  const h = height || geo.height;
  const wrap = el('div', compact ? 'chart-wrap chart-compact' : 'chart-wrap');
  const svg = svgEl('svg', { viewBox: `0 0 ${geo.width} ${h}`, role: 'img', 'aria-label': label });
  withTitle(svg, label);
  wrap.append(svg);
  const plotW = geo.width - geo.left - geo.right, plotH = h - geo.top - geo.bottom;
  const slot = plotW / Math.max(1, count);
  return { ...geo, compact, wrap, svg, height: h, plotW, plotH, slot, bottom: geo.top + plotH, x: (index) => geo.left + index * slot + slot / 2 };
}

function gridLines(chart, min, max, format) {
  const { svg, divisions } = chart;
  for (let i = 0; i <= divisions; i++) {
    const y = chart.top + (chart.plotH / divisions) * i;
    svg.append(svgEl('line', { x1: chart.left, y1: y, x2: chart.width - chart.right, y2: y, class: 'chart-grid-line' }));
    const label = svgEl('text', { x: chart.left - 8, y: y + 3, class: 'chart-axis', 'text-anchor': 'end' });
    label.textContent = format(max - ((max - min) * i) / divisions);
    svg.append(label);
  }
}

/** Right-hand ticks for a secondary series: top of scale and zero. */
function rightAxis(chart, max, format) {
  const x = chart.width - chart.right + 8;
  for (const [y, value] of [[chart.top + 3, max], [chart.bottom + 3, 0]]) {
    const label = svgEl('text', { x, y, class: 'chart-axis', 'text-anchor': 'start' });
    label.textContent = format(value);
    chart.svg.append(label);
  }
}

/**
 * At most `maxLabels` x labels. Daily keys keep the week-aligned cadence and
 * `start`/`middle`/`end` anchors; a caller-supplied `labelFor` (weekly bars,
 * per-session dots) falls back to an even step from the newest point.
 */
function drawXLabels(chart, count, labelFor, custom) {
  if (!count) return;
  const maxLabels = Math.max(1, chart.maxLabels);
  const step = custom
    ? Math.max(1, Math.ceil(count / maxLabels))
    : Math.max(7, Math.ceil(count / maxLabels / 7) * 7);
  for (let index = 0; index < count; index++) {
    if ((count - 1 - index) % step !== 0) continue;
    const anchor = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
    const label = svgEl('text', { x: chart.x(index), y: chart.height - 9, class: 'chart-axis', 'text-anchor': anchor });
    label.textContent = labelFor(index);
    chart.svg.append(label);
  }
}

function markerTicks(chart, dates, markers) {
  if (!(markers instanceof Set) || !markers.size) return 0;
  let drawn = 0;
  dates.forEach((date, index) => {
    if (!markers.has(date)) return;
    const x = chart.x(index);
    const tick = svgEl('line', { x1: x, x2: x, y1: chart.bottom + MARKER_TOP, y2: chart.bottom + MARKER_TOP + MARKER_LENGTH, class: 'chart-marker' });
    chart.svg.append(withTitle(tick, `Training day · ${labelDate(date)}`));
    drawn++;
  });
  return drawn;
}

function legend(entries) {
  const list = el('div', 'chart-legend metric-legend');
  for (const [swatchClass, text] of entries) {
    const item = el('span');
    item.append(el('i', swatchClass), document.createTextNode(text));
    list.append(item);
  }
  return list;
}

/** An empty chart is the compact empty state, inside the panel that titles it. */
function emptyChart(wrap, title, copy = 'Try a wider date range.') {
  const empty = el('div', 'empty-state is-compact chart-empty');
  empty.append(el('p', 'empty-state-title', title));
  if (copy) empty.append(el('p', '', copy));
  wrap.append(empty);
  return wrap;
}

function valueRange(values, { fromZero = false } = {}) {
  const present = values.filter((value) => value != null);
  if (!present.length) return { min: 0, max: 1 };
  let min = fromZero ? 0 : Math.min(...present);
  let max = Math.max(...present);
  if (fromZero) return { min: 0, max: Math.max(max, 1) };
  const spread = max - min;
  const padding = spread > 0 ? spread * 0.12 : Math.max(Math.abs(max) * 0.05, 1);
  return { min: min - padding, max: max + padding };
}

/**
 * Polylines for consecutive runs of non-null values; single points are covered
 * by dots. With `bridge` (dense series drawn without dots) gaps are joined so
 * sparse measurements still show as a line.
 */
function runs(chart, values, y, className, bridge = false) {
  let run = [];
  const flush = () => { if (run.length > 1) chart.svg.append(svgEl('polyline', { points: run.join(' '), class: className })); run = []; };
  values.forEach((value, index) => {
    if (value == null) { if (!bridge) flush(); return; }
    run.push(`${chart.x(index)},${y(value)}`);
  });
  flush();
}

/** Bars at least 1 unit wide with a 1-unit gap where the slot allows it. */
function barWidth(chart) { return Math.max(1, Math.min(31, chart.slot * 0.62, chart.slot - 1)); }

function labeller(points, xLabel) {
  return typeof xLabel === 'function'
    ? (index) => String(xLabel(points[index], index))
    : (index) => labelDate(points[index]?.date);
}

function finish(chart, points, markers, entries, xLabel) {
  drawXLabels(chart, points.length, labeller(points, xLabel), typeof xLabel === 'function');
  if (markerTicks(chart, points.map((point) => point.date), markers)) entries.push(['legend-marker', 'training day']);
  if (entries.length) chart.wrap.append(legend(entries));
  return chart.wrap;
}

/**
 * Line chart over point arrays with an optional rolling-mean overlay.
 * Dots are drawn only for series with at most 90 plotted points.
 * @param {{ points: {date:string,value:number|null}[], mean?: (number|null)[], unit?: string, label: string, seriesLabel?: string, decimals?: number, markers?: Set<string>, height?: number, format?: (value:number)=>string, axisFormat?: (value:number)=>string, xLabel?: (point:object,index:number)=>string, xLabels?: number, compact?: boolean }} options
 */
export function lineChart({ points = [], mean = null, unit = '', label = 'Trend', seriesLabel = '', decimals = 0, markers = null, height = 0, format = null, axisFormat = null, xLabel = null, xLabels = 0, compact = false }) {
  const chart = frame({ label, height, count: points.length, compact });
  if (xLabels) chart.maxLabels = xLabels;
  const values = points.map((point) => point.value);
  const plotted = values.filter((value) => value != null).length;
  if (!plotted) return emptyChart(chart.wrap, 'No data in this range');
  const fmt = format || defaultFormat(unit, decimals);
  const axisFmt = axisFormat || ((value) => formatValue(value, decimals));
  const meanValues = Array.isArray(mean) ? mean : [];
  const range = valueRange([...values, ...meanValues]);
  const y = (value) => chart.top + (1 - (value - range.min) / (range.max - range.min)) * chart.plotH;
  gridLines(chart, range.min, range.max, axisFmt);
  if (meanValues.length) runs(chart, meanValues, y, 'chart-mean');
  const dots = plotted <= MAX_DOTS;
  runs(chart, values, y, 'chart-line', !dots);
  const labelFor = labeller(points, xLabel);
  if (dots) {
    const radius = compact ? (points.length > 40 ? 2.5 : 3.5) : points.length > 40 ? 3 : 4;
    points.forEach((point, index) => {
      if (point.value == null) return;
      const dot = svgEl('circle', { cx: chart.x(index), cy: y(point.value), r: radius, class: 'chart-dot' });
      const meanText = meanValues[index] != null ? ` · 7-day mean ${fmt(meanValues[index])}` : '';
      chart.svg.append(withTitle(dot, `${labelFor(index)}: ${fmt(point.value)}${meanText}`));
    });
  }
  const entries = seriesLabel ? [['legend-line', seriesLabel]] : [];
  if (meanValues.some((value) => value != null)) entries.push(['legend-mean', '7-day mean']);
  return finish(chart, points, markers, entries, xLabel);
}

/**
 * Bar chart over point arrays, with an optional rolling-mean line on the same
 * scale and an optional `overlay` series on its own right-hand scale.
 * @param {{ points: {date:string,value:number|null}[], mean?: (number|null)[], overlay?: {values:(number|null)[], label?:string, format?:(value:number)=>string}, unit?: string, label: string, seriesLabel?: string, decimals?: number, markers?: Set<string>, height?: number, format?: (value:number)=>string, axisFormat?: (value:number)=>string, xLabel?: (point:object,index:number)=>string, xLabels?: number, compact?: boolean }} options
 */
export function barChart({ points = [], mean = null, overlay = null, unit = '', label = 'Daily totals', seriesLabel = '', decimals = 0, markers = null, height = 0, format = null, axisFormat = null, xLabel = null, xLabels = 0, compact = false }) {
  const overlayValues = Array.isArray(overlay?.values) ? overlay.values : [];
  const hasOverlay = overlayValues.some((value) => value != null);
  const chart = frame({ label, height, count: points.length, compact, extraRight: hasOverlay ? (compact ? 30 : 44) : 0 });
  if (xLabels) chart.maxLabels = xLabels;
  const values = points.map((point) => point.value);
  if (!values.some((value) => value != null)) return emptyChart(chart.wrap, 'No data in this range');
  const fmt = format || defaultFormat(unit, decimals);
  const axisFmt = axisFormat || ((value) => formatValue(value, decimals));
  const meanValues = Array.isArray(mean) ? mean : [];
  const range = valueRange([...values, ...meanValues], { fromZero: true });
  const y = (value) => chart.top + (1 - value / range.max) * chart.plotH;
  gridLines(chart, 0, range.max, axisFmt);
  const labelFor = labeller(points, xLabel);
  const barW = barWidth(chart);
  points.forEach((point, index) => {
    if (point.value == null) return;
    const top = y(Math.max(0, point.value));
    const bar = svgEl('rect', { x: chart.x(index) - barW / 2, y: top, width: barW, height: Math.max(0, chart.bottom - top), rx: Math.min(4, barW / 2), class: 'chart-bar' });
    const meanText = meanValues[index] != null ? ` · 7-day mean ${fmt(meanValues[index])}` : '';
    chart.svg.append(withTitle(bar, `${labelFor(index)}: ${fmt(point.value)}${meanText}`));
  });
  if (meanValues.length) runs(chart, meanValues, y, 'chart-mean');
  const entries = seriesLabel ? [['legend-bar', seriesLabel]] : [];
  if (meanValues.some((value) => value != null)) entries.push(['legend-mean', '7-day mean']);
  if (hasOverlay) {
    const overlayFmt = overlay.format || ((value) => formatValue(value));
    const overlayMax = Math.max(...overlayValues.filter((value) => value != null), 1);
    const overlayY = (value) => chart.top + (1 - value / overlayMax) * chart.plotH;
    rightAxis(chart, overlayMax, overlayFmt);
    runs(chart, overlayValues, overlayY, 'chart-line');
    const radius = compact ? 2.5 : 3.5;
    overlayValues.forEach((value, index) => {
      if (value == null || index >= points.length) return;
      const dot = svgEl('circle', { cx: chart.x(index), cy: overlayY(value), r: radius, class: 'chart-dot' });
      chart.svg.append(withTitle(dot, `${labelFor(index)}: ${overlayFmt(value)}`));
    });
    if (overlay.label) entries.push(['legend-dot', overlay.label]);
  }
  return finish(chart, points, markers, entries, xLabel);
}

const STAGES = [['deep', 'Deep'], ['light', 'Light'], ['rem', 'REM'], ['awake', 'Awake']];

/**
 * Stacked sleep-stage bars from `sleepStack` rows. Nights without stage data
 * draw the total as a plain bar so they still appear.
 * @param {{ rows: {date:string,deep:number|null,light:number|null,rem:number|null,awake:number|null,total:number|null}[], unit?: string, label: string, markers?: Set<string>, height?: number, compact?: boolean }} options
 */
export function stackedBarChart({ rows = [], unit = 'min', label = 'Sleep stages', markers = null, height = 0, compact = false }) {
  const chart = frame({ label, height, count: rows.length, compact });
  const stageSum = (row) => STAGES.reduce((sum, [stage]) => sum + (row[stage] ?? 0), 0);
  const hasStages = (row) => STAGES.some(([stage]) => row[stage] != null);
  const heights = rows.map((row) => (hasStages(row) ? stageSum(row) : row.total));
  if (!heights.some((value) => value != null)) return emptyChart(chart.wrap, 'No sleep data in this range');
  const fmt = unit === 'min' ? formatMinutes : (value) => `${formatValue(value)} ${unit}`;
  const max = Math.max(...heights.filter((value) => value != null), 1);
  const scale = (minutes) => (minutes / max) * chart.plotH;
  gridLines(chart, 0, max, (value) => (unit === 'min' ? formatMinutes(value) : formatValue(value)));
  const barW = barWidth(chart);
  let anyStages = false;
  rows.forEach((row, index) => {
    if (heights[index] == null) return;
    const group = svgEl('g');
    const stageText = STAGES.filter(([stage]) => row[stage] != null).map(([stage, name]) => `${name} ${formatMinutes(row[stage])}`).join(' · ');
    withTitle(group, `${labelDate(row.date)}: ${fmt(row.total)} asleep${stageText ? ` · ${stageText}` : ''}`);
    const x = chart.x(index) - barW / 2;
    if (hasStages(row)) {
      anyStages = true;
      let cursor = chart.bottom;
      for (const [stage] of STAGES) {
        if (!row[stage]) continue;
        const h = scale(row[stage]);
        cursor -= h;
        group.append(svgEl('rect', { x, y: cursor, width: barW, height: h, class: `chart-bar sleep-${stage}` }));
      }
    } else {
      const h = scale(row.total);
      group.append(svgEl('rect', { x, y: chart.bottom - h, width: barW, height: h, rx: Math.min(4, barW / 2), class: 'chart-bar' }));
    }
    chart.svg.append(group);
  });
  const entries = anyStages ? STAGES.map(([stage, name]) => [`sleep-${stage}`, name]) : [];
  return finish(chart, rows, markers, entries, null);
}
