'use strict';

const {
  SPECIALTY_SERVICE_CLOSEOUTS,
  observationsForSpecialtyService,
  noApplicationOutcomeConflict,
  specialtyActionScopeForAreas,
  specialtyCompletedWorkWithoutAction,
  specialtyProtocolActionScopes,
  specialtyServiceKey,
  validateSpecialtyAreas,
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
      const actionLabels = new Set(spec.protocols.map((action) => action.label));
      for (const { value, excludesActions } of spec.findingActionExclusions || []) {
        expect(allowed.has(value)).toBe(true);
        expect(excludesActions.length).toBeGreaterThan(0);
        excludesActions.forEach((label) => expect(actionLabels.has(label)).toBe(true));
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
        // Every non-exclusive action either applies product, performs
        // non-chemical work, or is a monitoring / review step — never an
        // unclassified completed action (local audit P1 on #3701).
        if (!action.exclusive && !action.treatmentApplied && !action.treatmentPerformed) {
          expect(action.label).toMatch(/monitor|reviewed/i);
        }
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
      observations: [], actions: ['Inspection only'], productCount: 0,
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

  test('rejects protocol actions the specialty preset does not offer on an explicit lane', () => {
    expect(validateSpecialtyClosureCombination('dethatching', {
      observations: ['Inspection only'], actions: ['Inspection only', 'Checked irrigation heads'],
    })).toBe('“Checked irrigation heads” is not a protocol action for this service.');
    expect(validateSpecialtyClosureCombination('bee_wasp_removal', {
      observations: [], actions: ['Cobweb sweep'],
    })).toBe('“Cobweb sweep” is not a protocol action for this service.');
  });

  test('a keyless legacy row keeps its dynamic actions while preset rules still apply', () => {
    expect(validateSpecialtyClosureCombination('bee_wasp_removal', {
      observations: [], actions: ['Cobweb sweep', 'Exposed nest treated'], enforcePresetActions: false,
    })).toBeNull();
    expect(validateSpecialtyClosureCombination('bee_wasp_removal', {
      observations: [], actions: ['Cobweb sweep', 'Inspection and identification only', 'Exposed nest treated'],
      enforcePresetActions: false,
    })).toBe('Clear “Inspection and identification only” or remove the other completed actions before submitting.');
  });

  test('rejects nest counts and identified species beside no-evidence findings', () => {
    expect(validateSpecialtyObservationCombination('mud_dauber_removal', [
      'No current evidence observed', '1–3 nests',
    ])).toBe('“No current evidence observed” cannot be paired with “1–3 nests”.');
    expect(validateSpecialtyObservationCombination('mud_dauber_removal', [
      'Mud dauber activity without completed nests', 'Exact count not practical',
    ])).toBe('“Mud dauber activity without completed nests” cannot be paired with “Exact count not practical”.');
    expect(validateSpecialtyObservationCombination('tick_control', [
      'No tick activity observed', 'Brown dog tick',
    ])).toBe('“No tick activity observed” cannot be paired with “Brown dog tick”.');
    expect(validateSpecialtyObservationCombination('tick_control', [
      'No tick activity observed', 'Species not confirmed',
    ])).toBeNull();
    expect(validateSpecialtyObservationCombination('mud_dauber_removal', [
      'Inactive or abandoned nests', '4–10 nests',
    ])).toBeNull();
  });

  test('rejects no-evidence or inactive findings beside treatment of active pests', () => {
    expect(validateSpecialtyClosureCombination('mud_dauber_removal', {
      observations: ['No current evidence observed'], actions: ['Active nests treated'],
    })).toBe('“No current evidence observed” cannot be paired with action “Active nests treated”.');
    expect(validateSpecialtyClosureCombination('bee_wasp_removal', {
      observations: ['Inactive'], actions: ['Void nest treated'],
    })).toBe('“Inactive” cannot be paired with action “Void nest treated”.');
    expect(validateSpecialtyClosureCombination('fire_ant', {
      observations: ['No active fire ants observed'], actions: ['Individual mound treatment'],
    })).toBe('“No active fire ants observed” cannot be paired with action “Individual mound treatment”.');
    expect(validateSpecialtyClosureCombination('mud_dauber_removal', {
      observations: ['Inactive or abandoned nests'], actions: ['Inactive nests removed'],
    })).toBeNull();
    expect(validateSpecialtyClosureCombination('fire_ant', {
      observations: ['No active fire ants observed'], actions: ['Broadcast bait application'],
    })).toBeNull();
  });

  test('specialty areas must come from the preset, or the lane legacy list on keyless rows', () => {
    expect(validateSpecialtyAreas('fire_ant', ['Kitchen', 'Front lawn'])).toBe('“Kitchen” is not a treatment area for this service.');
    expect(validateSpecialtyAreas('fire_ant', ['Front lawn', 'Fence line'])).toBeNull();
    // Keyless legacy row: the generic pest chips its older client offered still pass…
    expect(validateSpecialtyAreas('fire_ant', ['Fence line', 'Perimeter'], { enforcePresetAreas: false })).toBeNull();
    // …but another lane's vocabulary never does.
    expect(validateSpecialtyAreas('dethatching', ['Kitchen'], { enforcePresetAreas: false }))
      .toBe('“Kitchen” is not a treatment area for this service.');
    expect(validateSpecialtyAreas('general_pest', ['Kitchen'])).toBeNull();
    expect(validateSpecialtyAreas('bed_bug', [])).toBeNull();
  });

  test('a completed-work finding needs a performed action at submit', () => {
    expect(validateSpecialtyClosureCombination('dethatching', {
      observations: ['Full quoted area completed', 'Heavy debris removed'], actions: [],
    })).toBe('“Full quoted area completed” requires a completed protocol action — add the work performed before submitting.');
    expect(validateSpecialtyClosureCombination('plugging', {
      observations: ['9-inch spacing'], actions: ['Sod plugs installed at quoted spacing'],
    })).toBeNull();
    expect(specialtyCompletedWorkWithoutAction(SPECIALTY_SERVICE_CLOSEOUTS.bee_wasp_removal, ['Active'], [])).toBeNull();
  });

  test('a no-application outcome cannot carry performed actions or products', () => {
    expect(validateSpecialtyClosureCombination('fire_ant', {
      observations: ['Active mounds observed'], actions: ['Individual mound treatment'], visitOutcome: 'inspection_only',
    })).toBe('Visit outcome “inspection only” cannot record the performed action “Individual mound treatment” — change the outcome or clear the action.');
    expect(validateSpecialtyClosureCombination('fire_ant', {
      observations: [], actions: ['Inspection only'], productCount: 1, visitOutcome: 'customer_declined',
    })).toBe('Visit outcome “customer declined” cannot record applied products — change the outcome or remove the products.');
    expect(validateSpecialtyClosureCombination('fire_ant', {
      observations: [], actions: ['Inspection only'], productCount: 0, visitOutcome: 'inspection_only',
    })).toBeNull();
    expect(validateSpecialtyClosureCombination('fire_ant', {
      observations: [], actions: ['Individual mound treatment'], productCount: 1, visitOutcome: 'completed',
    })).toBeNull();
    expect(noApplicationOutcomeConflict(SPECIALTY_SERVICE_CLOSEOUTS.fire_ant, ['Individual mound treatment'], 0, 'incomplete')).toBeNull();
    // A keyless legacy row's dynamic action is performed work for this check too.
    expect(validateSpecialtyClosureCombination('fire_ant', {
      observations: [], actions: ['Legacy mound drench'], enforcePresetActions: false, visitOutcome: 'customer_declined',
    })).toBe('Visit outcome “customer declined” cannot record the performed action “Legacy mound drench” — change the outcome or clear the action.');
  });

  test('accepts consistent work state and lanes without work-state rules', () => {
    expect(validateSpecialtyClosureCombination('dethatching', {
      observations: ['Inspection only'], actions: ['Inspection only'],
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

  test('server derives specialty action metadata from the preset and treated areas', () => {
    expect(specialtyProtocolActionScopes('bee_wasp_removal', {
      actions: ['Void nest treated', 'Inspection and identification only', 'Not a preset action'],
      areas: ['Attic'],
    })).toEqual([
      { label: 'Void nest treated', scope: 'interior', treatmentApplied: true, treatmentPerformed: true, dryDown: true, reentryWait: false },
      { label: 'Inspection and identification only', scope: 'interior', treatmentApplied: false, treatmentPerformed: false, dryDown: false, reentryWait: false },
    ]);
    expect(specialtyProtocolActionScopes('bee_wasp_removal', {
      actions: ['Void nest treated'], areas: ['Attic', 'Eaves / soffit'],
    })).toEqual([{ label: 'Void nest treated', scope: 'exterior', treatmentApplied: true, treatmentPerformed: true, dryDown: true, reentryWait: false }]);
    expect(specialtyProtocolActionScopes('tick_control', {
      actions: ['Pet-resting or kennel-area treatment'], areas: ['Interior pet areas', 'Furniture near pet areas'],
    })).toEqual([{ label: 'Pet-resting or kennel-area treatment', scope: 'interior', treatmentApplied: true, treatmentPerformed: true, dryDown: true, reentryWait: false }]);
    // A granular bait is an application without a dry-down phase.
    expect(specialtyProtocolActionScopes('fire_ant', {
      actions: ['Broadcast bait application', 'Individual mound treatment'], areas: ['Front lawn'],
    })).toEqual([
      { label: 'Broadcast bait application', scope: 'exterior', treatmentApplied: true, treatmentPerformed: true, dryDown: false, reentryWait: false },
      { label: 'Individual mound treatment', scope: 'exterior', treatmentApplied: true, treatmentPerformed: true, dryDown: true, reentryWait: false },
    ]);
    // Completed mechanical work is treatment without a pesticide application.
    expect(specialtyProtocolActionScopes('plugging', {
      actions: ['Sod plugs installed at quoted spacing', 'Installation areas reviewed with customer'], areas: ['Front lawn'],
    })).toEqual([
      { label: 'Sod plugs installed at quoted spacing', scope: 'exterior', treatmentApplied: false, treatmentPerformed: true, dryDown: false, reentryWait: false },
      { label: 'Installation areas reviewed with customer', scope: 'exterior', treatmentApplied: false, treatmentPerformed: false, dryDown: false, reentryWait: false },
    ]);
    // Heat and steam are treatment without a pesticide application.
    expect(specialtyProtocolActionScopes('bed_bug', {
      actions: ['Heat treatment', 'Vacuuming performed'], areas: ['Primary bedroom'],
    })).toEqual([
      { label: 'Heat treatment', scope: 'interior', treatmentApplied: false, treatmentPerformed: true, dryDown: false, reentryWait: true },
      { label: 'Vacuuming performed', scope: 'interior', treatmentApplied: false, treatmentPerformed: true, dryDown: false, reentryWait: false },
    ]);
    expect(specialtyProtocolActionScopes('general_pest', { actions: ['Anything'], areas: [] })).toBeNull();
    expect(specialtyActionScopeForAreas(['Other'], 'exterior')).toBe('exterior');
    expect(specialtyActionScopeForAreas([], 'interior')).toBe('interior');
  });

  test('the completion route skips specialty preset checks on typed lanes', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'complete-scheduled-service.js'), 'utf8');
    // mosquito_one_time aliases onto the mosquito preset while its typed
    // mosquito_event schema owns the areas — the preset area/action checks
    // must not run for typed closeouts.
    expect(source).toMatch(/const resolvedSpecialtyServiceKey = typedFindingsType \? null : specialtyServiceKey\(/);
  });
});
