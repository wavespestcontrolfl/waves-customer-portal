const catalog = require('./service-completion-observations.json');

const EMPTY_OBSERVATIONS = new Set();
const ROUTINE_SERVICE_OBSERVATIONS = Object.freeze(Object.fromEntries(
  Object.entries(catalog).map(([family, rows]) => [
    family,
    new Set(rows.map(([, label]) => label)),
  ]),
));

// These rows explicitly describe a visible plant symptom, damage, or decline.
// Pest signs/presence, surface roots, nearby fungal growth, soil
// and irrigation conditions can coexist with a plant with no visible stress.
const TREE_SHRUB_VISIBLE_STRESS_IDS = new Set([
  'yellow-foliage',
  'discolored-foliage',
  'leaf-spots',
  'leaf-chewing',
  'distorted-growth',
  'premature-leaf-drop',
  'sparse-canopy',
  'branch-dieback',
  'deadwood',
  'wilted-foliage',
  'sticky-sooty-coating',
  'trunk-damage',
  'bark-cracking',
  'frond-discoloration',
  'dead-fronds',
  'abnormal-new-growth',
]);

function observationsForRoutineService(family) {
  return Object.prototype.hasOwnProperty.call(ROUTINE_SERVICE_OBSERVATIONS, family)
    ? ROUTINE_SERVICE_OBSERVATIONS[family]
    : EMPTY_OBSERVATIONS;
}

function conflictingRoutineObservations(observations = []) {
  const selected = new Set(observations);
  for (const scope of ['interior', 'exterior']) {
    const labels = catalog.recurring_pest
      .filter(([id]) => id === `no-live-${scope}` || id === `live-${scope}`)
      .map(([, label]) => label);
    if (labels.every((label) => selected.has(label))) {
      return `Choose either no visible activity or visible activity for the inspected ${scope} areas.`;
    }
  }
  const trends = catalog.recurring_pest
    .filter(([id]) => id === 'activity-reduced' || id === 'activity-increased')
    .map(([, label]) => label);
  if (trends.every((label) => selected.has(label))) {
    return 'Choose either reduced or increased activity compared with the previous documented visit.';
  }
  const noVisiblePlantStress = catalog.tree_shrub.find(([id]) => id === 'no-visible-stress')?.[1];
  const visiblePlantStress = catalog.tree_shrub
    .filter(([id]) => TREE_SHRUB_VISIBLE_STRESS_IDS.has(id))
    .find(([, label]) => selected.has(label));
  if (selected.has(noVisiblePlantStress) && visiblePlantStress) {
    return 'Choose either no visible plant stress or a visible plant stress or symptom finding for the inspected plants.';
  }
  return null;
}

module.exports = {
  ROUTINE_SERVICE_OBSERVATIONS,
  observationsForRoutineService,
  conflictingRoutineObservations,
};
