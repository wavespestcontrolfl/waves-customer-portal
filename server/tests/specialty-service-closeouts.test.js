'use strict';

const {
  SPECIALTY_SERVICE_CLOSEOUTS,
  observationsForSpecialtyService,
  specialtyServiceKey,
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
        const exclusive = new Set(spec.protocols.filter((action) => action.exclusive === true).map((action) => action.label));
        expect(exclusive.size).toBeGreaterThan(0);
        [...Object.keys(spec.workState.noWork), ...spec.workState.completed].forEach((value) => expect(allowed.has(value)).toBe(true));
        Object.values(spec.workState.noWork).forEach((actions) => {
          expect(actions.length).toBeGreaterThan(0);
          actions.forEach((label) => expect(exclusive.has(label)).toBe(true));
        });
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

  test('rejects a no-work finding whose exclusive action explains a different work state', () => {
    expect(validateSpecialtyClosureCombination('dethatching', {
      observations: ['Inspection only'], actions: ['Work deferred; office follow-up required'],
    })).toBe('“Inspection only” cannot be paired with action “Work deferred; office follow-up required”.');
    expect(validateSpecialtyClosureCombination('plugging', {
      observations: ['Not installed', 'Work deferred'], actions: ['Inspection only'],
    })).toBe('“Work deferred” cannot be paired with action “Inspection only”.');
    expect(validateSpecialtyClosureCombination('plugging', {
      observations: ['Not installed'], actions: ['Work deferred; office follow-up required'],
    })).toBeNull();
  });

  test('a profile key is authoritative and only keyless rows use the display name', () => {
    expect(specialtyServiceKey({ serviceKey: 'flea_tick', serviceType: 'Flea & Tick Control' })).toBeNull();
    expect(specialtyServiceKey({ serviceKey: 'pest_control', serviceType: 'Bee Removal' })).toBeNull();
    expect(specialtyServiceKey({ serviceKey: 'mosquito_one_time' })).toBe('mosquito');
    expect(specialtyServiceKey({ serviceKey: 'bed_bug' })).toBe('bed_bug_treatment');
    expect(specialtyServiceKey({ serviceType: 'Flea & Tick Yard Treatment' })).toBe('tick_control');
    expect(specialtyServiceKey({ serviceType: 'Yellowjacket Removal' })).toBe('bee_wasp_removal');
    expect(specialtyServiceKey({ serviceType: 'General Pest Control' })).toBeNull();
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
