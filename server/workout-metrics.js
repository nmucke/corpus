// Pure helpers for intra-workout metrics: window construction, the "needs
// fetch" decision, and every summary shown by the session dialog and the
// Metrics > Workouts page. No SQLite, no network, no clock except the `now`
// arguments, so the same numbers are produced for live and demo data.
import { WORKOUT_METRICS, WORKOUT_METRIC_KEYS, WINDOW_PADDING } from '../public/workout-metrics-catalog.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
// One set is assumed to take this long; routine rest values (when known) are
// added on top. Segment boundaries are estimates: Hevy has no set timestamps.
const SET_SECONDS = 40;
const DEFAULT_REST_SECONDS = 90;
// Consecutive heart-rate samples further apart than max(3x median, this) count
// as a dropout rather than covered time.
const MIN_GAP_MS = 15 * SECOND;
// A window that came back empty is retried until the workout is this old.
export const LATE_DATA_MS = 48 * 60 * MINUTE;
const EXCLUDED_TEMPLATE_TYPES = /(bodyweight|assisted|cardio|distance|duration|time|reps_only)/;

const metricByKey = new Map(WORKOUT_METRICS.map((metric) => [metric.key, metric]));

function round(value, decimals = 0) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// Hevy sends RFC 3339 with `+00:00`; demo and Google data use `Z`. Date.parse
// handles both. Numbers pass through as epoch milliseconds.
export function parseTimeMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// The padded window is what gets requested and charted: it holds the warm-up
// ramp before the first set and the recovery tail after the last one. Every
// summary is clipped back to [startMs, endMs], the workout itself.
export function workoutWindow(workout) {
  const startMs = parseTimeMs(workout?.start_time);
  const endMs = parseTimeMs(workout?.end_time);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return {
    workoutId: workout.id,
    startMs,
    endMs,
    durationMs: endMs - startMs,
    windowStartMs: startMs - WINDOW_PADDING.beforeSeconds * SECOND,
    windowEndMs: endMs + WINDOW_PADDING.afterSeconds * SECOND,
  };
}

// Back-to-back workouts overlap once padded; one request per merged span keeps
// the request count down. Samples are time-addressed, so each workout still
// stores and reads its own window out of the shared response.
export function mergeWindows(windows = []) {
  const sorted = [...windows].sort((a, b) => a.windowStartMs - b.windowStartMs || a.windowEndMs - b.windowEndMs);
  const groups = [];
  for (const window of sorted) {
    const last = groups.at(-1);
    if (last && window.windowStartMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, window.windowEndMs);
      last.windows.push(window);
    } else groups.push({ startMs: window.windowStartMs, endMs: window.windowEndMs, windows: [window] });
  }
  return groups;
}

// Re-fetch when there is no ledger row, when Hevy changed the workout times, or
// when an empty window was fetched before the workout's late-data deadline. The
// rule settles itself: once a fetch happens after that deadline, it is the last.
export function needsFetch(window, row) {
  if (!window) return false;
  if (!row) return true;
  if (row.start_ms !== window.windowStartMs || row.end_ms !== window.windowEndMs) return true;
  if (row.status !== 'empty') return false;
  const fetchedAt = parseTimeMs(row.fetched_at);
  return fetchedAt === null || fetchedAt < window.endMs + LATE_DATA_MS;
}

function sortSamples(samples = []) {
  return [...samples].filter((sample) => sample && Number.isFinite(sample.atMs) && Number.isFinite(sample.value)).sort((a, b) => a.atMs - b.atMs);
}

function byMetric(samples) {
  const groups = new Map(WORKOUT_METRIC_KEYS.map((key) => [key, []]));
  for (const sample of sortSamples(samples)) if (groups.has(sample.metric)) groups.get(sample.metric).push(sample);
  return groups;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Value of an interval sample that falls inside [startMs, endMs], prorated by
// the overlap so a bucket straddling the workout edge is not double counted.
function clipInterval(sample, startMs, endMs) {
  const width = Number.isFinite(sample.durationMs) && sample.durationMs > 0 ? sample.durationMs : 0;
  if (!width) return sample.atMs >= startMs && sample.atMs <= endMs ? sample.value : 0;
  const from = Math.max(sample.atMs, startMs);
  const to = Math.min(sample.atMs + width, endMs);
  return to > from ? sample.value * ((to - from) / width) : 0;
}

// Wall-clock minutes of an interval sample that fall inside [startMs, endMs],
// ignoring its value. Zone minutes are time, not credit: Google's
// active-zone-minutes payload awards 2 AZM for a minute in PEAK, and counting
// that as two minutes would make the zones add up to more than the workout.
function clipMinutes(sample, startMs, endMs) {
  // A zoned interval with no stored width is one minute; that is the only
  // granularity active-zone-minutes reports.
  const width = Number.isFinite(sample.durationMs) && sample.durationMs > 0 ? sample.durationMs : MINUTE;
  const from = Math.max(sample.atMs, startMs);
  const to = Math.min(sample.atMs + width, endMs);
  return to > from ? (to - from) / MINUTE : 0;
}

function inRange(samples, startMs, endMs) {
  return samples.filter((sample) => sample.atMs >= startMs && sample.atMs <= endMs);
}

export function heartRateSummary(samples, startMs, endMs) {
  const inside = inRange(samples, startMs, endMs);
  if (!inside.length) return null;
  const values = inside.map((sample) => sample.value);
  const times = inside.map((sample) => sample.atMs);
  const gaps = times.slice(1).map((time, index) => time - times[index]).filter((gap) => gap > 0);
  const medianInterval = median(gaps);
  const threshold = medianInterval === null ? MIN_GAP_MS : Math.max(medianInterval * 3, MIN_GAP_MS);
  const covered = gaps.filter((gap) => gap <= threshold).reduce((total, gap) => total + gap, 0);
  const duration = endMs - startMs;
  return {
    avg: round(values.reduce((total, value) => total + value, 0) / values.length),
    max: round(Math.max(...values)),
    min: round(Math.min(...values)),
    coverage: duration > 0 ? round(Math.min(1, covered / duration), 3) : 0,
    sample_count: inside.length,
    median_interval_ms: medianInterval === null ? null : Math.round(medianInterval),
  };
}

function intervalTotal(samples, startMs, endMs, decimals = 0) {
  if (!samples.length) return null;
  return round(samples.reduce((total, sample) => total + clipInterval(sample, startMs, endMs), 0), decimals);
}

// Minutes per zone inside the workout, plus `none`: workout minutes that no
// zone interval claims. Measured from each interval's width, never from its
// stored value, which is Google's AZM credit rather than elapsed time.
export function zoneMinutes(samples, startMs, endMs) {
  if (!samples.length) return null;
  const zones = Object.fromEntries((metricByKey.get('zone')?.labels ?? []).map((label) => [label, 0]));
  let claimed = 0;
  for (const sample of samples) {
    const minutes = clipMinutes(sample, startMs, endMs);
    if (!minutes) continue;
    const label = typeof sample.label === 'string' && sample.label ? sample.label : 'none';
    zones[label] = (zones[label] ?? 0) + minutes;
    claimed += minutes;
  }
  const total = (endMs - startMs) / MINUTE;
  const result = Object.fromEntries(Object.entries(zones).map(([label, value]) => [label, round(value)]));
  result.none = round(Math.max(0, total - claimed));
  return result;
}

function exerciseRows(workout) {
  return [...(workout?.exercises ?? [])]
    .map((exercise, index) => ({
      index: Number.isInteger(exercise?.index) ? exercise.index : index,
      title: typeof exercise?.title === 'string' ? exercise.title : '',
      sets: Array.isArray(exercise?.sets) ? exercise.sets : [],
    }))
    .sort((a, b) => a.index - b.index);
}

// Estimated exercise segments. Hevy stores no per-set timestamps, so the
// workout duration is split proportionally to each exercise's set count,
// weighted by the routine's rest_seconds when the workout came from a routine.
export function estimateSegments(workout, { startMs, endMs, restSeconds = null, heartRate = [] } = {}) {
  const rows = exerciseRows(workout).filter((row) => row.sets.length > 0);
  const weights = rows.map((row) => {
    if (!restSeconds) return row.sets.length;
    const rest = Number(restSeconds instanceof Map ? restSeconds.get(row.index) : restSeconds?.[row.index]);
    const perSet = SET_SECONDS + (Number.isFinite(rest) && rest >= 0 ? rest : DEFAULT_REST_SECONDS);
    return row.sets.length * perSet;
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!rows.length || total <= 0 || !(endMs > startMs)) return [];
  const duration = endMs - startMs;
  let cursor = startMs;
  return rows.map((row, index) => {
    const from = Math.round(cursor);
    cursor = index === rows.length - 1 ? endMs : cursor + (duration * weights[index]) / total;
    const to = Math.round(cursor);
    const inside = heartRate.filter((sample) => sample.atMs >= from && sample.atMs < to);
    return {
      index: row.index,
      title: row.title,
      sets: row.sets.length,
      from_ms: from,
      to_ms: to,
      heart_rate: inside.length
        ? { avg: round(inside.reduce((sum, sample) => sum + sample.value, 0) / inside.length), max: round(Math.max(...inside.map((sample) => sample.value))) }
        : null,
    };
  });
}

function isWorkingSet(set) { return set?.type !== 'warmup'; }

function templateType(templateTypes, exercise) {
  const id = String(exercise?.exercise_template_id ?? '');
  const type = templateTypes instanceof Map ? templateTypes.get(id) : templateTypes?.[id];
  return String(type ?? '').toLowerCase();
}

// Same external-load rule as public/analytics.js: working sets only, and no
// bodyweight, assisted, or cardio templates.
export function workoutTotals(workout, templateTypes = null) {
  let exercises = 0;
  let sets = 0;
  let volume = 0;
  for (const exercise of workout?.exercises ?? []) {
    exercises += 1;
    const external = !EXCLUDED_TEMPLATE_TYPES.test(templateType(templateTypes, exercise));
    for (const set of exercise?.sets ?? []) {
      if (!isWorkingSet(set)) continue;
      sets += 1;
      const weight = Number(set?.weight_kg);
      const reps = Number(set?.reps);
      if (external && Number.isFinite(weight) && Number.isFinite(reps) && weight > 0 && reps > 0) volume += weight * reps;
    }
  }
  return { exercise_count: exercises, set_count: sets, volume_kg: round(volume, 1) };
}

function seriesFor(groups) {
  const series = {};
  for (const metric of WORKOUT_METRICS) {
    const samples = groups.get(metric.key) ?? [];
    const entry = { unit: metric.unit, samples: samples.map((sample) => (metric.labels ? [sample.atMs, round(sample.value, 3), sample.label ?? null] : [sample.atMs, round(sample.value, 3)])) };
    if (metric.kind === 'interval') {
      const width = metric.windowSeconds ? metric.windowSeconds * SECOND : median(samples.map((sample) => sample.durationMs).filter((value) => Number.isFinite(value) && value > 0));
      entry.interval_ms = width ?? MINUTE;
    }
    series[metric.key] = entry;
  }
  return series;
}

// The one summariser behind both the session dialog and the overview.
// `samples` are the stored padded-window samples; every number is clipped to
// the workout interval. The overview needs only `summary`, so `detail: false`
// skips the chart series and the segment estimate for every listed workout.
export function summariseWorkout({ workout, samples = [], restSeconds = null, detail = true } = {}) {
  const window = workoutWindow(workout);
  if (!window) return null;
  const groups = byMetric(samples);
  const heartRate = groups.get('heart_rate') ?? [];
  const summary = {
    heart_rate: heartRateSummary(heartRate, window.startMs, window.endMs),
    calories: intervalTotal(groups.get('calories') ?? [], window.startMs, window.endMs),
    steps: intervalTotal(groups.get('steps') ?? [], window.startMs, window.endMs),
    zones: zoneMinutes(groups.get('zone') ?? [], window.startMs, window.endMs),
    duration_min: round(window.durationMs / MINUTE, 1),
  };
  return {
    window: { start_ms: window.windowStartMs, end_ms: window.windowEndMs },
    series: detail ? seriesFor(groups) : null,
    summary,
    exercises: detail ? estimateSegments(workout, { startMs: window.startMs, endMs: window.endMs, restSeconds, heartRate: inRange(heartRate, window.startMs, window.endMs) }) : [],
    estimated_segments: true,
  };
}

// Shape for a workout with no usable window, no Google connection, or an empty
// window: every catalog key present, no numbers invented.
export function blankMetrics(workout = null) {
  const window = workoutWindow(workout);
  return {
    window: window ? { start_ms: window.windowStartMs, end_ms: window.windowEndMs } : null,
    series: seriesFor(byMetric([])),
    summary: { heart_rate: null, calories: null, steps: null, zones: null, duration_min: window ? round(window.durationMs / MINUTE, 1) : null },
    exercises: [],
    estimated_segments: true,
  };
}

// One row of GET /api/metrics/workouts. `summary` comes from summariseWorkout;
// pass null for a workout whose window was never fetched.
export function overviewRow({ workout, status = 'unfetched', summary = null, templateTypes = null } = {}) {
  const window = workoutWindow(workout);
  const heartRate = summary?.heart_rate ?? null;
  return {
    id: workout?.id ?? null,
    title: workout?.title ?? null,
    start_time: workout?.start_time ?? null,
    end_time: workout?.end_time ?? null,
    duration_min: window ? round(window.durationMs / MINUTE, 1) : null,
    status,
    ...workoutTotals(workout, templateTypes),
    heart_rate: heartRate ? { avg: heartRate.avg, max: heartRate.max, min: heartRate.min, coverage: heartRate.coverage } : null,
    calories: summary?.calories ?? null,
    steps: summary?.steps ?? null,
    zones: summary?.zones ?? null,
  };
}

export function coverageCounts(rows = []) {
  const counts = { workouts: rows.length, with_metrics: 0, unfetched: 0, empty: 0 };
  for (const row of rows) {
    if (row.status === 'ready') counts.with_metrics += 1;
    else if (row.status === 'empty') counts.empty += 1;
    else counts.unfetched += 1;
  }
  return counts;
}
