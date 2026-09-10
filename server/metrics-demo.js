// Deterministic demo health metrics. Values depend only on the calendar date
// (and the distance from the range end for slow trends), so any range renders
// the same numbers on every run without touching the live metric tables.
import { METRIC_KEYS } from '../public/metrics-catalog.js';
import { demoExerciseTemplates, demoRoutines } from './demo.js';
import { workoutWindow, summariseWorkout, overviewRow, coverageCounts, blankMetrics, parseTimeMs } from './workout-metrics.js';

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2020, 0, 1);

function dayIndex(date) { return Math.round((Date.UTC(...date.split('-').map(Number).map((part, i) => i === 1 ? part - 1 : part)) - EPOCH) / DAY_MS); }
function isoDay(index) { return new Date(EPOCH + index * DAY_MS).toISOString().slice(0, 10); }
function weekday(index) { return new Date(EPOCH + index * DAY_MS).getUTCDay(); }

// mulberry32 seeded per (day, salt): independent, repeatable noise per metric.
function noise(day, salt) {
  let a = (Math.imul(day + 1, 0x9E3779B1) ^ Math.imul(salt + 1, 0x85EBCA77)) >>> 0;
  a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (day, salt, low, high) => low + noise(day, salt) * (high - low);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round = (value, decimals = 0) => Number(value.toFixed(decimals));

export function demoMetricSeries(from, to) {
  const series = Object.fromEntries(METRIC_KEYS.map((key) => [key, []]));
  const start = dayIndex(from); const end = dayIndex(to);
  const push = (key, date, value) => series[key].push({ date, value });
  for (let day = start; day <= end; day += 1) {
    const date = isoDay(day); const dow = weekday(day); const back = end - day;
    const training = dow === 1 || dow === 3 || dow === 5; // matches the demo workouts (Mon/Wed/Fri)
    const trend = clamp(back / 180, 0, 1); // 0 at the range end, 1 six months earlier
    if (noise(day, 1) > 0.03) { // occasional day without the watch
      const steps = round(clamp(7600 + (training ? 2400 : 0) - (dow === 0 ? 1600 : 0) + between(day, 2, -2200, 2200), 5000, 14000));
      push('steps', date, steps);
      push('distance_km', date, round(steps * 0.00075 * between(day, 3, 0.95, 1.05), 2));
      push('active_zone_minutes', date, round(clamp(training ? between(day, 4, 24, 60) : between(day, 4, 0, 16), 0, 60)));
      push('calories_kcal', date, round(clamp(2050 + steps * 0.045 + (training ? 180 : 0) + between(day, 5, -120, 120), 2100, 2900)));
    }
    push('resting_hr', date, round(clamp(52 + 6 * trend + between(day, 6, -1.5, 1.5) + (training ? 0 : -0.5), 52, 60)));
    push('hrv_ms', date, round(clamp(50 + 6 * (1 - trend) + (dow === 1 || dow === 3 || dow === 5 ? -6 : 4) + between(day, 7, -10, 10), 35, 70)));
    push('spo2_pct', date, round(clamp(97 + between(day, 8, -1.4, 1.4), 95, 99), 1));
    if (noise(day, 9) > 0.04) {
      const total = round(clamp(430 + (dow === 0 || dow === 6 ? 40 : 0) + between(day, 10, -70, 70), 360, 520));
      const deep = round(total * 0.15); const light = round(total * 0.55); const rem = round(total * 0.22); const awake = total - deep - light - rem;
      push('sleep_minutes', date, total - awake);
      push('sleep_deep_minutes', date, deep); push('sleep_light_minutes', date, light); push('sleep_rem_minutes', date, rem); push('sleep_awake_minutes', date, awake);
    }
    if (noise(day, 11) > 0.1) push('weight_kg', date, round(79.2 + 1.3 * trend + between(day, 12, -0.4, 0.4), 1));
    if (day % 3 === 0) push('body_fat_pct', date, round(clamp(17.4 + 1.2 * trend + between(day, 13, -0.4, 0.4), 17, 19), 1));
    if (dow === 0) push('vo2max', date, round(clamp(45.4 - 1.2 * trend + between(day, 14, -0.3, 0.3), 44, 46), 1));
  }
  return series;
}

// --- workout metrics ---------------------------------------------------------
// Deterministic intra-workout data for demo mode: a realistic resistance
// profile (warm-up ramp, one spike per estimated set, recovery troughs, a short
// dropout) at ~2 s spacing, a sustained profile for the cardio session, and
// minute intervals for steps, calories, and heart rate zones that follow the
// same heart-rate curve. Values depend only on the workout id and start time,
// and nothing here ever touches SQLite.
const HR_SPACING_MS = 2000;
const MINUTE_MS = 60_000;
const DEMO_SOURCE = 'Demo watch';
const ZONE_FLOORS = [['PEAK', 160], ['CARDIO', 135], ['FAT_BURN', 110]];

function seedOf(workout) {
  const text = `${workout?.id ?? ''}|${workout?.start_time ?? ''}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

const pad2 = (value) => String(value).padStart(2, '0');
const localDateOf = (ms) => { const date = new Date(ms); return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`; };
const setCount = (workout) => (workout?.exercises ?? []).reduce((total, exercise) => total + (exercise?.sets?.length ?? 0), 0);
const isCardio = (workout) => (workout?.exercises ?? []).some((exercise) => exercise?.exercise_template_id === 'demo-run');
// Demo mode has to show every state the live page can reach, so the status is a
// fixed function of the workout id: one workout in ten was fetched and came back
// 'empty' (the watch was not worn, or Google has not synced it yet) and one in
// ten is still 'unfetched', which is what drives the "Fetch from Google Health"
// action. Demo mode never reaches Google, so an unfetched demo window stays
// unfetched; the sync returns its warning and writes nothing.
function demoWindowStatus(workout) {
  const digits = /(\d+)$/.exec(String(workout?.id ?? ''))?.[1];
  const bucket = digits ? Number(digits) % 10 : Math.floor(noise(seedOf(workout) % 1000, 41) * 10);
  if (bucket === 7) return 'empty';
  if (bucket === 3) return 'unfetched';
  return 'ready';
}

function heartRateCurve(workout, window) {
  const seed = seedOf(workout) % 100000;
  const sets = Math.max(1, setCount(workout));
  const cardio = isCardio(workout);
  const resting = 58 + between(seed, 21, -3, 5);
  const working = cardio ? 142 + between(seed, 22, -6, 8) : 104 + between(seed, 22, -6, 8);
  const spike = cardio ? 14 : 34 + between(seed, 23, -5, 7);
  const duration = window.endMs - window.startMs;
  const halfWidth = Math.max(25_000, (duration / sets) * 0.34);
  return (atMs) => {
    if (atMs < window.startMs) {
      // Pre-workout pad: resting, ramping into the warm-up.
      const ramp = 1 - (window.startMs - atMs) / (window.startMs - window.windowStartMs);
      return resting + (working - resting) * 0.45 * clamp(ramp, 0, 1) ** 2;
    }
    if (atMs > window.endMs) {
      const decay = (atMs - window.endMs) / (window.windowEndMs - window.endMs);
      return resting + 24 * Math.exp(-3 * clamp(decay, 0, 1));
    }
    const progress = (atMs - window.startMs) / duration;
    const drift = cardio ? 12 * progress : 6 * progress;
    if (cardio) return working + drift + 5 * Math.sin(progress * 11) + between(seed + Math.round(atMs / 30_000), 24, -2, 2);
    // One triangular spike per estimated set, with recovery troughs between.
    const position = progress * sets;
    const index = Math.min(sets - 1, Math.floor(position));
    const centre = window.startMs + ((index + 0.55) * duration) / sets;
    const closeness = clamp(1 - Math.abs(atMs - centre) / halfWidth, 0, 1);
    const warmup = clamp((atMs - window.startMs) / Math.max(MINUTE_MS, duration * 0.08), 0, 1);
    return working * (0.82 + 0.18 * warmup) + drift + spike * closeness - 6 * (1 - closeness) + between(seed + Math.round(atMs / 10_000), 25, -2.5, 2.5);
  };
}

// One or two short dropouts, the way a watch loses contact mid-session.
function dropouts(workout, window) {
  const seed = seedOf(workout) % 100000;
  const duration = window.endMs - window.startMs;
  const count = noise(seed, 31) > 0.5 ? 2 : 1;
  return Array.from({ length: count }, (_, index) => {
    const at = window.startMs + duration * between(seed, 32 + index, 0.15 + index * 0.4, 0.35 + index * 0.4);
    const width = between(seed, 35 + index, 45_000, 110_000);
    return { from: at, to: at + width };
  });
}

function demoSamples(workout, window) {
  const curve = heartRateCurve(workout, window);
  const gaps = dropouts(workout, window);
  const samples = [];
  for (let atMs = window.windowStartMs; atMs <= window.windowEndMs; atMs += HR_SPACING_MS) {
    if (gaps.some((gap) => atMs >= gap.from && atMs <= gap.to)) continue;
    samples.push({ metric: 'heart_rate', atMs, value: round(clamp(curve(atMs), 45, 195)), durationMs: null, label: null });
  }
  const seed = seedOf(workout) % 100000;
  const cardio = isCardio(workout);
  const firstBucket = Math.floor(window.windowStartMs / MINUTE_MS) * MINUTE_MS;
  for (let at = firstBucket; at < window.windowEndMs; at += MINUTE_MS) {
    const inside = samples.filter((sample) => sample.metric === 'heart_rate' && sample.atMs >= at && sample.atMs < at + MINUTE_MS);
    if (!inside.length) continue;
    const averageHr = inside.reduce((total, sample) => total + sample.value, 0) / inside.length;
    const minute = Math.round(at / MINUTE_MS);
    const active = at >= window.startMs - MINUTE_MS && at < window.endMs;
    const steps = cardio && active ? between(minute, 51, 148, 172) : active ? between(minute, 51, 0, 34) : between(minute, 51, 0, 12);
    samples.push({ metric: 'steps', atMs: at, value: round(steps), durationMs: MINUTE_MS, label: null });
    samples.push({ metric: 'calories', atMs: at, value: round(clamp((averageHr - 48) * 0.105 + between(minute, 52, -0.4, 0.6), 1, 20), 1), durationMs: MINUTE_MS, label: null });
    const zone = ZONE_FLOORS.find(([, floor]) => averageHr >= floor + between(seed, 53, -2, 2))?.[0];
    if (zone) samples.push({ metric: 'zone', atMs: at, value: 1, durationMs: MINUTE_MS, label: zone });
  }
  return samples.sort((a, b) => a.atMs - b.atMs);
}

const demoRestSeconds = (workout) => {
  const routine = demoRoutines.find((item) => item.id === workout?.routine_id);
  return routine ? new Map(routine.exercises.map((exercise) => [exercise.index, exercise.rest_seconds])) : null;
};
const demoTemplateTypes = new Map(demoExerciseTemplates.map((template) => [String(template.id), template.type]));

export function demoWorkoutMetrics(workout) {
  const window = workoutWindow(workout);
  const header = { mode: 'demo', workout: { id: workout?.id ?? null, title: workout?.title ?? null, start_time: workout?.start_time ?? null, end_time: workout?.end_time ?? null } };
  if (!window) return { ...header, status: 'unfetched', fetched_at: null, source: null, ...blankMetrics(workout) };
  const status = demoWindowStatus(workout);
  const fetchedAt = new Date(window.endMs + 90 * MINUTE_MS).toISOString();
  // `fetched_at` is null unless the window was actually fetched.
  if (status !== 'ready') return { ...header, status, fetched_at: status === 'empty' ? fetchedAt : null, source: null, ...blankMetrics(workout) };
  const body = summariseWorkout({ workout, samples: demoSamples(workout, window), restSeconds: demoRestSeconds(workout) });
  return { ...header, status: 'ready', fetched_at: fetchedAt, source: DEMO_SOURCE, window: body.window, series: body.series, summary: body.summary, exercises: body.exercises, estimated_segments: true };
}

export function demoWorkoutMetricsOverview(workouts = [], { from, to } = {}) {
  const rows = [];
  for (const workout of [...workouts].sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)))) {
    const startMs = parseTimeMs(workout?.start_time);
    if (startMs === null) continue;
    const date = localDateOf(startMs);
    if ((from && date < from) || (to && date > to)) continue;
    const metrics = demoWorkoutMetrics(workout);
    rows.push(overviewRow({ workout, status: metrics.status, summary: metrics.status === 'ready' ? metrics.summary : null, templateTypes: demoTemplateTypes }));
  }
  return { mode: 'demo', range: { from: from ?? null, to: to ?? null }, coverage: coverageCounts(rows), workouts: rows };
}
