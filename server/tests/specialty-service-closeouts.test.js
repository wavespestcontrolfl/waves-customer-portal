'use strict';

const {
  SPECIALTY_SERVICE_CLOSEOUTS,
  observationsForSpecialtyService,
  validateSpecialtyObservationCombination,
  validateSpecialtyClosureCombination,
} = require('../../shared/specialty-service-closeouts');

describe('specialty service closeout vocabulary', () => {
  test('allowlist is the flattened shared group vocabulary with no cross-group duplicates', () => {
    for (const [key, spec] of Object.entries(SPECIALTY_SERVICE_CLOSEOUTS)) {
      const flat = spec.findingGroups.flatMap((group) => group.options);
      expect(observationsForSpecialtyService(key)).toEqual(flat);
      expect(new Set(flat).size).toBe(flat.length);
    }
  });

  test('exclusion and work-state rules only reference values in their own vocabulary', () => {
    for (const [key, spec] of Object.entries(SPECIALTY_SERVICE_CLOSEOUTS)) {
      const allowed = new Set(observationsForSpecialtyService(key));
      for (const { value, excludes } of spec.exclusions || []) {
        expect(allowed.has(value)).toBe(true);
        expect(excludes.length).toBeGreaterThan(0);
        excludes.forEach((other) => expect(allowed.has(other)).toBe(true));
      }
      if (spec.workState) {
        [...spec.workState.noWork, ...spec.workState.completed].forEach((value) => expect(allowed.has(value)).toBe(true));
        expect(spec.protocols.some((action) => action.exclusive === true)).toBe(true);
      }
      spec.protocols.forEach((action) => {
        expect(['interior', 'exterior']).toContain(action.scope);
        expect(typeof action.treatmentApplied).toBe('boolean');
      });
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
    expect(validateSpecialtyObservationCombination('dethatching', [
      'Inspection only', 'Heavy debris removed',
    ])).toBe('“Inspection only” cannot be paired with “Heavy debris removed”.');
    expect(validateSpecialtyObservationCombination('plugging', [
      'Not installed', 'Full quoted area completed',
    ])).toBe('“Not installed” cannot be paired with “Full quoted area completed”.');
  });

  test('rejects no-work findings beside performed actions and vice versa', () => {
    expect(validateSpecialtyClosureCombination('dethatching', {
      observations: ['Inspection only'], actions: ['Double-pass dethatching completed'],
    })).toBe('“Inspection only” cannot be paired with completed action “Double-pass dethatching completed”.');
    expect(validateSpecialtyClosureCombination('plugging', {
      observations: ['Not installed'], actions: ['Sod plugs installed at quoted spacing'],
    })).toBe('“Not installed” cannot be paired with completed action “Sod plugs installed at quoted spacing”.');
    expect(validateSpecialtyClosureCombination('dethatching', {
      observations: ['Full quoted area completed', 'Heavy debris removed'], actions: ['Inspection only'],
    })).toBe('“Inspection only” cannot be paired with finding “Full quoted area completed”.');
  });

  test('rejects an exclusive action beside other preset actions or applied products', () => {
    expect(validateSpecialtyClosureCombination('bee_wasp_removal', {
      observations: ['Active'], actions: ['Inspection and identification only', 'Exposed nest treated'],
    })).toBe('Clear “Inspection and identification only” or remove the other completed actions before submitting.');
    expect(validateSpecialtyClosureCombination('mud_dauber_removal', {
      observations: [], actions: ['No treatment recommended'], productCount: 1,
    })).toBe('Remove applied products or clear “No treatment recommended” before completing this visit.');
    expect(validateSpecialtyClosureCombination('bed_bug', {
      observations: [], actions: ['Inspection only', '[Protocol] free-text line'], productCount: 0,
    })).toBeNull();
    expect(validateSpecialtyClosureCombination('bee_wasp_removal', {
      observations: [], actions: ['Exposed nest treated', 'Nest physically removed'], productCount: 2,
    })).toBeNull();
  });

  test('accepts consistent work state, tagged free-text actions and lanes without work-state rules', () => {
    expect(validateSpecialtyClosureCombination('dethatching', {
      observations: ['Inspection only'], actions: ['Inspection only', 'Checked irrigation heads'],
    })).toBeNull();
    expect(validateSpecialtyClosureCombination('plugging', {
      observations: ['9-inch spacing', 'Full quoted area completed'],
      actions: ['Sod plugs installed at quoted spacing', 'Installed plugs watered in'],
    })).toBeNull();
    expect(validateSpecialtyClosureCombination('bee_wasp_removal', {
      observations: ['Active'], actions: ['Inspection and identification only'],
    })).toBeNull();
    expect(validateSpecialtyClosureCombination('general_pest', {
      observations: ['anything'], actions: ['anything'],
    })).toBeNull();
  });
});
