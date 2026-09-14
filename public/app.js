import {
  durationMinutes,
  exerciseProgress,
  filterByPeriod,
  muscleDistribution,
  periodStart,
  summarize,
  templateMap,
  weeklySeries,
  workoutVolume,
} from "./analytics.js";
import { invalidateMetrics, renderMetricsDashboard, renderMetricsTrends } from "./metrics.js";
import { invalidateWorkoutMetrics, renderMetricsWorkouts } from "./metrics-workouts.js";
import { invalidateSupplementDoses, renderSupplements, renderSupplementsHistory } from "./supplements.js";
import { workoutMetricsSection } from "./workout-metrics.js";
import { renderPrograms as renderProgramsModule, renderProgramProgress } from "./programs.js";
import { localDateKey, matchingPrograms, programTimeline } from "./program-timeline.js";
import { pendingCount, renderProposals } from "./proposals.js";
import { renderSettings as renderSettingsModule } from "./settings.js";
import { barChart, lineChart, mountChart } from "./metric-charts.js";
import {
  MISSING,
  MISSING_ROUTINE,
  NEVER_SYNCED,
  NOT_SET,
  convertKg,
  dateLabel,
  formatBpm,
  formatCompact,
  formatDateTime,
  formatDay,
  formatDuration,
  formatElapsed,
  formatLoad,
  formatNumber,
  formatSeconds,
  formatSet,
  plural,
} from "./format.js";
import { PERIODS, analyticsPeriod, getPeriod, periodDays, periodLabel, periodWeeks, setPeriod } from "./period.js";

const root = document.querySelector("#view-root");
const loading = document.querySelector("#loading-view");
const dialog = document.querySelector("#app-dialog");
const dialogBody = document.querySelector("#dialog-body");
const dialogTitle = document.querySelector("#dialog-title");
const dialogEyebrow = document.querySelector("#dialog-eyebrow");
const modeBadge = document.querySelector("#mode-badge");
const modeToggle = document.querySelector("#mode-toggle");
const syncButton = document.querySelector("#sync-button");
const menuButton = document.querySelector("#menu-button");
const scrim = document.querySelector("#mobile-scrim");

/** One string table for the data-mode vocabulary (D6). */
export const MODE_COPY = {
  badge: { demo: "Demo data", live: "Live data" },
  // Keyed by the mode the app is in; the label names the mode it switches to.
  toggle: { demo: "Use my data", live: "View demo data" },
  // Keyed by the mode that was just turned on.
  toast: {
    demo: { title: "Demo data on", body: "Demo and live archives stay separate." },
    live: { title: "Live data on", body: "Demo and live archives stay separate." },
  },
  error: "Couldn’t switch data mode",
};

let state = null;
let selectedExerciseId = "";
let sessionQuery = "";
let sessionExercise = "all";
let sessionProgram = "all";
let csrfSession = null;
let proposalPollTimer = null;
let lastRoute = null;

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined && text !== null) element.textContent = String(text);
  return element;
};

const add = (parent, ...children) => {
  for (const child of children.flat()) if (child) parent.append(child);
  return parent;
};

async function csrfToken() {
  if (!csrfSession) {
    csrfSession = fetch("/api/session", { headers: { Accept: "application/json" } })
      .then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.csrfToken) throw Object.assign(new Error(body.error || "Could not start a secure session."), { code: body.code });
        return body.csrfToken;
      })
      .catch(error => { csrfSession = null; throw error; });
  }
  return csrfSession;
}

async function api(path, options = {}, retried = false) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) headers["X-Corpus-CSRF"] = await csrfToken();
  const response = await fetch(path, { ...options, headers });
  const body = await response.json().catch(() => ({}));
  // The server rejects an invalid token before it runs a mutation, so one
  // fresh-session retry is safe and avoids duplicating a completed request.
  if (!response.ok && response.status === 403 && body.code === "csrf_invalid" && !retried) {
    csrfSession = null;
    return api(path, options, true);
  }
  if (!response.ok) throw Object.assign(new Error(body.error || `Request failed (${response.status})`), { code: body.code });
  return body;
}

function toast(title, message = "", type = "success") {
  const item = node("div", `toast ${type}`, "");
  item.setAttribute("role", type === "error" ? "alert" : "status");
  add(item, node("span", "", type === "error" ? "!" : "✓"));
  const copy = node("div");
  add(copy, node("strong", "", title), message ? node("p", "", message) : null);
  item.append(copy);
  document.querySelector("#toast-region").append(item);
  window.setTimeout(() => item.remove(), 4800);
}

/** In-flight feedback. `:disabled` means unavailable; `.is-busy` means working. */
function setBusy(control, busy) {
  if (!control) return;
  control.disabled = Boolean(busy);
  control.classList.toggle("is-busy", Boolean(busy));
}

function templateById() { return templateMap(state?.exerciseTemplates || []); }
function unit() { return state?.settings?.unit || "kg"; }
/** Hevy's exercise type enum as a human label: `weight_reps` → "Weight & reps". */
function exerciseKind(type) {
  const parts = String(type || "exercise").split("_").filter(Boolean);
  const label = parts.length === 2 ? `${parts[0]} & ${parts[1]}` : parts.join(" ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function titleCase(value) { return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

function route() {
  const value = location.hash.slice(1).split("/")[0];
  return ["overview", "sessions", "programs", "proposals", "exercises", "metrics", "metrics-trends", "metrics-workouts", "supplements", "supplements-history", "settings"].includes(value) ? value : "overview";
}

/* ---------------------------------------------------------------- helpers */

/** The one view header: eyebrow → h1 → description, actions in `.view-actions`. */
function heading(eyebrow, title, description, ...actions) {
  const header = node("header", "view-header");
  const copy = node("div", "view-heading");
  add(copy, eyebrow ? node("p", "eyebrow", eyebrow) : null, node("h1", "", title), description ? node("p", "", description) : null);
  add(header, copy);
  const items = actions.flat().filter(Boolean);
  if (items.length) add(header, add(node("div", "view-actions"), items));
  return header;
}

function panelHeader(title, subtitle, extra) {
  const header = node("header", "panel-header");
  const copy = node("div");
  add(copy, node("h2", "", title), subtitle ? node("p", "", subtitle) : null);
  add(header, copy, extra);
  return header;
}

/** An in-page section title for content that is not inside a panel. */
function sectionHeading(title, subtitle, action) {
  const header = node("header", "section-heading");
  const copy = node("div");
  add(copy, node("h2", "", title), subtitle ? node("p", "", subtitle) : null);
  add(header, copy, action);
  return header;
}

function emptyState({ title, copy = "", icon = "○", action = null, compact = false } = {}) {
  const empty = node("div", compact ? "empty-state is-compact" : "empty-state");
  if (icon) {
    const glyph = node("span", "empty-state-icon", icon);
    glyph.setAttribute("aria-hidden", "true");
    empty.append(glyph);
  }
  add(empty, node("p", "empty-state-title", title), copy ? node("p", "", copy) : null, action);
  return empty;
}

/** `▲ 12 vs previous 12 weeks`, or a flat note when there is nothing to compare. */
function statDelta(change, format, decimals = 0) {
  if (change == null) return [node("span", "stat-delta flat", "no previous window")];
  const rounded = Number(Number(change).toFixed(decimals));
  if (rounded === 0) return [node("span", "stat-delta flat", `no change vs previous ${periodLabel(getPeriod())}`)];
  const up = rounded > 0;
  const span = node("span", `stat-delta ${up ? "up" : "down"}`);
  const glyph = node("span", "", up ? "▲" : "▼");
  glyph.setAttribute("aria-hidden", "true");
  add(span, glyph, node("span", "sr-only", up ? "Up" : "Down"), node("span", "", ` ${format(Math.abs(rounded))}`));
  return [span, document.createTextNode(` vs previous ${periodLabel(getPeriod())}`)];
}

function statCard(label, value, { change, format = (input) => formatNumber(input), decimals = 0, suffix = "" } = {}) {
  const card = add(node("article", "card stat-card"), node("p", "stat-label", label), node("p", "stat-value", value));
  if (change !== undefined || suffix) {
    const note = node("p", "stat-note");
    add(note, change === undefined ? null : statDelta(change, format, decimals), suffix ? document.createTextNode(`${change === undefined ? "" : " · "}${suffix}`) : null);
    card.append(note);
  }
  return card;
}

function miniMetric(label, value) {
  return add(node("div", "mini-metric"), node("span", "", label), node("strong", "", value));
}

/** The shared range picker; `onChange` defaults to a full re-render. */
function periodPicker(onChange) {
  const picker = node("div", "period-picker");
  picker.setAttribute("aria-label", "Date range");
  const current = getPeriod();
  for (const [value, label] of PERIODS) {
    const control = node("button", "", label);
    control.type = "button";
    control.dataset.period = value;
    control.setAttribute("aria-pressed", String(value === current));
    control.addEventListener("click", () => {
      if (getPeriod() === value) return;
      setPeriod(value);
      if (onChange) onChange(value); else render();
    });
    picker.append(control);
  }
  return picker;
}

/**
 * `label.field > span.field-label + control (+ p.field-hint)`. The control is
 * reachable as the label's native `.control` property.
 */
function field(label, {
  tag = "input", type = "text", value = "", placeholder = "", hint = "", required = false,
  options = null, rows = 0, maxLength = 0, name = "", autocomplete = "",
} = {}) {
  const wrapper = node("label", "field");
  add(wrapper, node("span", "field-label", label));
  const controlTag = options ? "select" : tag;
  const className = controlTag === "select" ? "select" : controlTag === "textarea" ? "textarea" : "input";
  const control = node(controlTag, className);
  if (controlTag === "input") control.type = type;
  if (options) {
    for (const option of options) {
      const entry = typeof option === "string" ? { value: option, label: option } : option;
      const element = node("option", "", entry.label ?? entry.title ?? entry.value);
      element.value = entry.value ?? entry.id ?? "";
      control.append(element);
    }
  }
  if (placeholder) control.placeholder = placeholder;
  if (required) control.required = true;
  if (rows) control.rows = rows;
  if (maxLength) control.maxLength = maxLength;
  if (name) control.name = name;
  if (autocomplete) control.autocomplete = autocomplete;
  if (value != null && value !== "") control.value = String(value);
  add(wrapper, control, hint ? node("p", "field-hint", hint) : null);
  return wrapper;
}

function button(label, { variant = "secondary", size = "", icon = "", onClick = null, type = "button", title = "" } = {}) {
  const classes = ["button", variant];
  if (size) classes.push(size);
  if (icon && !label) classes.push("icon");
  const control = node("button", classes.join(" "));
  control.type = type;
  if (icon) {
    const glyph = node("span", "icon", icon);
    glyph.setAttribute("aria-hidden", "true");
    control.append(glyph);
  }
  if (label) control.append(node("span", "", label));
  else if (title) control.setAttribute("aria-label", title);
  if (title) control.title = title;
  if (onClick) control.addEventListener("click", onClick);
  return control;
}

function settingsLink(text = "Open Settings", { asButton = false } = {}) {
  const link = node("a", asButton ? "button secondary" : "text-button", text);
  link.href = "#settings";
  return link;
}

/** The one demo marker, rendered by the router on every route (D9). */
function demoNotice() {
  const notice = node("div", "notice notice--demo");
  const icon = node("span", "notice-icon", "D");
  icon.setAttribute("aria-hidden", "true");
  const body = node("div", "notice-body");
  add(body, node("p", "", "You’re viewing demo data. Demo and live archives stay separate."));
  // On Settings the link would point at the page the user is already on.
  const action = route() === "settings" ? null : add(node("div", "notice-action"), settingsLink());
  return add(notice, icon, body, action);
}

/* ------------------------------------------------------------ global actions */

async function setMode(enableDemo, control = modeToggle) {
  setBusy(control, true);
  try {
    await api("/api/demo", { method: "POST", body: JSON.stringify({ enabled: enableDemo }) });
    invalidateMetrics();
    invalidateWorkoutMetrics();
    invalidateSupplementDoses();
    await loadState();
    const copy = MODE_COPY.toast[enableDemo ? "demo" : "live"];
    toast(copy.title, copy.body);
  } catch (error) {
    toast(MODE_COPY.error, error.message || "Please try again.", "error");
  } finally {
    setBusy(control, false);
  }
}

/** Syncs every connected source, then reports one toast (D1/D2). */
async function syncAll() {
  const hevy = Boolean(state?.settings?.hasApiKey);
  const google = Boolean(state?.settings?.googleHealth?.connected);
  if (!hevy && !google) {
    location.hash = "#settings";
    toast("Connect a data source", "Save your Hevy key or connect Google Health in Settings, then sync.");
    return;
  }
  setBusy(syncButton, true);
  const done = [];
  const warnings = [];
  let imported = 0;
  try {
    if (hevy) {
      try {
        await api("/api/sync", { method: "POST", body: "{}" });
        invalidateWorkoutMetrics();
        invalidateSupplementDoses();
        done.push("hevy");
      } catch (error) {
        toast("Couldn’t sync Hevy", error.message || "Please try again.", "error");
      }
    }
    if (google) {
      try {
        const result = await api("/api/metrics/sync", { method: "POST", body: "{}" });
        invalidateMetrics();
        invalidateWorkoutMetrics();
        invalidateSupplementDoses();
        imported = Number(result?.imported) || 0;
        warnings.push(...(Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : []));
        done.push("google");
      } catch (error) {
        toast("Couldn’t sync Google Health", error.message || "Please try again.", "error");
      }
    }
    await loadState();
    if (!done.length) return;
    const sources = [];
    if (done.includes("hevy")) sources.push(`Hevy: ${plural(state.workouts.length, "workout")}`);
    if (done.includes("google")) sources.push(`Google Health: ${plural(imported, "data point")}`);
    const extra = [...warnings];
    if (state.mode === "demo") extra.push("Switch to live data to see the changes.");
    toast("Sync complete", [sources.join(" · "), ...extra].filter(Boolean).join(" "));
  } finally {
    setBusy(syncButton, false);
  }
}

/* ------------------------------------------------------------------ overview */

function renderOverview() {
  const view = node("section", "view section-page");
  add(view, heading("Workout", "Overview", "Your training, in perspective.", periodPicker()));
  const map = templateById();
  const now = new Date();
  const span = analyticsPeriod(getPeriod());
  const displayUnit = unit();
  const summary = summarize(state.workouts, span, now, map);
  const previous = previousSummary(span, now, map);
  const change = (key) => (previous ? summary[key] - previous[key] : null);
  const volume = convertKg(summary.volumeKg, displayUnit) || 0;
  const previousVolume = previous ? convertKg(previous.volumeKg, displayUnit) || 0 : null;

  const stats = node("div", "stat-grid");
  add(stats,
    statCard("Workouts", formatNumber(summary.workouts), { change: change("workouts") }),
    statCard(`Training volume (${displayUnit}·reps)`, formatNumber(volume), { change: previous ? volume - previousVolume : null }),
    statCard("Weekly consistency", `${summary.consistency}%`, {
      change: change("consistency"),
      format: (value) => `${formatNumber(value)} pts`,
      suffix: `${summary.activeWeeks} of ${summary.totalWeeks} weeks active`,
    }),
    statCard("Time trained", formatDuration(summary.minutes), { change: change("minutes"), format: (value) => formatDuration(value) }),
  );
  view.append(programOverview(), stats);

  const filtered = filterByPeriod(state.workouts, span, now);
  const grid = node("div", "dashboard-grid");
  add(grid, volumePanel(map, span, now, displayUnit), progressPanel(filtered, map, displayUnit), recentPanel(filtered, map, displayUnit), musclePanel(filtered, map));
  view.append(grid);
  return view;
}

/**
 * The window immediately before the current one. Null for the full archive and
 * for an empty preceding window, which is a gap rather than a baseline.
 */
function previousSummary(span, now, map) {
  const start = periodStart(span, now);
  if (!start) return null;
  const previous = summarize(state.workouts, span, new Date(start.getTime() - 1), map);
  return previous.workouts ? previous : null;
}

function programOverview() {
  const panel = node("section", "panel program-overview");
  const link = node("a", "text-button", "Manage programs");
  link.href = "#programs";
  const now = new Date();
  const active = state.programs.filter((program) => programTimeline(program, now).status === "active");
  add(panel, panelHeader(active.length ? "Currently training" : "No active program", "Program dates and activity · independent of the dashboard date range", link));
  if (!active.length) {
    const next = state.programs.filter((program) => programTimeline(program, now).status === "upcoming").sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
    panel.append(node("p", "note", next ? `Up next: ${next.title}, starting ${formatDay(next.start_date)}.` : "Set a program’s start date and duration in Programs to follow your training block here."));
    return panel;
  }
  const grid = node("div", "card-grid");
  for (const program of active) {
    const card = node("article", "card program-card");
    const sessionsLink = node("a", "text-button", "View program sessions");
    sessionsLink.href = "#sessions";
    sessionsLink.addEventListener("click", () => { sessionProgram = program.id; sessionQuery = ""; sessionExercise = "all"; });
    add(card, node("h3", "card-title", program.title), renderProgramProgress(context(), program, now), sessionsLink);
    grid.append(card);
  }
  panel.append(grid);
  return panel;
}

function volumePanel(map, span, now, displayUnit) {
  const panel = node("section", "panel full-span");
  add(panel, panelHeader("Training volume & activity", "Weekly totals · warm-ups, bodyweight and cardio excluded from volume"));
  const series = weeklySeries(state.workouts, span, now, map);
  const points = series.map((point) => ({ date: localDateKey(point.start), value: convertKg(point.volumeKg, displayUnit) }));
  const counts = series.map((point) => point.workouts);
  const mount = node("div", "chart-mount");
  mountChart(mount, ({ compact }) => barChart({
    points,
    compact,
    label: `Weekly external-load volume in ${displayUnit}·reps and workout count`,
    seriesLabel: `Volume (${displayUnit}·reps)`,
    format: (value) => `${formatNumber(value)} ${displayUnit}·reps`,
    axisFormat: formatCompact,
    overlay: {
      values: counts,
      label: "Workouts",
      format: compact ? (value) => formatNumber(value) : (value) => plural(value, "workout"),
    },
    xLabel: (point) => formatDay(point.date),
    xLabels: compact ? 4 : 7,
  }));
  panel.append(mount);
  return panel;
}

function musclePanel(workouts, map) {
  const panel = node("section", "panel");
  add(panel, panelHeader("Muscle distribution", "Working sets by primary muscle group"));
  const muscles = muscleDistribution(workouts, map).slice(0, 6);
  if (!muscles.length) {
    panel.append(emptyState({ title: "No set data", copy: "Muscle distribution appears after a session is logged.", compact: true }));
    return panel;
  }
  const list = node("div", "muscle-list");
  const max = muscles[0].sets;
  for (const item of muscles) {
    const row = node("div", "muscle-row");
    const top = node("div", "muscle-row-top");
    add(top, node("span", "", titleCase(item.muscle)), node("span", "", plural(item.sets, "set")));
    const track = node("div", "track");
    const fill = node("span");
    fill.style.width = `${(item.sets / max) * 100}%`;
    track.append(fill);
    add(row, top, track);
    list.append(row);
  }
  panel.append(list);
  return panel;
}

function exerciseChoices(workouts = state.workouts) {
  const choices = new Map();
  for (const workout of workouts) {
    for (const exercise of workout.exercises || []) {
      const id = String(exercise.exercise_template_id || "");
      if (id && exercise.title) choices.set(id, exercise.title);
    }
  }
  return [...choices.entries()].map(([id, title]) => ({ id, title })).sort((a, b) => a.title.localeCompare(b.title));
}

function progressPanel(workouts, map, displayUnit) {
  const panel = node("section", "panel full-span");
  const choices = exerciseChoices(workouts);
  if (!choices.some((choice) => choice.id === selectedExerciseId)) selectedExerciseId = choices[0]?.id || "";
  const picker = choices.length
    ? field("Exercise", { options: choices.map((choice) => ({ value: choice.id, label: choice.title })), value: selectedExerciseId })
    : null;
  if (picker) picker.control.addEventListener("change", () => { selectedExerciseId = picker.control.value; render(); });
  add(panel, panelHeader("Exercise progress", "Best external load per session · warm-ups excluded", picker));
  if (!choices.length) {
    panel.append(emptyState({ title: "No exercise history", copy: "Exercise progress appears after a loaded exercise is logged.", compact: true }));
    return panel;
  }
  const entries = exerciseProgress(workouts, selectedExerciseId, map);
  if (!entries.length) {
    panel.append(emptyState({
      title: "No external-load sets",
      copy: "This exercise has no loaded working sets in the selected date range.",
      compact: true,
      action: button("Show all time", { onClick: () => { setPeriod("all"); render(); }, size: "sm" }),
    }));
    return panel;
  }
  const layout = node("div", "progress-layout");
  const metrics = node("div", "metric-stack");
  const best = Math.max(...entries.map((entry) => entry.bestKg));
  const total = entries.reduce((sum, entry) => sum + entry.volumeKg, 0);
  add(metrics,
    miniMetric(`Best load (${displayUnit})`, formatLoad(best, displayUnit)),
    miniMetric("Sessions", formatNumber(entries.length)),
    miniMetric(`Total volume (${displayUnit}·reps)`, formatNumber(convertKg(total, displayUnit))),
  );
  const points = entries.map((entry) => ({ date: localDateKey(entry.date), value: convertKg(entry.bestKg, displayUnit) }));
  const mount = node("div", "chart-mount");
  mountChart(mount, ({ compact }) => lineChart({
    points,
    compact,
    label: `Best external load per session in ${displayUnit}`,
    format: (value) => `${formatNumber(value, 1)} ${displayUnit}`,
    decimals: 1,
    xLabel: (point) => formatDay(point.date),
    xLabels: compact ? 3 : 6,
  }));
  add(layout, metrics, mount);
  panel.append(layout);
  return panel;
}

function recentPanel(workouts, map, displayUnit) {
  const panel = node("section", "panel");
  const link = node("a", "text-button", "View all sessions");
  link.href = "#sessions";
  add(panel, panelHeader("Recent sessions", "Your latest work in this date range", link));
  const recent = [...workouts].sort((a, b) => new Date(b.start_time) - new Date(a.start_time)).slice(0, 5);
  if (!recent.length) {
    panel.append(emptyState({
      title: "No recent sessions",
      copy: "Nothing was logged in this date range.",
      compact: true,
      action: button("Show all time", { onClick: () => { setPeriod("all"); render(); }, size: "sm" }),
    }));
    return panel;
  }
  const list = node("div", "recent-list");
  recent.forEach((workout) => list.append(sessionRow(workout, map, displayUnit)));
  panel.append(list);
  return panel;
}

function sessionProgramBadges(workout, detailed = false) {
  const programs = matchingPrograms(workout, state.programs);
  const badges = node("span", "program-badges");
  for (const program of programs) {
    const timeline = programTimeline(program, new Date(workout.start_time));
    const badge = node("span", "pill pill--neutral", `${program.title} · week ${timeline.currentWeek}`);
    badge.title = `Matched by routine and session date: ${formatDay(timeline.startDate)} – ${formatDay(timeline.endDate)}`;
    badges.append(badge);
  }
  if (!programs.length) badges.append(node("span", "note", "No program match"));
  if (!detailed) return badges;
  return add(node("div"), badges, node("p", "note", "Program matches use the selected routines and local session dates. Changing a program’s dates or routines recalculates these matches."));
}

function sessionRow(workout, map, displayUnit = unit()) {
  const control = node("button", "session-row");
  control.type = "button";
  const date = new Date(workout.start_time);
  const valid = !Number.isNaN(date.getTime());
  const dateBox = node("span", "session-date");
  add(dateBox, node("strong", "", valid ? date.getDate() : MISSING), node("span", "", valid ? dateLabel(date, { month: "short" }) : ""));
  const main = node("span", "session-main");
  const exerciseCount = workout.exercises?.length || 0;
  const setCount = (workout.exercises || []).reduce((sum, exercise) => sum + (exercise.sets?.length || 0), 0);
  add(main, node("strong", "", workout.title || "Untitled workout"), node("span", "", `${plural(exerciseCount, "exercise")} · ${plural(setCount, "set")}`));
  const badges = sessionProgramBadges(workout);
  main.append(badges);
  control.setAttribute("aria-label", `Open ${workout.title || "workout"} from ${dateLabel(workout.start_time, { dateStyle: "long" })}. ${badges.textContent}`);
  const meta = node("span", "session-meta");
  const volume = node("span");
  add(volume, node("strong", "", `${formatNumber(convertKg(workoutVolume(workout, map), displayUnit))} ${displayUnit}·reps`), document.createTextNode("volume"));
  const time = node("span");
  add(time, node("strong", "", formatDuration(durationMinutes(workout))), document.createTextNode("duration"));
  add(meta, volume, time);
  add(control, dateBox, main, meta, node("span", "session-arrow", "→"));
  control.addEventListener("click", () => showSession(workout));
  return control;
}

/* ------------------------------------------------------------------ sessions */

function renderSessions() {
  const view = node("section", "view section-page");
  add(view, heading("Workout", "Sessions", "Search every synced workout and open a session for its full set-by-set record.", periodPicker()));

  const panel = node("section", "panel");
  const header = panelHeader("Sessions", "…");
  const subtitle = header.querySelector("p");
  const results = node("div", "recent-list");
  const update = () => updateSessionResults(results, subtitle);

  const filters = node("div", "filters");
  const search = field("Search sessions", { type: "search", value: sessionQuery, placeholder: "Workout or exercise" });
  search.control.addEventListener("input", () => { sessionQuery = search.control.value; update(); });

  const exercise = field("Exercise", {
    options: [{ value: "all", label: "All exercises" }, ...exerciseChoices().map((choice) => ({ value: choice.id, label: choice.title }))],
    value: sessionExercise,
  });
  exercise.control.addEventListener("change", () => { sessionExercise = exercise.control.value; update(); });

  if (sessionProgram !== "all" && sessionProgram !== "none" && !state.programs.some((program) => program.id === sessionProgram)) sessionProgram = "all";
  const program = field("Program", {
    options: [{ value: "all", label: "All programs" }, { value: "none", label: "No program match" }, ...state.programs.map((item) => ({ value: item.id, label: item.title }))],
    value: sessionProgram,
  });
  program.control.addEventListener("change", () => { sessionProgram = program.control.value; update(); });

  add(filters, search, exercise, program);
  add(view, filters);
  add(panel, header, results);
  view.append(panel);
  update();
  return view;
}

function matchingSessions() {
  const query = sessionQuery.trim().toLocaleLowerCase();
  return filterByPeriod(state.workouts, analyticsPeriod(getPeriod()), new Date()).filter((workout) => {
    const matchesExercise = sessionExercise === "all" || (workout.exercises || []).some((exercise) => String(exercise.exercise_template_id) === sessionExercise);
    const programs = matchingPrograms(workout, state.programs);
    const matchesProgram = sessionProgram === "all" || (sessionProgram === "none" ? !programs.length : programs.some((program) => program.id === sessionProgram));
    const haystack = [workout.title, ...(workout.exercises || []).map((exercise) => exercise.title)].filter(Boolean).join(" ").toLocaleLowerCase();
    return matchesExercise && matchesProgram && (!query || haystack.includes(query));
  }).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
}

function updateSessionResults(results, subtitle) {
  const workouts = matchingSessions();
  subtitle.textContent = `${plural(workouts.length, "session")} in this range`;
  results.replaceChildren();
  if (!workouts.length) {
    results.append(emptyState({
      title: "No matching sessions",
      copy: "Try another search, another filter, or a wider date range.",
      icon: "⌕",
      action: getPeriod() === "all" ? null : button("Show all time", { onClick: () => { setPeriod("all"); render(); } }),
    }));
    return;
  }
  const map = templateById();
  const displayUnit = unit();
  workouts.forEach((workout) => results.append(sessionRow(workout, map, displayUnit)));
}

/* ------------------------------------------------------------------- dialogs */

function openDialog(eyebrow, title, content) {
  dialogEyebrow.textContent = eyebrow;
  dialogTitle.textContent = title;
  dialogBody.replaceChildren(content);
  dialog.showModal();
}

function setDisplay(set, displayUnit) {
  return [
    Number(set.weight_kg) > 0 ? formatLoad(set.weight_kg, displayUnit) : MISSING,
    set.reps != null ? formatNumber(set.reps) : MISSING,
    set.duration_seconds != null ? formatSeconds(set.duration_seconds) : MISSING,
    set.distance_meters != null ? formatNumber(set.distance_meters) : MISSING,
    set.rpe != null ? formatNumber(set.rpe, 1) : MISSING,
  ];
}

function showSession(workout) {
  const displayUnit = unit();
  const content = node("div", "dialog-stack");
  const meta = node("div", "detail-meta");
  const volume = add(node("div"), node("span", "", `External volume (${displayUnit}·reps)`), node("strong", "", formatNumber(convertKg(workoutVolume(workout, templateById()), displayUnit))));
  const duration = add(node("div"), node("span", "", "Duration"), node("strong", "", formatDuration(durationMinutes(workout))));
  const date = add(node("div"), node("span", "", "Started"), node("strong", "", formatDateTime(workout.start_time)));
  add(meta, date, duration, volume);
  add(content, meta, sessionProgramBadges(workout, true));
  // The dialog is built synchronously and `.dialog` has no width until it is
  // open, so the section is mounted here and only fetches once it is on screen.
  const metrics = workoutMetricsSection(context(), workout);
  content.append(metrics.element);
  for (const exercise of workout.exercises || []) {
    const section = node("section", "exercise-detail");
    add(section, node("h3", "card-title", exercise.title || "Untitled exercise"));
    if (exercise.notes) section.append(node("p", "exercise-note", exercise.notes));
    const table = node("table", "sets-table");
    const thead = node("thead"), headRow = node("tr");
    ["Set", `Load (${displayUnit})`, "Reps", "Time", "Distance (m)", "RPE"].forEach((label) => headRow.append(node("th", "", label)));
    thead.append(headRow);
    table.append(thead);
    const tbody = node("tbody");
    (exercise.sets || []).forEach((set, index) => {
      const row = node("tr");
      const first = node("td", "", String(index + 1));
      if (set.type && set.type !== "normal") first.append(node("span", "micro-tag", String(set.type).replaceAll("_", " ")));
      row.append(first);
      setDisplay(set, displayUnit).forEach((value) => row.append(node("td", "", value)));
      tbody.append(row);
    });
    table.append(tbody);
    section.append(table);
    content.append(section);
  }
  content.append(add(node("div", "dialog-actions"), button("Close", { onClick: () => dialog.close() })));
  openDialog("Session", workout.title || "Untitled workout", content);
  metrics.start();
}

/* ----------------------------------------------------------------- exercises */

function renderExercises() {
  const view = node("section", "view section-page");
  add(view, heading("Workout", "Exercises", "The exercise templates imported with your Hevy archive."));
  const filters = node("div", "filters");
  const search = field("Search exercises", { type: "search", placeholder: "Name, muscle or equipment" });
  add(filters, search);
  const count = node("p", "note");
  const grid = node("div", "card-grid");
  add(view, filters, count, grid);

  const update = () => {
    const query = search.control.value.trim().toLocaleLowerCase();
    const templates = state.exerciseTemplates.filter((item) => {
      const secondary = Array.isArray(item.secondary_muscle_groups) ? item.secondary_muscle_groups : [];
      const searchText = [item.title, item.primary_muscle_group, ...secondary, item.equipment]
        .filter(Boolean)
        .join(" ")
        .replaceAll("_", " ")
        .toLocaleLowerCase();
      return searchText.includes(query);
    });
    count.textContent = plural(templates.length, "exercise");
    grid.replaceChildren();
    if (!templates.length) {
      grid.append(emptyState({ title: "No matching exercises", copy: "Try a broader search.", icon: "⌕" }));
      return;
    }
    templates.forEach((item) => grid.append(exerciseCard(item)));
  };
  search.control.addEventListener("input", update);
  update();
  return view;
}

function exerciseCard(item) {
  const card = node("article", "card exercise-card");
  add(card, node("p", "label-caps", exerciseKind(item.type)), node("h3", "card-title", item.title || "Untitled exercise"));

  const secondary = Array.isArray(item.secondary_muscle_groups) ? item.secondary_muscle_groups : [];
  const muscles = [];
  const seen = new Set();
  [item.primary_muscle_group, ...secondary].forEach((muscle) => {
    const value = String(muscle || "").trim();
    const key = value.replaceAll("_", " ").toLocaleLowerCase();
    if (value && !seen.has(key)) { seen.add(key); muscles.push(value); }
  });
  const primary = String(item.primary_muscle_group || "").trim();
  const muscleTags = node("div", "exercise-tags");
  (muscles.length ? muscles : [NOT_SET]).forEach((muscle) => {
    const isPrimary = Boolean(primary) && muscle === primary;
    muscleTags.append(node("span", "pill pill--neutral", `${muscle === NOT_SET ? NOT_SET : titleCase(muscle)}${isPrimary ? " · Primary" : ""}`));
  });
  const equipmentTags = node("div", "exercise-tags");
  equipmentTags.append(node("span", "pill pill--neutral", item.equipment ? titleCase(item.equipment) : NOT_SET));
  add(card,
    add(node("div", "exercise-attribute"), node("p", "label-caps", "Muscle groups"), muscleTags),
    add(node("div", "exercise-attribute"), node("p", "label-caps", "Equipment"), equipmentTags),
  );
  return card;
}

/* -------------------------------------------------------------------- shell */

function context() {
  return {
    state,
    node,
    add,
    api,
    refresh: loadState,
    toast,
    openDialog,
    closeDialog: () => dialog.close(),
    heading,
    panelHeader,
    sectionHeading,
    emptyState,
    statCard,
    miniMetric,
    periodPicker,
    field,
    button,
    settingsLink,
    setBusy,
    demoNotice,
    setMode,
    syncAll,
    titleCase,
    sessionRow,
    showSession,
    format: {
      MISSING, NOT_SET, NEVER_SYNCED, MISSING_ROUTINE,
      formatNumber, formatCompact, formatDuration, formatSeconds, formatDay,
      formatDateTime, dateLabel, formatLoad, formatSet, convertKg, plural,
      formatElapsed, formatBpm,
    },
    period: {
      list: PERIODS,
      get: getPeriod,
      set: setPeriod,
      label: periodLabel,
      days: periodDays,
      weeks: periodWeeks,
      analytics: analyticsPeriod,
    },
  };
}

function updateChrome() {
  const live = state.mode === "live";
  const mode = live ? "live" : "demo";
  modeBadge.classList.toggle("live", live);
  modeBadge.replaceChildren(node("span"), document.createTextNode(MODE_COPY.badge[mode]));
  modeToggle.hidden = false;
  modeToggle.textContent = MODE_COPY.toggle[mode];
  const connected = Boolean(state.settings?.hasApiKey) || Boolean(state.settings?.googleHealth?.connected);
  if (syncButton) syncButton.title = connected ? "Sync your connected data sources" : "Connect a data source in Settings to sync";
  const current = route();
  document.querySelectorAll("[data-route]").forEach((link) => {
    const active = link.dataset.route === current;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  document.querySelectorAll(".nav-group").forEach((group) => { if (group.querySelector(`[data-route="${current}"]`)) group.open = true; });
  const badge = document.querySelector("#proposals-badge");
  const count = pendingCount(state.proposals || []);
  if (badge) { badge.textContent = count ? String(count) : ""; badge.hidden = !count; }
}

function syncProposalPolling() {
  const focused = typeof document.hasFocus !== "function" || document.hasFocus();
  const active = route() === "proposals" && (document.visibilityState !== "hidden" || focused);
  if (active && !proposalPollTimer) proposalPollTimer = window.setInterval(() => {
    const currentProfile = document.querySelector(".proposals-view .profile-form");
    if (currentProfile && (currentProfile.dataset.dirty === "true" || currentProfile.contains(document.activeElement))) return;
    loadState().catch(() => {});
  }, 15000);
  if (!active && proposalPollTimer) { window.clearInterval(proposalPollTimer); proposalPollTimer = null; }
}

function render() {
  if (!state) return;
  const current = route();
  updateChrome();
  let view;
  switch (current) {
    case "sessions": view = renderSessions(); break;
    case "programs": view = renderProgramsModule(context()); break;
    case "proposals": view = renderProposals(context()); break;
    case "exercises": view = renderExercises(); break;
    case "metrics": view = renderMetricsDashboard(context()); break;
    case "metrics-trends": view = renderMetricsTrends(context()); break;
    case "metrics-workouts": view = renderMetricsWorkouts(context()); break;
    case "supplements": view = renderSupplements(context()); break;
    case "supplements-history": view = renderSupplementsHistory(context()); break;
    case "settings": view = renderSettingsModule(context()); break;
    default: view = renderOverview();
  }
  // The view transition belongs to a route change, not to an in-page filter.
  if (current !== lastRoute) view.classList.add("is-entering");
  lastRoute = current;
  root.replaceChildren(view);
  if (state.mode === "demo") {
    const header = view.querySelector(".view-header");
    if (header) header.after(demoNotice()); else view.prepend(demoNotice());
  }
  root.hidden = false;
  loading.hidden = true;
  closeMenu();
  syncProposalPolling();
}

async function loadState() {
  const previousMode = state?.mode;
  state = await api("/api/state");
  if (previousMode && previousMode !== state.mode) {
    selectedExerciseId = "";
    sessionExercise = "all";
    sessionProgram = "all";
  }
  state.workouts ||= [];
  state.routines ||= [];
  state.exerciseTemplates ||= [];
  state.programs ||= [];
  state.proposals ||= [];
  state.trainingProfile ||= { goals: "", equipment: "", constraints: "", schedule: "" };
  state.settings ||= { unit: "kg", hasApiKey: false, lastSync: null };
  state.settings.googleHealth ||= { hasClient: false, connected: false, lastSync: null };
  render();
  return state;
}

function closeMenu() {
  document.body.classList.remove("menu-open");
  menuButton.setAttribute("aria-expanded", "false");
  scrim.hidden = true;
}

menuButton.addEventListener("click", () => {
  const open = !document.body.classList.contains("menu-open");
  document.body.classList.toggle("menu-open", open);
  menuButton.setAttribute("aria-expanded", String(open));
  scrim.hidden = !open;
});
scrim.addEventListener("click", closeMenu);
window.addEventListener("hashchange", render);
window.addEventListener("focus", syncProposalPolling);
document.addEventListener("visibilitychange", syncProposalPolling);
document.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
dialog.addEventListener("close", () => dialogBody.replaceChildren());

syncButton?.addEventListener("click", () => { syncAll(); });
modeToggle.addEventListener("click", () => { setMode(state.mode !== "demo"); });

function startup() {
  return loadState().catch((error) => {
    loading.hidden = false;
    loading.replaceChildren(emptyState({
      title: "Corpus couldn’t load",
      copy: error.message || "Check that the local server is running.",
      icon: "!",
      action: button("Try again", { variant: "primary", onClick: () => { loading.replaceChildren(node("span", "loader"), node("p", "", "Opening your training archive…")); startup(); } }),
    }));
    toast("Couldn’t load your archive", error.message || "Check that the local server is running.", "error");
  });
}

if (!location.hash) history.replaceState(null, "", "#overview");
startup();
