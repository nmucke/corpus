import { createHash, randomBytes } from 'node:crypto';
import { WORKOUT_METRICS } from '../public/workout-metrics-catalog.js';

// Google Health API v4 adapter. Pure functions over an injected fetchImpl,
// mirroring server/hevy.js. See docs/metrics.md ("Source decision", "Adapter").
const API_BASE = 'https://health.googleapis.com/v4/users/me/dataTypes';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const TIMEOUT_MS = 20_000;
// A full year is roughly 40 requests; this is a hard stop for broken pagination.
const MAX_PAGES = 200;
const DAY_MS = 86_400_000;
// Workout windows: the live API caps pageSize at 5000 (default 50) and a padded
// workout window holds at most a few thousand raw heart-rate samples.
const WORKOUT_PAGE_SIZE = 5000;
const MAX_WORKOUT_PAGES = 20;
const MAX_WORKOUT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRES_IN = 3600;

export const SCOPES = [
  'https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly',
  'https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly',
  'https://www.googleapis.com/auth/googlehealth.sleep.readonly',
];

export class GoogleHealthError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'GoogleHealthError';
    this.code = code;
    this.status = status ?? ({ unauthorized: 401, rate_limited: 429, network: 502, invalid_response: 502, oauth: 400 }[code] ?? 502);
  }
}

// Data type table. `payload` is the DataPoint field holding the values,
// `value` extracts the catalog-unit number from it (null = skip the point).
// The `filterField` prefixes are the first thing to adjust if a live account
// returns HTTP 400 for a filter: Google's docs mix camelCase and snake_case
// (daily types documented as camelCase, sample and sleep types as snake_case).
const DATA_TYPES = [
  { slug: 'steps', metric: 'steps', method: 'dailyRollUp', windowDays: 90, payload: 'steps', value: (v) => toNumber(v.countSum) },
  { slug: 'distance', metric: 'distance_km', method: 'dailyRollUp', windowDays: 90, payload: 'distance', value: (v) => scale(toNumber(v.millimetersSum), 1e6) },
  { slug: 'active-zone-minutes', metric: 'active_zone_minutes', method: 'dailyRollUp', windowDays: 90, payload: 'activeZoneMinutes', value: (v) => sumPresent(v.sumInFatBurnHeartZone, v.sumInCardioHeartZone, v.sumInPeakHeartZone) },
  { slug: 'total-calories', metric: 'calories_kcal', method: 'dailyRollUp', windowDays: 14, payload: 'totalCalories', value: (v) => toNumber(v.kcalSum) },
  { slug: 'daily-resting-heart-rate', metric: 'resting_hr', method: 'list', shape: 'daily', filterField: 'daily_resting_heart_rate.date', pageSize: 1000, payload: 'dailyRestingHeartRate', value: (v) => toNumber(v.beatsPerMinute) },
  { slug: 'daily-heart-rate-variability', metric: 'hrv_ms', method: 'list', shape: 'daily', filterField: 'daily_heart_rate_variability.date', pageSize: 1000, payload: 'dailyHeartRateVariability', value: (v) => toNumber(v.averageHeartRateVariabilityMilliseconds) },
  { slug: 'daily-oxygen-saturation', metric: 'spo2_pct', method: 'list', shape: 'daily', filterField: 'daily_oxygen_saturation.date', pageSize: 1000, payload: 'dailyOxygenSaturation', value: (v) => toNumber(v.averagePercentage) },
  { slug: 'weight', metric: 'weight_kg', method: 'list', shape: 'sample', filterField: 'weight.sample_time.physical_time', pageSize: 1000, payload: 'weight', value: (v) => scale(toNumber(v.weightGrams), 1000) },
  { slug: 'body-fat', metric: 'body_fat_pct', method: 'list', shape: 'sample', filterField: 'body_fat.sample_time.physical_time', pageSize: 1000, payload: 'bodyFat', value: (v) => toNumber(v.percentage) },
  { slug: 'run-vo2-max', metric: 'vo2max', method: 'list', shape: 'sample', filterField: 'run_vo2_max.sample_time.physical_time', pageSize: 1000, payload: 'runVo2Max', value: (v) => toNumber(v.runVo2Max) },
  { slug: 'sleep', metric: 'sleep_minutes', method: 'list', shape: 'sleep', filterField: 'sleep.interval.end_time', pageSize: 25, payload: 'sleep' },
];

const SLEEP_STAGES = { DEEP: 'deep', LIGHT: 'light', ASLEEP: 'light', REM: 'rem', AWAKE: 'awake', RESTLESS: 'awake' };
const STAGE_METRICS = { deep: 'sleep_deep_minutes', light: 'sleep_light_minutes', rem: 'sleep_rem_minutes', awake: 'sleep_awake_minutes' };
const FATAL_CODES = new Set(['unauthorized', 'rate_limited', 'network']);

// --- value and date helpers -------------------------------------------------

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
}

function scale(value, divisor) { return value === null ? null : value / divisor; }

function sumPresent(...values) {
  const numbers = values.map(toNumber).filter((value) => value !== null);
  return numbers.length ? numbers.reduce((total, value) => total + value, 0) : null;
}

function toInteger(value) {
  const number = toNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }
function parseDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && isoDate(ms) === value ? ms : null;
}
function addDays(date, days) { return isoDate(parseDate(date) + days * DAY_MS); }
function civilParts(date) {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}
function dateFromParts(parts) {
  const year = toInteger(parts?.year);
  const month = toInteger(parts?.month);
  const day = toInteger(parts?.day);
  if (year === null || month === null || day === null) return null;
  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return parseDate(text) === null ? null : text;
}
// Google Duration strings: "3600s", "-18000s", "0s", "1.5s". Unknown → 0 (UTC).
function offsetSeconds(duration) {
  const match = typeof duration === 'string' ? /^(-?\d+(?:\.\d+)?)s$/.exec(duration.trim()) : null;
  return match ? Number(match[1]) : 0;
}
function civilDateOf(time, offset) {
  const ms = typeof time === 'string' ? Date.parse(time) : NaN;
  return Number.isFinite(ms) ? isoDate(ms + offsetSeconds(offset) * 1000) : null;
}
function lastSegment(name) {
  const segment = typeof name === 'string' ? name.split('/').at(-1) : '';
  return segment || null;
}
function minutesBetween(start, end) {
  const from = typeof start === 'string' ? Date.parse(start) : NaN;
  const to = typeof end === 'string' ? Date.parse(end) : NaN;
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? (to - from) / 60_000 : 0;
}

// --- OAuth -------------------------------------------------------------------

export function pkcePair() {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizationUrl({ clientId, redirectUri, state, codeChallenge } = {}) {
  for (const [key, value] of Object.entries({ clientId, redirectUri, state, codeChallenge })) {
    if (typeof value !== 'string' || !value) throw new TypeError(`${key} is required.`);
  }
  const url = new URL(AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

// Error messages carry only Google's short `error` code, never request params.
async function tokenRequest(fetchImpl, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw new GoogleHealthError('network', 'Google token request timed out.');
    throw new GoogleHealthError('network', 'Could not reach Google to exchange tokens.');
  }
  try {
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    if (!response?.ok) {
      const code = typeof json?.error === 'string' && /^[\w-]{1,64}$/.test(json.error) ? json.error : `HTTP ${response?.status ?? 'error'}`;
      throw new GoogleHealthError('oauth', `Google rejected the token request (${code}).`, 400);
    }
    if (!json || typeof json !== 'object' || typeof json.access_token !== 'string' || !json.access_token) throw new GoogleHealthError('oauth', 'Google returned an invalid token response.', 502);
    const expiresIn = toNumber(json.expires_in) ?? DEFAULT_EXPIRES_IN;
    return {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === 'string' && json.refresh_token ? json.refresh_token : null,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      scope: typeof json.scope === 'string' ? json.scope : '',
    };
  } finally {
    clearTimeout(timer);
  }
}

function requireClient(clientId, clientSecret) {
  if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) throw new GoogleHealthError('oauth', 'Google client ID and client secret are required.', 400);
}

export async function exchangeCode(fetchImpl, { clientId, clientSecret, code, codeVerifier, redirectUri } = {}) {
  requireClient(clientId, clientSecret);
  if (typeof code !== 'string' || !code || typeof codeVerifier !== 'string' || !codeVerifier || typeof redirectUri !== 'string' || !redirectUri) throw new GoogleHealthError('oauth', 'Authorization code, verifier, and redirect URI are required.', 400);
  return tokenRequest(fetchImpl, { grant_type: 'authorization_code', code, code_verifier: codeVerifier, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri });
}

export async function refreshAccessToken(fetchImpl, { clientId, clientSecret, refreshToken } = {}) {
  requireClient(clientId, clientSecret);
  if (typeof refreshToken !== 'string' || !refreshToken) throw new GoogleHealthError('oauth', 'A refresh token is required.', 400);
  const tokens = await tokenRequest(fetchImpl, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret });
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

// Best effort: returns true when Google acknowledged the revocation.
export async function revokeToken(fetchImpl, token) {
  if (typeof token !== 'string' || !token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const url = new URL(REVOKE_URL);
    url.searchParams.set('token', token);
    const response = await fetchImpl(url.toString(), { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: controller.signal });
    return Boolean(response?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// --- data points -------------------------------------------------------------

async function request(fetchImpl, url, accessToken, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, { ...init, headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...init.headers }, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    if (error?.name === 'AbortError') throw new GoogleHealthError('network', 'Google Health request timed out.');
    throw new GoogleHealthError('network', 'Could not reach Google Health.');
  }
  try {
    const status = response?.status;
    if (status === 401) throw new GoogleHealthError('unauthorized', 'Google Health rejected the access token.', 401);
    if (status === 429) throw new GoogleHealthError('rate_limited', 'Google Health rate limited the sync. Please try again later.', 429);
    if (status === 403) throw new GoogleHealthError('invalid_response', 'access denied (403); check the enabled API and granted scopes', 502);
    if (!response?.ok) throw new GoogleHealthError('invalid_response', `request failed (${status ?? 'error'})`, 502);
    const json = await response.json();
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new GoogleHealthError('invalid_response', 'invalid JSON response', 502);
    return json;
  } catch (error) {
    if (error instanceof GoogleHealthError) throw error;
    throw new GoogleHealthError('invalid_response', 'invalid JSON response', 502);
  } finally {
    clearTimeout(timer);
  }
}

function itemsOf(json, key) {
  if (json[key] === undefined) return [];
  if (Array.isArray(json[key])) return json[key];
  throw new GoogleHealthError('invalid_response', `invalid ${key} response`, 502);
}

function nextToken(json) { return typeof json.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : null; }

// Inclusive civil-date windows of at most windowDays days each.
function windows(from, to, windowDays) {
  const result = [];
  for (let start = from; start <= to; start = addDays(start, windowDays)) {
    const end = addDays(start, windowDays - 1);
    result.push({ start, end: end < to ? end : to });
  }
  return result;
}

async function* rollupItems(fetchImpl, accessToken, type, from, to) {
  const url = `${API_BASE}/${type.slug}/dataPoints:dailyRollUp`;
  for (const window of windows(from, to, type.windowDays)) {
    let pageToken = null;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      // `range` is a CivilTimeInterval: CivilDateTime `{ date: {year, month, day} }` with an exclusive end.
      // No pageSize: the live API rejects a page size smaller than the number of days in the range.
      const body = { range: { start: { date: civilParts(window.start) }, end: { date: civilParts(addDays(window.end, 1)) } }, windowSizeDays: 1 };
      if (pageToken) body.pageToken = pageToken;
      const json = await request(fetchImpl, url, accessToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      yield* itemsOf(json, 'rollupDataPoints');
      pageToken = nextToken(json);
      if (!pageToken) break;
      if (page === MAX_PAGES) throw new GoogleHealthError('invalid_response', `stopped after ${MAX_PAGES} pages`, 502);
    }
  }
}

function listFilter(type, from, to) {
  if (type.shape === 'daily') return `${type.filterField} >= "${from}" AND ${type.filterField} < "${addDays(to, 1)}"`;
  // Physical timestamps: widen by a day on each side so civil dates near the
  // range edges are not lost; points are trimmed to [from, to] after mapping.
  return `${type.filterField} >= "${addDays(from, -1)}T00:00:00Z" AND ${type.filterField} < "${addDays(to, 2)}T00:00:00Z"`;
}

// The one paginated `dataPoints` list used by both the daily series and the
// workout windows; they differ only in the filter, the page size, and the cap.
async function* pagedDataPoints(fetchImpl, accessToken, slug, filter, pageSize, maxPages) {
  let pageToken = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = new URL(`${API_BASE}/${slug}/dataPoints`);
    url.searchParams.set('filter', filter);
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const json = await request(fetchImpl, url.toString(), accessToken, { method: 'GET' });
    yield* itemsOf(json, 'dataPoints');
    pageToken = nextToken(json);
    if (!pageToken) return;
    if (page === maxPages) throw new GoogleHealthError('invalid_response', `stopped after ${maxPages} pages`, 502);
  }
}

function point(metric, sourceId, date, startTime, endTime, value, raw) {
  return { metric, sourceId, date, startTime: startTime ?? null, endTime: endTime ?? null, value, raw };
}

function mapSleep(item) {
  const sleep = item?.sleep && typeof item.sleep === 'object' ? item.sleep : {};
  const id = lastSegment(item?.name);
  const interval = sleep.interval && typeof sleep.interval === 'object' ? sleep.interval : {};
  const date = civilDateOf(interval.endTime, interval.endUtcOffset);
  if (!id || !date) return null;
  const stages = Array.isArray(sleep.stages) ? sleep.stages : [];
  const minutes = { deep: 0, light: 0, rem: 0, awake: 0 };
  for (const stage of stages) {
    const key = SLEEP_STAGES[String(stage?.type ?? '').toUpperCase()];
    if (key) minutes[key] += minutesBetween(stage.startTime, stage.endTime);
  }
  const summary = sleep.summary && typeof sleep.summary === 'object' ? sleep.summary : null;
  const asleep = toNumber(summary?.minutesAsleep) ?? (stages.length ? minutes.deep + minutes.light + minutes.rem : null);
  if (asleep === null) return null;
  const raw = { name: item.name, interval, summary, stages: stages.map((stage) => ({ startTime: stage?.startTime ?? null, endTime: stage?.endTime ?? null, type: stage?.type ?? null })) };
  const points = [point('sleep_minutes', id, date, interval.startTime ?? null, interval.endTime ?? null, asleep, raw)];
  for (const [stage, metric] of Object.entries(STAGE_METRICS)) {
    if (minutes[stage] > 0) points.push(point(metric, `${id}:${stage}`, date, interval.startTime ?? null, interval.endTime ?? null, minutes[stage], { sessionId: id, stage, minutes: minutes[stage] }));
  }
  return points;
}

// Returns an array of points, or null when the item has no usable value.
function mapItem(type, item) {
  if (!item || typeof item !== 'object') return null;
  if (type.shape === 'sleep') return mapSleep(item);
  const payload = item[type.payload] && typeof item[type.payload] === 'object' ? item[type.payload] : {};
  const value = type.value(payload);
  if (value === null || !Number.isFinite(value)) return null;
  if (type.method === 'dailyRollUp') {
    const date = dateFromParts(item.civilStartTime?.date ?? item.civilStartTime);
    return date ? [point(type.metric, date, date, null, null, value, { civilStartTime: item.civilStartTime, civilEndTime: item.civilEndTime ?? null, [type.payload]: payload })] : null;
  }
  if (type.shape === 'daily') {
    // Daily summaries carry no `name`; there is one value per civil date, so the date is the id.
    const dateParts = payload.date ?? item.date;
    const date = dateFromParts(dateParts);
    const id = lastSegment(item.name) ?? date;
    return date ? [point(type.metric, id, date, null, null, value, { name: item.name ?? null, date: dateParts, [type.payload]: payload })] : null;
  }
  const id = lastSegment(item.name);
  if (!id) return null;
  const sampleTime = payload.sampleTime ?? item.sampleTime ?? {};
  const date = dateFromParts(sampleTime.civilTime?.date ?? sampleTime.civilTime) ?? civilDateOf(sampleTime.physicalTime, sampleTime.utcOffset);
  return date ? [point(type.metric, id, date, sampleTime.physicalTime ?? null, null, value, { name: item.name, sampleTime, [type.payload]: payload })] : null;
}

export async function fetchMetricPoints(fetchImpl, accessToken, { from, to } = {}) {
  if (typeof accessToken !== 'string' || !accessToken) throw new TypeError('An access token is required.');
  if (parseDate(from) === null || parseDate(to) === null) throw new TypeError('from and to must be YYYY-MM-DD dates.');
  if (from > to) throw new TypeError('from must not be after to.');
  const points = new Map();
  const warnings = [];
  const failed = [];
  for (const type of DATA_TYPES) {
    let skipped = 0;
    try {
      const items = type.method === 'dailyRollUp'
        ? rollupItems(fetchImpl, accessToken, type, from, to)
        : pagedDataPoints(fetchImpl, accessToken, type.slug, listFilter(type, from, to), type.pageSize, MAX_PAGES);
      for await (const item of items) {
        const mapped = mapItem(type, item);
        if (!mapped) { skipped += 1; continue; }
        for (const entry of mapped) if (entry.date >= from && entry.date <= to) points.set(`${entry.metric} ${entry.sourceId}`, entry);
      }
    } catch (error) {
      if (error instanceof GoogleHealthError && FATAL_CODES.has(error.code)) throw error;
      warnings.push(`${type.slug}: ${error instanceof GoogleHealthError ? error.message : 'could not map the response'}`);
      failed.push(type.slug);
    }
    if (skipped > 0) warnings.push(`${type.slug}: skipped ${skipped} point${skipped === 1 ? '' : 's'} without a numeric value`);
  }
  // `failed` lists data types whose request failed outright; skipped points are warnings only.
  return { points: [...points.values()], warnings, failed };
}

// --- workout samples ---------------------------------------------------------

// High-frequency data inside one workout window. The catalog row drives the
// request (slug, method, windowSeconds); this table only adds what the wire
// format needs, so a new metric is one catalog row plus one entry here.
const WORKOUT_FIELDS = {
  heart_rate: {
    filterField: 'heart_rate.sample_time.physical_time',
    payload: 'heartRate',
    // Live shape: beatsPerMinute is an int64 string, sampleTime.physicalTime an RFC 3339 instant.
    map: (payload) => {
      const atMs = Date.parse(payload?.sampleTime?.physicalTime ?? '');
      const value = toNumber(payload?.beatsPerMinute);
      return Number.isFinite(atMs) && value !== null ? { atMs, value, durationMs: null, label: null } : null;
    },
  },
  steps: { payload: 'steps', map: (payload) => ({ value: toNumber(payload?.countSum) }) },
  calories: { payload: 'totalCalories', map: (payload) => ({ value: toNumber(payload?.kcalSum) }) },
  zone: {
    filterField: 'active_zone_minutes.interval.start_time',
    payload: 'activeZoneMinutes',
    // Only minutes that reached a zone are reported, one interval each.
    map: (payload) => {
      const atMs = Date.parse(payload?.interval?.startTime ?? '');
      const endMs = Date.parse(payload?.interval?.endTime ?? '');
      const value = toNumber(payload?.activeZoneMinutes);
      const zone = typeof payload?.heartRateZone === 'string' ? payload.heartRateZone : null;
      return Number.isFinite(atMs) && value !== null ? { atMs, value, durationMs: Number.isFinite(endMs) && endMs > atMs ? endMs - atMs : 60_000, label: zone } : null;
    },
  },
};

// RFC 3339 at second precision: the live filter parser accepts `...Z` instants.
function rfc3339(ms, roundUp = false) {
  const seconds = roundUp ? Math.ceil(ms / 1000) : Math.floor(ms / 1000);
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sourceOf(item) {
  const source = item?.dataSource && typeof item.dataSource === 'object' ? item.dataSource : {};
  const platform = typeof source.platform === 'string' && source.platform ? source.platform : 'UNKNOWN';
  const device = source.device && typeof source.device === 'object' ? source.device : null;
  const application = source.application && typeof source.application === 'object' ? source.application : null;
  const label = [device?.displayName, application?.displayName, application?.name, application?.packageName].find((value) => typeof value === 'string' && value) ?? platform;
  return { key: `${platform}/${label}`, label, platform, device: Boolean(device) };
}

// Two watches (or a watch and a phone app) can both record heart rate for the
// same minutes. Interleaving them would invent noise, so one primary source per
// window wins: most samples, then a FITBIT platform, then a device over an app.
function primarySource(entries) {
  const sources = new Map();
  for (const entry of entries) {
    const current = sources.get(entry.source.key) ?? { ...entry.source, count: 0 };
    current.count += 1;
    sources.set(entry.source.key, current);
  }
  const ranked = [...sources.values()].sort((a, b) => b.count - a.count
    || Number(b.platform === 'FITBIT') - Number(a.platform === 'FITBIT')
    || Number(b.device) - Number(a.device)
    || a.key.localeCompare(b.key));
  return ranked[0] ?? null;
}

// Only `>=` and `<` are supported by the live filter parser.
function workoutFilter(type, startMs, endMs) {
  return `${type.filterField} >= "${rfc3339(startMs)}" AND ${type.filterField} < "${rfc3339(endMs, true)}"`;
}

async function workoutRollupItems(fetchImpl, accessToken, type, startMs, endMs) {
  const body = { range: { startTime: rfc3339(startMs), endTime: rfc3339(endMs, true) }, windowSize: `${type.windowSeconds ?? 60}s` };
  const json = await request(fetchImpl, `${API_BASE}/${type.slug}/dataPoints:rollUp`, accessToken, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return itemsOf(json, 'rollupDataPoints');
}

// Everything recorded inside one (padded) workout window, in catalog units.
// Pure over the injected fetch; credentials never appear in errors or results.
export async function fetchWorkoutSamples(fetchImpl, accessToken, { startMs, endMs } = {}) {
  if (typeof accessToken !== 'string' || !accessToken) throw new TypeError('An access token is required.');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw new TypeError('startMs and endMs must be epoch milliseconds with endMs after startMs.');
  if (endMs - startMs > MAX_WORKOUT_WINDOW_MS) throw new TypeError('A workout window cannot span more than 24 hours.');
  const samples = [];
  const warnings = [];
  const failed = [];
  let sourceKey = null;
  let sourceLabel = null;
  for (const metric of WORKOUT_METRICS) {
    const type = { ...metric, ...WORKOUT_FIELDS[metric.key] };
    if (!type.map) { warnings.push(`${metric.slug}: no payload mapper`); failed.push(metric.slug); continue; }
    const collected = [];
    let skipped = 0;
    try {
      const items = metric.method === 'rollUp'
        ? await workoutRollupItems(fetchImpl, accessToken, type, startMs, endMs)
        : pagedDataPoints(fetchImpl, accessToken, type.slug, workoutFilter(type, startMs, endMs), WORKOUT_PAGE_SIZE, MAX_WORKOUT_PAGES);
      for await (const item of items) {
        const payload = item?.[type.payload] && typeof item[type.payload] === 'object' ? item[type.payload] : null;
        const mapped = payload ? type.map(payload, item) : null;
        // Roll-up bins carry their own interval; samples carry their own time.
        const atMs = mapped?.atMs ?? Date.parse(item?.startTime ?? '');
        const width = mapped?.durationMs ?? (Number.isFinite(Date.parse(item?.endTime ?? '')) ? Date.parse(item.endTime) - atMs : (metric.windowSeconds ?? 0) * 1000);
        if (!mapped || mapped.value === null || !Number.isFinite(mapped.value) || !Number.isFinite(atMs)) { skipped += 1; continue; }
        collected.push({ metric: metric.key, atMs, value: mapped.value, durationMs: metric.kind === 'interval' ? (width > 0 ? width : (metric.windowSeconds ?? 60) * 1000) : null, label: mapped.label ?? null, source: sourceOf(item) });
      }
    } catch (error) {
      if (error instanceof GoogleHealthError && FATAL_CODES.has(error.code)) throw error;
      warnings.push(`${metric.slug}: ${error instanceof GoogleHealthError ? error.message : 'could not map the response'}`);
      failed.push(metric.slug);
      continue;
    }
    if (skipped > 0) warnings.push(`${metric.slug}: skipped ${skipped} point${skipped === 1 ? '' : 's'} without a usable value`);
    let kept = collected;
    // Every listed data type can come back from two overlapping recorders; a
    // roll-up is already aggregated across sources by Google, so it has none.
    if (metric.method === 'list') {
      const primary = primarySource(collected);
      if (primary) {
        kept = collected.filter((entry) => entry.source.key === primary.key);
        if (!sourceKey) { sourceKey = primary.key; sourceLabel = primary.label; }
      }
    }
    for (const entry of kept) samples.push({ metric: entry.metric, atMs: entry.atMs, value: entry.value, durationMs: entry.durationMs, label: entry.label });
  }
  samples.sort((a, b) => a.atMs - b.atMs || a.metric.localeCompare(b.metric));
  return { samples, sourceKey, sourceLabel, warnings, failed };
}
