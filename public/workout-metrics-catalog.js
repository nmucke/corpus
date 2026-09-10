// Shared definitions for intra-workout metrics: the high-frequency data fetched
// inside a Hevy workout window. Imported by the server (adapter, storage,
// summaries) and the browser (labels, units, charts). Keep this file
// dependency-free and side-effect-free.
//
// kind:    'sample'   – point in time (at_ms, value)
//          'interval' – a bucket starting at at_ms and covering duration_ms
// method:  how the Google Health adapter asks for it ('list' or 'rollUp').
// Adding a metric here plus one payload mapper in server/google-health.js is
// the whole change; storage, summaries, and routes are catalog-driven.
export const WORKOUT_METRICS = [
  { key: 'heart_rate', label: 'Heart rate', unit: 'bpm', decimals: 0, kind: 'sample',   slug: 'heart-rate',             method: 'list' },
  { key: 'steps',      label: 'Steps',      unit: 'steps', decimals: 0, kind: 'interval', slug: 'steps',                 method: 'rollUp', windowSeconds: 60 },
  { key: 'calories',   label: 'Calories',   unit: 'kcal', decimals: 0, kind: 'interval', slug: 'total-calories',         method: 'rollUp', windowSeconds: 60 },
  { key: 'zone',       label: 'Heart rate zone', unit: 'min', decimals: 0, kind: 'interval', slug: 'active-zone-minutes', method: 'list', labels: ['FAT_BURN', 'CARDIO', 'PEAK'] },
];
export const WORKOUT_METRIC_KEYS = WORKOUT_METRICS.map((m) => m.key);
export const HEART_RATE_ZONES = [{ key: 'FAT_BURN', label: 'Fat burn' }, { key: 'CARDIO', label: 'Cardio' }, { key: 'PEAK', label: 'Peak' }];
export const WINDOW_PADDING = { beforeSeconds: 300, afterSeconds: 600 };

const byKey = new Map(WORKOUT_METRICS.map((metric) => [metric.key, metric]));
export function workoutMetricByKey(key) { return byKey.get(key) || null; }
export function isWorkoutMetricKey(key) { return byKey.has(key); }
