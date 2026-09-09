# corpus

corpus is a local-first training and health data workbench. The current release is deliberately narrow and includes:

- Hevy workout sessions, routines, and exercise templates imported through a read-only full snapshot;
- local programs that group routines into ordered training days, with optional dated training blocks;
- a routine builder that publishes new workouts to Hevy and edits existing routines;
- an HTML overview with session, program, routine, and exercise views;
- workout counts, duration, weekly trends, external-load volume, muscle distribution, and exercise progress;
- a separate synthetic demo mode, kg/lb preferences, local settings, and Markdown export.

Future modules can add supplements, nutrition, body measurements, and a knowledge library without changing the local-only boundary.

The project is for personal use and for people who clone or fork the repository. It has no hosted service, account system, telemetry, CDN assets, cloud sync, or embedded AI model.

## Requirements

- Node.js 24 or newer
- A Hevy Pro account and a Hevy API key for live imports

The application has no npm runtime dependencies, so `npm install` is not needed. Node's built-in modules provide the server, local API, and database integration. On Node 24.11, starting or testing may print Node's experimental built-in SQLite warning; that warning is expected for this release.

## Run it

```sh
npm start
```

Open <http://127.0.0.1:3210>. The server binds to loopback only. To use another local port or data directory:

```sh
PORT=3211 npm start
CORPUS_DATA_DIR=/path/to/corpus-data npm start
```

Useful checks and operations are available without starting the web server:

```sh
npm test          # run the Node test suite
npm run status    # print the local mode and record counts
npm run sync      # manually import a read-only full Hevy snapshot
npm run export    # generate Markdown exports for analysis
```

The web interface exposes the same sync and export actions. Sync only reads from Hevy. **Create in Hevy** publishes a new routine; **Save changes to Hevy** updates the routine being edited. Workout history is not changed by either action.

## Create a routine in Hevy

1. Add your Hevy API key in Settings and sync your account to load its exercise library.
2. Open **Programs → New Hevy routine**.
3. Name the routine, add exercises, and enter set targets, rest times, and notes. Use the arrows to order exercises. Loads follow your kg/lb preference; Corpus converts them to kilograms for Hevy.
4. Click **Create in Hevy** to publish the routine to **My Routines**. It also becomes available in Corpus's saved routines and local program editor.

Demo mode lets you preview the builder but cannot publish. Publishing requests are not automatically retried. If a request has an uncertain result, check Hevy and sync before creating again to avoid duplicates.

To edit a saved routine, open **Programs → Saved routines → Edit routine**. The builder loads the current exercises and targets. Make changes and choose **Save changes to Hevy** to update that same routine. Its folder and links from Corpus programs are preserved. Sync first if you have recently changed the routine in Hevy.

## Follow a training program

Open **Programs → New program**, choose your routines, and set a start date and duration. Use the 8-, 10-, or 12-week shortcuts, or enter 1–52 weeks. You can also leave a program unscheduled; existing programs remain unscheduled until you edit them.

Program cards show the inclusive date range, upcoming/active/completed status, current week, and sessions logged in each program week. The overview highlights active programs independently of its dashboard date filter. Time progress measures calendar days through today, not workout adherence.

Sessions receive program labels when their Hevy routine ID matches a program day and their local start date falls within that block. Use the **Program** filter in Sessions to review a block. Reusing a routine outside the block does not associate those sessions; overlapping programs can both match a session. Changing a program's dates or routines recalculates associations, so keep completed blocks and create a new program for your next cycle if you want separate records. Program weeks begin on the chosen start date, while the main dashboard uses Monday-based weeks. Dates follow your laptop's local timezone.

## Configure Hevy

Create a key in Hevy at <https://hevy.com/settings?developer>. The UI has a local settings form for the key. For command-line use, `HEVY_API_KEY` can be supplied through the process environment. Keep the key out of source control; local settings are intended to be stored with mode `0600`.

The first sync imports a complete paginated snapshot of workouts, routines, and exercise templates. Later manual syncs reconcile the snapshot in one SQLite transaction. Records that disappeared from Hevy are removed from the current imported dataset after a successful snapshot; exports are regenerated from that current dataset and do not provide deletion history. A separate synthetic demo dataset is available for screenshots and exploration; it is kept separate from live imported data and can be disabled before a real sync.

## Local data

The default data directory is `data/`, which is ignored by git. It contains `data/corpus.sqlite`, the SQLite database for structured records and sync metadata; generated Markdown under `data/exports/`; and the credential-bearing `data/settings.json`. Current Hevy workout, routine, and exercise-template table IDs are the corresponding Hevy IDs. Future connectors will need a deliberate namespaced-ID migration before adding other sources. A `data/knowledge/` convention may be introduced with the later knowledge module; it is not part of the current data model.

To make a backup, stop corpus and copy the entire data directory to a protected location. The copy includes the local credential and should be treated as sensitive.

## Project direction

The local database remains the source of truth for the current workout data. Markdown exports are the readable boundary for Codex and Claude Code workflows. Planned AI skills may read exported Markdown and read-only SQL queries against `data/corpus.sqlite`, then write recommendations as reviewable notes; the current application does not perform AI inference or send personal data to a remote model automatically.

The architecture is documented in [docs/architecture.md](docs/architecture.md). It keeps workouts, nutrition, supplements, and knowledge as separate modules so each can be added one at a time. Cloud storage can be added later only through an explicit opt-in migration with a clear data contract; it is not promised by the current local setup.
