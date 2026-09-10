// SVG chart builders for the Metrics module. Each builder returns a
// `.chart-wrap` element and reuses the chart classes from app.js
// (chart-grid-line, chart-axis, chart-bar, chart-line, chart-dot) so the
// charts inherit the existing look. Inputs are day-filled arrays from
// metrics-analytics.js; null values leave gaps. `compact: true` picks a
// smaller viewBox with fewer labels for the two-column dashboard cards.

const SVG_NS = 'http://www.w3.org/2000/svg';
const FULL = { width: 760, left: 50, right: 22, top: 18, bottom: 38, height: 250, divisions: 4, maxLabels: 8 };
const COMPACT = { width: 420, left: 40, right: 12, top: 12, bottom: 30, height: 200, divisions: 2, maxLabels: 4 };
const MARKER_TOP = 4, MARKER_LENGTH = 6;
const MAX_DOTS = 90;

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

export function formatValue(value, decimals = 0) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: 0 }).format(Number(value));
}

/** Minutes as `7h 12m`; whole hours drop the minutes part. */
export function formatMinutes(minutes) {
  if (minutes == null || !Number.isFinite(Number(minutes))) return '—';
  const total = Math.round(Number(minutes));
  const hours = Math.floor(total / 60), remainder = total % 60;
  if (!hours) return `${remainder}m`;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

/** Formats a 'YYYY-MM-DD' key in the local calendar without timezone shifts. */
export function labelDate(key, options = { month: 'short', day: 'numeric' }) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!match) return 'Unknown date';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function defaultFormat(unit, decimals) {
  return (value) => (unit ? `${formatValue(value, decimals)} ${unit}` : formatValue(value, decimals));
}

function frame({ label, height, count, compact = false }) {
  const geo = compact ? COMPACT : FULL;
  const h = height || geo.height;
  const wrap = el('div', compact ? 'chart-wrap chart-compact' : 'chart-wrap');
  const svg = svgEl('svg', { viewBox: `0 0 ${geo.width} ${h}`, role: 'img', 'aria-label': label });
  withTitle(svg, label);
  wrap.append(svg);
  const plotW = geo.width - geo.left - geo.right, plotH = h - geo.top - geo.bottom;
  const slot = plotW / Math.max(1, count);
  return { ...geo, wrap, svg, height: h, plotW, plotH, slot, bottom: geo.top + plotH, x: (index) => geo.left + index * slot + slot / 2 };
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

function xLabels(chart, dates) {
  const count = dates.length;
  const step = Math.max(7, Math.ceil(count / chart.maxLabels / 7) * 7);
  dates.forEach((date, index) => {
    if ((count - 1 - index) % step !== 0) return;
    const anchor = index === 0 ? 'start' : index === count - 1 ? 'end' : 'middle';
    const label = svgEl('text', { x: chart.x(index), y: chart.height - 9, class: 'chart-axis', 'text-anchor': anchor });
    label.textContent = labelDate(date);
    chart.svg.append(label);
  });
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

function emptyChart(wrap, text) {
  wrap.append(el('div', 'chart-empty', text));
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

function finish(chart, dates, markers, entries) {
  xLabels(chart, dates);
  if (markerTicks(chart, dates, markers)) entries.push(['legend-marker', 'training day']);
  if (entries.length) chart.wrap.append(legend(entries));
  return chart.wrap;
}

/**
 * Line chart over day-filled points with an optional rolling-mean overlay.
 * Dots are drawn only for series with at most 90 plotted points.
 * @param {{ points: {date:string,value:number|null}[], mean?: (number|null)[], unit?: string, label: string, decimals?: number, markers?: Set<string>, height?: number, format?: (value:number)=>string, compact?: boolean }} options
 */
export function lineChart({ points = [], mean = null, unit = '', label = 'Trend', decimals = 0, markers = null, height = 0, format = null, compact = false }) {
  const chart = frame({ label, height, count: points.length, compact });
  const values = points.map((point) => point.value);
  const plotted = values.filter((value) => value != null).length;
  if (!plotted) return emptyChart(chart.wrap, 'No data in this range');
  const fmt = format || defaultFormat(unit, decimals);
  const meanValues = Array.isArray(mean) ? mean : [];
  const range = valueRange([...values, ...meanValues]);
  const y = (value) => chart.top + (1 - (value - range.min) / (range.max - range.min)) * chart.plotH;
  gridLines(chart, range.min, range.max, (value) => formatValue(value, decimals));
  if (meanValues.length) runs(chart, meanValues, y, 'chart-mean');
  const dots = plotted <= MAX_DOTS;
  runs(chart, values, y, 'chart-line', !dots);
  if (dots) {
    const radius = compact ? (points.length > 40 ? 2.5 : 3.5) : points.length > 40 ? 3 : 4;
    points.forEach((point, index) => {
      if (point.value == null) return;
      const dot = svgEl('circle', { cx: chart.x(index), cy: y(point.value), r: radius, class: 'chart-dot' });
      const meanText = meanValues[index] != null ? ` · 7-day mean ${fmt(meanValues[index])}` : '';
      chart.svg.append(withTitle(dot, `${labelDate(point.date)}: ${fmt(point.value)}${meanText}`));
    });
  }
  const entries = meanValues.some((value) => value != null) ? [['legend-mean', '7-day mean']] : [];
  return finish(chart, points.map((point) => point.date), markers, entries);
}

/**
 * Bar chart over day-filled points, optionally with a rolling-mean line.
 * @param {{ points: {date:string,value:number|null}[], mean?: (number|null)[], unit?: string, label: string, decimals?: number, markers?: Set<string>, height?: number, format?: (value:number)=>string, compact?: boolean }} options
 */
export function barChart({ points = [], mean = null, unit = '', label = 'Daily totals', decimals = 0, markers = null, height = 0, format = null, compact = false }) {
  const chart = frame({ label, height, count: points.length, compact });
  const values = points.map((point) => point.value);
  if (!values.some((value) => value != null)) return emptyChart(chart.wrap, 'No data in this range');
  const fmt = format || defaultFormat(unit, decimals);
  const meanValues = Array.isArray(mean) ? mean : [];
  const range = valueRange([...values, ...meanValues], { fromZero: true });
  const y = (value) => chart.top + (1 - value / range.max) * chart.plotH;
  gridLines(chart, 0, range.max, (value) => formatValue(value, decimals));
  const barW = barWidth(chart);
  points.forEach((point, index) => {
    if (point.value == null) return;
    const top = y(Math.max(0, point.value));
    const bar = svgEl('rect', { x: chart.x(index) - barW / 2, y: top, width: barW, height: Math.max(0, chart.bottom - top), rx: Math.min(4, barW / 2), class: 'chart-bar' });
    const meanText = meanValues[index] != null ? ` · 7-day mean ${fmt(meanValues[index])}` : '';
    chart.svg.append(withTitle(bar, `${labelDate(point.date)}: ${fmt(point.value)}${meanText}`));
  });
  if (meanValues.length) runs(chart, meanValues, y, 'chart-mean');
  const entries = meanValues.some((value) => value != null) ? [['legend-mean', '7-day mean']] : [];
  return finish(chart, points.map((point) => point.date), markers, entries);
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
  return finish(chart, rows.map((row) => row.date), markers, entries);
}
