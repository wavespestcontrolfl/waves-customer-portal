const catalog = require('./service-completion-observations.json');
const lawnCatalog = require('./lawn-condition-findings.json');

const EMPTY_OBSERVATIONS = new Set();
const STRUCTURED_OBSERVATION_FINDING_DETAIL = 'Recorded during the structured service closeout.';
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

const LAWN_DEFINITE_LIVE_PEST_LABELS = new Set([
  'Chinch bugs — observed',
  'Tropical sod webworms',
  'Armyworms',
  'White grubs',
  'Mole crickets',
  'Fire ants',
  'Turf scale or mealybugs',
]);
const LAWN_PEST_OBSERVATION_SCOPE = new Map();
const lawnPestFindings = lawnCatalog.groups
  .flatMap(({ findings }) => findings)
  .filter(({ label }) => label === 'No live pests detected' || LAWN_DEFINITE_LIVE_PEST_LABELS.has(label));
for (const { label, statement } of lawnPestFindings) {
  for (const location of lawnCatalog.locations) {
    for (const extent of ['', ...lawnCatalog.extents]) {
      const observation = `${statement} Location: ${location}.${extent ? ` Extent: ${extent}.` : ''}`;
      LAWN_PEST_OBSERVATION_SCOPE.set(observation, {
        location,
        state: label === 'No live pests detected' ? 'absent' : 'present',
      });
    }
  }
}
const routineLiveLawnPests = catalog.lawn.find(([id]) => id === 'live-pests')?.[1];
LAWN_PEST_OBSERVATION_SCOPE.set(routineLiveLawnPests, { location: null, state: 'present' });

function observationsForRoutineService(family) {
  return Object.prototype.hasOwnProperty.call(ROUTINE_SERVICE_OBSERVATIONS, family)
    ? ROUTINE_SERVICE_OBSERVATIONS[family]
    : EMPTY_OBSERVATIONS;
}

function conflictingRoutineObservations(observations = [], { treeShrubLandscapeCondition = null } = {}) {
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
  if (selected.has(noVisiblePlantStress) && ['Poor', 'Declining'].includes(treeShrubLandscapeCondition)) {
    return 'Choose a plant-stress finding when the overall landscape condition is poor or declining.';
  }
  const lawnPestStates = observations
    .map((observation) => LAWN_PEST_OBSERVATION_SCOPE.get(observation))
    .filter(Boolean);
  const noLiveLawnPests = lawnPestStates.filter(({ state }) => state === 'absent');
  const liveLawnPests = lawnPestStates.filter(({ state }) => state === 'present');
  const throughout = 'Throughout inspected lawn';
  if (noLiveLawnPests.some(({ location: noLiveLocation }) => liveLawnPests.some(({ location: liveLocation }) => (
    noLiveLocation === throughout
      || liveLocation === throughout
      || (liveLocation && liveLocation === noLiveLocation)
  )))) {
    return 'Choose either no live lawn pests or a live lawn-pest finding for the same inspected area.';
  }
  return null;
}

module.exports = {
  ROUTINE_SERVICE_OBSERVATIONS,
  STRUCTURED_OBSERVATION_FINDING_DETAIL,
  observationsForRoutineService,
  conflictingRoutineObservations,
};
