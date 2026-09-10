import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createService } from '../server/service.js';
import { createApp } from '../server/index.js';
import { METRIC_KEYS } from '../public/metrics-catalog.js';

async function withService(t, fetchImpl) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'corpus-metrics-'));
  const service = await createService({ dataDir, fetchImpl });
  t.after(async () => { service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { service, dataDir };
}

const DAY_MS = 86_400_000;
const pad = (value) => String(value).padStart(2, '0');
const localDate = (now = new Date()) => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const parts = (date) => { const [year, month, day] = date.split('-').map(Number); return { year, month, day }; };
const today = localDate();
const yesterday = addDays(today, -1);
const rowCount = (dataDir, sql) => { const db = new DatabaseSync(path.join(dataDir, 'corpus.sqlite'), { readOnly: true }); try { return db.prepare(sql).get(); } finally { db.close(); } };
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const named = (slug, id) => `users/me/dataTypes/${slug}/dataPoints/${id}`;

function sampleData() {
  const sampleTime = (time) => ({ physicalTime: `${today}T${time}:00Z`, utcOffset: '0s', civilTime: { ...parts(today), hours: Number(time.slice(0, 2)) } });
  return {
    rollups: {
      steps: [{ civilStartTime: parts(yesterday), civilEndTime: parts(today), steps: { countSum: '8123' } }, { civilStartTime: parts(today), civilEndTime: parts(addDays(today, 1)), steps: { countSum: '4000' } }],
      distance: [{ civilStartTime: parts(today), distance: { millimetersSum: '3250000' } }],
      'active-zone-minutes': [{ civilStartTime: parts(today), activeZoneMinutes: { sumInFatBurnHeartZone: 10, sumInCardioHeartZone: 5, sumInPeakHeartZone: 1 } }],
      'total-calories': [{ civilStartTime: parts(today), totalCalories: { kcalSum: 2450 } }],
    },
    lists: {
      'daily-resting-heart-rate': [{ name: named('daily-resting-heart-rate', 'rhr-1'), dailyRestingHeartRate: { beatsPerMinute: 55, date: parts(today) } }],
      'daily-heart-rate-variability': [{ name: named('daily-heart-rate-variability', 'hrv-1'), dailyHeartRateVariability: { averageHeartRateVariabilityMilliseconds: 48, date: parts(today) } }, { name: named('daily-heart-rate-variability', 'hrv-2'), dailyHeartRateVariability: { date: parts(yesterday) } }],
      'daily-oxygen-saturation': [{ name: named('daily-oxygen-saturation', 'spo2-1'), dailyOxygenSaturation: { averagePercentage: 97.5, date: parts(today) } }],
      weight: [{ name: named('weight', 'w-1'), weight: { weightGrams: '80000', sampleTime: sampleTime('07:00') } }, { name: named('weight', 'w-2'), weight: { weightGrams: '81000', sampleTime: sampleTime('20:00') } }],
      'body-fat': [{ name: named('body-fat', 'bf-1'), bodyFat: { percentage: 18.2, sampleTime: sampleTime('07:00') } }],
      'run-vo2-max': [{ name: named('run-vo2-max', 'vo2-1'), runVo2Max: { runVo2Max: 45.1, sampleTime: sampleTime('07:00') } }],
      sleep: [
        { name: named('sleep', 'sleep-1'), sleep: { interval: { startTime: `${yesterday}T22:00:00Z`, endTime: `${today}T05:20:00Z`, startUtcOffset: '0s', endUtcOffset: '0s' }, summary: { minutesAsleep: 300, minutesAwake: 20, minutesInSleepPeriod: 320 }, stages: [
          { startTime: `${yesterday}T22:00:00Z`, endTime: `${yesterday}T23:00:00Z`, type: 'DEEP' }, { startTime: `${yesterday}T23:00:00Z`, endTime: `${today}T02:00:00Z`, type: 'LIGHT' },
          { startTime: `${today}T02:00:00Z`, endTime: `${today}T03:00:00Z`, type: 'REM' }, { startTime: `${today}T03:00:00Z`, endTime: `${today}T03:20:00Z`, type: 'AWAKE' }] } },
        { name: named('sleep', 'sleep-2'), sleep: { interval: { startTime: `${today}T13:00:00Z`, endTime: `${today}T14:00:00Z`, startUtcOffset: '0s', endUtcOffset: '0s' }, summary: { minutesAsleep: 60, minutesAwake: 0, minutesInSleepPeriod: 60 }, stages: [{ startTime: `${today}T13:00:00Z`, endTime: `${today}T14:00:00Z`, type: 'LIGHT' }] } },
      ],
    },
  };
}

// Answers Google endpoints by URL: token exchange/refresh, revoke, daily
// roll-ups, and data point lists. `validBearers` (when set) makes the Health
// API answer 401 for any other access token.
function googleFetch({ data = sampleData(), tokens = {}, validBearers = null } = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const auth = options.headers?.authorization ?? options.headers?.Authorization ?? null;
    const call = { host: parsed.hostname, path: parsed.pathname, method: options.method ?? 'GET', auth, body: options.body ?? null, query: Object.fromEntries(parsed.searchParams) };
    calls.push(call);
    if (parsed.hostname === 'oauth2.googleapis.com' && parsed.pathname === '/token') {
      const params = new URLSearchParams(String(options.body));
      const grant = tokens[params.get('grant_type')];
      const answer = grant ? grant(params) : null;
      return answer ? jsonResponse(answer) : jsonResponse({ error: 'invalid_grant' }, 400);
    }
    if (parsed.hostname === 'oauth2.googleapis.com' && parsed.pathname === '/revoke') return jsonResponse({});
    if (parsed.hostname === 'health.googleapis.com') {
      if (validBearers && !validBearers.has(auth)) return jsonResponse({ error: { status: 'UNAUTHENTICATED' } }, 401);
      const slug = parsed.pathname.split('/dataTypes/')[1].split('/')[0];
      if (parsed.pathname.endsWith(':dailyRollUp')) return jsonResponse({ rollupDataPoints: data.rollups[slug] ?? [] });
      return jsonResponse({ dataPoints: data.lists[slug] ?? [] });
    }
    throw new Error(`Unexpected request to ${parsed.hostname}`);
  };
  return { fetchImpl, calls };
}

const tokenAnswer = (accessToken, expiresIn = 3600, refreshToken = 'refresh-1') => ({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn, scope: 'https://www.googleapis.com/auth/googlehealth.sleep.readonly', token_type: 'Bearer' });

async function connect(service) {
  await service.saveSettings({ googleClientId: 'client-id.apps.googleusercontent.com', googleClientSecret: 'client-secret-value' });
  const { url } = await service.googleHealthConnect({ redirectUri: 'http://127.0.0.1:3210/api/metrics/google/callback' });
  const state = new URL(url).searchParams.get('state');
  return service.googleHealthCallback({ code: 'auth-code-value', state });
}

test('schema version 6 creates the metric tables and demo metrics never touch them', async (t) => {
  const { service, dataDir } = await withService(t, async () => { throw new Error('not called'); });
  const db = new DatabaseSync(path.join(dataDir, 'corpus.sqlite'), { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version').value, '6');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('metric_sources', 'metric_points', 'metric_points_by_metric_date') ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(names, ['metric_points', 'metric_points_by_metric_date', 'metric_sources']);
  const metrics = service.getMetrics({ days: 90 });
  assert.equal(metrics.mode, 'demo');
  assert.deepEqual(Object.keys(metrics.series).sort(), [...METRIC_KEYS].sort());
  assert.equal(metrics.range.to, today);
  assert.equal(metrics.range.from, addDays(today, -89));
  assert.equal(metrics.series.steps.length > 80, true);
  assert.ok(metrics.series.steps.every((point) => point.value >= 5000 && point.value <= 14000 && point.date >= metrics.range.from && point.date <= metrics.range.to));
  assert.ok(metrics.series.weight_kg.every((point) => point.value >= 78.5 && point.value <= 81));
  assert.ok(metrics.series.sleep_minutes.length < 90, 'demo data leaves gaps for the UI to fill');
  const stage = (key, date) => metrics.series[key].find((point) => point.date === date)?.value ?? 0;
  for (const point of metrics.series.sleep_minutes) assert.equal(point.value, stage('sleep_deep_minutes', point.date) + stage('sleep_light_minutes', point.date) + stage('sleep_rem_minutes', point.date));
  assert.deepEqual(service.getMetrics({ days: 90 }), metrics, 'demo series are deterministic');
  assert.deepEqual(metrics.sources, []);
  assert.equal(service.getMetrics({ days: 3 }).range.from, addDays(today, -6));
  assert.equal(service.getMetrics({ days: 10000 }).range.from, addDays(today, -729));
  assert.equal(service.getMetrics({ days: 'lots' }).range.from, addDays(today, -89));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM metric_points').get().count, 0);
});

test('google client credentials stay private and gate the OAuth flow', async (t) => {
  const { service, dataDir } = await withService(t, googleFetch().fetchImpl);
  assert.deepEqual(service.getState().settings.googleHealth, { hasClient: false, connected: false, lastSync: null });
  await assert.rejects(service.googleHealthConnect({ redirectUri: 'http://127.0.0.1:3210/api/metrics/google/callback' }), { code: 'no_google_client' });
  await assert.rejects(service.saveSettings({ googleClientId: 'x'.repeat(513) }), { code: 'validation' });
  await service.saveSettings({ googleClientId: ' client-id ', googleClientSecret: 'client-secret-value' });
  await service.saveSettings({ googleClientId: '', googleClientSecret: '' }); // empty fields keep stored credentials
  const settings = service.getState().settings;
  assert.deepEqual(settings.googleHealth, { hasClient: true, connected: false, lastSync: null });
  assert.doesNotMatch(JSON.stringify(service.getState()), /client-secret-value/);
  const file = path.join(dataDir, 'settings.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { googleClientId: 'client-id', googleClientSecret: 'client-secret-value' });
  await assert.rejects(service.googleHealthConnect({ redirectUri: 'https://attacker.example/api/metrics/google/callback' }), { code: 'validation' });
  await assert.rejects(service.googleHealthConnect({ redirectUri: 'http://127.0.0.1:3210/api/other' }), { code: 'validation' });
  const { url } = await service.googleHealthConnect({ redirectUri: 'http://localhost:3210/api/metrics/google/callback' });
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(parsed.searchParams.get('client_id'), 'client-id');
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost:3210/api/metrics/google/callback');
  assert.ok(parsed.searchParams.get('state'));
  assert.doesNotMatch(url, /client-secret-value/);
  await assert.rejects(service.googleHealthCallback({ code: 'auth-code-value', state: 'not-the-state' }), (error) => error.code === 'oauth_state' && error.status === 400);
  await assert.rejects(service.syncMetrics(), { code: 'not_connected' });
});

test('callback exchanges the code, sync upserts points idempotently, aggregates, and exports', async (t) => {
  const mock = googleFetch({ tokens: { authorization_code: (params) => params.get('code') === 'auth-code-value' && params.get('code_verifier') ? tokenAnswer('access-1') : null } });
  const { service, dataDir } = await withService(t, mock.fetchImpl);
  assert.deepEqual(await connect(service), { connected: true });
  const exchange = mock.calls.find((call) => call.path === '/token');
  assert.equal(new URLSearchParams(exchange.body).get('redirect_uri'), 'http://127.0.0.1:3210/api/metrics/google/callback');
  assert.deepEqual(service.getState().settings.googleHealth, { hasClient: true, connected: true, lastSync: null });
  assert.deepEqual(service.getMetrics().sources, [{ id: 'google-health', kind: 'api', label: 'Google Health', lastSync: null, syncedThrough: null }]);
  const stored = JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.equal(stored.googleHealth.accessToken, 'access-1');
  assert.equal(stored.googleHealth.refreshToken, 'refresh-1');
  assert.doesNotMatch(JSON.stringify(service.getState()), /access-1|refresh-1|auth-code-value/);
  assert.equal(service.getState().mode, 'demo');

  const result = await service.syncMetrics();
  assert.equal(result.mode, 'live');
  assert.equal(service.getState().mode, 'live');
  assert.equal(result.imported, 19);
  assert.ok(result.warnings.some((warning) => warning.startsWith('daily-heart-rate-variability: skipped 1 point')));
  assert.ok(mock.calls.filter((call) => call.host === 'health.googleapis.com').every((call) => call.auth === 'Bearer access-1'));
  assert.equal(mock.calls.filter((call) => call.path === '/token').length, 1, 'a fresh token is not refreshed');
  const rollup = mock.calls.find((call) => call.path.endsWith('/steps/dataPoints:dailyRollUp'));
  assert.equal(rollup.method, 'POST');
  assert.deepEqual(JSON.parse(rollup.body).range.start, { date: parts(addDays(today, -365)) });
  assert.equal(JSON.parse(rollup.body).pageSize, undefined, 'the live API rejects a page size below the day count');
  assert.equal(JSON.parse(rollup.body).windowSizeDays, 1);
  assert.match(mock.calls.find((call) => call.path.endsWith('/weight/dataPoints')).query.filter, /weight\.sample_time\.physical_time >= /);
  assert.equal(mock.calls.find((call) => call.path.endsWith('/sleep/dataPoints')).query.pageSize, '25');
  const value = (key, date = today) => result.series[key].find((point) => point.date === date)?.value;
  assert.deepEqual(result.series.steps, [{ date: yesterday, value: 8123 }, { date: today, value: 4000 }]);
  assert.equal(value('distance_km'), 3.25);
  assert.equal(value('active_zone_minutes'), 16);
  assert.equal(value('calories_kcal'), 2450);
  assert.equal(value('resting_hr'), 55);
  assert.deepEqual(result.series.hrv_ms, [{ date: today, value: 48 }]);
  assert.equal(value('spo2_pct'), 97.5);
  assert.equal(value('weight_kg'), 80.5, 'two weight samples on one day average');
  assert.equal(value('body_fat_pct'), 18.2);
  assert.equal(value('vo2max'), 45.1);
  assert.equal(value('sleep_minutes'), 360, 'two sleep sessions on one civil date add up');
  assert.equal(value('sleep_deep_minutes'), 60);
  assert.equal(value('sleep_light_minutes'), 240);
  assert.equal(value('sleep_rem_minutes'), 60);
  assert.equal(value('sleep_awake_minutes'), 20);
  assert.deepEqual(Object.keys(result.series).sort(), [...METRIC_KEYS].sort());
  assert.equal(result.sources[0].syncedThrough, today);
  assert.ok(result.sources[0].lastSync);
  assert.equal(service.getState().settings.googleHealth.lastSync, result.sources[0].lastSync);
  assert.equal(rowCount(dataDir, 'SELECT COUNT(*) AS count FROM metric_points').count, 19);
  assert.equal(rowCount(dataDir, "SELECT cursor_json FROM metric_sources WHERE id = 'google-health'").cursor_json, JSON.stringify({ syncedThrough: today }));
  assert.doesNotMatch(JSON.stringify(rowCount(dataDir, 'SELECT GROUP_CONCAT(raw_json) AS raw FROM metric_points')), /access-1|refresh-1/);

  const before = mock.calls.length;
  const again = await service.syncMetrics();
  assert.equal(rowCount(dataDir, 'SELECT COUNT(*) AS count FROM metric_points').count, 19, 're-sync is idempotent');
  assert.equal(again.imported, 19);
  const resync = mock.calls.slice(before).find((call) => call.path.endsWith('/steps/dataPoints:dailyRollUp'));
  assert.deepEqual(JSON.parse(resync.body).range.start, { date: parts(addDays(today, -7)) }, 'later syncs refetch from syncedThrough - 7 days');
  assert.equal(service.getMetrics({ days: 7 }).series.steps.length, 2);

  const exported = await service.exportMarkdown();
  assert.ok(exported.files.includes('exports/metrics.md'));
  const markdown = await readFile(path.join(dataDir, 'exports', 'metrics.md'), 'utf8');
  assert.match(markdown, /# Health metrics/);
  assert.match(markdown, /Google Health \(api\): last sync .+, synced through /);
  assert.match(markdown, /- Weight: 80\.5 kg \(/);
  assert.match(markdown, new RegExp(`\\| ${today} \\| 4000 \\|`));
  assert.doesNotMatch(markdown, /Demo data|access-1|refresh-1/);

  const disconnected = await service.googleHealthDisconnect();
  assert.deepEqual(disconnected.googleHealth, { hasClient: true, connected: false, lastSync: again.sources[0].lastSync }, 'disconnecting keeps the last sync time');
  assert.ok(mock.calls.some((call) => call.path === '/revoke'));
  assert.equal(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).googleHealth, undefined);
  assert.equal(rowCount(dataDir, 'SELECT COUNT(*) AS count FROM metric_points').count, 19, 'disconnecting keeps imported data');
  await assert.rejects(service.syncMetrics(), { code: 'not_connected' });
  await service.setDemo(true);
  await service.exportMarkdown();
  assert.match(await readFile(path.join(dataDir, 'exports', 'metrics.md'), 'utf8'), /Demo data/);
});

test('sync refreshes expiring tokens, retries once after 401, and disconnects when the grant is gone', async (t) => {
  const expiring = googleFetch({ tokens: { authorization_code: () => tokenAnswer('access-1', 10), refresh_token: (params) => params.get('refresh_token') === 'refresh-1' ? { access_token: 'access-2', expires_in: 3600 } : null } });
  const first = await withService(t, expiring.fetchImpl);
  await connect(first.service);
  const result = await first.service.syncMetrics();
  assert.equal(result.imported, 19);
  const refreshes = expiring.calls.filter((call) => call.path === '/token' && new URLSearchParams(call.body).get('grant_type') === 'refresh_token');
  assert.equal(refreshes.length, 1);
  assert.ok(expiring.calls.filter((call) => call.host === 'health.googleapis.com').every((call) => call.auth === 'Bearer access-2'));
  const stored = JSON.parse(await readFile(path.join(first.dataDir, 'settings.json'), 'utf8')).googleHealth;
  assert.equal(stored.accessToken, 'access-2');
  assert.equal(stored.refreshToken, 'refresh-1', 'a refresh without a new refresh token keeps the old one');

  const rejected = googleFetch({ validBearers: new Set(['Bearer access-2']), tokens: { authorization_code: () => tokenAnswer('access-1'), refresh_token: () => ({ access_token: 'access-2', expires_in: 3600 }) } });
  const second = await withService(t, rejected.fetchImpl);
  await connect(second.service);
  assert.equal((await second.service.syncMetrics()).imported, 19, 'a 401 triggers one refresh and a retry');
  assert.equal(rejected.calls.filter((call) => call.host === 'health.googleapis.com' && call.auth === 'Bearer access-1').length, 1);

  const revoked = googleFetch({ validBearers: new Set(), tokens: { authorization_code: () => tokenAnswer('access-1'), refresh_token: () => ({ access_token: 'access-2', expires_in: 3600 }) } });
  const third = await withService(t, revoked.fetchImpl);
  await connect(third.service);
  await assert.rejects(third.service.syncMetrics(), (error) => error.code === 'not_connected' && error.status === 401 && !/access-|refresh-/.test(error.message));
  assert.equal(third.service.getState().settings.googleHealth.connected, false);
  assert.equal(third.service.getState().mode, 'demo', 'a failed sync does not switch modes');
  assert.equal(rowCount(third.dataDir, 'SELECT COUNT(*) AS count FROM metric_points').count, 0);

  const gone = googleFetch({ tokens: { authorization_code: () => tokenAnswer('access-1', 10) } });
  const fourth = await withService(t, gone.fetchImpl);
  await connect(fourth.service);
  await assert.rejects(fourth.service.syncMetrics(), { code: 'not_connected' });
  assert.equal(fourth.service.getState().settings.googleHealth.connected, false, 'invalid_grant on refresh clears the tokens');
});

test('HTTP routes serve metrics, gate connect, and render the callback page without echoing the code', async (t) => {
  const { service } = await withService(t, googleFetch().fetchImpl);
  const app = createApp(service);
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const metrics = await fetch(`${base}/api/metrics?days=30`);
  assert.equal(metrics.status, 200);
  const payload = await metrics.json();
  assert.equal(payload.mode, 'demo');
  assert.deepEqual(payload.range, { from: addDays(today, -29), to: today });
  assert.deepEqual(Object.keys(payload.series).sort(), [...METRIC_KEYS].sort());
  const connectResponse = await fetch(`${base}/api/metrics/google/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(connectResponse.status, 400);
  assert.equal((await connectResponse.json()).code, 'no_google_client');
  await service.saveSettings({ googleClientId: 'client-id', googleClientSecret: 'client-secret-value' });
  const started = await fetch(`${base}/api/metrics/google/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(new URL((await started.json()).url).searchParams.get('redirect_uri'), `${base}/api/metrics/google/callback`);
  const callback = await fetch(`${base}/api/metrics/google/callback?code=secret-code-value&state=not-the-state`, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(callback.status, 400);
  assert.match(callback.headers.get('content-type'), /^text\/html/);
  assert.match(callback.headers.get('content-security-policy'), /default-src 'self'/);
  const html = await callback.text();
  assert.match(html, /invalid or has expired/);
  assert.doesNotMatch(html, /secret-code-value/);
  const foreignHost = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/metrics/google/callback?code=x&state=y`, { headers: { Host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(foreignHost, 403, 'the callback still enforces the Host check');
  assert.equal((await fetch(`${base}/api/metrics/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  const disconnect = await fetch(`${base}/api/metrics/google/disconnect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(disconnect.status, 200);
  assert.deepEqual((await disconnect.json()).googleHealth, { hasClient: true, connected: false, lastSync: null });
});

test('a sync with a failed data type keeps its cursor so the same range is fetched again', async (t) => {
  const mock = googleFetch({ tokens: { authorization_code: () => tokenAnswer('access-1') } });
  let failSteps = true;
  const fetchImpl = async (url, options) => (failSteps && String(url).includes('/steps/dataPoints:dailyRollUp') ? jsonResponse({ error: { message: 'boom' } }, 500) : mock.fetchImpl(url, options));
  const { service, dataDir } = await withService(t, fetchImpl);
  await connect(service);
  const first = await service.syncMetrics();
  assert.ok(first.warnings.some((warning) => warning.startsWith('steps:')));
  assert.ok(first.imported > 0, 'points from the other data types are still stored');
  assert.equal(first.sources[0].syncedThrough, null, 'the cursor does not advance past a failed data type');
  assert.ok(first.sources[0].lastSync);
  assert.equal(rowCount(dataDir, "SELECT cursor_json FROM metric_sources WHERE id = 'google-health'").cursor_json, null);
  failSteps = false;
  const before = mock.calls.length;
  const second = await service.syncMetrics();
  assert.ok(!second.warnings.some((warning) => warning.startsWith('steps:')), 'skipped-point warnings alone do not hold the cursor back');
  assert.equal(second.sources[0].syncedThrough, today);
  const rollup = mock.calls.slice(before).find((call) => call.path.endsWith('/steps/dataPoints:dailyRollUp'));
  assert.deepEqual(JSON.parse(rollup.body).range.start, { date: parts(addDays(today, -365)) }, 'the retry fetches the full first-sync range');
});
