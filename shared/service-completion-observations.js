const catalog = require('./service-completion-observations.json');

const EMPTY_OBSERVATIONS = new Set();
const ROUTINE_SERVICE_OBSERVATIONS = Object.freeze(Object.fromEntries(
  Object.entries(catalog).map(([family, rows]) => [
    family,
    new Set(rows.map(([, label]) => label)),
  ]),
));

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
  return null;
}

module.exports = {
  ROUTINE_SERVICE_OBSERVATIONS,
  observationsForRoutineService,
  conflictingRoutineObservations,
};
