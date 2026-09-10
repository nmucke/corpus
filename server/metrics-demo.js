// Deterministic demo health metrics. Values depend only on the calendar date
// (and the distance from the range end for slow trends), so any range renders
// the same numbers on every run without touching the live metric tables.
import { METRIC_KEYS } from '../public/metrics-catalog.js';

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
