# Corpus UI conventions

The front end is plain HTML, JS and CSS under `public/`. These rules keep every view looking and
behaving like one product. When adding or changing UI, follow them rather than inventing a local
variant; if a rule genuinely does not fit, change the rule here first.

## Shared primitives

`app.js` owns the shared helpers and hands them to feature modules through `context()`:
`heading`, `panelHeader`, `sectionHeading`, `emptyState`, `statCard`, `miniMetric`, `periodPicker`,
`field`, `button`, `settingsLink`, `setBusy`, `setMode`, `syncAll`, plus the `format` and `period`
namespaces. Feature modules must not define private copies of these. Formatting lives in
`format.js`; the shared date range lives in `period.js`; every chart is drawn by `metric-charts.js`
through `mountChart`, which picks full or compact geometry from the measured container.

## Layout

- Every view: `.view` (grid, one vertical rhythm) → `heading(eyebrow, h1, description, ...actions)`.
  Eyebrow is the sidebar group (Workout, Metrics, Supplements, Settings); h1 is the nav label; actions sit in
  `.view-actions` in the order content selector → range picker → source action.
- The router renders the demo notice under the header on every route in demo mode. Views never
  render their own demo message.
- Content sits in `.panel` with `panelHeader`; in-page titles outside a panel use `sectionHeading`.
- Card decks use `.card-grid` (intrinsic columns, no breakpoints) and `.card` → `.label-caps` kicker
  → `h3.card-title` → `.card-meta` → body → `.card-actions` (small buttons).
- Modules never set outer margins or inline styles; spacing comes from the `.view` and `.panel-stack`
  gaps.

## Controls

- Button variants map to consequence: `primary` is the one action that advances the flow (at most one
  per panel, dialog or card row); `secondary` is everything else; `danger` destroys local data or
  breaks a connection; `ghost` is a quiet tertiary; `text-button` is navigation. Sizes: default,
  `sm`, `icon`. Glyphs live in `<span class="icon" aria-hidden="true">` next to a label span, never
  inside the label text.
- `:disabled` means unavailable; `.is-busy` means working. Never disable a control for a missing
  prerequisite: hide it, or keep it enabled and route the user to the fix with a neutral toast.
- Fields: `field(label, options)` → `label.field > .field-label + control (+ .field-hint)`. Groups use
  `fieldset` + `legend.field-label`. Units go in labels (`Load (kg)`, `Time (s)`), never in cells.
- Every dialog: eyebrow = object class, h2 = object name or action, body in `.dialog-stack`, one
  `.dialog-actions` row ordered Cancel/Close · danger · secondary · primary. Errors are inline
  `.form-error`; toasts only report outcomes after the dialog closes.

## Data sources and modes

- The top bar is source agnostic: mode badge and toggle on the left, one `Sync` on the right that
  syncs every connected source. Per-source Save · Connect · Sync now · Disconnect live on that
  source's integration card in Settings, with a status pill and a "Last synced" line.
- Data mode and display unit are preferences in Settings → Data & preferences and apply on change.
  The mode vocabulary is the `MODE_COPY` table in `app.js`; do not add a second one.

## Copy

- Toasts: success `<Object> <past-tense verb>` + one sentence; errors `Couldn't <verb> <object>` +
  the server message. No toast for navigation.
- Absent values: `—` in cells, "Not set" for unfilled fields, "No longer in Hevy" for broken
  references, "Never synced" for sync timestamps.
- The AI feature is "draft" in all user-facing text.

## Stylesheet

- All colour, type, radius and spacing values come from the tokens in `:root`; no raw hex or rgba
  outside that block. Text tokens meet 4.5:1 on the surfaces they are used on.
- Type scale `--fs-caps` … `--fs-display`; weights 400/500/600/700 only. Meta text that users must
  read is at least 12px; 10px is reserved for uppercase micro-labels.
- The stylesheet is split into commented sections (Tokens, Base, Shell, Layout, Buttons, Forms,
  Cards, Pills, Notices, States, Dialog, Charts, then one section per view). Module-specific rules
  stay in their view's section; shared rules go in the component sections.
- A class used in JS must have a rule; a rule must have a user.

## Verifying a change

Run `npm test`, then look at the affected routes at 1400px and 390px wide, including any dialog the
change touches. Demo mode covers every empty and populated state except live-only connection states,
which are read from the code paths in `settings.js`.
