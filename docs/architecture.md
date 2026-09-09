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
Markdown exports        Hevy API adapter
      |
      v
Codex / Claude Code workflows (planned, explicit local reads)
```

The frontend owns presentation and interaction: dashboard cards, progress charts, workout and routine views, local programs, unit preferences, demo mode, settings, sync, and export actions. The backend owns validation, persistence, sync state, atomic imports, and file permissions. The browser never talks directly to Hevy; API keys stay on the backend side of the local process.

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

Static `GET` requests serve the local HTML, CSS, and JavaScript interface. Hevy writes go through the local routine endpoints, with credentials kept on the server.

## Structured storage

SQLite is the source of truth for the implemented workout module. The database is `data/corpus.sqlite` and contains separate records for:

- imported Hevy workouts and their exercises and sets;
- Hevy routines and exercise templates;
- local programs, which group routines into ordered training days and optional dated training blocks;
- sync metadata and source identifiers;
- the selected demo/live mode.

Unit preference and the saved API key live in the private `data/settings.json` file.

Schema version 3 adds nullable `start_date` (`YYYY-MM-DD`) and `duration_weeks` (integer 1–52) to programs. Both values must be present or both null. Existing programs migrate to unscheduled without changing their days or IDs. Updates that omit both scheduling fields preserve the saved schedule; explicitly sending both null clears it.

The shared `public/program-timeline.js` helpers derive inclusive end dates, statuses, and session associations. Calendar-day arithmetic avoids daylight-saving drift. A session belongs to each scheduled program with a matching routine ID and a date within the block, using the laptop's timezone. These associations are derived from the current program definition rather than persisted historical assignments. Program edits therefore recalculate them. Program weeks start on the block's start date, independently of the dashboard's Monday-based weeks. Each matching session counts once per program even if multiple days use its routine; overlapping programs may each count it. Program activity excludes future timestamps, and time progress counts calendar days through today rather than measuring adherence.

The current `workouts`, `routines`, and `exercise_templates` table IDs are the corresponding Hevy IDs. `source_items` records the raw source payload for each imported item. A future second source will require a deliberate namespaced-ID migration; the current schema does not pretend to support multiple source systems.

Markdown is the human- and agent-readable layer. `data/exports/` contains generated `overview.md`, `workouts.md`, `routines.md`, and `programs.md`. Exports are regenerated from the selected current mode and are not an append-only history. A future knowledge module may introduce `data/knowledge/` with explicit provenance fields; that module is not implemented by the current service.

## Hevy sync

Sync is a manual, read-only full snapshot. The Hevy adapter fetches all pages for workouts, routines, and exercise templates, validates the response, and writes the result in one SQLite transaction. The live snapshot becomes visible only after the complete import succeeds. A failed request leaves the previous local snapshot available.

Reconciliation compares source IDs in the new snapshot with previously imported records. Missing workouts, routines, and exercise templates are physically removed from the current imported tables after the new snapshot has been validated; the current schema has no tombstone or deletion-history table. Existing exports remain untouched if the sync fails, and a successful export regenerates Markdown from the selected current mode. Imported rows retain raw source JSON and sync metadata while they exist. The adapter treats pagination limits, malformed responses, invalid keys, rate limiting, and network failures as recoverable sync errors.

The official Hevy API documentation is at <https://api.hevyapp.com/docs/>. It requires an `api-key` header, is currently limited to Hevy Pro users, and documents paginated workouts, routines, and exercise templates. Hevy also exposes a workout events endpoint for future incremental synchronization; the current full-snapshot operation keeps reconciliation straightforward while that integration evolves.

Routine publishing is a separate, explicit action. The backend validates imported exercise IDs and set targets, converts the form into Hevy's `{routine: ...}` request, and calls `POST /v1/routines`. It uses the default folder and does not edit existing routines. Demo mode cannot publish. A request identifier tracks the publication so repeated submissions do not send the same POST again after success or an uncertain outcome. Network failures and ambiguous responses require checking Hevy before creating again; there are no automatic write retries. A confirmed remote success is reported as such even if the local cache needs refreshing.

Editing uses `PUT /v1/routines/{id}` and updates the same routine locally after Hevy confirms success. The builder loads saved targets in the user's display unit and preserves the routine's folder, existing superset membership, and custom set metrics. Program references keep pointing to the same routine ID. Write deduplication includes the operation and target so editing cannot be confused with creating a routine. Editing uses the last synced local record; users should sync changes made in Hevy before opening the editor.

The UI's demo mode is a separate synthetic dataset for screenshots and empty-state exploration. Demo records are generated by the demo module, are not written into the live imported tables, and must never be mixed into a live snapshot or used as evidence in progress analysis. Programs are stored with the active mode, so a demo program and a live program remain separate.

## Analytics definitions

The analytics helpers use the workout `start_time` and local calendar weeks beginning on Monday.

- **Workout count** includes workouts with a valid start time between the selected period start and now. Future-dated or invalid workouts are excluded.
- **Duration** is the difference between valid `end_time` and `start_time`, rounded to whole minutes. Missing or non-positive durations count as zero.
- **External-load volume** sums `weight_kg × reps` for positive, numeric working sets. Warmups are excluded. Exercises whose template type indicates bodyweight, assisted, cardio, distance, duration, time, or reps-only work are excluded, so this is a comparable external-load measure rather than total physical work.
- **Weekly series** creates one bucket per calendar week from the selected start week through the current week, including the current partial week. The `all` range starts at the week containing the oldest dated workout.
- **Active weeks** is the number of weekly buckets containing at least one workout. It is a descriptive activity count, not an adherence measure. The displayed consistency percentage is `active weeks ÷ total displayed weeks`, rounded to a whole percent.
- **Muscle distribution** counts working sets by each exercise template's primary muscle group. It excludes warmups but does not otherwise remove bodyweight or cardio exercises; templates without a group are counted as `Other`.
- **Exercise progress** applies the external-load rules, then reports each dated exercise occurrence's best positive working-set weight and external-load volume. It is not a one-repetition-max estimate.

## Local security and recovery

The Hevy key can come from `HEVY_API_KEY` or local settings. Settings and any credential-bearing file should be created with owner-only permissions (`0600`) and must remain ignored by git. The key should not appear in logs, Markdown exports, test fixtures, or error messages.

For a backup, stop the server first and copy the complete data directory, including the database, Markdown exports, sync metadata, and settings. A backup contains a credential and must be stored as sensitive local data. Restoring means replacing or selecting the complete data directory through `CORPUS_DATA_DIR`.

## AI and future modules

Codex and Claude Code workflows are planned as a series of repository skills. Their safe default is to read exported Markdown and read-only SQLite queries, explain the evidence used, and save proposed programs or recommendations as reviewable notes. They should not imply local model inference, silently send data to a remote service, or mutate imported workout history. Applying a recommendation to a local program remains an explicit user action.

Nutrition, supplements, body measurements, and knowledge are later modules with their own tables, importers, Markdown conventions, and provenance. They consume shared identity, time, and source conventions rather than coupling directly to the workout tables. Cloud storage, if added, requires deliberate opt-in migrations, explicit credentials, and a documented synchronization policy; it is outside the current application boundary.
