# corpus

corpus is a local-first training and health data workbench. The current release is deliberately narrow and includes:

- Hevy workout sessions, routines, and exercise templates imported through a read-only full snapshot;
- local programs that group routines into ordered training days, with optional dated training blocks;
- a routine builder that publishes new workouts to Hevy and edits existing routines;
- an HTML overview with session, program, routine, and exercise views;
- workout counts, duration, weekly trends, external-load volume, muscle distribution, and exercise progress;
- daily health metrics (activity, heart, sleep, body, and fitness) imported from Google Health, with a dashboard and trends view;
- a separate synthetic demo mode, kg/lb preferences, local settings, and Markdown export;
- an optional, tools-only training assistant that prepares local proposals for review.

Future modules can add supplements, nutrition, and a knowledge library without changing the local-only boundary.

The project is for personal use and for people who clone or fork the repository. It has no hosted service, account system, telemetry, CDN assets, cloud sync, or embedded AI model.

## Requirements

- Node.js 24 or newer
- A Hevy Pro account and a Hevy API key for live imports
- Optionally, a Google account with Fitbit or Google Health data and a personal Google Cloud OAuth client for health metrics

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

## Use the training assistant

The training assistant is a separate role from development. It reads compact,
bounded Corpus context through its local MCP server and can save a proposal. It
cannot sync, change settings, edit code, run SQL, approve a proposal, or publish
to Hevy. Review and publishing stay in the Corpus interface.

Start Corpus first, then launch one personal CLI from a terminal in this
repository:

```sh
npm run assistant:codex
npm run assistant:claude

# verify the installed CLI supports the restricted launch without starting a session
npm run assistant:codex -- --check
npm run assistant:claude -- --check
```

Install and sign in to the native CLI before running either command. Codex can
use a ChatGPT subscription or an API key; this launcher requires the ChatGPT
sign-in path. OpenAI documents installation, sign-in, and billing in its
[Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli),
[authentication guide](https://learn.chatgpt.com/docs/auth), and
[pricing guide](https://learn.chatgpt.com/docs/pricing). Claude Code supports a
personal subscription or Console account; see its
[quickstart](https://code.claude.com/docs/en/quickstart) and
[authentication guide](https://code.claude.com/docs/en/authentication).

The launcher copies only `assistant/` into a temporary workspace. It keeps the
CLI's normal personal login location and does not edit global configuration.
For Codex it requires ChatGPT authentication, read-only sandboxing, the Corpus
MCP server, and no shell or other MCP tools. For Claude it starts with only
`Skill`, `AskUserQuestion`, and the strict Corpus MCP configuration. These are
launch restrictions for the training session, not a general-purpose operating
system security boundary. In VS Code, open the integrated terminal and run the
same commands; Corpus does not configure an IDE extension automatically.

See [docs/assistant.md](docs/assistant.md) for the skills, proposal workflow,
privacy boundary, and MCP contract.

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

## Inspect planned muscle coverage

In **Programs**, select **Muscle coverage** on a program or saved routine. The front and back figures highlight muscle groups from your synced Hevy exercise templates. Choose **Exercises** or **Working sets**, and include secondary muscles when you want to see their contributions alongside primary targets. Select a muscle to inspect the exercises behind its count.

Routine counts cover one session of that routine. Program counts cover one pass through its listed training days; a routine listed twice contributes twice. The view does not multiply by the program's duration or assume the day list is a weekly schedule. Working sets exclude warmups. Repeated muscle tags within one exercise count once, with primary taking precedence over secondary. These are planned coverage counts, not measured muscle activation or an ideal training-volume prescription. The fixed shading scale makes counts comparable between views; exact counts remain available in the breakdown. Missing exercise metadata and categories without a body region are identified explicitly.

## Configure Hevy

Create a key in Hevy at <https://hevy.com/settings?developer>. The UI has a local settings form for the key. For command-line use, `HEVY_API_KEY` can be supplied through the process environment. Keep the key out of source control; local settings are intended to be stored with mode `0600`.

The first sync imports a complete paginated snapshot of workouts, routines, and exercise templates. Later manual syncs reconcile the snapshot in one SQLite transaction. Records that disappeared from Hevy are removed from the current imported dataset after a successful snapshot; exports are regenerated from that current dataset and do not provide deletion history. A separate synthetic demo dataset is available for screenshots and exploration; it is kept separate from live imported data and can be disabled before a real sync.

## Google Health metrics

Corpus imports daily health data through the Google Health API. Google Fit and the legacy Fitbit Web API are not used because both shut down in 2026. Setup uses a personal, unverified Google Cloud OAuth client:

1. Create a project at <https://console.cloud.google.com/>.
2. Enable the **Google Health API** in **APIs & Services → Library**.
3. Configure the OAuth consent screen: user type **External**, publishing status **Testing**, and add your own Google account as a test user.
4. Create an OAuth client under **Credentials → Create credentials → OAuth client ID** with application type **Desktop app**.
5. Paste the client ID and client secret into **Settings → Google Health** in Corpus.
6. Click **Connect**. A Google sign-in tab opens; approve the "unverified app" warning, which is expected for a personal app in Testing, and grant the read-only scopes. Google redirects back to the local server, and Settings shows the connection.
7. Open **Metrics → Dashboard** and click **Sync Google Health**.

Imported metrics: steps, distance, active zone minutes, energy burned, resting heart rate, heart rate variability, blood oxygen, sleep with deep/light/REM/awake stages, weight, body fat, and cardio fitness (VO₂ max). Sleep is dated by the morning you woke up. Weight follows your kg/lb preference.

The first sync fetches the last year; later syncs re-fetch the last week so late-arriving data is picked up, and re-syncing never duplicates points. A successful sync switches Corpus to live mode. The client ID, secret, and OAuth tokens stay in `data/settings.json` in the local data directory; **Disconnect** revokes and forgets them. Demo mode shows generated metrics and never writes to the metric tables.

## Local data

The default data directory is `data/`, which is ignored by git. It contains `data/corpus.sqlite`, the SQLite database for structured records, proposals, and sync metadata; generated Markdown under `data/exports/`; the credential-bearing `data/settings.json` (Hevy key, Google Health client and tokens); the local assistant credential; and proposal rationale files. Current Hevy workout, routine, and exercise-template table IDs are the corresponding Hevy IDs, and a second workout source would need a deliberate namespaced-ID migration. Health metric points are already namespaced by source. A `data/knowledge/` convention may be introduced with the later knowledge module; it is not part of the current data model.

To make a backup, stop corpus and copy the entire data directory to a protected location. The copy includes the local credential and should be treated as sensitive.

## Project direction

The local database remains the source of truth for current workout data. The
optional assistant uses the fixed, local MCP tool set described in
[docs/assistant.md](docs/assistant.md), rather than exports, arbitrary file
access, or SQL. Corpus itself makes no AI-provider request. A chosen native CLI
may send the bounded context it receives to that CLI's provider; the launcher
states this before it starts a session.

The architecture is documented in [docs/architecture.md](docs/architecture.md). It keeps workouts, health metrics, nutrition, supplements, and knowledge as separate modules so each can be added one at a time. Cloud storage can be added later only through an explicit opt-in migration with a clear data contract; it is not promised by the current local setup.
