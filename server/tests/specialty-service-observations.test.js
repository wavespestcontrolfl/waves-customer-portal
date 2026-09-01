'use strict';

const {
  SPECIALTY_SERVICE_OBSERVATION_GROUPS_BY_KEY,
  SPECIALTY_OBSERVATION_EXCLUSIONS_BY_KEY,
  observationsForSpecialtyService,
  validateSpecialtyObservationCombination,
} = require('../../shared/specialty-service-observations');

describe('specialty service observation vocabulary', () => {
  test('allowlist is the flattened shared group vocabulary with no cross-group duplicates', () => {
    for (const [key, groups] of Object.entries(SPECIALTY_SERVICE_OBSERVATION_GROUPS_BY_KEY)) {
      const flat = groups.flatMap((group) => group.options);
      expect(observationsForSpecialtyService(key)).toEqual(flat);
      expect(new Set(flat).size).toBe(flat.length);
    }
  });

  test('exclusion rules only reference values in their own service vocabulary', () => {
    for (const [key, rules] of Object.entries(SPECIALTY_OBSERVATION_EXCLUSIONS_BY_KEY)) {
      const allowed = new Set(observationsForSpecialtyService(key));
      for (const { value, excludes } of rules) {
        expect(allowed.has(value)).toBe(true);
        expect(excludes.length).toBeGreaterThan(0);
        excludes.forEach((other) => expect(allowed.has(other)).toBe(true));
      }
    }
  });

  test('accepts one value per group', () => {
    expect(validateSpecialtyObservationCombination('bee_wasp_removal', [
      'Paper wasp', 'Exposed paper nest', 'Active',
    ])).toBeNull();
    expect(validateSpecialtyObservationCombination('mosquito_monthly', [
      'Light mosquito activity', 'Removable standing water found',
    ])).toBeNull();
    expect(validateSpecialtyObservationCombination('fire_ant', [])).toBeNull();
    expect(validateSpecialtyObservationCombination('general_pest', ['anything'])).toBeNull();
  });

  test('rejects two values from one single-select group, including through aliases', () => {
    expect(validateSpecialtyObservationCombination('mud_dauber_removal', [
      'Active mud nests', 'No current evidence observed',
    ])).toBe('Select only one value in each specialty finding group.');
    expect(validateSpecialtyObservationCombination('bed_bug', [
      'Initial treatment', 'Post-treatment inspection',
    ])).toBe('Select only one value in each specialty finding group.');
  });

  test('rejects dependent pairs the completion UI reconciles away', () => {
    expect(validateSpecialtyObservationCombination('bee_wasp_removal', [
      'Inactive or abandoned nest', 'Active',
    ])).toBe('“Inactive or abandoned nest” cannot be paired with “Active”.');
    expect(validateSpecialtyObservationCombination('bee_wasp_removal', [
      'Inactive or abandoned nest', 'Inactive',
    ])).toBeNull();
    expect(validateSpecialtyObservationCombination('fire_ant', [
      'No active fire ants observed', 'Widespread activity',
    ])).toBe('“No active fire ants observed” cannot be paired with “Widespread activity”.');
  });
});
