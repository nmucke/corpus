import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  SCOPES,
  GoogleHealthError,
  pkcePair,
  authorizationUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  fetchMetricPoints,
} from '../server/google-health.js';

const SECRET = 'top-secret-client-value';
const TOKEN = 'access-token-value';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Fake fetch keyed by data type slug. A route may be a canned JSON body, a
// Response, or a function receiving the recorded call.
function fakeFetch(routes = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    const call = { url: parsed, method: options.method || 'GET', headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : null, options };
    calls.push(call);
    const match = /\/v4\/users\/me\/dataTypes\/([^/]+)\/dataPoints(:dailyRollUp)?$/.exec(parsed.pathname);
    const route = routes[match?.[1]];
    const result = typeof route === 'function' ? await route(call) : route;
    if (result instanceof Response) return result;
    if (result === undefined) return json(match?.[2] ? { rollupDataPoints: [] } : { dataPoints: [] });
    return json(result);
  };
  return { fetchImpl, calls };
}

const rollupCalls = (calls, slug) => calls.filter((call) => call.url.pathname === `/v4/users/me/dataTypes/${slug}/dataPoints:dailyRollUp`);
const listCalls = (calls, slug) => calls.filter((call) => call.url.pathname === `/v4/users/me/dataTypes/${slug}/dataPoints`);
const byMetric = (points, metric) => points.filter((point) => point.metric === metric);
// Number of days covered by a CivilTimeInterval with an exclusive end.
const spanDays = ({ start, end }) => (Date.UTC(end.date.year, end.date.month - 1, end.date.day) - Date.UTC(start.date.year, start.date.month - 1, start.date.day)) / 86_400_000;
const rollup = (date, payload) => {
  const [year, month, day] = date.split('-').map(Number);
  // Live shape: CivilDateTime with the date nested under `date` and an empty `time`.
  return { civilStartTime: { date: { year, month, day }, time: {} }, civilEndTime: { date: { year, month, day: day + 1 }, time: {} }, ...payload };
};

// --- PKCE and authorization URL ---------------------------------------------

test('pkcePair returns a base64url verifier and its S256 challenge', () => {
  const { verifier, challenge } = pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.notEqual(pkcePair().verifier, verifier);
});

test('authorizationUrl carries the documented OAuth parameters', () => {
  const url = new URL(authorizationUrl({ clientId: 'client-id', redirectUri: 'http://127.0.0.1:4310/api/metrics/google/callback', state: 'state-1', codeChallenge: 'challenge-1' }));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  const params = Object.fromEntries(url.searchParams);
  assert.deepEqual(params, {
    client_id: 'client-id',
    redirect_uri: 'http://127.0.0.1:4310/api/metrics/google/callback',
    response_type: 'code',
    scope: SCOPES.join(' '),
    state: 'state-1',
    code_challenge: 'challenge-1',
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  assert.equal(SCOPES.length, 3);
  assert.ok(SCOPES.every((scope) => scope.startsWith('https://www.googleapis.com/auth/googlehealth.') && scope.endsWith('.readonly')));
  assert.throws(() => authorizationUrl({ clientId: 'client-id', redirectUri: 'x', state: 's' }), TypeError);
});

// --- token exchange and refresh ---------------------------------------------

test('exchangeCode posts a form body and returns normalized tokens', async () => {
  const calls = [];
  const before = Date.now();
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3599, scope: SCOPES.join(' '), token_type: 'Bearer' });
  };
  const tokens = await exchangeCode(fetchImpl, { clientId: 'client-id', clientSecret: SECRET, code: 'code-1', codeVerifier: 'verifier-1', redirectUri: 'http://127.0.0.1:4310/cb' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].options.body)), {
    grant_type: 'authorization_code', code: 'code-1', code_verifier: 'verifier-1', client_id: 'client-id', client_secret: SECRET, redirect_uri: 'http://127.0.0.1:4310/cb',
  });
  assert.equal(tokens.accessToken, 'at-1');
  assert.equal(tokens.refreshToken, 'rt-1');
  assert.equal(tokens.scope, SCOPES.join(' '));
  const expiresAt = Date.parse(tokens.expiresAt);
  assert.ok(expiresAt >= before + 3599_000 && expiresAt <= Date.now() + 3599_000);
});

test('exchangeCode maps Google errors to oauth without leaking the secret', async () => {
  const fetchImpl = async () => json({ error: 'invalid_grant', error_description: `secret was ${SECRET}` }, 400);
  await assert.rejects(
    exchangeCode(fetchImpl, { clientId: 'client-id', clientSecret: SECRET, code: 'code-1', codeVerifier: 'v', redirectUri: 'http://127.0.0.1/cb' }),
    (error) => {
      assert.ok(error instanceof GoogleHealthError);
      assert.equal(error.code, 'oauth');
      assert.equal(error.status, 400);
      assert.match(error.message, /invalid_grant/);
      assert.ok(!error.message.includes(SECRET));
      return true;
    },
  );
  const malformed = async () => new Response('<html>', { status: 200 });
  await assert.rejects(exchangeCode(malformed, { clientId: 'c', clientSecret: SECRET, code: 'x', codeVerifier: 'v', redirectUri: 'r' }), (error) => error.code === 'oauth' && !error.message.includes(SECRET));
  await assert.rejects(exchangeCode(async () => json({}), { clientId: 'c', clientSecret: '', code: 'x', codeVerifier: 'v', redirectUri: 'r' }), (error) => error.code === 'oauth');
});

test('exchangeCode maps fetch rejections to network', async () => {
  const fetchImpl = async () => { throw new Error(`ECONNRESET ${SECRET}`); };
  await assert.rejects(
    exchangeCode(fetchImpl, { clientId: 'client-id', clientSecret: SECRET, code: 'code-1', codeVerifier: 'v', redirectUri: 'http://127.0.0.1/cb' }),
    (error) => error instanceof GoogleHealthError && error.code === 'network' && !error.message.includes(SECRET),
  );
});

test('refreshAccessToken keeps the stored refresh token when Google omits one', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => { calls.push(options); return json({ access_token: 'at-2', expires_in: '3600', scope: 'scope-a' }); };
  const tokens = await refreshAccessToken(fetchImpl, { clientId: 'client-id', clientSecret: SECRET, refreshToken: 'rt-old' });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[0].body)), { grant_type: 'refresh_token', refresh_token: 'rt-old', client_id: 'client-id', client_secret: SECRET });
  assert.equal(tokens.accessToken, 'at-2');
  assert.equal(tokens.refreshToken, 'rt-old');
  assert.equal(tokens.scope, 'scope-a');
  assert.ok(Number.isFinite(Date.parse(tokens.expiresAt)));
  const rotated = await refreshAccessToken(async () => json({ access_token: 'at-3', refresh_token: 'rt-new', expires_in: 10 }), { clientId: 'c', clientSecret: SECRET, refreshToken: 'rt-old' });
  assert.equal(rotated.refreshToken, 'rt-new');
  await assert.rejects(refreshAccessToken(async () => json({ error: 'invalid_client' }, 401), { clientId: 'c', clientSecret: SECRET, refreshToken: 'rt-old' }), (error) => error.code === 'oauth' && /invalid_client/.test(error.message) && !error.message.includes(SECRET));
  await assert.rejects(refreshAccessToken(async () => { throw new Error('offline'); }, { clientId: 'c', clientSecret: SECRET, refreshToken: 'rt-old' }), (error) => error.code === 'network');
});

test('revokeToken posts the token and never throws', async () => {
  const calls = [];
  assert.equal(await revokeToken(async (url, options) => { calls.push({ url, options }); return new Response('', { status: 200 }); }, 'rt-old'), true);
  assert.equal(calls[0].options.method, 'POST');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://oauth2.googleapis.com/revoke');
  assert.equal(url.searchParams.get('token'), 'rt-old');
  assert.equal(await revokeToken(async () => new Response('', { status: 400 }), 'rt-old'), false);
  assert.equal(await revokeToken(async () => { throw new Error('offline'); }, 'rt-old'), false);
  assert.equal(await revokeToken(async () => { throw new Error('never called'); }, ''), false);
});

// --- fetchMetricPoints ------------------------------------------------------

test('fetchMetricPoints validates the date range', async () => {
  const { fetchImpl, calls } = fakeFetch();
  await assert.rejects(fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-1-1', to: '2026-01-02' }), TypeError);
  await assert.rejects(fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-02-30', to: '2026-03-02' }), TypeError);
  await assert.rejects(fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-01-05', to: '2026-01-04' }), TypeError);
  await assert.rejects(fetchMetricPoints(fetchImpl, '', { from: '2026-01-01', to: '2026-01-04' }), TypeError);
  assert.equal(calls.length, 0);
});

test('fetchMetricPoints splits rollups into per-type windows and sends bearer auth', async () => {
  const { fetchImpl, calls } = fakeFetch();
  const result = await fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-01-01', to: '2026-04-10' });
  assert.deepEqual(result, { points: [], warnings: [], failed: [] });
  const steps = rollupCalls(calls, 'steps');
  assert.equal(steps.length, 2);
  // CivilTimeInterval: `end` is exclusive (the day after the window's last day) and there is no pageSize.
  assert.deepEqual(steps.map((call) => call.body), [
    { range: { start: { date: { year: 2026, month: 1, day: 1 } }, end: { date: { year: 2026, month: 4, day: 1 } } }, windowSizeDays: 1 },
    { range: { start: { date: { year: 2026, month: 4, day: 1 } }, end: { date: { year: 2026, month: 4, day: 11 } } }, windowSizeDays: 1 },
  ]);
  assert.ok(steps.every((call) => !('pageSize' in call.body)));
  assert.ok(steps.every((call) => spanDays(call.body.range) <= 90));
  assert.equal(steps[0].method, 'POST');
  assert.equal(steps[0].headers['content-type'], 'application/json');
  const calories = rollupCalls(calls, 'total-calories');
  assert.equal(calories.length, 8);
  assert.deepEqual(calories[0].body.range, { start: { date: { year: 2026, month: 1, day: 1 } }, end: { date: { year: 2026, month: 1, day: 15 } } });
  assert.deepEqual(calories.at(-1).body.range, { start: { date: { year: 2026, month: 4, day: 9 } }, end: { date: { year: 2026, month: 4, day: 11 } } });
  assert.ok(calories.every((call) => !('pageSize' in call.body) && spanDays(call.body.range) <= 14));
  assert.equal(rollupCalls(calls, 'distance').length, 2);
  assert.equal(rollupCalls(calls, 'active-zone-minutes').length, 2);
  for (const slug of ['daily-resting-heart-rate', 'daily-heart-rate-variability', 'daily-oxygen-saturation', 'weight', 'body-fat', 'run-vo2-max', 'sleep']) {
    assert.equal(listCalls(calls, slug).length, 1, slug);
  }
  assert.ok(calls.every((call) => call.headers.authorization === `Bearer ${TOKEN}`));
  const hr = listCalls(calls, 'daily-resting-heart-rate')[0];
  assert.equal(hr.method, 'GET');
  assert.equal(hr.url.searchParams.get('filter'), 'daily_resting_heart_rate.date >= "2026-01-01" AND daily_resting_heart_rate.date < "2026-04-11"');
  assert.equal(hr.url.searchParams.get('pageSize'), '1000');
  assert.equal(hr.url.searchParams.get('pageToken'), null);
  assert.equal(listCalls(calls, 'daily-heart-rate-variability')[0].url.searchParams.get('filter'), 'daily_heart_rate_variability.date >= "2026-01-01" AND daily_heart_rate_variability.date < "2026-04-11"');
  assert.equal(listCalls(calls, 'daily-oxygen-saturation')[0].url.searchParams.get('filter'), 'daily_oxygen_saturation.date >= "2026-01-01" AND daily_oxygen_saturation.date < "2026-04-11"');
  const weight = listCalls(calls, 'weight')[0];
  assert.equal(weight.url.searchParams.get('filter'), 'weight.sample_time.physical_time >= "2025-12-31T00:00:00Z" AND weight.sample_time.physical_time < "2026-04-12T00:00:00Z"');
  assert.match(listCalls(calls, 'body-fat')[0].url.searchParams.get('filter'), /^body_fat\.sample_time\.physical_time >= /);
  assert.match(listCalls(calls, 'run-vo2-max')[0].url.searchParams.get('filter'), /^run_vo2_max\.sample_time\.physical_time >= /);
  const sleep = listCalls(calls, 'sleep')[0];
  assert.match(sleep.url.searchParams.get('filter'), /^sleep\.interval\.end_time >= "2025-12-31T00:00:00Z" AND sleep\.interval\.end_time < "2026-04-12T00:00:00Z"$/);
  assert.equal(sleep.url.searchParams.get('pageSize'), '25');
});

test('fetchMetricPoints follows nextPageToken for rollups and lists', async () => {
  const { fetchImpl, calls } = fakeFetch({
    steps: (call) => (call.body.pageToken === 'p2'
      ? { rollupDataPoints: [rollup('2026-01-02', { steps: { countSum: '2' } })] }
      : { rollupDataPoints: [rollup('2026-01-01', { steps: { countSum: '1' } })], nextPageToken: 'p2' }),
    weight: (call) => (call.url.searchParams.get('pageToken') === 'w2'
      ? { dataPoints: [{ name: 'users/me/dataTypes/weight/dataPoints/w-2', weight: { weightGrams: '81000', sampleTime: { physicalTime: '2026-01-02T07:00:00Z', utcOffset: '0s' } } }] }
      : { dataPoints: [{ name: 'users/me/dataTypes/weight/dataPoints/w-1', weight: { weightGrams: '80000', sampleTime: { physicalTime: '2026-01-01T07:00:00Z', utcOffset: '0s' } } }], nextPageToken: 'w2' }),
  });
  const { points, warnings } = await fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-01-01', to: '2026-01-03' });
  assert.deepEqual(warnings, []);
  const steps = rollupCalls(calls, 'steps');
  assert.equal(steps.length, 2);
  assert.equal(steps[0].body.pageToken, undefined);
  assert.equal(steps[1].body.pageToken, 'p2');
  assert.deepEqual(steps[1].body.range, steps[0].body.range);
  const weight = listCalls(calls, 'weight');
  assert.equal(weight.length, 2);
  assert.equal(weight[1].url.searchParams.get('pageToken'), 'w2');
  assert.equal(weight[1].url.searchParams.get('filter'), weight[0].url.searchParams.get('filter'));
  assert.deepEqual(byMetric(points, 'steps').map((point) => [point.date, point.value]), [['2026-01-01', 1], ['2026-01-02', 2]]);
  assert.deepEqual(byMetric(points, 'weight_kg').map((point) => [point.sourceId, point.value]), [['w-1', 80], ['w-2', 81]]);
});

test('fetchMetricPoints maps every data type with unit conversions and civil dates', async () => {
  const { fetchImpl } = fakeFetch({
    steps: { rollupDataPoints: [rollup('2026-03-01', { steps: { countSum: '8123' } }), rollup('2026-03-02', { steps: {} })] },
    distance: { rollupDataPoints: [rollup('2026-03-01', { distance: { millimetersSum: '5230000' } })] },
    'active-zone-minutes': { rollupDataPoints: [rollup('2026-03-01', { activeZoneMinutes: { sumInFatBurnHeartZone: 10, sumInCardioHeartZone: '20', sumInPeakHeartZone: 5 } }), rollup('2026-03-02', { activeZoneMinutes: { sumInFatBurnHeartZone: 7 } })] },
    'total-calories': { rollupDataPoints: [rollup('2026-03-01', { totalCalories: { kcalSum: 2345.5 } })] },
    'daily-resting-heart-rate': { dataPoints: [{ name: 'users/me/dataTypes/daily-resting-heart-rate/dataPoints/rhr-1', dailyRestingHeartRate: { beatsPerMinute: 52, date: { year: 2026, month: 3, day: 1 } } }] },
    'daily-heart-rate-variability': { dataPoints: [
      { name: 'users/me/dataTypes/daily-heart-rate-variability/dataPoints/hrv-1', dailyHeartRateVariability: { date: { year: 2026, month: 3, day: 1 } } },
      { name: 'users/me/dataTypes/daily-heart-rate-variability/dataPoints/hrv-2', dailyHeartRateVariability: { averageHeartRateVariabilityMilliseconds: 41.5, date: { year: 2026, month: 3, day: 2 } } },
    ] },
    'daily-oxygen-saturation': { dataPoints: [{ name: 'users/me/dataTypes/daily-oxygen-saturation/dataPoints/spo2-1', date: { year: 2026, month: 3, day: 2 }, dailyOxygenSaturation: { averagePercentage: '96.5' } }] },
    weight: { dataPoints: [
      // 03:30Z in UTC-5 is still the previous evening.
      { name: 'users/me/dataTypes/weight/dataPoints/w-1', weight: { weightGrams: '80500', sampleTime: { physicalTime: '2026-03-02T03:30:00Z', utcOffset: '-18000s' } } },
      // civilTime (live shape: { date, time }) wins over the physical time when present.
      { name: 'users/me/dataTypes/weight/dataPoints/w-2', weight: { weightGrams: 79000, sampleTime: { physicalTime: '2026-03-02T23:30:00Z', utcOffset: '3600s', civilTime: { date: { year: 2026, month: 3, day: 3 }, time: { hours: 0, minutes: 30 } } } } },
    ] },
    'body-fat': { dataPoints: [{ name: 'users/me/dataTypes/body-fat/dataPoints/bf-1', bodyFat: { percentage: 18.2, sampleTime: { physicalTime: '2026-03-01T08:00:00Z', utcOffset: '0s' } } }] },
    'run-vo2-max': { dataPoints: [{ name: 'users/me/dataTypes/run-vo2-max/dataPoints/vo2-1', runVo2Max: { runVo2Max: '44.1', sampleTime: { physicalTime: '2026-03-01T08:00:00Z' } } }] },
    sleep: { dataPoints: [
      {
        name: 'users/me/dataTypes/sleep/dataPoints/sleep-1',
        sleep: {
          // Ends 22:30Z which is 07:30 on 2026-03-02 in UTC+9.
          interval: { startTime: '2026-03-01T14:00:00Z', endTime: '2026-03-01T22:30:00Z', startUtcOffset: '32400s', endUtcOffset: '32400s' },
          summary: { minutesAsleep: 420, minutesAwake: 20, minutesInSleepPeriod: 510 },
          stages: [
            { startTime: '2026-03-01T14:00:00Z', endTime: '2026-03-01T14:15:00Z', type: 'AWAKE' },
            { startTime: '2026-03-01T14:15:00Z', endTime: '2026-03-01T16:45:00Z', type: 'LIGHT' },
            { startTime: '2026-03-01T16:45:00Z', endTime: '2026-03-01T17:45:00Z', type: 'DEEP' },
            { startTime: '2026-03-01T17:45:00Z', endTime: '2026-03-01T19:25:00Z', type: 'REM' },
            { startTime: '2026-03-01T19:25:00Z', endTime: '2026-03-01T20:15:00Z', type: 'ASLEEP' },
            { startTime: '2026-03-01T20:15:00Z', endTime: '2026-03-01T20:20:00Z', type: 'RESTLESS' },
          ],
        },
      },
      {
        // No summary: asleep minutes come from the non-awake stages; no REM stage → no rem point.
        name: 'users/me/dataTypes/sleep/dataPoints/sleep-2',
        sleep: {
          interval: { startTime: '2026-03-02T23:00:00Z', endTime: '2026-03-03T06:00:00Z', startUtcOffset: '0s', endUtcOffset: '0s' },
          stages: [
            { startTime: '2026-03-02T23:00:00Z', endTime: '2026-03-03T02:00:00Z', type: 'LIGHT' },
            { startTime: '2026-03-03T02:00:00Z', endTime: '2026-03-03T03:00:00Z', type: 'DEEP' },
            { startTime: '2026-03-03T03:00:00Z', endTime: '2026-03-03T03:10:00Z', type: 'AWAKE' },
          ],
        },
      },
      // Out of range by civil end date: dropped without a warning.
      { name: 'users/me/dataTypes/sleep/dataPoints/sleep-3', sleep: { interval: { endTime: '2026-03-06T06:00:00Z', endUtcOffset: '0s' }, summary: { minutesAsleep: 400 } } },
    ] },
  });
  const { points, warnings, failed } = await fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-03-01', to: '2026-03-05' });
  assert.deepEqual(warnings.sort(), [
    'daily-heart-rate-variability: skipped 1 point without a numeric value',
    'steps: skipped 1 point without a numeric value',
  ]);
  assert.deepEqual(failed, []);
  for (const point of points) {
    assert.ok(Number.isFinite(point.value), point.metric);
    assert.ok(point.date >= '2026-03-01' && point.date <= '2026-03-05', `${point.metric} ${point.date}`);
    assert.ok(!JSON.stringify(point.raw).includes(TOKEN));
  }
  const one = (metric, sourceId) => { const found = byMetric(points, metric).filter((point) => point.sourceId === sourceId); assert.equal(found.length, 1, `${metric}/${sourceId}`); return found[0]; };
  assert.deepEqual(one('steps', '2026-03-01'), { metric: 'steps', sourceId: '2026-03-01', date: '2026-03-01', startTime: null, endTime: null, value: 8123, raw: { civilStartTime: { date: { year: 2026, month: 3, day: 1 }, time: {} }, civilEndTime: { date: { year: 2026, month: 3, day: 2 }, time: {} }, steps: { countSum: '8123' } } });
  assert.equal(byMetric(points, 'steps').length, 1);
  assert.equal(one('distance_km', '2026-03-01').value, 5.23);
  assert.equal(one('active_zone_minutes', '2026-03-01').value, 35);
  assert.equal(one('active_zone_minutes', '2026-03-02').value, 7);
  assert.equal(one('calories_kcal', '2026-03-01').value, 2345.5);
  assert.equal(one('resting_hr', 'rhr-1').value, 52);
  assert.equal(one('resting_hr', 'rhr-1').date, '2026-03-01');
  assert.deepEqual(byMetric(points, 'hrv_ms').map((point) => [point.sourceId, point.date, point.value]), [['hrv-2', '2026-03-02', 41.5]]);
  assert.deepEqual([one('spo2_pct', 'spo2-1').date, one('spo2_pct', 'spo2-1').value], ['2026-03-02', 96.5]);
  const w1 = one('weight_kg', 'w-1');
  assert.equal(w1.value, 80.5);
  assert.equal(w1.date, '2026-03-01');
  assert.equal(w1.startTime, '2026-03-02T03:30:00Z');
  assert.equal(w1.endTime, null);
  assert.equal(w1.raw.name, 'users/me/dataTypes/weight/dataPoints/w-1');
  const w2 = one('weight_kg', 'w-2');
  assert.equal(w2.value, 79);
  assert.equal(w2.date, '2026-03-03');
  assert.equal(one('body_fat_pct', 'bf-1').value, 18.2);
  assert.equal(one('vo2max', 'vo2-1').value, 44.1);
  assert.equal(one('vo2max', 'vo2-1').date, '2026-03-01');
  const sleep1 = one('sleep_minutes', 'sleep-1');
  assert.equal(sleep1.date, '2026-03-02');
  assert.equal(sleep1.value, 420);
  assert.equal(sleep1.startTime, '2026-03-01T14:00:00Z');
  assert.equal(sleep1.endTime, '2026-03-01T22:30:00Z');
  assert.equal(sleep1.raw.summary.minutesAsleep, 420);
  assert.equal(sleep1.raw.stages.length, 6);
  assert.deepEqual([one('sleep_deep_minutes', 'sleep-1:deep').value, one('sleep_light_minutes', 'sleep-1:light').value, one('sleep_rem_minutes', 'sleep-1:rem').value, one('sleep_awake_minutes', 'sleep-1:awake').value], [60, 200, 100, 20]);
  assert.equal(one('sleep_deep_minutes', 'sleep-1:deep').date, '2026-03-02');
  const sleep2 = one('sleep_minutes', 'sleep-2');
  assert.equal(sleep2.value, 240);
  assert.equal(sleep2.date, '2026-03-03');
  assert.equal(one('sleep_light_minutes', 'sleep-2:light').value, 180);
  assert.equal(one('sleep_awake_minutes', 'sleep-2:awake').value, 10);
  assert.equal(byMetric(points, 'sleep_rem_minutes').length, 1);
  assert.equal(byMetric(points, 'sleep_minutes').length, 2);
});

test('fetchMetricPoints uses the date as the id for daily summaries without a name', async () => {
  // Live daily-summary points carry no `name`; int64 values arrive as strings.
  const item = { dataSource: { deviceType: 'TRACKER' }, dailyRestingHeartRate: { date: { year: 2026, month: 3, day: 1 }, beatsPerMinute: '71' } };
  const { fetchImpl } = fakeFetch({ 'daily-resting-heart-rate': { dataPoints: [item] } });
  const { points, warnings } = await fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-03-01', to: '2026-03-02' });
  assert.deepEqual(warnings, []);
  assert.equal(points.length, 1);
  const { raw, ...point } = points[0];
  assert.deepEqual(point, { metric: 'resting_hr', sourceId: '2026-03-01', date: '2026-03-01', startTime: null, endTime: null, value: 71 });
  assert.equal(raw.name, null);
  assert.deepEqual(raw.date, { year: 2026, month: 3, day: 1 });
  assert.deepEqual(raw.dailyRestingHeartRate, item.dailyRestingHeartRate);
});

test('fetchMetricPoints still accepts flat civil dates for rollups and samples', async () => {
  const { fetchImpl } = fakeFetch({
    steps: { rollupDataPoints: [{ civilStartTime: { year: 2026, month: 3, day: 1 }, civilEndTime: { year: 2026, month: 3, day: 2 }, steps: { countSum: '10' } }] },
    weight: { dataPoints: [{ name: 'users/me/dataTypes/weight/dataPoints/w-flat', weight: { weightGrams: 80000, sampleTime: { physicalTime: '2026-03-02T23:30:00Z', utcOffset: '0s', civilTime: { year: 2026, month: 3, day: 1 } } } }] },
  });
  const { points, warnings } = await fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-03-01', to: '2026-03-02' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(points.map((point) => [point.metric, point.sourceId, point.date, point.value]), [['steps', '2026-03-01', '2026-03-01', 10], ['weight_kg', 'w-flat', '2026-03-01', 80]]);
});

test('fetchMetricPoints drops sample points whose civil date leaves the range', async () => {
  const { fetchImpl } = fakeFetch({
    weight: { dataPoints: [
      { name: 'users/me/dataTypes/weight/dataPoints/w-early', weight: { weightGrams: 80000, sampleTime: { physicalTime: '2026-03-01T02:00:00Z', utcOffset: '-10800s' } } },
      { name: 'users/me/dataTypes/weight/dataPoints/w-in', weight: { weightGrams: 80000, sampleTime: { physicalTime: '2026-03-01T02:00:00Z', utcOffset: '0s' } } },
      { name: 'users/me/dataTypes/weight/dataPoints/w-late', weight: { weightGrams: 80000, sampleTime: { physicalTime: '2026-03-02T20:00:00Z', utcOffset: '18000s' } } },
    ] },
  });
  const { points, warnings } = await fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-03-01', to: '2026-03-02' });
  assert.deepEqual(warnings, []);
  assert.deepEqual(points.map((point) => point.sourceId), ['w-in']);
});

test('fetchMetricPoints throws unauthorized on any 401 and rate_limited on 429', async () => {
  const unauthorized = fakeFetch({ 'daily-resting-heart-rate': () => json({ error: { code: 401 } }, 401) });
  await assert.rejects(fetchMetricPoints(unauthorized.fetchImpl, TOKEN, { from: '2026-03-01', to: '2026-03-02' }), (error) => error instanceof GoogleHealthError && error.code === 'unauthorized' && error.status === 401);
  assert.equal(listCalls(unauthorized.calls, 'daily-resting-heart-rate').length, 1);
  assert.equal(listCalls(unauthorized.calls, 'weight').length, 0);
  const limited = fakeFetch({ steps: () => json({ error: { code: 429 } }, 429) });
  await assert.rejects(fetchMetricPoints(limited.fetchImpl, TOKEN, { from: '2026-03-01', to: '2026-03-02' }), (error) => error instanceof GoogleHealthError && error.code === 'rate_limited' && error.status === 429);
  assert.equal(limited.calls.length, 1);
  const offline = fakeFetch({ distance: () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(fetchMetricPoints(offline.fetchImpl, TOKEN, { from: '2026-03-01', to: '2026-03-02' }), (error) => error instanceof GoogleHealthError && error.code === 'network');
});

test('fetchMetricPoints turns per-type failures into warnings and keeps going', async () => {
  const { fetchImpl, calls } = fakeFetch({
    steps: () => json({ error: 'boom' }, 500),
    distance: () => new Response('not json', { status: 200 }),
    'active-zone-minutes': { rollupDataPoints: 'nope' },
    'total-calories': (call) => (call.body.pageToken
      ? { rollupDataPoints: [rollup('2026-03-02', { totalCalories: { kcalSum: 2 } })], nextPageToken: 'again' }
      : { rollupDataPoints: [rollup('2026-03-01', { totalCalories: { kcalSum: 1 } })], nextPageToken: 'again' }),
    'daily-resting-heart-rate': { dataPoints: [{ dataSource: { deviceType: 'TRACKER' }, dailyRestingHeartRate: { beatsPerMinute: '50', date: { year: 2026, month: 3, day: 1 } } }] },
  });
  const { points, warnings, failed } = await fetchMetricPoints(fetchImpl, TOKEN, { from: '2026-03-01', to: '2026-03-02' });
  assert.deepEqual(warnings, [
    'steps: request failed (500)',
    'distance: invalid JSON response',
    'active-zone-minutes: invalid rollupDataPoints response',
    'total-calories: stopped after 200 pages',
  ]);
  // Only outright request failures are listed; skipped points stay warnings.
  assert.deepEqual(failed, ['steps', 'distance', 'active-zone-minutes', 'total-calories']);
  assert.equal(rollupCalls(calls, 'total-calories').length, 200);
  assert.deepEqual(byMetric(points, 'resting_hr').map((point) => point.value), [50]);
  // Pages fetched before the cap are kept; the upsert is idempotent.
  assert.deepEqual(byMetric(points, 'calories_kcal').map((point) => [point.date, point.value]), [['2026-03-01', 1], ['2026-03-02', 2]]);
  assert.equal(listCalls(calls, 'sleep').length, 1);
});
