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

## Workout metrics

High-frequency data is fetched only **inside Hevy workout windows**, padded by
five minutes before and ten minutes after (`WINDOW_PADDING` in
`public/workout-metrics-catalog.js`) so the warm-up ramp and the recovery tail
are visible in the chart. Inside a window Corpus stores the highest frequency
Google offers (raw heart-rate samples, roughly every 1–3 s). There is no all-day
intraday import.

The shared catalog is `public/workout-metrics-catalog.js` — imported by the
adapter, the summaries, and the browser. Adding a metric is one catalog row plus
one payload mapper in `server/google-health.js`.

| Metric key | Data type slug | Method | Payload | Stored |
| --- | --- | --- | --- | --- |
| `heart_rate` | `heart-rate` | `dataPoints` list | `heartRate.beatsPerMinute` (int64 string), `heartRate.sampleTime.physicalTime` | one sample per point (bpm) |
| `steps` | `steps` | `dataPoints:rollUp` | `steps.countSum` | 60 s intervals (steps) |
| `calories` | `total-calories` | `dataPoints:rollUp` | `totalCalories.kcalSum` | 60 s intervals (kcal) |
| `zone` | `active-zone-minutes` | `dataPoints` list | `activeZoneMinutes.{interval,heartRateZone,activeZoneMinutes}` | one interval per zoned minute, `label` = `FAT_BURN`/`CARDIO`/`PEAK` |

Verified against a live account on 2026-09-10; these corrections override the
published docs:

- `GET /v4/users/me/dataTypes/{slug}/dataPoints?filter=<field> >= "S" AND <field> < "E"&pageSize=5000`.
  The default `pageSize` is **50** (which truncates a window) and the maximum is
  **5000**; only `>=` and `<` comparators are accepted, and the filter field
  prefixes are snake_case (`heart_rate.sample_time.physical_time`,
  `active_zone_minutes.interval.start_time`). Timestamps are RFC 3339 at second
  precision (start floored, end rounded up). `nextPageToken` is followed, capped
  at 20 pages per metric.
- `POST /v4/users/me/dataTypes/{slug}/dataPoints:rollUp` with body
  `{ "range": { "startTime": RFC3339, "endTime": RFC3339 }, "windowSize": "60s" }`
  → `{ "rollupDataPoints": [{ startTime, endTime, <payload> }] }`. Empty bins are
  omitted and no `pageSize` is sent. This is a different action from the daily
  `dataPoints:dailyRollUp`; `total-calories` and `calories-in-heart-rate-zone`
  reject `list` with `400 UNSUPPORTED_DATA_TYPE_ACTION`.
- A window can contain **two overlapping heart-rate sources** (a Pixel Watch via
  `platform: "FITBIT"` and `com.hevy` via `HEALTH_CONNECT`). Interleaving them
  would invent noise, so one primary source wins per window: most samples, then
  a FITBIT platform, then a device over an application. The adapter returns
  `sourceKey` (`FITBIT/Pixel Watch 4`) and `sourceLabel` (`Pixel Watch 4`), and
  the dropped samples are reported as a warning. The same choice is made for
  every listed data type (`heart_rate` and `zone`), because both carry a
  `dataSource`; a roll-up is aggregated across sources by Google and has none.
- Extension point, not used in v1: `exercise` list works **only without a
  filter** (pageSize 25, newest first, `pageToken` is an offset). Hevy workouts
  appear there as `STRENGTH_TRAINING` sessions from `com.hevy` with the Hevy
  UUID in `notes`, which is the natural way to add session-level data later.

Adapter entry point:

```js
export async function fetchWorkoutSamples(fetchImpl, accessToken, { startMs, endMs });
// -> { samples: [{ metric, atMs, value, durationMs, label }], sourceKey, sourceLabel, warnings, failed }
```

Per-metric failures become `warnings` plus `failed` (slugs) exactly like
`fetchMetricPoints`; 401 throws `unauthorized`, 429 throws `rate_limited`, and
credentials never appear in an error message or in returned data.

### Storage

Schema version 7 adds two live-only tables. Demo mode never writes to them.

```sql
CREATE TABLE IF NOT EXISTS workout_samples (
  source TEXT NOT NULL REFERENCES metric_sources(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,            -- key from public/workout-metrics-catalog.js
  at_ms INTEGER NOT NULL,          -- epoch ms UTC (sample time, or interval start)
  value REAL NOT NULL,             -- catalog unit
  duration_ms INTEGER,             -- interval width for kind 'interval'; NULL for samples
  label TEXT,                      -- zone name for 'zone'; NULL otherwise
  PRIMARY KEY (source, metric, at_ms)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS workout_sample_windows (
  source TEXT NOT NULL REFERENCES metric_sources(id) ON DELETE CASCADE,
  workout_id TEXT NOT NULL,        -- no FK: samples are time-addressed and outlive Hevy reconciliation
  start_ms INTEGER NOT NULL,       -- padded window actually requested
  end_ms INTEGER NOT NULL,
  status TEXT NOT NULL,            -- 'complete' | 'empty'
  detail_json TEXT,                -- { sampleCounts, sourceKey, sourceLabel, warnings } (no tokens)
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (source, workout_id)
) WITHOUT ROWID;
```

Ledger rules:

- One `BEGIN IMMEDIATE` transaction per window: its samples and its ledger row
  are written together. A window that comes back with samples replaces its own
  span (`DELETE` then insert) rather than merging into it, so a re-fetch that
  picks a different primary source cannot leave the old recorder's samples
  interleaved with the new ones; samples also upsert by primary key, so a
  re-fetch of unchanged data is idempotent and overlapping windows share their
  samples. A window that comes back with nothing deletes nothing, so a transient
  gap at Google cannot erase stored samples.
- A window is fetched when (a) it has no ledger row, (b) the stored
  `start_ms`/`end_ms` differ from the current padded window (Hevy edited the
  workout times), or (c) its status is `empty` and `fetched_at` is earlier than
  the workout end plus 48 h, so late-arriving data is picked up. Rule (c)
  settles itself: the first fetch after that deadline is the last one.
- A **failed** window (any metric's request failed) writes nothing at all — no
  samples and no row — so the next sync retries it. A partially written window
  would look complete forever.
- Budget: at most 25 windows per sync call, newest workouts first. Padded
  windows that overlap are merged into one request.
- The ledger is the progress record; the Google source cursor keeps only
  `syncedThrough` for the daily series, and the daily sync merges that key into
  `cursor_json` instead of replacing the object.

### Service API

```js
syncWorkoutMetrics({ workoutIds = null, budget = 25 } = {})
  // live only; same token refresh and 401 retry helper as syncMetrics.
  // -> { fetched, empty, failed: [workoutId], warnings: [string] }
getWorkoutMetrics(workoutId)             // -> WorkoutMetrics; demo mode is generated, never SQLite
getWorkoutMetricsOverview({ days = 90 }) // -> Overview; `days` clamped to 7-730
```

`syncMetrics()` calls `syncWorkoutMetrics({ budget: 25 })` at the end, best
effort: its warnings are appended to the sync warnings and its failure can never
fail the daily sync, so the one "Sync Google Health" button covers both. Identical
warnings are reported once however many windows produced them, so a 25-window
sync does not put the same sentence on screen 25 times.

`getWorkoutMetricsOverview` needs only `summary` per row, so it asks
`summariseWorkout` for `detail: false`: no chart series and no segment estimate
are built for workouts the page only lists. It still reads each fetched window's
samples, so the cost of the page grows with `days`; moving the heart-rate
aggregate into SQL is the next step if 730 days becomes slow.

### HTTP routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/workouts/:id/metrics` | One workout's samples, summary, and estimated segments. |
| `POST` | `/api/workouts/:id/metrics/sync` | Fetch just that workout's window (budget 1), then return the same payload. No request body. |
| `GET` | `/api/metrics/workouts?days=90` | Coverage and one summary row per workout, newest first. |

`GET /api/workouts/:id/metrics` returns:

```json
{
  "mode": "live",
  "workout": { "id": "…", "title": "Full Body 2", "start_time": "…", "end_time": "…" },
  "status": "ready",
  "fetched_at": "2026-09-10T10:43:32.256Z",
  "window": { "start_ms": 1757392410000, "end_ms": 1757396403000 },
  "source": "Pixel Watch 4",
  "series": {
    "heart_rate": { "unit": "bpm", "samples": [[1757392410000, 96]] },
    "steps": { "unit": "steps", "interval_ms": 60000, "samples": [[1757392380000, 12]] },
    "calories": { "unit": "kcal", "interval_ms": 60000, "samples": [[1757392380000, 6.4]] },
    "zone": { "unit": "min", "interval_ms": 60000, "samples": [[1757392380000, 1, "CARDIO"]] }
  },
  "summary": {
    "heart_rate": { "avg": 128, "max": 171, "min": 62, "coverage": 0.94, "sample_count": 3301, "median_interval_ms": 1240 },
    "calories": 312, "steps": 1840,
    "zones": { "FAT_BURN": 18, "CARDIO": 22, "PEAK": 6, "none": 5 },
    "duration_min": 51.5
  },
  "exercises": [{ "index": 0, "title": "Barbell Back Squat", "sets": 4, "from_ms": 1757392710000, "to_ms": 1757393500000, "heart_rate": { "avg": 132, "max": 168 } }],
  "estimated_segments": true
}
```

- `status` is `ready`, `empty` (fetched, but Google had nothing — the watch was
  not worn or has not synced), `unfetched` (no window fetched yet; the browser
  offers the POST above), or `not_connected` (live mode without a Google
  connection; point the user at Settings). `fetched_at` is null unless `ready`
  or `empty`. Every catalog key is always present in `series`, possibly with an
  empty `samples` array, and every `summary` field except `duration_min` is null
  when that metric has no data in the window.
- When Hevy edits a workout's times the stored window no longer matches, so the
  next sync re-fetches it. Until then the status stays `ready` over the samples
  that fall inside the new window, which may be incomplete at its edges. That
  self-heals on the next sync and does not need a status of its own.
- `samples` are compact arrays sorted by time at raw resolution — the server
  never resamples. The browser breaks the line when a gap exceeds
  `max(3 × median interval, 15 s)`.
- 404 `{ error, code: "workout_not_found" }` is returned **only** for an unknown
  workout id, never for missing samples.
- All summaries are clipped to the workout interval; the padding exists only for
  the chart and is exposed as `window`.
- `GET /api/metrics/workouts?days=90` returns `{ mode, range, coverage, workouts }`
  with `coverage: { workouts, with_metrics, unfetched, empty }` and one row per
  workout — including workouts without metrics, so the page can show coverage.
  Rows carry `duration_min`, `status`, `exercise_count`, `set_count` (working
  sets), `volume_kg` (the external-load rule from `docs/architecture.md`), and
  `heart_rate` / `calories` / `steps` / `zones`, which are null unless the row is
  `ready`.
- The two payloads count sets differently, on purpose: a row's `set_count` is
  **working sets** (warmups excluded, the same rule as every other training
  total), while `exercises[].sets` in the single-workout payload is **every
  set** in that exercise, because the segment estimate divides the workout by
  the time actually spent, and a warmup set takes time too. Label them
  accordingly rather than comparing one against the other.

### Summaries

`server/workout-metrics.js` is a pure module — window building, merging, the
"needs fetch" decision, and every number — so the session dialog and the
overview page always agree.

- **Heart rate**: average, maximum, minimum, `sample_count`, and
  `median_interval_ms` over the samples inside the workout. `coverage` is the
  fraction of the workout duration spanned by consecutive samples no further
  apart than `max(3 × median interval, 15 s)`; longer gaps count as dropouts.
- **Zone minutes** are wall-clock time, measured from each zoned interval's
  width clipped to the workout interval — never from its stored value. Google's
  `active-zone-minutes` value is an **AZM credit**, and a minute in PEAK is
  awarded 2: counting the credit as elapsed time would report 120 minutes in
  PEAK for a one-hour workout and drive `none` to zero. The stored sample keeps
  the credit as-is (`series.zone` samples are `[at_ms, credit, zone]`), because
  it is the number Fitbit's own weekly AZM goal uses and is worth having later;
  only `summary.zones` and the overview's `zones` convert to minutes. An
  interval straddling the workout edge is prorated, and the workout minutes no
  zone claims are reported as `none`.
- **Calories and steps** are prorated totals over the same interval.
- **Exercise segments are estimated.** Hevy stores no per-set timestamps, so the
  workout duration is divided proportionally to each exercise's set count,
  weighted by the routine's `rest_seconds` when the workout has a `routine_id`
  with stored routine exercises (each set is assumed to take 40 s plus its rest,
  90 s when unknown). `estimated_segments: true` marks the payload, and the UI
  must label it.

### Demo behaviour

`server/metrics-demo.js` generates workout metrics deterministically from the
workout id and start time with the same seeded `noise` helper: a resistance
profile with a warm-up ramp, one spike per estimated set, recovery troughs and
one or two short dropouts at ~2 s spacing; a distinct sustained profile for the
`demo-run` cardio session; and minute intervals for steps, calories, and zones
that follow the same heart-rate curve.

The status is a fixed function of the workout id so that every state the live
page can reach is visible without live data: ids ending in 7
(`demo-workout-07/17/27`) report `empty`, ids ending in 3
(`demo-workout-03/13/23`) stay `unfetched` — which is what puts the dialog's
"Fetch from Google Health" action and the Workouts page's fetch action on screen
— and the rest are `ready`. Demo mode branches before SQLite: it never reads or
writes `workout_samples` or `workout_sample_windows`, and `syncWorkoutMetrics` in
demo mode is a no-op with a warning. An unfetched demo window therefore stays
unfetched after a `POST /api/workouts/:id/metrics/sync`: demo mode has no Google
connection to fetch from, and the route still answers 200 with the unchanged
payload.

## Markdown export

`data/exports/metrics.md` contains the source status and a 90-day table (date
and one column per metric that has data) plus a "Latest" section listing each
metric's most recent value. Numbers use the catalog decimals and units.

## Out of scope for this iteration

AI assistant access to metrics, file importers (Health Connect, Takeout),
all-day intraday series outside workout windows, `exercise` session data, and
notifications.
