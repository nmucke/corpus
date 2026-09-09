import {
  durationMinutes,
  exerciseProgress,
  filterByPeriod,
  muscleDistribution,
  summarize,
  templateMap,
  weeklySeries,
  workoutVolume,
} from "./analytics.js";
import { renderPrograms as renderProgramsModule, renderProgramProgress } from "./programs.js";
import { matchingPrograms, programTimeline } from "./program-timeline.js";
import { pendingCount, renderProposals } from "./proposals.js";
import { renderSettings as renderSettingsModule } from "./settings.js";

const root = document.querySelector("#view-root");
const loading = document.querySelector("#loading-view");
const dialog = document.querySelector("#app-dialog");
const dialogBody = document.querySelector("#dialog-body");
const dialogTitle = document.querySelector("#dialog-title");
const dialogEyebrow = document.querySelector("#dialog-eyebrow");
const modeBadge = document.querySelector("#mode-badge");
const modeToggle = document.querySelector("#mode-toggle");
const syncButton = document.querySelector("#sync-button");
const exportButton = document.querySelector("#export-button");
const menuButton = document.querySelector("#menu-button");
const scrim = document.querySelector("#mobile-scrim");

let state = null;
let period = "8";
let selectedExerciseId = "";
let sessionQuery = "";
let sessionExercise = "all";
let sessionProgram = "all";
let csrfSession = null;
let proposalPollTimer = null;

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

function setBusy(button, busy) {
  button.disabled = busy;
  button.classList.toggle("syncing", busy);
}

function templateById() { return templateMap(state?.exerciseTemplates || []); }
function unit() { return state?.settings?.unit || "kg"; }
function convertKg(value) { return unit() === "lb" ? value * 2.2046226218 : value; }
function formatNumber(value, digits = 0) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(value || 0);
}
function formatVolume(kg) {
  const value = convertKg(kg);
  if (value >= 1000000) return `${formatNumber(value / 1000000, 1)}m`;
  if (value >= 1000) return `${formatNumber(value / 1000, 1)}k`;
  return formatNumber(value);
}
function formatDuration(minutes) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}
function dateLabel(value, options = { month: "short", day: "numeric" }) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown date" : new Intl.DateTimeFormat(undefined, options).format(date);
}
function route() {
  const value = location.hash.slice(1).split("/")[0];
  return ["overview", "sessions", "programs", "proposals", "exercises", "settings"].includes(value) ? value : "overview";
}

function heading(eyebrow, title, description, action) {
  const header = node("header", "view-header");
  const copy = node("div", "view-heading");
  add(copy, node("p", "eyebrow", eyebrow), node("h1", "", title), description ? node("p", "", description) : null);
  add(header, copy, action);
  return header;
}

function periodPicker() {
  const picker = node("div", "period-picker");
  picker.setAttribute("aria-label", "Date range");
  for (const [value, label] of [["4", "4 weeks"], ["8", "8 weeks"], ["12", "12 weeks"], ["all", "All"]]) {
    const button = node("button", "", label);
    button.type = "button";
    button.dataset.period = value;
    button.setAttribute("aria-pressed", String(value === period));
    button.addEventListener("click", () => { period = value; render(); });
    picker.append(button);
  }
  return picker;
}

function emptyState(title, copy, icon = "○") {
  const empty = node("div", "empty-state");
  add(empty, node("div", "empty-state-icon", icon), node("h2", "", title), node("p", "", copy));
  return empty;
}

function statCard(label, value, note) {
  return add(node("article", "stat-card"), node("p", "stat-label", label), node("p", "stat-value", value), node("p", "stat-note", note));
}

function demoBanner() {
  if (state.mode !== "demo") return null;
  const banner = node("div", "demo-banner");
  add(banner, node("span", "demo-banner-icon", "D"));
  const copy = node("p");
  add(copy, node("strong", "", "You’re viewing demo training data. "), document.createTextNode("Connect your Hevy account in Settings whenever you’re ready."));
  const link = node("a", "text-button", "Open settings");
  link.href = "#settings";
  add(banner, copy, link);
  return banner;
}

function renderOverview() {
  const view = node("section", "view overview-view");
  add(view, heading("Training overview", "Your training, in perspective.", "A clear view of the work you’ve put in — and where it’s taking you.", periodPicker()), demoBanner());
  const map = templateById();
  const summary = summarize(state.workouts, period, new Date(), map);
  const rangeLabel = period === "all" ? "across your full archive" : `in the last ${period} weeks`;
  const stats = node("div", "stat-grid");
  add(stats,
    statCard("Workouts", formatNumber(summary.workouts), rangeLabel),
    statCard("Training volume", formatVolume(summary.volumeKg), `${unit()}·reps · working sets`),
    statCard("Weekly consistency", `${summary.consistency}%`, `${summary.activeWeeks} of ${summary.totalWeeks} weeks active`),
    statCard("Time trained", formatDuration(summary.minutes), rangeLabel),
  );
  view.append(programOverview(), stats);
  const filtered = filterByPeriod(state.workouts, period, new Date());
  const grid = node("div", "dashboard-grid");
  grid.append(volumePanel(map), musclePanel(filtered, map), progressPanel(filtered, map), recentPanel(filtered, map));
  view.append(grid);
  return view;
}

function programOverview() {
  const panel = node("section", "panel program-overview");
  const link = node("a", "text-button", "Manage programs"); link.href = "#programs";
  const now = new Date();
  const active = state.programs.filter(program => programTimeline(program, now).status === "active");
  add(panel, panelHeader(active.length ? "Currently training" : "No active program", "Program dates and activity · independent of the dashboard date range", link));
  if (!active.length) {
    const next = state.programs.filter(program => programTimeline(program, now).status === "upcoming").sort((a, b) => a.start_date.localeCompare(b.start_date))[0];
    panel.append(node("p", "field-hint", next ? `Up next: ${next.title}, starting ${next.start_date}.` : "Set a program’s start date and duration in Programs to follow your training block here."));
    return panel;
  }
  const grid = node("div", "program-grid");
  for (const program of active) {
    const card = node("article", "program-card");
    const sessionsLink = node("a", "text-button", "View program sessions"); sessionsLink.href = "#sessions";
    sessionsLink.addEventListener("click", () => { sessionProgram = program.id; sessionQuery = ""; sessionExercise = "all"; });
    add(card, node("h2", "", program.title), renderProgramProgress(context(), program, now), sessionsLink);
    grid.append(card);
  }
  panel.append(grid);
  return panel;
}

function sessionProgramBadges(workout, detailed = false) {
  const programs = matchingPrograms(workout, state.programs);
  const badges = node("span", "program-badges");
  for (const program of programs) {
    const timeline = programTimeline(program, new Date(workout.start_time));
    const badge = node("span", "program-badge", `${program.title} · week ${timeline.currentWeek}`);
    badge.title = `Matched by routine and session date: ${timeline.startDate} – ${timeline.endDate}`;
    badges.append(badge);
  }
  if (!programs.length) badges.append(node("span", "field-hint", "No program match"));
  if (!detailed) return badges;
  return add(node("div"), badges, node("p", "field-hint", "Program matches use the selected routines and local session dates. Changing a program’s dates or routines recalculates these matches."));
}

function panelHeader(title, subtitle, extra) {
  const header = node("header", "panel-header");
  const copy = node("div");
  add(copy, node("h2", "", title), node("p", "", subtitle));
  add(header, copy, extra);
  return header;
}

function volumePanel(map) {
  const panel = node("section", "panel full-span");
  const legend = node("div", "chart-legend");
  const a = node("span"); add(a, node("i"), document.createTextNode(`Volume (${unit()}·reps)`));
  const b = node("span"); add(b, node("i"), document.createTextNode("Workouts"));
  add(legend, a, b);
  add(panel, panelHeader("Training volume & activity", "Weekly totals · warm-ups, bodyweight and cardio excluded from volume", legend));
  const series = weeklySeries(state.workouts, period, new Date(), map);
  panel.append(buildChart(series));
  return panel;
}

function svgEl(tag, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function buildChart(series) {
  const wrap = node("div", "chart-wrap");
  if (!series.length || !series.some((point) => point.workouts)) {
    wrap.append(emptyState("No sessions in this range", "Sync or choose a wider date range to see your training rhythm.", "↗"));
    return wrap;
  }
  const width = 760, height = 250, left = 48, right = 22, top = 18, bottom = 34;
  const plotW = width - left - right, plotH = height - top - bottom;
  const values = series.map((point) => convertKg(point.volumeKg));
  const maxVolume = Math.max(...values, 1);
  const maxWorkouts = Math.max(...series.map((point) => point.workouts), 1);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `Weekly external-load volume in ${unit()} repetitions and workout count` });
  const title = svgEl("title"); title.textContent = "Weekly training volume and workout activity"; svg.append(title);
  for (let i = 0; i <= 4; i++) {
    const y = top + (plotH / 4) * i;
    svg.append(svgEl("line", { x1: left, y1: y, x2: width - right, y2: y, class: "chart-grid-line" }));
    const label = svgEl("text", { x: left - 9, y: y + 3, class: "chart-axis", "text-anchor": "end" });
    label.textContent = formatVolume(maxVolume * (1 - i / 4) / (unit() === "lb" ? 2.2046226218 : 1));
    svg.append(label);
  }
  const countTop = svgEl("text", { x: width - right + 8, y: top + 3, class: "chart-axis", "text-anchor": "start" });
  countTop.textContent = `${maxWorkouts} workouts`; svg.append(countTop);
  const countBottom = svgEl("text", { x: width - right + 8, y: top + plotH + 3, class: "chart-axis", "text-anchor": "start" });
  countBottom.textContent = "0"; svg.append(countBottom);
  const slot = plotW / series.length;
  const barW = Math.min(31, slot * .52);
  const points = [];
  series.forEach((point, index) => {
    const x = left + index * slot + slot / 2;
    const barH = (values[index] / maxVolume) * plotH;
    const bar = svgEl("rect", { x: x - barW / 2, y: top + plotH - barH, width: barW, height: Math.max(0, barH), rx: 4, class: "chart-bar" });
    const barTitle = svgEl("title"); barTitle.textContent = `${dateLabel(point.start)}: ${formatNumber(values[index])} ${unit()}·reps`; bar.append(barTitle); svg.append(bar);
    const dotY = top + plotH - (point.workouts / maxWorkouts) * plotH;
    points.push(`${x},${dotY}`);
    if (index % Math.ceil(series.length / 7) === 0 || index === series.length - 1) {
      const label = svgEl("text", { x, y: height - 10, class: "chart-axis", "text-anchor": "middle" });
      label.textContent = dateLabel(point.start); svg.append(label);
    }
  });
  svg.append(svgEl("polyline", { points: points.join(" "), class: "chart-line" }));
  series.forEach((point, index) => {
    const [x, y] = points[index].split(",");
    const dot = svgEl("circle", { cx: x, cy: y, r: 4, class: "chart-dot" });
    const dotTitle = svgEl("title"); dotTitle.textContent = `${point.workouts} workout${point.workouts === 1 ? "" : "s"}`; dot.append(dotTitle); svg.append(dot);
  });
  wrap.append(svg);
  return wrap;
}

function musclePanel(workouts, map) {
  const panel = node("section", "panel");
  add(panel, panelHeader("Muscle distribution", "Working sets by primary muscle group"));
  const muscles = muscleDistribution(workouts, map).slice(0, 6);
  if (!muscles.length) { panel.append(emptyState("No set data", "Muscle distribution appears after a session is logged.")); return panel; }
  const list = node("div", "muscle-list");
  const max = muscles[0].sets;
  for (const item of muscles) {
    const row = node("div", "muscle-row");
    const top = node("div", "muscle-row-top"); add(top, node("span", "", titleCase(item.muscle)), node("span", "", `${item.sets} sets`));
    const track = node("div", "track"); const fill = node("span"); fill.style.width = `${(item.sets / max) * 100}%`; track.append(fill);
    add(row, top, track); list.append(row);
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

function progressPanel(workouts, map) {
  const panel = node("section", "panel progress-panel");
  const choices = exerciseChoices(workouts);
  if (!choices.some((choice) => choice.id === selectedExerciseId)) selectedExerciseId = choices[0]?.id || "";
  const select = node("select", "select");
  select.setAttribute("aria-label", "Exercise for progress chart");
  for (const choice of choices) {
    const option = node("option", "", choice.title); option.value = choice.id; option.selected = choice.id === selectedExerciseId; select.append(option);
  }
  select.addEventListener("change", () => { selectedExerciseId = select.value; render(); });
  add(panel, panelHeader("Exercise progress", "Best external load per session · warm-ups excluded", choices.length ? select : null));
  if (!choices.length) { panel.append(emptyState("No exercise history", "Exercise progress appears after a loaded exercise is logged.")); return panel; }
  const entries = exerciseProgress(workouts, selectedExerciseId, map);
  if (!entries.length) { panel.append(emptyState("No external-load sets", "This exercise has no loaded working sets in the selected date range.")); return panel; }
  const layout = node("div", "progress-layout");
  const metrics = node("div", "metric-stack");
  const best = Math.max(...entries.map((entry) => entry.bestKg));
  const total = entries.reduce((sum, entry) => sum + entry.volumeKg, 0);
  add(metrics,
    miniMetric("Best load", `${formatNumber(convertKg(best), 1)} ${unit()}`),
    miniMetric("Sessions", formatNumber(entries.length)),
    miniMetric("Total volume", `${formatVolume(total)} ${unit()}·reps`),
  );
  add(layout, metrics, progressChart(entries)); panel.append(layout);
  return panel;
}

function miniMetric(label, value) {
  return add(node("div", "mini-metric"), node("span", "", label), node("strong", "", value));
}

function progressChart(entries) {
  const wrap = node("div", "chart-wrap");
  const width = 560, height = 190, left = 20, right = 20, top = 17, bottom = 29;
  const values = entries.map((entry) => convertKg(entry.bestKg));
  const min = Math.min(...values), max = Math.max(...values);
  const spread = Math.max(max - min, max * .1, 1);
  const pointX = (index) => entries.length === 1 ? width / 2 : left + index * ((width - left - right) / (entries.length - 1));
  const pointY = (value) => top + (1 - (value - (min - spread * .2)) / (spread * 1.4)) * (height - top - bottom);
  const points = values.map((value, index) => `${pointX(index)},${pointY(value)}`);
  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, role: "img", "aria-label": `Best external load trend in ${unit()}` });
  for (let i = 0; i < 3; i++) svg.append(svgEl("line", { x1: left, x2: width - right, y1: top + i * 60, y2: top + i * 60, class: "chart-grid-line" }));
  svg.append(svgEl("polyline", { points: points.join(" "), class: "chart-line" }));
  entries.forEach((entry, index) => {
    const dot = svgEl("circle", { cx: pointX(index), cy: pointY(values[index]), r: 5, class: "chart-dot" });
    const title = svgEl("title"); title.textContent = `${dateLabel(entry.date)}: ${formatNumber(values[index], 1)} ${unit()}`; dot.append(title); svg.append(dot);
    if (index === 0 || index === entries.length - 1) {
      const label = svgEl("text", { x: pointX(index), y: height - 7, class: "chart-axis", "text-anchor": index ? "end" : "start" });
      label.textContent = dateLabel(entry.date); svg.append(label);
    }
  });
  wrap.append(svg); return wrap;
}

function recentPanel(workouts, map) {
  const panel = node("section", "panel progress-panel");
  const link = node("a", "text-button", "View all sessions"); link.href = "#sessions";
  add(panel, panelHeader("Recent sessions", "Your latest work in this date range", link));
  const recent = [...workouts].sort((a, b) => new Date(b.start_time) - new Date(a.start_time)).slice(0, 5);
  if (!recent.length) { panel.append(emptyState("No recent sessions", "Try a wider date range or sync your Hevy archive.")); return panel; }
  const list = node("div", "recent-list"); recent.forEach((workout) => list.append(sessionRow(workout, map))); panel.append(list);
  return panel;
}

function sessionRow(workout, map) {
  const button = node("button", "session-row"); button.type = "button";
  button.setAttribute("aria-label", `Open ${workout.title || "workout"} from ${dateLabel(workout.start_time, { dateStyle: "long" })}`);
  const date = new Date(workout.start_time);
  const dateBox = node("span", "session-date"); add(dateBox, node("strong", "", Number.isNaN(date.getTime()) ? "—" : date.getDate()), node("span", "", Number.isNaN(date.getTime()) ? "" : dateLabel(date, { month: "short" })));
  const main = node("span", "session-main");
  const exerciseCount = workout.exercises?.length || 0;
  const setCount = (workout.exercises || []).reduce((sum, exercise) => sum + (exercise.sets?.length || 0), 0);
  add(main, node("strong", "", workout.title || "Untitled workout"), node("span", "", `${exerciseCount} exercises · ${setCount} sets`));
  main.append(sessionProgramBadges(workout));
  button.setAttribute("aria-label", `${button.getAttribute("aria-label")}. ${main.lastChild.textContent}`);
  const meta = node("span", "session-meta");
  const volume = node("span"); add(volume, node("strong", "", `${formatVolume(workoutVolume(workout, map))} ${unit()}·reps`), document.createTextNode("volume"));
  const time = node("span"); add(time, node("strong", "", formatDuration(durationMinutes(workout))), document.createTextNode("duration"));
  add(meta, volume, time);
  add(button, dateBox, main, meta, node("span", "session-arrow", "→"));
  button.addEventListener("click", () => showSession(workout));
  return button;
}

function renderSessions() {
  const view = node("section", "view section-page");
  add(view, heading("Training log", "Sessions", "Search every synced workout and open a session for its full set-by-set record."));
  const filters = node("div", "filters session-filters");
  const searchField = node("div", "field search-field");
  const searchLabel = node("label", "", "Search sessions"); searchLabel.htmlFor = "session-search"; searchField.append(searchLabel);
  const search = node("input", "input"); search.id = "session-search"; search.type = "search"; search.placeholder = "Workout or exercise"; search.value = sessionQuery;
  search.addEventListener("input", () => { sessionQuery = search.value; updateSessionResults(results, count); }); searchField.append(search);
  const exerciseField = node("div", "field"); const exerciseLabel = node("label", "", "Exercise"); exerciseLabel.htmlFor = "session-exercise"; exerciseField.append(exerciseLabel);
  const select = node("select", "select"); select.id = "session-exercise"; const any = node("option", "", "All exercises"); any.value = "all"; select.append(any);
  exerciseChoices().forEach((choice) => { const option = node("option", "", choice.title); option.value = choice.id; option.selected = choice.id === sessionExercise; select.append(option); });
  select.addEventListener("change", () => { sessionExercise = select.value; updateSessionResults(results, count); }); exerciseField.append(select);
  const programField = node("div", "field"); const programLabel = node("label", "", "Program"); programLabel.htmlFor = "session-program";
  const programSelect = node("select", "select"); programSelect.id = "session-program";
  if (sessionProgram !== "all" && sessionProgram !== "none" && !state.programs.some(program => program.id === sessionProgram)) sessionProgram = "all";
  for (const choice of [{ id: "all", title: "All programs" }, { id: "none", title: "No program match" }, ...state.programs]) {
    const option = node("option", "", choice.title); option.value = choice.id; option.selected = choice.id === sessionProgram; programSelect.append(option);
  }
  programSelect.addEventListener("change", () => { sessionProgram = programSelect.value; updateSessionResults(results, count); });
  add(programField, programLabel, programSelect);
  add(filters, searchField, exerciseField, programField); view.append(filters);
  const count = node("p", "result-count"); const results = node("div", "panel recent-list"); add(view, count, results); updateSessionResults(results, count);
  return view;
}

function matchingSessions() {
  const query = sessionQuery.trim().toLocaleLowerCase();
  return [...state.workouts].filter((workout) => {
    const matchesExercise = sessionExercise === "all" || (workout.exercises || []).some((exercise) => String(exercise.exercise_template_id) === sessionExercise);
    const programs = matchingPrograms(workout, state.programs);
    const matchesProgram = sessionProgram === "all" || (sessionProgram === "none" ? !programs.length : programs.some(program => program.id === sessionProgram));
    const haystack = [workout.title, ...(workout.exercises || []).map((exercise) => exercise.title)].filter(Boolean).join(" ").toLocaleLowerCase();
    return matchesExercise && matchesProgram && (!query || haystack.includes(query));
  }).sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
}

function updateSessionResults(results, count) {
  const workouts = matchingSessions(); count.textContent = `${workouts.length} session${workouts.length === 1 ? "" : "s"}`; results.replaceChildren();
  if (!workouts.length) { results.append(emptyState("No matching sessions", "Try another search or exercise filter.", "⌕")); return; }
  const map = templateById(); workouts.forEach((workout) => results.append(sessionRow(workout, map)));
}

function openDialog(eyebrow, title, content) {
  dialogEyebrow.textContent = eyebrow; dialogTitle.textContent = title; dialogBody.replaceChildren(content); dialog.showModal();
}

function setDisplay(set) {
  const cells = [];
  const weight = Number(set.weight_kg);
  cells.push(Number.isFinite(weight) && weight > 0 ? `${formatNumber(convertKg(weight), 1)} ${unit()}` : "—");
  cells.push(set.reps != null && Number.isFinite(Number(set.reps)) ? String(set.reps) : "—");
  cells.push(set.duration_seconds != null && Number.isFinite(Number(set.duration_seconds)) ? formatDuration(Math.round(set.duration_seconds / 60)) : "—");
  cells.push(set.distance_meters != null && Number.isFinite(Number(set.distance_meters)) ? `${formatNumber(set.distance_meters)} m` : "—");
  cells.push(set.rpe != null && Number.isFinite(Number(set.rpe)) ? String(set.rpe) : "—");
  return cells;
}

function showSession(workout) {
  const content = node("div"); const meta = node("div", "detail-meta");
  const volume = add(node("div"), node("span", "", "External volume"), node("strong", "", `${formatVolume(workoutVolume(workout, templateById()))} ${unit()}·reps`));
  const duration = add(node("div"), node("span", "", "Duration"), node("strong", "", formatDuration(durationMinutes(workout))));
  const date = add(node("div"), node("span", "", "Started"), node("strong", "", dateLabel(workout.start_time, { dateStyle: "medium", timeStyle: "short" })));
  add(meta, date, duration, volume); add(content, meta, sessionProgramBadges(workout, true));
  for (const exercise of workout.exercises || []) {
    const section = node("section", "exercise-detail"); add(section, node("h3", "", exercise.title || "Untitled exercise"));
    if (exercise.notes) section.append(node("p", "exercise-note", exercise.notes));
    const table = node("table", "sets-table");
    const thead = node("thead"), hr = node("tr"); ["Set", "Load", "Reps", "Time", "Distance", "RPE"].forEach((label) => hr.append(node("th", "", label))); thead.append(hr); table.append(thead);
    const tbody = node("tbody");
    (exercise.sets || []).forEach((set, index) => {
      const row = node("tr"); const first = node("td", "", String(index + 1)); if (set.type && set.type !== "normal") first.append(node("span", "set-type", set.type)); row.append(first);
      setDisplay(set).forEach((value) => row.append(node("td", "", value))); tbody.append(row);
    });
    table.append(tbody); section.append(table); content.append(section);
  }
  openDialog("Session detail", workout.title || "Untitled workout", content);
}

function renderExercises() {
  const view = node("section", "view section-page");
  add(view, heading("Movement library", "Exercises", "The exercise templates imported with your Hevy archive."));
  const searchWrap = node("div", "filters"); const searchField = node("div", "field search-field"); const label = node("label", "", "Search exercises"); label.htmlFor = "exercise-search"; searchField.append(label);
  const search = node("input", "input"); search.id = "exercise-search"; search.type = "search"; search.placeholder = "Name, muscle or equipment"; searchField.append(search); searchWrap.append(searchField); view.append(searchWrap);
  const count = node("p", "result-count"); const grid = node("div", "exercise-grid"); add(view, count, grid);
  const update = () => {
    const query = search.value.trim().toLocaleLowerCase();
    const templates = state.exerciseTemplates.filter((item) => {
      const secondary = Array.isArray(item.secondary_muscle_groups) ? item.secondary_muscle_groups : [];
      const searchText = [item.title, item.primary_muscle_group, ...secondary, item.equipment]
        .filter(Boolean)
        .join(" ")
        .replaceAll("_", " ")
        .toLocaleLowerCase();
      return searchText.includes(query);
    });
    count.textContent = `${templates.length} exercise${templates.length === 1 ? "" : "s"}`; grid.replaceChildren();
    if (!templates.length) { grid.append(emptyState("No matching exercises", "Try a broader search.", "⌕")); return; }
    templates.forEach((item) => {
      const card = node("article", "exercise-card");
      add(card, node("p", "card-kicker", String(item.type || "exercise").replaceAll("_", " ")), node("h2", "", item.title || "Untitled exercise"));

      const secondary = Array.isArray(item.secondary_muscle_groups) ? item.secondary_muscle_groups : [];
      const muscles = [];
      const seenMuscles = new Set();
      [item.primary_muscle_group, ...secondary].forEach((muscle) => {
        const value = String(muscle || "").trim();
        const key = value.replaceAll("_", " ").toLocaleLowerCase();
        if (value && !seenMuscles.has(key)) { seenMuscles.add(key); muscles.push(value); }
      });
      const muscleTags = node("div", "exercise-tags");
      const primaryMuscle = String(item.primary_muscle_group || "").trim();
      (muscles.length ? muscles : ["Not specified"]).forEach((muscle) => {
        const isPrimary = Boolean(primaryMuscle) && muscle === primaryMuscle;
        muscleTags.append(node("span", isPrimary ? "tag primary-muscle" : "tag", `${titleCase(muscle)}${isPrimary ? " · Primary" : ""}`));
      });
      const muscleGroup = node("div", "exercise-attribute");
      add(muscleGroup, node("p", "exercise-label", "Muscle groups"), muscleTags);

      const equipmentTags = node("div", "exercise-tags");
      equipmentTags.append(node("span", "tag", item.equipment ? titleCase(item.equipment) : "Not specified"));
      const equipmentGroup = node("div", "exercise-attribute");
      add(equipmentGroup, node("p", "exercise-label", "Equipment"), equipmentTags);
      card.append(muscleGroup, equipmentGroup); grid.append(card);
    });
  };
  search.addEventListener("input", update); update(); return view;
}

function titleCase(value) { return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }

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
  };
}

function updateChrome() {
  const live = state.mode === "live";
  modeBadge.classList.toggle("live", live);
  modeBadge.replaceChildren(node("span"), document.createTextNode(live ? "Live Hevy data" : "Demo data"));
  modeToggle.hidden = false;
  modeToggle.textContent = live ? "View demo" : "Use my data";
  syncButton.disabled = false;
  syncButton.title = state.settings.hasApiKey ? "Sync your Hevy archive" : "Add your Hevy API key in Settings to sync";
  document.querySelectorAll("[data-route]").forEach((link) => link.classList.toggle("is-active", link.dataset.route === route()));
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
  updateChrome();
  let view;
  switch (route()) {
    case "sessions": view = renderSessions(); break;
    case "programs": view = renderProgramsModule(context()); break;
    case "proposals": view = renderProposals(context()); break;
    case "exercises": view = renderExercises(); break;
    case "settings": view = renderSettingsModule(context()); break;
    default: view = renderOverview();
  }
  root.replaceChildren(view);
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

syncButton.addEventListener("click", async () => {
  if (!state.settings.hasApiKey) {
    location.hash = "#settings";
    toast("Add your Hevy API key", "Save it locally in Settings before syncing.", "error");
    return;
  }
  setBusy(syncButton, true);
  try { await api("/api/sync", { method: "POST", body: "{}" }); await loadState(); toast("Hevy sync complete", "Your local archive is up to date."); }
  catch (error) { toast("Hevy sync failed", error.message, "error"); }
  finally { setBusy(syncButton, false); }
});

exportButton.addEventListener("click", async () => {
  setBusy(exportButton, true);
  try {
    const result = await api("/api/export", { method: "POST", body: "{}" });
    const files = Array.isArray(result.files) ? result.files : [];
    toast("Markdown export ready", files.length ? `${files.length} file${files.length === 1 ? "" : "s"} written locally.` : "Export completed.");
  } catch (error) { toast("Export failed", error.message, "error"); }
  finally { setBusy(exportButton, false); }
});

modeToggle.addEventListener("click", async () => {
  const enableDemo = state.mode !== "demo";
  setBusy(modeToggle, true);
  try { await api("/api/demo", { method: "POST", body: JSON.stringify({ enabled: enableDemo }) }); await loadState(); toast(enableDemo ? "Demo mode on" : "Live mode on", enableDemo ? "You’re viewing sample training data." : "Your local Hevy archive is active."); }
  catch (error) { toast("Couldn’t switch data mode", error.message, "error"); }
  finally { setBusy(modeToggle, false); }
});

if (!location.hash) history.replaceState(null, "", "#overview");
loadState().catch((error) => {
  loading.replaceChildren(emptyState("Corpus couldn’t load", error.message || "Check that the local server is running.", "!"));
  toast("Couldn’t load your archive", error.message, "error");
});
