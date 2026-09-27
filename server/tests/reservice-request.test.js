/**
 * server/services/reservice-request.js — the re-service picker's pest-chip
 * choice lists and the two pure helpers that normalize a posted selection
 * and render its labels.
 */
const { RESERVICE_PEST_CHOICES, normalizeRequestPests, pestLabels } = require('../services/reservice-request');

describe('RESERVICE_PEST_CHOICES', () => {
  test('exposes exactly the pest and lawn lanes, frozen, in the specified order', () => {
    expect(Object.isFrozen(RESERVICE_PEST_CHOICES)).toBe(true);
    expect(Object.isFrozen(RESERVICE_PEST_CHOICES.pest)).toBe(true);
    expect(RESERVICE_PEST_CHOICES.pest.map((c) => c.key)).toEqual(['ants', 'roaches', 'spiders', 'wasps', 'other']);
    expect(RESERVICE_PEST_CHOICES.lawn.map((c) => c.key)).toEqual(['weeds', 'lawn_insects', 'brown_patches', 'other']);
    expect(RESERVICE_PEST_CHOICES.pest.find((c) => c.key === 'ants').label).toBe('Ants');
    expect(RESERVICE_PEST_CHOICES.lawn.find((c) => c.key === 'brown_patches').label).toBe('Brown or dead patches');
  });
});

describe('normalizeRequestPests', () => {
  test('de-dupes and returns keys in canonical order regardless of input order', () => {
    expect(normalizeRequestPests(['wasps', 'ants', 'ants', 'roaches'], 'pest'))
      .toEqual(['ants', 'roaches', 'wasps']);
  });

  test('drops invalid keys and keys from the other lane', () => {
    expect(normalizeRequestPests(['ants', 'weeds', 'made_up'], 'pest')).toEqual(['ants']);
    expect(normalizeRequestPests(['weeds', 'ants'], 'lawn')).toEqual(['weeds']);
  });

  test('ignores non-string entries inside an otherwise valid array', () => {
    expect(normalizeRequestPests(['ants', 42, null, { key: 'roaches' }], 'pest')).toEqual(['ants']);
  });

  test('returns null when nothing valid survives', () => {
    expect(normalizeRequestPests([], 'pest')).toBeNull();
    expect(normalizeRequestPests(['made_up'], 'pest')).toBeNull();
    expect(normalizeRequestPests(['ants'], 'lawn')).toBeNull();
  });

  test('ignores anything that is not an array', () => {
    expect(normalizeRequestPests('ants', 'pest')).toBeNull();
    expect(normalizeRequestPests(null, 'pest')).toBeNull();
    expect(normalizeRequestPests(undefined, 'pest')).toBeNull();
    expect(normalizeRequestPests({ 0: 'ants' }, 'pest')).toBeNull();
  });

  test('an unknown lane always returns null', () => {
    expect(normalizeRequestPests(['ants'], 'termite')).toBeNull();
    expect(normalizeRequestPests(['ants'], undefined)).toBeNull();
  });

  test('never returns more keys than the lane has choices, even with excess duplicates', () => {
    const result = normalizeRequestPests(['ants', 'roaches', 'spiders', 'wasps', 'other', 'ants', 'roaches'], 'pest');
    expect(result).toHaveLength(5);
    expect(result).toEqual(['ants', 'roaches', 'spiders', 'wasps', 'other']);
  });
});

describe('pestLabels', () => {
  test('renders labels in the given keys order for the lane', () => {
    expect(pestLabels(['ants', 'roaches'], 'pest')).toEqual(['Ants', 'Roaches']);
    expect(pestLabels(['weeds'], 'lawn')).toEqual(['Weeds']);
  });

  test('drops unknown or wrong-lane keys rather than surfacing undefined', () => {
    expect(pestLabels(['ants', 'weeds', 'made_up'], 'pest')).toEqual(['Ants']);
  });

  test('empty/invalid input yields an empty array', () => {
    expect(pestLabels([], 'pest')).toEqual([]);
    expect(pestLabels(null, 'pest')).toEqual([]);
    expect(pestLabels(['ants'], 'termite')).toEqual([]);
  });
});
