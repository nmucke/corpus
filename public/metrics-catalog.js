// Shared metric definitions for the Metrics module. Imported by the server
// (importers, daily aggregation, Markdown export) and the browser (labels,
// units, chart choices). Keep this file dependency-free and side-effect-free.

export const CATEGORIES = [
  { key: "activity", label: "Activity" },
  { key: "heart", label: "Heart" },
  { key: "sleep", label: "Sleep" },
  { key: "body", label: "Body" },
  { key: "fitness", label: "Fitness" },
];

// aggregate: how points on the same local date combine into one daily value.
//   sum  – additive quantities (steps, minutes)
//   mean – measurements sampled once or more per day (weight, resting HR)
// chart: preferred dashboard mark. decimals: display precision.
// unit "kg" is converted to the user's display unit in the browser.
export const METRICS = [
  { key: "steps", label: "Steps", category: "activity", unit: "steps", aggregate: "sum", decimals: 0, chart: "bar" },
  { key: "distance_km", label: "Distance", category: "activity", unit: "km", aggregate: "sum", decimals: 1, chart: "bar" },
  { key: "active_zone_minutes", label: "Active zone minutes", category: "activity", unit: "min", aggregate: "sum", decimals: 0, chart: "bar" },
  { key: "calories_kcal", label: "Energy burned", category: "activity", unit: "kcal", aggregate: "sum", decimals: 0, chart: "bar" },
  { key: "resting_hr", label: "Resting heart rate", category: "heart", unit: "bpm", aggregate: "mean", decimals: 0, chart: "line" },
  { key: "hrv_ms", label: "Heart rate variability", category: "heart", unit: "ms", aggregate: "mean", decimals: 0, chart: "line" },
  { key: "spo2_pct", label: "Blood oxygen", category: "heart", unit: "%", aggregate: "mean", decimals: 1, chart: "line" },
  { key: "sleep_minutes", label: "Sleep", category: "sleep", unit: "min", aggregate: "sum", decimals: 0, chart: "bar" },
  { key: "sleep_deep_minutes", label: "Deep sleep", category: "sleep", unit: "min", aggregate: "sum", decimals: 0, chart: "bar", stage: "deep" },
  { key: "sleep_light_minutes", label: "Light sleep", category: "sleep", unit: "min", aggregate: "sum", decimals: 0, chart: "bar", stage: "light" },
  { key: "sleep_rem_minutes", label: "REM sleep", category: "sleep", unit: "min", aggregate: "sum", decimals: 0, chart: "bar", stage: "rem" },
  { key: "sleep_awake_minutes", label: "Awake in bed", category: "sleep", unit: "min", aggregate: "sum", decimals: 0, chart: "bar", stage: "awake" },
  { key: "weight_kg", label: "Weight", category: "body", unit: "kg", aggregate: "mean", decimals: 1, chart: "line" },
  { key: "body_fat_pct", label: "Body fat", category: "body", unit: "%", aggregate: "mean", decimals: 1, chart: "line" },
  { key: "vo2max", label: "Cardio fitness (VO₂ max)", category: "fitness", unit: "ml/kg/min", aggregate: "mean", decimals: 1, chart: "line" },
];

export const METRIC_KEYS = METRICS.map((metric) => metric.key);
const byKey = new Map(METRICS.map((metric) => [metric.key, metric]));

export function metricByKey(key) { return byKey.get(key) || null; }
export function metricsInCategory(category) { return METRICS.filter((metric) => metric.category === category); }
export function isMetricKey(key) { return byKey.has(key); }
