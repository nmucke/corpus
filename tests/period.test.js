import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PERIOD,
  PERIODS,
  STORAGE_KEY,
  analyticsPeriod,
  getPeriod,
  isPeriod,
  periodDays,
  periodLabel,
  periodWeeks,
  setPeriod,
} from '../public/period.js';

function stubStorage({ throws = false } = {}) {
  const values = new Map();
  const store = {
    getItem(key) { if (throws) throw new Error('blocked'); return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { if (throws) throw new Error('blocked'); values.set(key, String(value)); },
    values,
  };
  globalThis.localStorage = store;
  return store;
}

function clearStorage() { delete globalThis.localStorage; }

test('the vocabulary is one list of tokens and labels', () => {
  assert.deepEqual(PERIODS, [
    ['4w', '4 weeks'],
    ['12w', '12 weeks'],
    ['26w', '26 weeks'],
    ['1y', '1 year'],
    ['all', 'All'],
  ]);
  assert.equal(DEFAULT_PERIOD, '12w');
  assert.ok(isPeriod('26w'));
  assert.ok(!isPeriod('8'));
  assert.ok(!isPeriod(null));
});

test('setPeriod validates, persists, and getPeriod reads storage back', () => {
  const store = stubStorage();
  try {
    assert.equal(getPeriod(), '12w');
    assert.equal(setPeriod('4w'), '4w');
    assert.equal(store.values.get(STORAGE_KEY), '4w');
    assert.equal(getPeriod(), '4w');
    // A stored value written by another view is honoured.
    store.values.set(STORAGE_KEY, '1y');
    assert.equal(getPeriod(), '1y');
    // Rubbish is ignored in both directions.
    assert.equal(setPeriod('nonsense'), '1y');
    assert.equal(store.values.get(STORAGE_KEY), '1y');
    store.values.set(STORAGE_KEY, 'nonsense');
    // A corrupt stored value falls back to the last value this session set.
    assert.equal(getPeriod(), '4w');
  } finally {
    clearStorage();
  }
});

test('a blocked or missing localStorage keeps the range working in memory', () => {
  clearStorage();
  assert.equal(setPeriod('26w'), '26w');
  assert.equal(getPeriod(), '26w');
  stubStorage({ throws: true });
  try {
    assert.doesNotThrow(() => setPeriod('4w'));
    assert.equal(getPeriod(), '4w');
  } finally {
    clearStorage();
    setPeriod(DEFAULT_PERIOD);
  }
});

test('labels, weeks and days derive from the same token', () => {
  assert.equal(periodLabel('4w'), '4 weeks');
  assert.equal(periodLabel('1y'), '1 year');
  assert.equal(periodLabel('all'), 'All');
  assert.equal(periodLabel('nope'), '12 weeks');
  assert.equal(periodWeeks('4w'), 4);
  assert.equal(periodWeeks('12w'), 12);
  assert.equal(periodWeeks('26w'), 26);
  assert.equal(periodWeeks('1y'), 52);
  assert.equal(periodWeeks('all'), null);
  assert.equal(periodWeeks('nope'), 12);
  assert.equal(periodDays('4w'), 28);
  assert.equal(periodDays('12w'), 84);
  assert.equal(periodDays('26w'), 182);
  assert.equal(periodDays('1y'), 365);
  assert.equal(periodDays('all'), null);
  assert.equal(periodDays('nope'), 84);
});

test('analyticsPeriod adapts the token for analytics.js', () => {
  assert.equal(analyticsPeriod('4w'), '4');
  assert.equal(analyticsPeriod('1y'), '52');
  assert.equal(analyticsPeriod('all'), 'all');
  clearStorage();
  setPeriod('26w');
  assert.equal(analyticsPeriod(), '26');
  setPeriod(DEFAULT_PERIOD);
});
