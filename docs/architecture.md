# corpus architecture

## Boundary

corpus is a single-user application running on one laptop. Node.js serves a static HTML/CSS/JavaScript interface and a small local HTTP API on `127.0.0.1:3210`. Requests from other hosts, cross-origin pages, and private files are rejected. There is no login flow because the process is intentionally local.

The runtime uses Node 24+ and built-in modules. It does not load a CDN, emit telemetry, call a cloud backend, or bundle an embedded AI model. `PORT` changes the loopback port, and `CORPUS_DATA_DIR` changes where local state is stored.

## Components

```text
HTML interface
      |
      v
Local HTTP API  --->  Workout service  --->  SQLite database
      |                       |
      v                       v
Review interface         Hevy API adapter
      ^                  Google Health adapter
      |
Corpus MCP bridge  <---  Codex / Claude Code training session
```

The frontend owns presentation and interaction: dashboard cards, progress charts, workout and routine views, local programs, health metrics dashboard and trends, unit preferences, demo mode, settings, sync, and export actions. The backend owns validation, persistence, sync state, atomic imports, and file permissions. The browser never talks directly to Hevy or Google Health; API keys and OAuth tokens stay on the backend side of the local process.

## Local API

The browser uses the following loopback-only endpoints. They are intentionally small and map directly to the service methods.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | Read the selected demo or live state, public settings, workouts, routines, exercise templates, and programs. |
| `POST` | `/api/settings` | Save the unit preference and optionally a Hevy key; the response exposes only whether a key exists. |
| `POST` | `/api/sync` | Fetch and atomically import a read-only full Hevy snapshot. |
| `POST` | `/api/routines` | Validate and publish a new Hevy routine, then cache the created record locally. |
| `PUT` | `/api/routines/:id` | Validate changes to an imported routine and update the same Hevy routine and local record. |
| `POST` | `/api/demo` | Select demo or live mode with `{ "enabled": true\|false }`. |
| `POST` | `/api/programs` | Create or update a local program with ordered `{ label, routineId }` days and optional `start_date` / `duration_weeks`. |
| `DELETE` | `/api/programs/:id` | Delete a local program in the active mode. |
| `POST` | `/api/export` | Regenerate Markdown files under `data/exports/`. |
| `GET` | `/api/metrics?days=90` | Read daily health metric series for the active mode (`days` clamped to 7–730). |
| `POST` | `/api/metrics/sync` | Sync Google Health into the local database. |
| `POST` | `/api/metrics/google/connect` | Start the Google OAuth flow; returns `{ url }` to open in a browser tab. |
| `GET` | `/api/metrics/google/callback` | Loopback redirect target for Google's `code` and `state`; returns a tiny HTML page. |
| `POST` | `/api/metrics/google/disconnect` | Revoke and forget the Google Health tokens. |
| `GET` | `/api/workouts/:id/metrics` | Read one workout's intra-workout samples, summary, and estimated exercise segments. |
| `POST` | `/api/workouts/:id/metrics/sync` | Fetch that one workout's padded window from Google Health (no request body). |
| `GET` | `/api/metrics/workouts?days=90` | Coverage and one metric summary row per workout (`days` clamped to 7–730). |
| `GET` | `/api/supplements/doses?days=90` | Read logged, scheduled and workout-derived supplement doses for the active mode (`days` clamped to 7–730). |
| `POST` | `/api/supplements` | Create or update a supplement in the active mode; an optional `id` names the one to update. |
| `DELETE` | `/api/supplements/:id` | Delete a supplement in the active mode; its doses cascade. |
| `POST` | `/api/supplements/:id/doses` | Log a dose, or upsert the override for one scheduled slot or logged session. |
| `DELETE` | `/api/supplements/doses/:id` | Delete one stored dose or override; the derived dose comes back. |
| `GET` | `/api/session` | Issue the browser review session and CSRF token. |
| `GET` | `/api/proposals/:id` | Read one proposal and its revision history for review. |
| `POST` | `/api/proposals/:id/review` | Human review: accept, decline, or request a revision. |
| `POST` | `/api/training-profile` | Save the local goals, equipment, constraints, and schedule profile. |
| `POST` | `/api/local-routines/:id/publish` | Explicitly publish an accepted local routine to Hevy. |

Static `GET` requests serve the local HTML, CSS, and JavaScript interface. Hevy writes go through the local routine endpoints, with credentials kept on the server. Browser review writes require the short-lived local session and CSRF token.

Draft rationale, notes, descriptions, and review feedback render as Markdown through
`public/markdown.js`, using a pinned local markdown-it browser bundle. Raw HTML
is escaped, images render as their alternative text without loading, and links
allow only explicit HTTP, HTTPS, or mail destinations. Draft cards show plain-text
previews; tables and code blocks scroll within the review panel when needed.

`/api/assistant/*` is separate from the browser API. It accepts a private local
bearer credential and is used only by the bundled stdio MCP bridge. It exposes a
fixed allowlist of context and proposal-drafting tools. It cannot review,
publish, sync, save settings, or access files and SQL. The bridge POSTs an
envelope shaped as `{ "args": { ... } }` to
`/api/assistant/tools/:toolName`; no arbitrary URL, file, database, or tool name
is accepted. See [assistant.md](assistant.md) for the complete tool contract.

## Structured storage

SQLite is the source of truth for the implemented workout module. The database is `data/corpus.sqlite` and contains separate records for:

- imported Hevy workouts and their exercises and sets;
- Hevy routines and exercise templates;
- local programs, which group routines into ordered training days and optional dated training blocks;
- a training profile plus proposals, immutable revision history, request ledger, and accepted local-routine overlays;
- imported daily health metrics and their sources, plus intra-workout samples and the ledger of fetched workout windows;
- sync metadata and source identifiers;
- the selected demo/live mode.

Unit preference, the saved Hevy API key, and the Google Health client credentials and OAuth tokens live in the private `data/settings.json` file.

Schema version 5 includes nullable `start_date` (`YYYY-MM-DD`) and
`duration_weeks` (integer 1–52) on programs. Both values must be present or both
null. Existing programs migrate to unscheduled without changing their days or
IDs. Updates that omit both scheduling fields preserve the saved schedule;
explicitly sending both null clears it.

Schema version 6 adds `metric_sources` and `metric_points` for the Metrics module. Each point is keyed by `(source, metric, source_id)`, so several sources (`google-health` today; file importers later) can store the same metric without a migration, and a re-import of the same source id updates the row instead of duplicating it. Points carry the source's local civil date, optional start and end times, the value in the catalog unit from `public/metrics-catalog.js`, and trimmed raw JSON for provenance. Daily series are derived at query time from the stored points and are never stored as a second copy. Both tables are live-only: demo metrics are generated by the demo module and never written to them.

Schema version 7 adds `workout_samples` and `workout_sample_windows` for
intra-workout metrics. Samples are keyed by `(source, metric, at_ms)` in epoch
milliseconds, so they are time-addressed rather than workout-addressed: they
survive Hevy reconciliation, and two overlapping padded windows share them
without duplication. `workout_sample_windows` is the ledger of which padded
window was fetched for which workout, with `complete` or `empty` status and a
`detail_json` summary (sample counts, primary source, warnings; never tokens). A
failed window writes nothing and is retried. Both tables are live-only; demo
workout metrics are generated. See [metrics.md](metrics.md).

Schema version 8 adds `supplements` and `supplement_doses` for the Supplements
module. Both are mode-scoped like programs, through the supplement's `mode`
column; doses inherit the scope from their supplement and cascade with it. Doses
implied by a schedule or by training are derived, never stored: a `daily` or
`weekly` supplement counts one dose per calendar slot and a `workout` one counts
one per logged session, through today, computed at read time from the schedule
and the mode's current workouts. A stored row naming a `slot`
(`'YYYY-MM-DD:n'`, unique per supplement) or a `workout_id` is only an override
for that one dose — a changed amount, or a zero meaning skipped — so nothing is
written by a clock or during Hevy sync, and an override whose slot or session no
longer exists stops matching and is dropped on the next write for that
supplement. See [supplements.md](supplements.md).

The shared `public/program-timeline.js` helpers derive inclusive end dates, statuses, and session associations. Calendar-day arithmetic avoids daylight-saving drift. A session belongs to each scheduled program with a matching routine ID and a date within the block, using the laptop's timezone. These associations are derived from the current program definition rather than persisted historical assignments. Program edits therefore recalculate them. Program weeks start on the block's start date, independently of the dashboard's Monday-based weeks. Each matching session counts once per program even if multiple days use its routine; overlapping programs may each count it. Program activity excludes future timestamps, and time progress counts calendar days through today rather than measuring adherence.

The current `workouts`, `routines`, and `exercise_templates` table IDs are the corresponding Hevy IDs. `source_items` records the raw source payload for each imported item. A future second workout source will require a deliberate namespaced-ID migration; the workout schema does not pretend to support multiple source systems, unlike the source-namespaced metric tables.

Markdown is the human- and agent-readable layer. `data/exports/` contains generated `overview.md`, `workouts.md`, `routines.md`, `programs.md`, `metrics.md`, and `supplements.md`. Exports are regenerated from the selected current mode and are not an append-only history. A future knowledge module may introduce `data/knowledge/` with explicit provenance fields; that module is not implemented by the current service.

## Hevy sync

Sync is a manual, read-only full snapshot. The Hevy adapter fetches all pages for workouts, routines, and exercise templates, validates the response, and writes the result in one SQLite transaction. The live snapshot becomes visible only after the complete import succeeds. A failed request leaves the previous local snapshot available.

Reconciliation compares source IDs in the new snapshot with previously imported records. Missing workouts, routines, and exercise templates are physically removed from the current imported tables after the new snapshot has been validated; the current schema has no tombstone or deletion-history table. Existing exports remain untouched if the sync fails, and a successful export regenerates Markdown from the selected current mode. Imported rows retain raw source JSON and sync metadata while they exist. The adapter treats pagination limits, malformed responses, invalid keys, rate limiting, and network failures as recoverable sync errors.

The official Hevy API documentation is at <https://api.hevyapp.com/docs/>. It requires an `api-key` header, is currently limited to Hevy Pro users, and documents paginated workouts, routines, and exercise templates. Hevy also exposes a workout events endpoint for future incremental synchronization; the current full-snapshot operation keeps reconciliation straightforward while that integration evolves.

Routine publishing is a separate, explicit action. The backend validates imported exercise IDs and set targets, converts the form into Hevy's `{routine: ...}` request, and calls `POST /v1/routines`. It uses the default folder and does not edit existing routines. Demo mode cannot publish. A request identifier tracks the publication so repeated submissions do not send the same POST again after success or an uncertain outcome. Network failures and ambiguous responses require checking Hevy before creating again; there are no automatic write retries. A confirmed remote success is reported as such even if the local cache needs refreshing.

Editing uses `PUT /v1/routines/{id}` and updates the same routine locally after Hevy confirms success. The builder loads saved targets in the user's display unit and preserves the routine's folder, existing superset membership, and custom set metrics. Program references keep pointing to the same routine ID. Write deduplication includes the operation and target so editing cannot be confused with creating a routine. Editing uses the last synced local record; users should sync changes made in Hevy before opening the editor.

The UI's demo mode is a separate synthetic dataset for screenshots and empty-state exploration. Demo records are generated by the demo module, are not written into the live imported tables, and must never be mixed into a live snapshot or used as evidence in progress analysis. Programs are stored with the active mode, so a demo program and a live program remain separate.

## Google Health sync

Daily health metrics come from the Google Health API v4, the supported successor for Fitbit and Google Health accounts. The Google Fit REST API and the Fitbit Web API are not used because both turn down in 2026. The adapter mirrors the Hevy adapter: pure functions over an injected fetch, with unauthorized, rate-limited, network, and malformed-response failures reported as typed errors. Per-type failures other than authentication are collected as warnings so one data type cannot fail the whole sync.

Authorization uses a Google Cloud OAuth "Desktop app" client with PKCE and a loopback redirect to `/api/metrics/google/callback` on the local server. The client ID, client secret, and the resulting access and refresh tokens are stored in `data/settings.json` (`0600`), never in SQLite, exports, or error messages. The callback route is exempt from the cross-site request check because it is a top-level navigation from Google; the one-time `state` value issued by the connect step, held in memory for ten minutes, is the protection against forged callbacks.

Sync is manual. The first sync fetches 365 days; each later sync re-fetches from the source cursor minus seven days to catch late-arriving data, then moves the cursor to today. Points are upserted by primary key inside one transaction, so a repeated sync is idempotent and a failed sync leaves the previous data intact. Like Hevy sync, a successful sync switches the app to live mode. Data types, request shapes, the service API, and the browser views are specified in [metrics.md](metrics.md).

The same sync also fills intra-workout metrics. After the daily points are
committed, `syncMetrics` calls `syncWorkoutMetrics` best effort for up to 25
padded workout windows, newest first, so the single "Sync Google Health" button
covers both; a workout-window failure becomes a warning and never fails the
daily sync. Both syncs share one token helper that refreshes an expiring access
token, retries once after a 401, and disconnects when the grant itself is gone.
Each window is written in its own transaction with its ledger row, replacing the
samples in its own span so a changed primary recorder cannot interleave with the
old one, and windows are re-fetched when the workout times change in Hevy or when
an empty window is still young enough for data to arrive late.

## Analytics definitions

The analytics helpers use the workout `start_time` and local calendar weeks beginning on Monday.

- **Workout count** includes workouts with a valid start time between the selected period start and now. Future-dated or invalid workouts are excluded.
- **Duration** is the difference between valid `end_time` and `start_time`, rounded to whole minutes. Missing or non-positive durations count as zero.
- **External-load volume** sums `weight_kg × reps` for positive, numeric working sets. Warmups are excluded. Exercises whose template type indicates bodyweight, assisted, cardio, distance, duration, time, or reps-only work are excluded, so this is a comparable external-load measure rather than total physical work.
- **Weekly series** creates one bucket per calendar week from the selected start week through the current week, including the current partial week. The `all` range starts at the week containing the oldest dated workout.
- **Active weeks** is the number of weekly buckets containing at least one workout. It is a descriptive activity count, not an adherence measure. The displayed consistency percentage is `active weeks ÷ total displayed weeks`, rounded to a whole percent.
- **Muscle distribution** counts working sets by each exercise template's primary muscle group. It excludes warmups but does not otherwise remove bodyweight or cardio exercises; templates without a group are counted as `Other`.
- **Planned muscle coverage** is a separate routine/program view built by `public/muscle-coverage.js` and rendered with local SVGs in `public/muscle-map.js`. Exercise entries join templates by ID. Each entry contributes one exercise and its non-warmup set count to each tagged muscle, deduplicating repeated tags and giving primary precedence. Primary and secondary contributions remain separate; the UI defaults to primary only and can add secondary contributions without weighting them. A program aggregates one pass through its day list, including repeated routines, without multiplying by duration. Missing routine/template references remain explicit. Anatomical regions follow the Hevy muscle taxonomy; cardio, full-body, other, and unrecognized categories remain textual counts rather than guessed regions. Figures use the same count bins (0, 1, 2, 3–4, 5+) in every view. Counts describe planned coverage, not physiological activation, adherence, or recommended volume. No additional persistence or network access is needed.
- **Exercise segments inside a workout are estimated.** Hevy records no per-set timestamps, so a workout's duration is divided proportionally to each exercise's set count, weighted by the routine's `rest_seconds` when the workout came from a routine. Segment boundaries and their heart-rate averages are therefore an attribution estimate, not measured set times, and every payload carrying them sets `estimated_segments: true` so the interface can say so.
- **Heart-rate coverage** inside a workout is the fraction of the workout duration spanned by consecutive samples no further apart than `max(3 × median interval, 15 s)`. Longer gaps are dropouts, not interpolated data. Summaries are clipped to the workout interval; the padded window around it exists only for the chart. Where two devices record the same minutes, one primary source is chosen per window rather than interleaving them.
- **Exercise progress** applies the external-load rules, then reports each dated exercise occurrence's best positive working-set weight and external-load volume. It is not a one-repetition-max estimate.
- **Daily metric values** combine the points on one local date according to the catalog's `aggregate` rule: additive quantities such as steps and minutes are summed, and sampled measurements such as weight and resting heart rate are averaged. Aggregation runs across all sources; days without data are omitted and filled by the browser.
- **Sleep** is dated by the session's civil end date, the morning the user woke up, so a night that crosses midnight counts once. Stage minutes (deep, light, REM, awake) are separate metrics under the same date.
- **Training-day comparison** reports the mean of a metric on days with a workout against days without one. It is descriptive and makes no causal claim about training and the metric.

## Local security and recovery

The Hevy key can come from `HEVY_API_KEY` or local settings. Settings, the
assistant bearer credential, and other credential-bearing files are owner-only
(`0600`) and ignored by git. Neither the Hevy key, the Google Health credentials and tokens, nor the assistant
credential is included in assistant tools, Markdown exports, test fixtures, or
error messages.

For a backup, stop the server first and copy the complete data directory,
including the database, proposals, Markdown exports, sync metadata, settings,
and assistant credential. A backup contains credentials and personal training
data, so store it as sensitive local data. Restoring means replacing or
selecting the complete data directory through `CORPUS_DATA_DIR`.

## Training assistant and future modules

The optional training assistant is a separate role, not a development agent in
the repository. Restricted CLI sessions use `scripts/assistant.js`, which copies `assistant/` to a
temporary directory, starts a personal native Codex or Claude Code CLI there,
and connects only the fixed Corpus MCP bridge. The four scoped skills cover
analysis, routine design, program design, and proposal revision. The model sees
compact summaries and paginated detail, rather than arbitrary database or file
access. Its only write is saving a reviewable proposal.

ChatGPT Desktop and desktop-local Claude Cowork can instead start
`server/mcp-local.js` through app configuration. That entry point reads the
existing credential from the selected data directory and supplies the same
training instructions through MCP initialization. `scripts/assistant-apps.js`
prints the ChatGPT STDIO settings and packages the shared workflows as a local
Claude plugin without embedding the credential or any training data. These app
sessions retain their host's other enabled capabilities, unlike the restricted
CLI launchers; the server-side MCP authorization boundary is identical.

Proposal acceptance is local and atomic: an accepted draft can create or update
local routine overlays and programs but does not contact Hevy. Publishing an
accepted local routine is a later, explicit browser action. It verifies the
imported target hash where relevant, uses a durable request identifier to avoid
duplicate remote writes, and remaps local program days only after a successful
new remote routine. Proposals use revisions and visible-entity hashes, so stale
targets and competing revisions are rejected. Details are in [assistant.md](assistant.md).

Corpus does not invoke an AI model or upload training data by itself. The native
app or CLI selected by the user can send the compact context to its own provider
under that account's terms. The CLI launcher's restrictions narrow its training
session; they are not a general operating-system isolation claim.

Body measurements such as weight and body fat are part of the Metrics module. Supplements have their own mode-scoped tables and Markdown export and follow the same shared conventions. Nutrition and knowledge are later modules with their own tables, importers, Markdown conventions, and provenance. They consume shared identity, time, and source conventions rather than coupling directly to the workout tables. Cloud storage, if added, requires deliberate opt-in migrations, explicit credentials, and a documented synchronization policy; it is outside the current application boundary.
