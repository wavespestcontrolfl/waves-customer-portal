'use strict';

const { PROJECT_TYPES } = require('../services/project-types');
const { SPECIALTY_SERVICE_CLOSEOUTS } = require('../../shared/specialty-service-closeouts');
const AREA_SCOPES = require('../../shared/treatment-area-scopes.json');
const { treatmentScope } = require('../services/service-report/report-data');

const AREA_FIELD_KEYS = ['areas_treated', 'spot_treatment_areas', 'treatment_zones'];

function controlledAreaLabels() {
  const labels = new Set();
  for (const def of Object.values(PROJECT_TYPES)) {
    for (const field of def.findingsFields || []) {
      if (AREA_FIELD_KEYS.includes(field.key)) (field.options || []).forEach((option) => labels.add(option));
    }
  }
  for (const spec of Object.values(SPECIALTY_SERVICE_CLOSEOUTS)) spec.areas.forEach((area) => labels.add(area));
  return [...labels].sort();
}

const scopeOf = (label) => treatmentScope({ service: { areas_serviced: JSON.stringify([label]) } });

describe('treatment-area scope vocabulary', () => {
  test('every controlled treatment-area label carries exactly one explicit scope', () => {
    const lists = ['interior', 'exterior', 'unscoped'];
    const missing = controlledAreaLabels().filter((label) => (
      lists.filter((list) => AREA_SCOPES[list].includes(label)).length !== 1
    ));
    expect(missing).toEqual([]);
  });

  test('scope lists do not overlap', () => {
    const all = [...AREA_SCOPES.interior, ...AREA_SCOPES.exterior, ...AREA_SCOPES.unscoped];
    expect(new Set(all).size).toBe(all.length);
  });

  test.each(AREA_SCOPES.interior)('%s alone fires only the interior scope', (label) => {
    expect(scopeOf(label)).toMatchObject({ hasInterior: true, hasExterior: false, hasLocationSignal: true });
  });

  test.each(AREA_SCOPES.exterior)('%s alone fires only the exterior scope', (label) => {
    expect(scopeOf(label)).toMatchObject({ hasInterior: false, hasExterior: true, hasLocationSignal: true });
  });

  test.each(AREA_SCOPES.unscoped)('%s alone leaves scope undetermined on a mixed line and never counts as explicit scope', (label) => {
    expect(scopeOf(label)).toMatchObject({ hasInterior: false, hasExterior: false, hasLocationSignal: false, hasExplicitScope: false });
    expect(treatmentScope({ service: { service_type: 'Termite Treatment', areas_serviced: JSON.stringify([label]) } }))
      .toMatchObject({ hasInterior: false, hasExterior: false, hasExplicitScope: false });
  });

  test.each(AREA_SCOPES.unscoped)('%s is exterior on outdoor-only lines', (label) => {
    for (const serviceType of ['One-Time Lawn Treatment', 'Mosquito Event Treatment', 'Tree & Shrub Care', 'Palm Injection']) {
      expect(treatmentScope({ service: { service_type: serviceType, areas_serviced: JSON.stringify([label]) } }))
        .toMatchObject({ hasInterior: false, hasExterior: true, hasExplicitScope: true });
    }
  });

  test('explicit scope wins over heuristics for labels that mention both sides', () => {
    expect(scopeOf('Garage / slab edge')).toMatchObject({ hasInterior: false, hasExterior: true });
    expect(scopeOf('Interior entry points')).toMatchObject({ hasInterior: true, hasExterior: false });
    expect(scopeOf('Patio / outdoor furniture areas')).toMatchObject({ hasInterior: false, hasExterior: true });
  });

  test('free text still classifies through the heuristics', () => {
    expect(scopeOf('Treated inside the kitchen cabinets')).toMatchObject({ hasInterior: true, hasExterior: false });
    expect(scopeOf('Along the foundation perimeter')).toMatchObject({ hasInterior: false, hasExterior: true });
  });
});
