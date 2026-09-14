# Supplements module

The Supplements module keeps the user's supplement stack (what they take, how
much, how often, where to buy it) and a log of doses, including doses that are
implied by logged workout sessions. This document is the implementation
contract: schema, service API, HTTP routes, derived rules, and browser views.
It follows the conventions of [metrics.md](metrics.md) and the local-data rules
of [architecture.md](architecture.md).

## Principles

- **Local, mode-scoped user data.** Supplements and doses are stored with the
  active data mode, exactly like programs. Demo and live records never mix, and
  demo mode is not seeded: it starts empty in both modes.
- **Lean backend.** Two tables, one pure helper module, five routes. Anything
  that can be derived at read time is derived, never stored twice.
- **Scheduled doses are assumed taken.** A supplement with a `daily`,
  `weekly` or `workout` frequency is logged automatically: one derived dose per
  scheduled slot (a calendar slot, or a logged workout session) inside its
  active window, through today. Nothing is written by a clock or during Hevy
  sync; the doses are computed at read time from the schedule and the current
  workouts, so reconciliation, demo mode and re-imports need no special
  handling. A stored row that names a slot or a workout is an *override* for
  that dose (a changed amount, or `0` = skipped), never the source of it.
- **Only `as_needed` supplements are logged by hand.** Extra manual doses on
  top of a schedule are still allowed.
- **Removing a dose you did not take** is the primary daily interaction, on
  Today, on a card's recent doses and retroactively in History. Skipping is an
  override row, so it can be undone; the schedule itself is never edited to
  record an exception.

## Storage (schema version 8)

```sql
CREATE TABLE IF NOT EXISTS supplements (
  id TEXT PRIMARY KEY,               -- randomUUID()
  mode TEXT NOT NULL,                -- 'demo' | 'live'
  name TEXT NOT NULL,                -- 1–120 chars
  brand TEXT NOT NULL DEFAULT '',    -- 0–120 chars
  type TEXT NOT NULL,                -- key from public/supplements-catalog.js SUPPLEMENT_TYPES
  dose_amount REAL NOT NULL,         -- > 0, ≤ 100000
  dose_unit TEXT NOT NULL,           -- key from DOSE_UNITS: g | mg | mcg | iu | ml | capsule | tablet | scoop | serving
  frequency_json TEXT NOT NULL,      -- see Frequency
  timing TEXT NOT NULL DEFAULT '',   -- 0–100 chars, free text ("Morning with breakfast", "After training")
  start_date TEXT NOT NULL,          -- YYYY-MM-DD
  end_date TEXT,                     -- YYYY-MM-DD ≥ start_date, or null while ongoing
  purchase_url TEXT,                 -- absolute http(s) URL ≤ 2048 chars, or null
  package_size REAL,                 -- amount per package in dose_unit, > 0, or null
  ingredients TEXT NOT NULL DEFAULT '', -- Markdown, ≤ 4000 chars
  notes TEXT NOT NULL DEFAULT '',    -- Markdown, ≤ 4000 chars
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supplement_doses (
  id TEXT PRIMARY KEY,               -- randomUUID()
  supplement_id TEXT NOT NULL REFERENCES supplements(id) ON DELETE CASCADE,
  taken_at TEXT NOT NULL,            -- ISO 8601 instant
  date TEXT NOT NULL,                -- local civil date YYYY-MM-DD of taken_at
  amount REAL NOT NULL,              -- ≥ 0 in the supplement's dose_unit; 0 means skipped
  workout_id TEXT,                   -- set only for a workout override row
  slot TEXT,                         -- set only for a calendar override row: 'YYYY-MM-DD:n', n = 0-based dose of the day
  note TEXT NOT NULL DEFAULT '',     -- ≤ 200 chars
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS supplement_doses_workout ON supplement_doses(supplement_id, workout_id) WHERE workout_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supplement_doses_slot ON supplement_doses(supplement_id, slot) WHERE slot IS NOT NULL;
CREATE INDEX IF NOT EXISTS supplement_doses_by_date ON supplement_doses(supplement_id, date);
```

Migration: bump `SCHEMA_VERSION` to 8 in `server/service.js`; the tables are
created with `IF NOT EXISTS` inside the existing `initialise` block. A database
already at version 8 without the `slot` column gets it through `ALTER TABLE`
in the same column check the programs migration uses, then the slot index is
created. Existing rows need no data migration. A row has at most one of
`workout_id` and `slot`; a row with neither is a manual dose. The `programs`-style `mode` column scopes
every read and write to `mode()`; `supplement_doses` has no `mode` column
because the supplement already carries it.

`workout_id` is not a foreign key: the workouts table holds Hevy IDs and demo
workouts are generated, so an override for a workout that later disappears
simply stops matching and is ignored (and is deleted on the next write for that
supplement, see below).

## Frequency

`frequency_json` is one of:

| kind | extra fields | Expected doses |
| --- | --- | --- |
| `daily` | `per_day` integer 1–6 (default 1) | `per_day` per calendar day in the active window |
| `weekly` | `weekdays` array of 0–6 (Monday = 0), 1–7 entries, sorted, unique | one per listed weekday in the active window |
| `workout` | `timing` may say before/after; no extra fields | one per logged workout whose local start date is in the active window |
| `as_needed` | none | none; only manual doses count |

The **active window** is `start_date` through `end_date` inclusive (or through
today when `end_date` is null). Derived doses are never generated after
today; the **scheduled window** of a range query is the active window clipped
to `[from, to]` and to today. Status is derived: `upcoming` when
`start_date` is after today, `ended` when `end_date` is before today,
otherwise `active`.

## Derived doses

`server/supplements.js` is a pure module (no SQLite, no clock other than the
`today` argument) exporting at least:

```js
validateSupplement(body, { today })      // → clean row fields or throws ServiceError('validation', message)
validateDose(body, supplement, { now })  // → { taken_at, date, amount, workout_id, note }
frequencyLabel(frequency)                // "Every day", "Twice a day", "Mon, Wed, Fri", "With every workout", "As needed"
supplementStatus(supplement, today)      // 'upcoming' | 'active' | 'ended'
workoutDoses(supplement, workouts, overridesByWorkoutId)
  // → derived dose rows for a `workout` supplement:
  //   one per workout with a valid start_time whose local date is in the active window,
  //   { id: `workout:${supplement.id}:${workout.id}`, supplement_id, taken_at: workout.end_time || workout.start_time,
  //     date, amount: supplement.dose_amount, workout_id, slot: null, workout_title, source: 'workout', skipped: false, note: '' }
  //   An override row for the same workout replaces amount/note (and sets skipped: amount === 0) and
  //   uses the override's own id so the browser can delete it.
scheduledDoses(supplement, { from, to, today }, overridesBySlot)
  // → derived dose rows for a `daily` or `weekly` supplement in the scheduled window:
  //   per_day rows per matching day (daily) or one per matching weekday (weekly),
  //   { id: `slot:${supplement.id}:${date}:${n}`, supplement_id, taken_at: local midnight of `date` as an ISO instant,
  //     date, amount: supplement.dose_amount, workout_id: null, slot: `${date}:${n}`, workout_title: null,
  //     source: 'schedule', skipped: false, note: '' }
  //   An override row for the same slot replaces amount/note (skipped: amount === 0) and uses its own id.
  //   Ordered by date descending, then n ascending.
expectedDoses(supplement, { from, to, today, workouts }) // integer expected count in the scheduled window
```

The service's dose reader merges, per supplement, (a) stored rows with neither
`workout_id` nor `slot` as `source: 'manual'`, (b) `workoutDoses(...)` for
`workout` supplements using the mode's current workouts (`state().workouts`,
which already covers demo and live), and (c) `scheduledDoses(...)` for
`daily` and `weekly` supplements. Stored override rows whose workout no longer
exists, or whose slot is outside the schedule (the frequency changed), are not
returned. The list is sorted by `taken_at` descending. Every returned row has
the shape
`{ id, supplement_id, taken_at, date, amount, unit, workout_id, slot, workout_title, source, skipped, note }`
with `source` one of `manual`, `workout`, `schedule`.

## Service API (`server/service.js`)

```js
getState()                                   // adds `supplements: [...]` for the active mode (see shape below)
getSupplementDoses({ days = 90 })            // { mode, range: { from, to }, doses: [...] }; days clamped 7–730 with clampDays
saveSupplement(body)                         // create when body.id is absent; update when it names a supplement in this mode
deleteSupplement(id)                         // { id, deleted: true }; doses cascade
logDose(supplementId, body = {})             // { dose }; body: { taken_at?, amount?, workout_id?, note? }
deleteDose(id)                               // { id, deleted: true }
```

Supplement shape in `state.supplements` (ordered by `status` active → upcoming
→ ended, then `name`):

```js
{ id, name, brand, type, dose_amount, dose_unit, frequency: { kind, per_day?, weekdays? }, frequency_label,
  timing, start_date, end_date, status, purchase_url, package_size, ingredients, notes, created_at, updated_at }
```

Rules:

- `saveSupplement` validates every field with the limits in the schema table.
  Unknown `type` or `dose_unit` keys are rejected. `purchase_url` must parse
  with `new URL` and use `http:` or `https:`; anything else is rejected, never
  silently dropped. `end_date` before `start_date` is rejected. Both dates
  use `isDateString`. When updating, `id` must exist in the active mode or the
  call throws `ServiceError('not_found', ..., 404)`. After a successful update
  that changed `frequency` away from `workout`, override rows (`workout_id IS
  NOT NULL`) for that supplement are deleted in the same transaction.
- `logDose` with no `workout_id` inserts a manual dose. `taken_at` defaults to
  now, must be a valid ISO instant not more than one hour in the future, and
  `date` is its local civil date. `amount` defaults to the supplement's
  `dose_amount` and must be ≥ 0 (0 is a skipped marker, allowed only with a
  `workout_id`).
- `logDose` with a `workout_id` requires a `workout` supplement and a workout
  of that id in the active mode; it upserts the override row on
  `(supplement_id, workout_id)` so the same session cannot be logged twice.
- `logDose` with a `slot` (`YYYY-MM-DD:n`) requires a `daily` or `weekly`
  supplement and a slot that the schedule actually generates (date in the
  scheduled window through today, matching weekday, `n < per_day`); it upserts
  the override row on `(supplement_id, slot)`. `workout_id` and `slot`
  together are rejected. The override's `taken_at` is the slot's local
  midnight and its `date` is the slot date, whatever `taken_at` the body sends.
- `deleteDose` deletes a stored row (manual or override). Derived rows have
  synthetic `workout:` / `slot:` ids and cannot be deleted; the browser offers
  "Didn't take" (an override with `amount: 0`) instead. Deleting an override
  restores the derived dose.
- After an update that changes `frequency.kind`, `per_day`, `weekdays`,
  `start_date` or `end_date`, override rows that no longer match a generated
  slot or a workout are deleted in the same transaction.
- Writes go through `serialiseWrite` like the other local writes.
- `exportMarkdown` adds `supplements.md`: one section per supplement with its
  fields, frequency label, status and the last 30 days of doses.

## HTTP routes (`server/index.js`)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| `GET` | `/api/supplements/doses?days=90` | — | `getSupplementDoses` |
| `POST` | `/api/supplements` | supplement fields, optional `id` | saved supplement |
| `DELETE` | `/api/supplements/:id` | — | `{ id, deleted: true }` |
| `POST` | `/api/supplements/:id/doses` | `{ taken_at?, amount?, workout_id?, slot?, note? }` | `{ dose }` |
| `DELETE` | `/api/supplements/doses/:id` | — | `{ id, deleted: true }` |

The routes sit with the other local writes (origin check only, no review
session), mirroring `/api/programs`. The supplement list itself rides on
`/api/state`, so the Stack page needs no extra request.

## Browser

### Navigation

A third sidebar group **Supplements** (icon `◍`) between Metrics and Settings,
with two routes:

- `#supplements` — nav label **Stack**
- `#supplements-history` — nav label **History**

The "coming later" sidebar note drops "supplements" ("Nutrition and knowledge
are coming later."). The router in `app.js` dispatches both routes to
`public/supplements.js`; after any supplement or dose write the module calls
`refresh()` (state) and `invalidateSupplementDoses()`.

### Files

- `public/supplements-catalog.js` — `SUPPLEMENT_TYPES` (`protein`, `creatine`,
  `pre_workout`, `amino_acid`, `vitamin`, `mineral`, `omega_3`, `electrolyte`,
  `probiotic`, `herbal`, `other`, each `{ key, label }`), `DOSE_UNITS`
  (`{ key, label, plural }` so `1 capsule` / `2 capsules` / `5 g` format
  right), `FREQUENCY_KINDS` with labels and hints, `WEEKDAYS` (Mon-first).
  Shared by server validation and the browser, like `metrics-catalog.js`.
- `public/supplements-analytics.js` — pure, tested helpers: `dueToday(supplement, today, workoutsToday)`,
  `takenToday(doses, supplementId, today)`, `adherence(supplement, doses, { from, to, workouts })`
  → `{ expected, taken, ratio }`, `doseCalendar(supplement, doses, { from, to })`
  → one cell per day `{ date, taken, expected }` for the calendar strip,
  `dosesPerPackage(supplement)`, `packageDays(supplement, adherence)`,
  `formatDose(amount, unit)`, `groupByDate(doses)`.
- `public/supplements.js` — the two views, the supplement dialog (read), the
  editor dialog (form), and the dose cache (same cache/invalidate pattern as
  `metrics-workouts.js`, fetched once per mode at 730 days and sliced by the
  range picker).
- `styles.css` gains one **Supplements** section at the end; new tokens only if
  a shared one is missing.

### Stack (`#supplements`)

`heading('Supplements', 'Stack', 'What you take, and whether you took it today.', New supplement)`.

1. **Today panel** (`panelHeader('Today', '<n> of <m> taken')`). One row per
   supplement that is due today (`daily`, `weekly` on a matching weekday,
   `workout` when a session has been logged today, and every `as_needed`
   supplement in a quieter "When needed" sub-list). Each row: name, dose and
   timing as meta, and one control on the right. Scheduled doses are already
   counted as taken, so the control removes rather than adds:
   - `daily` / `weekly`: the row reads "Taken ✓" (`.is-taken`) with a ghost
     **Didn't take** button that writes a `0` override for today's slot; a
     skipped row reads "Skipped" (`.is-skipped`) with **Undo** (deletes the
     override). For `per_day > 1` the row shows `2 of 2 taken` and one dose
     chip per slot, each with its own Didn't take / Undo.
   - `workout`: the same, with "Logged with <workout title> · <time>" as the
     meta and Didn't take / Undo on that session's override. Before any session
     today the supplement is not listed under Today; the card grid still shows it.
   - `as_needed`: **Log dose** button; taken ones show the count today and a
     **Remove** icon button on the latest one.
   Toasts: `Dose logged` / `Dose removed` / `Dose skipped` / `Dose restored`;
   errors `Couldn't log dose` (or `remove`) + server message.
   Empty state: "Nothing to take today" when the stack has active supplements
   but none are due; "Add your first supplement" with a secondary "New
   supplement" button when the stack is empty (the view heading already holds
   the primary; the Today panel is then omitted).
2. **Card grid** of supplements, active first, then upcoming, then an
   "Ended" `details` section collapsed by default. Card: kicker = type label,
   title = name, meta = `brand · <dose> · <frequency label>`, a status pill,
   a 30-day adherence line (`miniMetric`: `87% · 26 of 30 doses`; hidden for
   `as_needed`, shows dose count instead), and a compact 30-day calendar strip
   (one cell per day, filled when taken, outlined when expected but missed,
   blank when not expected). `card-actions`: **Details**, **Edit**, **Log dose**
   (`as_needed` only; a scheduled supplement is logged by its schedule). A **Buy** text link (`purchase_url`,
   `target="_blank" rel="noopener noreferrer"`) sits in the meta row when set.

### Supplement dialog (Details)

Eyebrow `Supplement`, h2 name. `.dialog-stack` with: pills (type, status,
brand); a definition list of Dose, Frequency, Timing, Started, Ends, Package
(`<size> = <n> doses ≈ <d> days` when `package_size` is set); Ingredients and
Notes rendered with `public/markdown.js` (empty ones say "Not set"); Buy link;
recent doses (last 10, newest first, each with date/time, amount, source
"Scheduled", "with <workout>" or "Manual", and per row: **Didn't take** for a
derived row, **Undo** for a skipped one, **Remove** for a manual one).
Actions row: Close · **Delete** (danger, confirm with a second click "Really
delete?" inside the same button, then toast `Supplement deleted`) ·
**Stop taking** / **Resume** (secondary; sets `end_date` to today, or clears
it) · **Edit** (primary).

### Editor dialog (New / Edit)

Eyebrow `Supplement`, h2 `New supplement` or the name. Fields in order, all
through `field(label, options)`:

- Name (required), Brand
- Type (select from catalog), Dose amount (number, step any) and Dose unit
  (select) side by side in a `.field-row`
- Frequency (select: Every day · Certain weekdays · With every workout · As needed).
  Conditional controls under it: Times per day (1–6) for daily; a weekday
  toggle group (`fieldset` + seven `button.weekday` toggles with
  `aria-pressed`) for weekly; a hint "One dose is counted for every logged
  workout session. You can skip a session from Today." for workout.
- Timing (text, placeholder "Morning with breakfast")
- Start date (date, default today), End date (date, optional, hint "Leave empty while you keep taking it")
- Where to buy (url), Package size (number, unit label follows the chosen dose unit)
- Ingredients (textarea, hint "Markdown, e.g. one line per ingredient"), Notes (textarea)

Inline `.form-error` on validation failure; success closes and toasts
`Supplement saved` (or `Supplement added`). For a new `workout` supplement
with a start date in the past, the hint under Start date explains that past
sessions since that date will count as doses.

### History (`#supplements-history`)

`heading('Supplements', 'History', 'Every dose, and how consistent you have been.', periodPicker)`.
Range comes from the shared `period` helper.

1. Stat cards: **Doses logged**, **Adherence** (all scheduled supplements in
   range, `taken / expected`), **With workouts** (derived and override doses
   with a workout).
2. **Adherence** panel: one row per supplement (name, `taken / expected`,
   ratio as a `progress` element, and the day calendar strip for the range,
   scrolling horizontally inside the panel when the range is long).
   `as_needed` rows show only the count.
3. **Doses** panel: a table grouped by date (newest first, 60 rows then a
   "Show more" button): time (`—` for scheduled rows), supplement, amount,
   source ("Scheduled", "Manual", "With <workout title>"; a skipped row shows
   "Skipped" with the amount struck through), note, and one action per row:
   **Didn't take** for a derived row (writes the `0` override), **Undo** for a
   skipped row (deletes the override), **Remove** for a manual row. This is
   where a dose is removed retroactively. The table scrolls inside
   `overflow-x: auto`.
   Empty state: "No doses in this range".

Loading and failure states reuse `loadingPanel` / `failurePanel` from
`metrics.js`.

### Copy and formatting

- Doses format as `5 g`, `2 capsules`, `1 scoop`, `1,000 IU`
  (`formatDose` in the analytics module; number formatting via `formatNumber`).
- Frequency labels come from `frequencyLabel` on the server (`frequency_label`)
  so cards and exports agree.
- Absent values follow `docs/ui.md`: `—` in cells, "Not set" in dialogs.

## Tests

- `tests/supplements.test.js` — pure helpers (validation limits, URL rules,
  frequency labels, status, `workoutDoses` and `scheduledDoses` with and
  without overrides, never past today, `expectedDoses` for each kind across a
  window and DST boundary) and the service (create/update/delete in both modes
  without leakage, cascade, override upsert for workouts and slots, slot
  validation against the schedule, stale overrides dropped after a frequency
  change, derived doses for demo workouts, `getSupplementDoses` clamping and
  sorting, export contents, schema version 8 on a fresh db and the `slot`
  column added to a version-8 db that lacks it).
- `tests/http.test.js` — the five routes against a stub service, including
  404 for unknown paths and `DELETE` id decoding.
- `tests/supplements-ui.test.js` — `supplements-analytics.js` and `formatDose`.

## Later

- Show today's stack on the Overview page and "logged with this session" in
  the session dialog.
- A read-only assistant tool exposing the stack, so drafts can mention
  supplement timing around training.
- Stock tracking (remaining amount after a restock) and cost per dose once a
  currency preference exists.
- Nutrition module sharing the dose log conventions.
