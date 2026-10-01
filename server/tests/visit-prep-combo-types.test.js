/**
 * visit-prep-combo-types.js + the read SHAPE (visit-prep-plant-applicability.js
 * readShapeForTypes) — which stops are combined Lawn & Pest visits (owner
 * ruling 2026-09-30). The labels are the real combined service_type names the
 * catalog / estimates / seeds produce.
 */
const { comboSubjectForType, isComboServiceType } = require('../services/visit-prep-combo-types');
const { readShapeForTypes, plantSubjectForTypes } = require('../services/visit-prep-plant-applicability');
const { hasPestPart } = require('../services/visit-prep-pest-applicability');
const { keyForShape } = require('../services/visit-prep-read-key');

describe('comboSubjectForType', () => {
  test.each([
    'Quarterly Pest Control Service + Lawn Care Service',
    'Recurring Pest Control + Recurring Lawn Care',
    'Quarterly Pest Control + Lawn',
    'Lawn Care + Pest Control',
    'General Pest Control + Lawn Care',
    'Pest Control + Lawn Care',
    'Pest + Lawn',
    'Pest & Lawn',
    'Pest and Lawn',
    'Lawn & Pest Program',
    'Lawn and Pest Control Assessment',
    'lawn_and_pest_program',
    'Quarterly Lawn Care Service + Bed Bug Treatment Service + Pest Control Service',
    'Palmetto Roach Pest Control + Lawn Care',
  ])('%s -> lawn', (label) => {
    expect(comboSubjectForType(label)).toBe('lawn');
    expect(isComboServiceType(label)).toBe(true);
  });

  test.each([
    'Pest + Tree & Shrub',
    'Pest Control Service + Tree & Shrub Care',
    'Ornamental Care & Pest Control',
  ])('%s -> tree_shrub', (label) => {
    expect(comboSubjectForType(label)).toBe('tree_shrub');
  });

  test.each([
    // single-line services
    'Quarterly Pest Control Service',
    'Lawn Care Service',
    'Tree & Shrub Care',
    'Lawn Pest Control',
    'lawn_pest_control',
    'Tree & Shrub Pest Control',
    // combos that include an excluded line are NOT lawn + pest combos
    'Pest & Mosquito',
    'Pest + Termite',
    'Pest + Rodent',
    'Lawn Care + Rodent Exclusion',
    'Pest + Lawn + Mosquito',
    'Pest + Lawn + Termite Bait',
    'Pest + Lawn + WDO Inspection',
    'Pest + Palm Injection',
    'Lawn + Palm Care',
    'Mosquito Control Service',
    'WDO Inspection',
    'Termite Bait Monitoring',
    'Waves Assessment',
    '',
    null,
  ])('%s is not a combo', (label) => {
    expect(comboSubjectForType(label)).toBeNull();
    expect(isComboServiceType(label)).toBe(false);
  });
});

describe('read shape and key', () => {
  const BOTH = { pestLive: true, plantLive: true };
  const shapeKey = (types, live = BOTH) => keyForShape(readShapeForTypes(types), live);

  test('a combined label has both a pest part and a plant subject', () => {
    expect(readShapeForTypes(['Lawn Care + Pest Control'])).toEqual({ pest: true, plantSubject: 'lawn' });
    expect(hasPestPart('Lawn Care + Pest Control')).toBe(true);
  });

  test('(b) separate pest-only and lawn-only members have both parts too', () => {
    expect(readShapeForTypes(['Quarterly Pest Control Service', 'Weekly Lawn Care'])).toEqual({ pest: true, plantSubject: 'lawn' });
  });

  test('a pest member no longer hides the plant subject', () => {
    expect(plantSubjectForTypes(['Quarterly Pest Control Service', 'Quarterly Tree & Shrub Care'])).toBe('tree_shrub');
  });

  test('lawn wins over tree & shrub when both are present', () => {
    expect(plantSubjectForTypes(['Quarterly Tree & Shrub Care', 'Lawn Care + Pest Control'])).toBe('lawn');
  });

  test.each([
    [['Lawn Care + Pest Control'], BOTH, 'combo:lawn'],
    [['Lawn Care + Pest Control'], { pestLive: true, plantLive: false }, 'pest'],
    [['Lawn Care + Pest Control'], { pestLive: false, plantLive: true }, 'plant:lawn'],
    [['Lawn Care + Pest Control'], { pestLive: false, plantLive: false }, null],
    [['Quarterly Pest Control Service', 'Weekly Lawn Care'], BOTH, 'combo:lawn'],
    [['Quarterly Pest Control Service', 'Weekly Lawn Care'], { pestLive: true, plantLive: false }, 'pest'],
    [['Quarterly Pest Control Service', 'Weekly Lawn Care'], { pestLive: false, plantLive: true }, 'plant:lawn'],
    [['Quarterly Pest Control Service'], BOTH, 'pest'],
    [['Weekly Lawn Care'], BOTH, 'plant:lawn'],
    [['Quarterly Tree & Shrub Care'], BOTH, 'plant:tree_shrub'],
    [['Pest & Mosquito'], BOTH, null],
    [['Quarterly Pest Control Service', 'Mosquito Control Service'], BOTH, 'pest'],
    [['Weekly Lawn Care', 'Termite Inspection'], BOTH, 'plant:lawn'],
    [[], BOTH, null],
  ])('%j with %j -> %s', (types, live, key) => {
    expect(shapeKey(types, live)).toBe(key);
  });
});
