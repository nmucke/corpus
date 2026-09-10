import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LB_PER_KG,
  MISSING,
  NOT_SET,
  convertKg,
  dateLabel,
  formatCompact,
  formatDateTime,
  formatDay,
  formatDuration,
  formatLoad,
  formatNumber,
  formatSeconds,
  formatSet,
  plural,
} from '../public/format.js';

test('formatNumber groups digits, caps decimals, and reports absent values once', () => {
  assert.equal(formatNumber(38500), '38,500');
  assert.equal(formatNumber(0), '0');
  assert.equal(formatNumber(12.345, 1), '12.3');
  assert.equal(formatNumber(12, 1), '12');
  assert.equal(formatNumber(null), MISSING);
  assert.equal(formatNumber(undefined), MISSING);
  assert.equal(formatNumber(''), MISSING);
  assert.equal(formatNumber('nope'), MISSING);
  assert.equal(formatNumber(true), MISSING);
  assert.equal(formatNumber('1200'), '1,200');
});

test('formatCompact abbreviates only above a thousand', () => {
  assert.equal(formatCompact(950), '950');
  assert.equal(formatCompact(7500), '7.5k');
  assert.equal(formatCompact(38500), '38.5k');
  assert.equal(formatCompact(1200000), '1.2m');
  assert.equal(formatCompact(-7500), '-7.5k');
  assert.equal(formatCompact(null), MISSING);
});

test('formatDuration and formatSeconds keep one spelling for each dimension', () => {
  assert.equal(formatDuration(45), '45m');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(432), '7h 12m');
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(90.4), '1h 30m');
  assert.equal(formatDuration(null), MISSING);
  assert.equal(formatSeconds(90), '90 s');
  assert.equal(formatSeconds(0), '0 s');
  assert.equal(formatSeconds(null), MISSING);
});

test('formatDay reads YYYY-MM-DD in the local calendar without a timezone shift', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    assert.equal(formatDay('2026-03-01'), 'Mar 1');
    assert.equal(formatDay('2026-03-01', { year: 'numeric', month: 'short', day: 'numeric' }), 'Mar 1, 2026');
    assert.equal(formatDay('not-a-date'), 'Unknown date');
    assert.equal(formatDay(null), 'Unknown date');
    // The naive `new Date('2026-03-01')` parse lands on Feb 28 in this zone.
    assert.equal(dateLabel('2026-03-01'), 'Mar 1');
  } finally {
    process.env.TZ = previous;
  }
});

test('dateLabel and formatDateTime handle ISO datetimes with one fallback', () => {
  const iso = new Date(2026, 8, 10, 14, 30).toISOString();
  assert.equal(dateLabel(iso), 'Sep 10');
  assert.match(formatDateTime(iso), /Sep 10, 2026/);
  assert.equal(dateLabel('rubbish'), 'Unknown date');
  assert.equal(dateLabel(null), 'Unknown date');
  assert.equal(dateLabel(new Date(2026, 0, 4)), 'Jan 4');
});

test('loads convert to the display unit and stay unitless', () => {
  assert.equal(convertKg(10, 'kg'), 10);
  assert.equal(convertKg(10, 'lb'), 10 * LB_PER_KG);
  assert.equal(convertKg(null, 'lb'), null);
  assert.equal(formatLoad(60, 'kg'), '60');
  assert.equal(formatLoad(60, 'lb'), '132.3');
  assert.equal(formatLoad(49.55, 'kg'), '49.6');
  assert.equal(formatLoad(null, 'kg'), MISSING);
});

test('plural pairs a formatted count with the right word', () => {
  assert.equal(plural(1, 'workout'), '1 workout');
  assert.equal(plural(0, 'workout'), '0 workouts');
  assert.equal(plural(1200, 'data point'), '1,200 data points');
  assert.equal(plural(2, 'entry', 'entries'), '2 entries');
  assert.equal(plural(null, 'session'), '0 sessions');
});

test('formatSet is the union of the programs and drafts renderings, including RPE', () => {
  assert.equal(formatSet({ reps: 8, weight_kg: 60, rpe: 8 }, 'kg'), '8 reps · 60 kg · RPE 8');
  assert.equal(formatSet({ rep_range: { start: 8, end: 10 }, weight_kg: 60 }, 'lb'), '8–10 reps · 132.3 lb');
  assert.equal(formatSet({ rep_range: { start: 8 } }), `8–${MISSING} reps`);
  assert.equal(formatSet({ duration_seconds: 90, distance_meters: 400 }), '90 s · 400 m');
  assert.equal(formatSet({ reps: 5, type: 'drop_set' }), '5 reps · drop set');
  assert.equal(formatSet({ reps: 5, type: 'normal' }), '5 reps');
  assert.equal(formatSet({}), NOT_SET);
  assert.equal(formatSet(null), NOT_SET);
});
