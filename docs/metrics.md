# Metrics module

The Metrics module imports daily health data (activity, heart, sleep, body,
fitness) into the local SQLite database and shows it next to training. This
document is the implementation contract: schema, service API, HTTP routes,
the Google Health adapter, and the browser views.

## Source decision (September 2026)

- **Google Fit REST API** is deprecated (no new clients since May 2024, shutdown
  by end of 2026). Not used.
- **Fitbit Web API** turns down in September 2026. Not used.
- **Google Health API v4** (`https://health.googleapis.com/v4`, GA March 2026)
  is the supported successor for Fitbit / Google Health accounts. Personal use
  works with an unverified Google Cloud OAuth "Desktop app" client while the
  consent screen stays in Testing with the user added as a test user. **This is
  the first ingestion path.**
- **Health Connect export** (Android zip with an undocumented SQLite file) and
  **Google Takeout Fit CSVs** are file-based backfill paths for later. The
  schema below is source-namespaced so they can be added as importers without
  a migration.

Verified v4 details used by the adapter:

| Data type path slug | Method | Value fields | Corpus metric |
| --- | --- | --- | --- |
| `steps` | `dataPoints:dailyRollUp` | `steps.countSum` (int64 string) | `steps` |
| `distance` | `dataPoints:dailyRollUp` | `distance.millimetersSum` | `distance_km` (÷ 1e6) |
| `active-zone-minutes` | `dataPoints:dailyRollUp` | `activeZoneMinutes.sumInFatBurnHeartZone` + `sumInCardioHeartZone` + `sumInPeakHeartZone` | `active_zone_minutes` |
| `total-calories` | `dataPoints:dailyRollUp` (max 14-day range) | `totalCalories.kcalSum` | `calories_kcal` |
| `daily-resting-heart-rate` | `dataPoints` list, filter on `.date` | `dailyRestingHeartRate.beatsPerMinute`, `date {year,month,day}` | `resting_hr` |
| `daily-heart-rate-variability` | list, filter on `.date` | `dailyHeartRateVariability.averageHeartRateVariabilityMilliseconds` | `hrv_ms` (skip point if absent) |
| `daily-oxygen-saturation` | list, filter on `.date` | `dailyOxygenSaturation.averagePercentage` | `spo2_pct` |
| `weight` | list, filter on `sample_time.physical_time` | `weight.weightGrams`, `sampleTime {physicalTime, utcOffset, civilTime}` | `weight_kg` (÷ 1000) |
| `body-fat` | list, filter on `sample_time.physical_time` | `bodyFat.percentage` | `body_fat_pct` |
| `run-vo2-max` | list, filter on `sample_time.physical_time` | `runVo2Max.runVo2Max` | `vo2max` |
| `sleep` | list, filter on `interval.end_time`, `pageSize` ≤ 25 | `sleep.interval {startTime,endTime,startUtcOffset,endUtcOffset}`, `sleep.summary {minutesAsleep, minutesAwake, minutesInSleepPeriod}`, `sleep.stages[] {startTime,endTime,type}` with `type` ∈ AWAKE, LIGHT, DEEP, REM, ASLEEP, RESTLESS | `sleep_minutes` + stage metrics |

Request shapes:

- `POST /v4/users/me/dataTypes/{slug}/dataPoints:dailyRollUp` body
  `{ "range": { "start": { "date": {year,month,day} }, "end": { "date": {year,month,day} } }, "windowSizeDays": 1 }`
  (a CivilTimeInterval; `end` is **exclusive**, so a window 2026-01-01..2026-03-31
  sends end 2026-04-01; no `pageSize` — the API rejects one smaller than the
  number of days in the range)
  → `{ "rollupDataPoints": [{ "civilStartTime": { "date": {year,month,day}, "time": {} }, "civilEndTime": {...}, "<type>": {...} }], "nextPageToken"? }`.
  Range limit: 14 days for `total-calories`, `heart-rate`, `active-minutes`, `calories-in-heart-rate-zone`; 90 days otherwise (a 91-day span is rejected).
- `GET /v4/users/me/dataTypes/{slug}/dataPoints?filter=<AIP-160>&pageSize=N&pageToken=` → `{ "dataPoints": [...], "nextPageToken"? }`, newest first. Defaults: pageSize 1440 (25 max for sleep/exercise).
- Filter field prefixes are snake_case for every type, including the daily
  summaries (the docs show those as camelCase, but the live API rejects that);
  the prefix per type is kept in one table in the adapter. Examples:
  `steps.interval.start_time >= "2026-09-01T00:00:00Z" AND steps.interval.start_time < "2026-09-08T00:00:00Z"`, `weight.sample_time.physical_time >= "..."`, `daily_heart_rate_variability.date >= "2026-09-01" AND daily_heart_rate_variability.date < "2026-09-08"`, `sleep.interval.end_time >= "..."`.
- Sample and sleep DataPoints have `name` = `users/me/dataTypes/{slug}/dataPoints/{id}`; the last segment is the stable source id. Daily summaries (`daily-*`) carry no `name`: there is one value per civil date, so the date is the id.
- OAuth 2.0: authorization at `https://accounts.google.com/o/oauth2/v2/auth` with PKCE (S256), `access_type=offline`, `prompt=consent`; token exchange and refresh at `https://oauth2.googleapis.com/token`; revoke at `https://oauth2.googleapis.com/revoke`. Loopback redirect `http://127.0.0.1:<port>/api/metrics/google/callback`. Scopes: `https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly`, `https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly`, `https://www.googleapis.com/auth/googlehealth.sleep.readonly`.
- Rate limit is generous (hundreds of requests per minute per user). A full first sync of 365 days is roughly 40 requests.

Verified against a live account on 2026-09-09: the rollup request and
response shapes above (CivilTimeInterval with exclusive end, nested
`civilStartTime.date`), snake_case filter prefixes for the daily types, the
90-day and 14-day maximum spans, and the page size rule (omit `pageSize` on
rollups; a value smaller than the day count is rejected). Still unverified:
whether Health Connect-only data appears in the API.

## Storage

Schema version 6 adds two live-only tables. Demo mode never writes to them;
demo metrics are generated by `server/metrics-demo.js`.

```sql
CREATE TABLE IF NOT EXISTS metric_sources (
  id TEXT PRIMARY KEY,            -- 'google-health' (later: 'health-connect', 'takeout')
  kind TEXT NOT NULL,             -- 'api' | 'file'
  label TEXT NOT NULL,
  cursor_json TEXT,               -- { "syncedThrough": "YYYY-MM-DD" }
  last_sync TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS metric_points (
  source TEXT NOT NULL REFERENCES metric_sources(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,           -- key from public/metrics-catalog.js
  source_id TEXT NOT NULL,        -- stable id within (source, metric); daily rollups use the date
  date TEXT NOT NULL,             -- local civil date YYYY-MM-DD as reported by the source
  start_time TEXT,                -- RFC 3339 with offset when known
  end_time TEXT,
  value REAL NOT NULL,            -- in the catalog unit (kg, km, min, bpm, ms, %, kcal, steps)
  raw_json TEXT,                  -- trimmed source payload for provenance (no tokens)
  imported_at TEXT NOT NULL,
  PRIMARY KEY (source, metric, source_id)
);
CREATE INDEX IF NOT EXISTS metric_points_by_metric_date ON metric_points(metric, date);
```

Rules:

- Imports upsert by primary key inside one `BEGIN IMMEDIATE` transaction, so a
  re-sync is idempotent and a failed sync leaves the previous data intact.
- Sleep sessions store one `sleep_minutes` point (source_id = session id) plus
  one point per stage metric (source_id = `<session id>:<stage>`), all dated by
  the session's **civil end date** (the morning you woke up). Stage mapping:
  DEEP → deep, LIGHT and ASLEEP → light, REM → rem, AWAKE and RESTLESS → awake.
- Daily series are derived at query time: `SELECT date, SUM(value)` for
  `aggregate: "sum"` metrics and `AVG(value)` for `aggregate: "mean"` metrics,
  across all sources. The daily series never stores a second copy.
- Google Health credentials live in `data/settings.json` (owner-only), never in
  SQLite, exports, tests fixtures, or error messages:
  `googleClientId`, `googleClientSecret`, and
  `googleHealth: { accessToken, refreshToken, expiresAt, scope, connectedAt }`.
- After a sync in which every data type's request succeeded, the source cursor
  `syncedThrough` becomes today. The next sync re-fetches from
  `syncedThrough − 7 days` to catch late-arriving data. A first sync fetches
  365 days. A sync in which any data type's request failed still stores the
  points it got but keeps the old cursor, so the next sync covers the same
  range again instead of leaving a permanent gap.
- A successful sync switches the app to live mode, matching Hevy sync.

## Service API (`server/service.js`)

```js
getMetrics({ days = 90 })            // sync; { mode, range: { from, to }, sources, series }
googleHealthConnect({ redirectUri }) // -> { url }; stores { state, verifier, redirectUri, expires } in memory (10 min)
googleHealthCallback({ code, state })// exchanges the code, stores tokens, ensures the source row; -> { connected: true }
googleHealthDisconnect()             // best-effort revoke, delete tokens; -> publicSettings()
syncMetrics()                        // refresh token if needed, fetch, upsert, cursor, mode=live; -> getMetrics()
saveSettings({ googleClientId?, googleClientSecret? })  // extends the existing method; empty strings keep stored values
publicSettings().googleHealth        // { hasClient: bool, connected: bool, lastSync: string|null }
exportMarkdown()                     // also writes data/exports/metrics.md
```

`getMetrics` response:

```json
{
  "mode": "live",
  "range": { "from": "2026-06-11", "to": "2026-09-09" },
  "sources": [{ "id": "google-health", "kind": "api", "label": "Google Health", "lastSync": "2026-09-09T06:00:00.000Z", "syncedThrough": "2026-09-09" }],
  "series": { "steps": [{ "date": "2026-06-11", "value": 8123 }], "resting_hr": [] }
}
```

Every catalog key is present in `series` (possibly empty). Days are omitted
when there is no data; the browser fills gaps. `days` is clamped to 7–730.

## HTTP routes (`server/index.js`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/metrics?days=90` | Daily series for the active mode. |
| `POST` | `/api/metrics/sync` | Sync Google Health into the local database. |
| `POST` | `/api/metrics/google/connect` | Start OAuth; body `{}`; returns `{ url }` to open in a browser tab. |
| `GET` | `/api/metrics/google/callback?code&state` | Loopback redirect target. Returns a tiny HTML page. Exempt from the cross-site check because it is a top-level navigation from Google; the one-time `state` is the protection. |
| `POST` | `/api/metrics/google/disconnect` | Revoke and forget tokens. |

The redirect URI is built by the route from the request host:
`http://${req.headers.host}/api/metrics/google/callback`. Errors keep the
existing `{ error, code }` JSON shape.

## Adapter (`server/google-health.js`)

Pure functions over an injected `fetchImpl`, mirroring `server/hevy.js`.

```js
export const SCOPES;                                   // array of three readonly scope strings
export class GoogleHealthError extends Error { code }  // 'unauthorized' | 'rate_limited' | 'network' | 'invalid_response' | 'oauth'
export function pkcePair();                            // { verifier, challenge } (S256, base64url)
export function authorizationUrl({ clientId, redirectUri, state, codeChallenge });
export async function exchangeCode(fetchImpl, { clientId, clientSecret, code, codeVerifier, redirectUri });
export async function refreshAccessToken(fetchImpl, { clientId, clientSecret, refreshToken });
export async function revokeToken(fetchImpl, token);   // never throws
export async function fetchMetricPoints(fetchImpl, accessToken, { from, to });
// tokens: { accessToken, refreshToken, expiresAt (ISO), scope }
// points: [{ metric, sourceId, date, startTime, endTime, value, raw }]
// fetchMetricPoints returns { points, warnings: [string] } and never returns credentials in errors.
```

`fetchMetricPoints` walks each data type in the table above, splitting the
date range into windows that respect the per-type limit, following
`nextPageToken`, and mapping to catalog metrics. A 401 throws `unauthorized`
(the service refreshes once and retries), 429 throws `rate_limited`, malformed
JSON throws `invalid_response`, and per-type failures other than auth are
collected as warnings rather than failing the whole sync.

## Browser

Navigation: a new `Metrics` group in the sidebar between the Workout group and
Settings, with two pages: **Dashboard** (`#metrics`) and **Trends**
(`#metrics-trends`). Both live in `public/metrics.js` and fetch
`/api/metrics?days=N` through the shared `api` helper, caching the last
response per `(mode, days)` and refetching after a sync.

Files:

- `public/metrics-analytics.js` — pure helpers, unit-tested: `fillDays`,
  `rollingMean`, `summarize` (latest, mean, min, max, change vs. previous
  window), `sleepStack`, `trainingDaySplit` (mean on days with a workout vs.
  without), `periodDays`.
- `public/metric-charts.js` — SVG builders reusing the existing chart CSS
  classes: `lineChart`, `barChart`, `stackedBarChart`. Optional training-day
  markers along the x-axis. Accessible titles and `<title>` tooltips.
- `public/metrics.js` — `renderMetricsDashboard(ctx)` and
  `renderMetricsTrends(ctx)`.
- `public/settings.js` — a "Google Health" panel: client ID, client secret,
  Connect / Disconnect, status rows; after Connect opens the URL in a new tab
  the page polls `/api/state` every 3 s for up to 2 min until connected.

Dashboard layout (top to bottom): view header with eyebrow "Health metrics",
title "Dashboard", period picker (4w, 12w, 26w, 1y) and a "Sync Google
Health" button; a four-tile stat row (steps per day, resting HR, sleep per
night, weight) each with a small change indicator against the previous window
(a change that rounds to zero reads as "no change"); then a two-column grid of
single-chart cards in this order: Steps, Resting heart rate, Sleep (stacked
stages), Heart rate variability, Weight (with 7-day mean), Body fat and Cardio
fitness (only when they have data), Active zone minutes. Cards use the charts'
compact mode (420-wide viewBox, at most four x labels) so axis text stays
legible at half width; series longer than 90 points draw lines without dots.
Empty states: in live mode with no source connected, one panel that points to
Settings; in either mode with a connected source but no data, a "Sync to load"
message.

Trends: metric select grouped by category, the same period picker, one large
chart with a 7-day rolling mean, a stats row (latest, average, min, max,
training-day average vs. rest-day average), and a scrollable daily table for
the last 30 days. Weight displays in the user's unit preference.

Design rules: reuse `.panel`, `.stat-grid`, `.stat-card`, `.period-picker`,
`.chart-wrap`, `.chart-*` classes; add only small CSS for stage colors, the
change indicator, and the table. No new libraries. Charts stay SVG and CSS
tokens only.

## Markdown export

`data/exports/metrics.md` contains the source status and a 90-day table (date
and one column per metric that has data) plus a "Latest" section listing each
metric's most recent value. Numbers use the catalog decimals and units.

## Out of scope for this iteration

AI assistant access to metrics, file importers (Health Connect, Takeout),
intraday heart rate, workout-level heart rate overlays, and notifications.
