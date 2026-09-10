// Pure helpers for the workout-metrics views: gap splitting for a raw heart-rate
// trace, axis ticks and value padding, exercise-segment layout, zone rows and the
// cross-session aggregations behind the Workouts stat tiles.
//
// No DOM and no catalog import, so `node --test` can load this module directly.
// Anything that needs the shared catalog (zone keys and labels) takes it as an
// argument instead — see `zoneRows`.

/** Samples are compact `[atMs, value]` pairs, sorted by time (contract). */
const MIN_GAP_MS = 15_000;
const GAP_FACTOR = 3;
/** Nice tick steps for an elapsed-time axis, in ms. */
const TIME_STEPS = [30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3, 20 * 60e3, 30 * 60e3, 60 * 60e3, 120 * 60e3];

function finite(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return typeof value !== 'boolean' && value !== null && value !== '' && Number.isFinite(number) ? number : null;
}

function mean(values) {
  const present = values.map(finite).filter((value) => value != null);
  return present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : null;
}

/** `[atMs, value]` pairs with both parts finite, in time order. */
export function cleanSamples(samples) {
  if (!Array.isArray(samples)) return [];
  return samples
    .map((sample) => (Array.isArray(sample) ? [finite(sample[0]), finite(sample[1])] : null))
    .filter((sample) => sample && sample[0] != null && sample[1] != null)
    .sort((a, b) => a[0] - b[0]);
}

/** Median spacing between consecutive samples; null for fewer than two samples. */
export function medianInterval(samples) {
  const points = cleanSamples(samples);
  if (points.length < 2) return null;
  const gaps = [];
  for (let index = 1; index < points.length; index++) gaps.push(points[index][0] - points[index - 1][0]);
  gaps.sort((a, b) => a - b);
  const middle = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[middle] : (gaps[middle - 1] + gaps[middle]) / 2;
}

/**
 * The gap that breaks the line: `max(3 × median interval, 15 s)`. A series with
 * no measurable cadence falls back to the 15 s floor.
 */
export function gapThreshold(samples, { medianMs = null } = {}) {
  const median = finite(medianMs) ?? medianInterval(samples);
  return Math.max(MIN_GAP_MS, (median ?? 0) * GAP_FACTOR);
}

/**
 * Splits samples into runs of continuous coverage, breaking wherever the spacing
 * exceeds `threshold`. Each run is drawn as its own polyline so a dropout reads
 * as missing data rather than as a slow drift.
 */
export function splitRuns(samples, threshold = null) {
  const points = cleanSamples(samples);
  if (!points.length) return [];
  const limit = finite(threshold) ?? gapThreshold(points);
  const runs = [[points[0]]];
  for (let index = 1; index < points.length; index++) {
    if (points[index][0] - points[index - 1][0] > limit) runs.push([]);
    runs[runs.length - 1].push(points[index]);
  }
  return runs;
}

/**
 * The padded window a trace is drawn on. The server sends one with every fetched
 * session, but samples are still worth drawing without it, so fall back to the
 * extent of the samples and the logged session. Null when there is no extent.
 */
export function traceWindow(window, samples, bounds = {}) {
  const start = finite(window?.start_ms);
  const end = finite(window?.end_ms);
  if (start != null && end != null && end > start) return { startMs: start, endMs: end };
  const marks = [
    ...cleanSamples(samples).map((sample) => sample[0]),
    finite(bounds.startMs),
    finite(bounds.endMs),
  ].filter((value) => value != null);
  if (!marks.length) return null;
  const low = Math.min(...marks);
  const high = Math.max(...marks);
  return high > low ? { startMs: low, endMs: high } : null;
}

/**
 * A y-range for bpm with breathing room, snapped outward to whole `step`s so the
 * gridline labels are round numbers. Never dips below zero.
 */
export function paddedExtent(values, { step = 10, minPad = 5, ratio = 0.12 } = {}) {
  const present = values.map(finite).filter((value) => value != null);
  if (!present.length) return { min: 0, max: step };
  const low = Math.min(...present);
  const high = Math.max(...present);
  const pad = Math.max(minPad, (high - low) * ratio);
  const min = Math.max(0, Math.floor((low - pad) / step) * step);
  const max = Math.ceil((high + pad) / step) * step;
  return { min, max: max > min ? max : min + step };
}

/**
 * Ticks along an elapsed-time axis: at most `max` marks on a round minute (or
 * 30 s) cadence, always including 0.
 * @returns {{ms:number}[]} offsets from the start of the window
 */
export function timeTicks(spanMs, { max = 6 } = {}) {
  const span = finite(spanMs);
  if (span == null || span <= 0 || max < 1) return [{ ms: 0 }];
  const step = TIME_STEPS.find((candidate) => span / candidate <= Math.max(1, max - 1))
    ?? Math.ceil(span / Math.max(1, max - 1) / 60e3) * 60e3;
  const ticks = [];
  for (let at = 0; at <= span + 1; at += step) ticks.push({ ms: at });
  return ticks;
}

/**
 * Exercise segments placed on the padded window as 0–1 fractions, plus the
 * clamped millisecond bounds a hover readout needs. Segments are clamped to the
 * window and dropped when they fall outside it.
 */
export function layoutSegments(exercises, { startMs, endMs } = {}) {
  const start = finite(startMs);
  const end = finite(endMs);
  if (start == null || end == null || end <= start || !Array.isArray(exercises)) return [];
  const span = end - start;
  const laid = [];
  for (const exercise of exercises) {
    const from = finite(exercise?.from_ms);
    const to = finite(exercise?.to_ms);
    if (from == null || to == null || to <= from || to <= start || from >= end) continue;
    const left = Math.max(start, from);
    const right = Math.min(end, to);
    laid.push({
      // 1-based ordinal shared by the band caption and the table's # column.
      number: laid.length + 1,
      title: String(exercise?.title || 'Untitled exercise'),
      fromMs: left,
      toMs: right,
      from: (left - start) / span,
      to: (right - start) / span,
      heartRate: exercise?.heart_rate || null,
      // Alternating bands read as separate segments without a second colour.
      band: laid.length % 2,
    });
  }
  return laid;
}

/** The stylesheet class one zone paints with: `FAT_BURN` → `zone--fat-burn`. */
export function zoneClass(key) {
  return `zone--${String(key || 'none').toLowerCase().replaceAll('_', '-')}`;
}

/**
 * Zone minutes as ordered rows with shares, `none` last. `zones` is the catalog's
 * `HEART_RATE_ZONES`, so this module never has to know the zone vocabulary.
 */
export function zoneRows(summary, zones = [], { noneLabel = 'Below zones' } = {}) {
  const entries = [
    ...zones.map((zone) => ({ key: zone.key, label: zone.label, minutes: finite(summary?.[zone.key]) ?? 0 })),
    { key: 'none', label: noneLabel, minutes: finite(summary?.none) ?? 0 },
  ];
  const total = entries.reduce((sum, entry) => sum + entry.minutes, 0);
  return entries.map((entry) => ({ ...entry, className: zoneClass(entry.key), share: total > 0 ? entry.minutes / total : 0, total }));
}

/** Minutes spent in a real zone (everything but `none`). */
export function activeZoneMinutes(summary, zones = []) {
  return zones.reduce((sum, zone) => sum + (finite(summary?.[zone.key]) ?? 0), 0);
}

/** True when an overview row actually carries heart-rate numbers. */
export function hasMetrics(row) {
  return row?.status === 'ready' && finite(row?.heart_rate?.avg) != null;
}

/**
 * The four Workouts tiles, over the overview rows of one window. Averages are
 * per session **with metrics**, so a half-fetched window is not read as a drop.
 */
export function overviewSummary(rows = [], zones = []) {
  const list = Array.isArray(rows) ? rows : [];
  const measured = list.filter(hasMetrics);
  return {
    sessions: list.length,
    measured: measured.length,
    avgHr: mean(measured.map((row) => row.heart_rate?.avg)),
    peakHr: mean(measured.map((row) => row.heart_rate?.max)),
    // A row without a zone split is unknown, not zero — same rule as calories.
    zoneMinutes: mean(measured.filter((row) => row.zones).map((row) => activeZoneMinutes(row.zones, zones))),
    calories: mean(measured.filter((row) => finite(row.calories) != null).map((row) => row.calories)),
  };
}

/** `current - previous` per tile, or null where either window has no baseline. */
export function overviewChange(current, previous) {
  const delta = (key) => {
    const now = finite(current?.[key]);
    const before = finite(previous?.[key]);
    return now == null || before == null ? null : now - before;
  };
  return { avgHr: delta('avgHr'), peakHr: delta('peakHr'), zoneMinutes: delta('zoneMinutes'), calories: delta('calories') };
}

/**
 * Splits overview rows into the selected window and the one immediately before
 * it. `days` of null (the `All` range) puts everything in `current` — there is
 * no window to compare against.
 */
export function partitionWindows(rows = [], days, nowMs = Date.now()) {
  const list = (Array.isArray(rows) ? rows : []).filter((row) => finite(new Date(row?.start_time).getTime()) != null);
  const span = finite(days);
  if (span == null) return { current: list, previous: [] };
  const dayMs = 24 * 60 * 60 * 1000;
  const from = nowMs - span * dayMs;
  const before = from - span * dayMs;
  const at = (row) => new Date(row.start_time).getTime();
  return {
    current: list.filter((row) => at(row) >= from),
    previous: list.filter((row) => at(row) >= before && at(row) < from),
  };
}
