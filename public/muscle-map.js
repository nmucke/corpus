import { MAPPED_MUSCLES, buildMuscleCoverage } from './muscle-coverage.js';
import { BACK_REGIONS, BODY_PATHS, FRONT_REGIONS } from './body-anatomy.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const MAPPED = new Set(MAPPED_MUSCLES);

function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  return element;
}

function intensity(value) {
  if (value <= 0) return 0;
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value <= 4) return 3;
  return 4;
}

function plural(value, singular, pluralWord = `${singular}s`) {
  return `${value} ${value === 1 ? singular : pluralWord}`;
}

function metricWords(metric) {
  return metric === 'sets' ? ['working set', 'working sets'] : ['exercise entry', 'exercise entries'];
}

function measure(muscle, metric, includeSecondary) {
  const primary = metric === 'sets' ? muscle.primarySets : muscle.primaryExercises;
  const secondary = metric === 'sets' ? muscle.secondarySets : muscle.secondaryExercises;
  return { primary, secondary, total: primary + (includeSecondary ? secondary : 0) };
}

function muscleMap(side, muscles, metric, includeSecondary, selectedId, choose) {
  const regions = side === 'front' ? FRONT_REGIONS : BACK_REGIONS;
  const svg = svgElement('svg', { class: 'body-map-svg', 'data-side': side, viewBox: '0 0 180 365', role: 'group', 'aria-label': `${side === 'front' ? 'Front' : 'Back'} body map. Choose a muscle in the map or list for exercise details.` });
  const title = svgElement('title'); title.textContent = `${side === 'front' ? 'Front' : 'Back'} body coverage map`; svg.append(title);
  const silhouette = svgElement('g', { class: 'body-silhouette', 'aria-hidden': 'true' });
  silhouette.append(
    svgElement('ellipse', { cx: 90, cy: 25, rx: 17, ry: 21 }),
    ...BODY_PATHS.map(attributes => svgElement('path', attributes)),
  );
  svg.append(silhouette);
  for (const [id, paths] of Object.entries(regions)) {
    const muscle = muscles.get(id);
    const value = measure(muscle, metric, includeSecondary).total;
    const label = `${muscle.label}: ${plural(value, ...metricWords(metric))}${includeSecondary ? ', including secondary targets' : ', primary targets only'}`;
    const group = svgElement('g', { class: `muscle-region${selectedId === id ? ' is-selected' : ''}`, 'data-muscle': id, 'data-intensity': String(intensity(value)), tabindex: '0', role: 'button', 'aria-pressed': String(selectedId === id), 'aria-label': label });
    const groupTitle = svgElement('title'); groupTitle.textContent = label; group.append(groupTitle);
    paths.forEach(attributes => group.append(svgElement('path', attributes)));
    group.addEventListener('click', () => choose(id, `map-${side}`));
    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(id, `map-${side}`); }
    });
    svg.append(group);
  }
  return svg;
}

function appendText(parent, ctx, tag, className, text) {
  parent.append(ctx.node(tag, className, text));
}

/** Open coverage for one routine or for one pass through every program day. */
export function openMuscleCoverage(ctx, { routine, program } = {}) {
  const { state, node, add, openDialog } = ctx;
  const coverage = buildMuscleCoverage({ routine, program, routines: state.routines, exerciseTemplates: state.exerciseTemplates });
  const isProgram = coverage.scope === 'program';
  const scopeName = isProgram ? 'program' : 'routine';
  const scopeTitle = isProgram ? (program?.title || 'Untitled program') : (routine?.title || 'Untitled routine');
  const content = node('section', 'muscle-coverage');
  const lead = node('div', 'coverage-intro');
  const passLabel = isProgram ? `One pass through ${plural(coverage.dayCount, 'program day')}` : 'One saved routine';
  add(lead,
    node('p', 'coverage-scope', scopeTitle),
    node('p', 'coverage-context', `${passLabel} · ${plural(coverage.exerciseCount, 'exercise entry', 'exercise entries')} · ${plural(coverage.workingSetCount, 'working set')}`),
    node('p', 'coverage-note', 'Counts show planned exercise and set coverage, not physiological activation.'),
  );
  content.append(lead);

  const controls = node('div', 'coverage-controls');
  const metricLabel = node('label', 'field coverage-metric');
  const metric = node('select', 'select'); metric.setAttribute('aria-label', 'Coverage metric');
  for (const [value, label] of [['exercises', 'Exercises'], ['sets', 'Working sets']]) {
    const option = node('option', '', label); option.value = value; metric.append(option);
  }
  add(metricLabel, node('span', '', 'Measure'), metric);
  const secondaryLabel = node('label', 'coverage-checkbox');
  const secondary = node('input'); secondary.type = 'checkbox';
  add(secondaryLabel, secondary, node('span', '', 'Include secondary muscles'));
  add(controls, metricLabel, secondaryLabel); content.append(controls);
  const targetNote = node('p', 'coverage-target-note'); content.append(targetNote);

  const status = node('div', 'coverage-status');
  if (coverage.missingRoutineCount) appendText(status, ctx, 'p', 'coverage-warning', `${plural(coverage.missingRoutineCount, 'selected program day')} ${coverage.missingRoutineCount === 1 ? 'uses' : 'use'} a routine that is no longer available. Its coverage cannot be shown.`);
  if (coverage.missingTemplateCount) appendText(status, ctx, 'p', 'coverage-warning', `${plural(coverage.missingTemplateCount, 'exercise entry', 'exercise entries')} ${coverage.missingTemplateCount === 1 ? 'has' : 'have'} no matching imported exercise template. ${coverage.missingTemplateCount === 1 ? 'It is' : 'They are'} included in totals but have no muscle target.`);
  if (coverage.missingMuscleCount) appendText(status, ctx, 'p', 'coverage-warning', `${plural(coverage.missingMuscleCount, 'exercise entry', 'exercise entries')} ${coverage.missingMuscleCount === 1 ? 'uses' : 'use'} an imported template with no muscle target. ${coverage.missingMuscleCount === 1 ? 'It is' : 'They are'} included in totals but have no muscle target.`);
  if (status.childElementCount) content.append(status);

  const visual = node('div', 'coverage-results'); content.append(visual);
  let selectedId = coverage.muscles.find(muscle => muscle.primaryExercises || muscle.secondaryExercises)?.id || MAPPED_MUSCLES[0];
  let countsOpen = false;

  const refresh = (focusTarget = '') => {
    if (typeof focusTarget !== 'string') focusTarget = '';
    const metricId = metric.value === 'sets' ? 'sets' : 'exercises';
    const includeSecondary = secondary.checked;
    const muscles = new Map(coverage.muscles.map(muscle => [muscle.id, muscle]));
    const mappedWithWork = MAPPED_MUSCLES.some(id => measure(muscles.get(id), metricId, includeSecondary).total > 0);
    const choose = (id, source) => { selectedId = id; refresh(source); };
    targetNote.textContent = `${includeSecondary ? 'Primary and secondary targets' : 'Primary targets only'} · Select a muscle to see its exercises.`;
    visual.replaceChildren();
    const figures = node('div', 'coverage-figures');
    const front = node('figure', 'coverage-figure'); add(front, muscleMap('front', muscles, metricId, includeSecondary, selectedId, choose), node('figcaption', '', 'Front'));
    const back = node('figure', 'coverage-figure'); add(back, muscleMap('back', muscles, metricId, includeSecondary, selectedId, choose), node('figcaption', '', 'Back'));
    add(figures, front, back); visual.append(figures);
    const legend = node('div', 'coverage-legend'); legend.setAttribute('aria-label', `Coverage intensity by ${metricId === 'sets' ? 'working sets' : 'exercise entries'}`);
    legend.append(node('span', 'coverage-legend-label', 'Lower → higher'));
    for (const [bucket, label] of [['0', '0'], ['1', '1'], ['2', '2'], ['3', '3–4'], ['4', '5+']]) {
      const item = node('span', 'coverage-legend-item'); item.dataset.intensity = bucket; add(item, node('i'), node('span', '', label)); legend.append(item);
    }
    visual.append(legend);
    if (!mappedWithWork) appendText(visual, ctx, 'p', 'coverage-empty', `No mapped muscles have ${metricId === 'sets' ? 'working sets' : 'exercise entries'} in this view. Try including secondary muscles or changing the measure.`);
    const words = metricWords(metricId);
    const notDrawn = coverage.muscles.filter(muscle => !MAPPED.has(muscle.id) && (muscle.primaryExercises || muscle.secondaryExercises));
    if (notDrawn.length) {
      const items = notDrawn.map(muscle => {
        const value = measure(muscle, metricId, includeSecondary);
        return `${muscle.label} (${value.primary} primary · ${value.secondary} secondary ${words[1]})`;
      });
      appendText(visual, ctx, 'p', 'coverage-unmapped-summary', `Not drawn on the body map: ${items.join(' · ')}.`);
    }

    const current = muscles.get(selectedId);
    const details = node('section', 'coverage-details');
    const exact = metricId === 'sets'
      ? `${plural(current.primaryExercises, 'primary exercise entry', 'primary exercise entries')} · ${plural(current.secondaryExercises, 'secondary exercise entry', 'secondary exercise entries')} · ${current.primarySets} primary and ${current.secondarySets} secondary working sets`
      : `${plural(current.primaryExercises, 'primary exercise entry', 'primary exercise entries')} · ${plural(current.secondaryExercises, 'secondary exercise entry', 'secondary exercise entries')}`;
    add(details, node('h3', '', `${current.label} details`), node('p', 'coverage-detail-total', exact));
    if (!current.contributions.length) {
      appendText(details, ctx, 'p', 'field-hint', `No planned exercise entries list ${current.label.toLowerCase()} as a target in this ${scopeName}.`);
    } else {
      const contributionList = node('ol', 'coverage-contributions');
      for (const item of current.contributions) {
        const entry = node('li');
        const location = isProgram ? `${item.routineTitle} · ${item.dayLabel}` : item.routineTitle;
        add(entry, node('strong', '', item.exerciseTitle), node('span', '', `${item.role === 'primary' ? 'Primary' : 'Secondary'} · ${location} · ${plural(item.sets, 'working set')}`));
        contributionList.append(entry);
      }
      details.append(contributionList);
    }
    visual.append(details);

    const counts = node('details', 'coverage-counts'); counts.open = countsOpen;
    const countsSummary = node('summary', '', 'All muscle counts'); counts.append(countsSummary);
    counts.addEventListener('toggle', () => { if (counts.isConnected) countsOpen = counts.open; });
    const rows = node('div', 'coverage-muscle-list');
    for (const muscle of coverage.muscles) {
      const value = measure(muscle, metricId, includeSecondary);
      const row = node('button', `coverage-muscle-row${selectedId === muscle.id ? ' is-selected' : ''}`); row.type = 'button';
      row.setAttribute('aria-pressed', String(selectedId === muscle.id));
      row.setAttribute('aria-label', `Show ${muscle.label} exercise details`);
      const label = node('span', 'coverage-muscle-name', muscle.label);
      if (!MAPPED.has(muscle.id)) label.append(node('small', 'coverage-unmapped', 'Unmapped'));
      const numbers = node('span', 'coverage-muscle-count', `${value.primary} primary · ${value.secondary} secondary ${words[1]}`);
      row.dataset.muscle = muscle.id;
      add(row, label, numbers); row.addEventListener('click', () => choose(muscle.id, 'list')); rows.append(row);
    }
    counts.append(rows); visual.append(counts);
    if (focusTarget === 'list') visual.querySelector(`.coverage-muscle-row[data-muscle="${CSS.escape(selectedId)}"]`)?.focus();
    if (focusTarget.startsWith('map-')) visual.querySelector(`.body-map-svg[data-side="${focusTarget.slice(4)}"] .muscle-region[data-muscle="${CSS.escape(selectedId)}"]`)?.focus();
  };
  metric.addEventListener('change', () => refresh());
  secondary.addEventListener('change', () => refresh());
  refresh();
  openDialog(isProgram ? 'Program coverage' : 'Routine coverage', 'Muscle coverage', content);
}
