/**
 * Rodent family typed flows (owner spec 2026-06-12, Phase 2 §§1–4):
 * dedicated exclusion (repair story) + sanitation (cleanup story) +
 * inspection (diagnostic story) forms, combo-module serving per service
 * key, and the owner wording rules (never "rodent-proof"; reduce-access
 * phrasing; observational absence claims).
 */
const {
  ACTIVITY_INDICATORS,
  REQUIRED_FINDINGS_FIELDS,
  TYPE_NEXT_STEP_CHIPS,
  NEXT_STEP_CHIPS,
  customerLabelForValue,
  findBannedCustomerCopy,
  getActivityIndicator,
  nextStepRequiredForType,
  validateTypedFindings,
  buildTodaysResult,
  buildTypedReportSnapshot,
  findingsSchemaForType,
} = require('../services/service-report/activity-indicators');
const { PROJECT_TYPES } = require('../services/project-types');

const EXCLUSION_VALUES = {
  exclusion_areas: 'Garage, Exterior perimeter',
  entry_points_addressed: 'AC line penetration, Garage door gaps',
  exclusion_work_completed: 'Sealed entry point, Installed hardware cloth / mesh',
  exclusion_materials: 'Rodent-resistant mesh, Sealant',
  remaining_concerns: 'Tree limbs touching roof, Trapping still active',
};

const SANITATION_VALUES = {
  sanitation_areas: 'Attic, Garage',
  contamination_level: 'Moderate',
  evidence_cleaned: 'Droppings, Nesting material',
  sanitation_work_completed: 'Removed droppings, Removed nesting material, Disinfected / sanitized affected areas, Deodorized affected areas',
  sanitation_limitations: 'Insulation contamination remains, Electrical / HVAC obstruction',
};

const INSPECTION_VALUES = {
  areas_inspected: 'Exterior perimeter, Garage, Attic access',
  activity_found: 'Yes',
  evidence_observed: 'Droppings, Gnaw marks',
  species: 'Rat',
  entry_points_found: 'AC line gap right side',
  interior_concern: 'Yes',
  exterior_pressure: 'Yes',
  photos_taken: 'Yes',
  recommended_service: 'Rodent trapping program',
  urgency: 'Soon',
};

describe('rodent family schemas', () => {
  test('three distinct stories — repair, cleanup, diagnostic', () => {
    const exclusion = Object.fromEntries(PROJECT_TYPES.rodent_exclusion.findingsFields.map((f) => [f.key, f]));
    const sanitation = Object.fromEntries(PROJECT_TYPES.rodent_sanitation.findingsFields.map((f) => [f.key, f]));
    const inspection = Object.fromEntries(PROJECT_TYPES.rodent_inspection.findingsFields.map((f) => [f.key, f]));
    expect(exclusion.entry_points_addressed).toBeTruthy();
    expect(exclusion.exclusion_materials).toBeTruthy();
    expect(exclusion.traps_set).toBeUndefined();
    expect(sanitation.contamination_level.options).toContain('Severe — office review needed');
    expect(sanitation.entry_points_addressed).toBeUndefined();
    expect(inspection.recommended_service).toBeTruthy();
    expect(inspection.urgency.options).toEqual(['Routine', 'Soon', 'High']);
    for (const type of ['rodent_exclusion', 'rodent_sanitation', 'rodent_inspection']) {
      expect(nextStepRequiredForType(type)).toBe(true);
      for (const chip of TYPE_NEXT_STEP_CHIPS[type]) {
        expect({ type, chip, hasSentence: !!NEXT_STEP_CHIPS[chip] }).toEqual({ type, chip, hasSentence: true });
      }
    }
  });

  test('gauges: exclusion + inspection share the rodent trend; sanitation has NONE', () => {
    expect(ACTIVITY_INDICATORS.rodent_exclusion.indicatorKey).toBe('rodent_activity');
    expect(ACTIVITY_INDICATORS.rodent_inspection.indicatorKey).toBe('rodent_activity');
    // Contamination is a cleanup measure — never on the activity trend.
    expect(getActivityIndicator('rodent_sanitation')).toBeNull();
  });

  test('combo modules are served per service key (owner spec §3)', () => {
    const plain = findingsSchemaForType('rodent_trapping', { serviceKey: 'rodent_trapping' });
    const combo = findingsSchemaForType('rodent_trapping', { serviceKey: 'rodent_trapping_exclusion_sanitation' });
    const exclusionOnly = findingsSchemaForType('rodent_trapping', { serviceKey: 'rodent_trapping_exclusion' });
    const plainKeys = plain.fields.map((f) => f.key);
    expect(plainKeys).not.toContain('entry_points_addressed');
    expect(plainKeys).not.toContain('sanitation_areas');
    expect(combo.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['entry_points_addressed', 'sanitation_areas']));
    const exclusionKeys = exclusionOnly.fields.map((f) => f.key);
    expect(exclusionKeys).toContain('entry_points_addressed');
    expect(exclusionKeys).not.toContain('sanitation_areas');
    // Unknown context (AI draft labeling) keeps the full registry.
    const unscoped = findingsSchemaForType('rodent_trapping');
    expect(unscoped.fields.map((f) => f.key)).toContain('entry_points_addressed');
  });
});

describe('exclusion report (owner template §1)', () => {
  test('repair story with reduce-access headline, never "rodent-proof"', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_exclusion',
      reportTypeLabel: 'Rodent Exclusion Summary',
      values: EXCLUSION_VALUES,
      chips: ['Continue trapping', 'Customer repair needed'],
      activity: { score: 2 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('Exclusion repairs were completed to reduce rodent access and help prevent re-entry.');
    expect(result.body).toContain('Completed rodent exclusion work today around the garage and exterior perimeter.');
    expect(result.body).toContain('Entry points addressed included the ac line penetration and garage door gaps.');
    expect(result.body).toContain('Materials used included rodent-resistant mesh and sealant.');
    expect(result.body).toContain('Remaining concerns: tree limbs touching roof and trapping still active.');
    expect(result.body).toContain('Trapping will continue until activity is reduced.');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('clean exclusion gets the no-remaining-concerns sentence', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_exclusion',
      reportTypeLabel: 'Rodent Exclusion Summary',
      values: { ...EXCLUSION_VALUES, remaining_concerns: 'No remaining concerns observed' },
      chips: ['No follow-up needed'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.body).toContain('No remaining concerns were observed today.');
  });
});

describe('sanitation report (owner template §2)', () => {
  test('cleanup story with level, evidence, limitations', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_sanitation',
      reportTypeLabel: 'Rodent Sanitation Summary',
      values: SANITATION_VALUES,
      chips: ['Complete exclusion', 'Continue trapping'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.headline).toBe('Moderate rodent contamination was cleaned and sanitized today.');
    expect(result.body).toContain('Completed rodent sanitation service in the attic and garage.');
    expect(result.body).toContain('Contamination level was moderate.');
    expect(result.body).toContain('We removed and treated droppings and nesting material.');
    expect(result.body).toContain('Some areas had limitations: insulation contamination remains and electrical / hvac obstruction.');
    expect(result.body).toContain('Completing the exclusion repairs is the key next step.');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('severe contamination promises office follow-up without saying "office review"', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_sanitation',
      reportTypeLabel: 'Rodent Sanitation Summary',
      values: { ...SANITATION_VALUES, contamination_level: 'Severe — office review needed' },
      chips: ['Additional sanitation recommended'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.headline).toBe('Severe rodent contamination was cleaned and sanitized today.');
    expect(result.body).toContain('our office will follow up with you on next steps');
    expect(customerLabelForValue('contamination_level', 'Severe — office review needed')).not.toContain('office review');
  });
});

describe('inspection report (owner template §4)', () => {
  test('diagnostic + sales-supportive when activity is found', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_inspection',
      reportTypeLabel: 'Rodent Inspection Summary',
      values: INSPECTION_VALUES,
      chips: ['Treatment recommended', 'Estimate to follow'],
      activity: { score: 3 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('Rodent activity was found during today’s inspection.');
    expect(result.body).toContain('We inspected the exterior perimeter, garage and attic access.');
    expect(result.body).toContain('Possible entry points were noted: AC line gap right side.');
    expect(result.body).toContain('we recommend rodent trapping program');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('clean inspection stays observational', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_inspection',
      reportTypeLabel: 'Rodent Inspection Summary',
      values: {
        areas_inspected: 'Exterior perimeter, Garage',
        activity_found: 'No',
        interior_concern: 'No',
        exterior_pressure: 'No',
        photos_taken: 'Yes',
        recommended_service: 'No service needed at this time',
        urgency: 'Routine',
      },
      chips: ['No action needed'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('No current rodent activity was observed during today’s inspection.');
    expect(result.body).toContain('No service is needed at this time');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });
});

describe('combo trapping narrative (owner template §3)', () => {
  test('exclusion + sanitation module work rides the trap sentence', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: {
        species: 'Roof rat',
        traps_checked: '6',
        captures: '1',
        trap_actions: 'Traps reset',
        entry_points_addressed: 'AC line penetration',
        exclusion_materials: 'Rodent-resistant mesh, Sealant',
        sanitation_areas: 'Attic',
        contamination_level: 'Light',
        evidence_cleaned: 'Droppings',
      },
      chips: ['Continue trapping'],
      activity: { score: 2 },
      visitSequence: 1,
    });
    expect(result.body).toContain('We checked 6 traps, removed 1 capture and reset the traps today.');
    expect(result.body).toContain('We also completed exclusion work at the ac line penetration using rodent-resistant mesh and sealant.');
    expect(result.body).toContain('We also completed light sanitation cleanup in the attic.');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('pure trap check narrative is unchanged by empty modules', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '4', captures: '0', trap_actions: 'Traps reset' },
      chips: ['Continue trapping'],
      activity: { score: 1 },
      visitSequence: 1,
    });
    expect(result.body).not.toContain('We also completed');
  });
});

describe('validation', () => {
  test('owner-required cores enforce; full submissions pass clean', () => {
    for (const [type, values] of [
      ['rodent_exclusion', EXCLUSION_VALUES],
      ['rodent_sanitation', SANITATION_VALUES],
      ['rodent_inspection', INSPECTION_VALUES],
    ]) {
      const empty = validateTypedFindings({ type, values: {}, expectedType: type, enforceRequired: true });
      expect(empty.ok).toBe(false);
      expect(empty.missing.length).toBeGreaterThanOrEqual(5);
      const full = validateTypedFindings({ type, values, expectedType: type, enforceRequired: true });
      expect({ type, ok: full.ok, errors: full.errors, missing: full.missing })
        .toEqual({ type, ok: true, errors: [], missing: [] });
    }
  });

  test('"none" chips cannot ride with the findings they negate', () => {
    const concerns = validateTypedFindings({
      type: 'rodent_exclusion',
      values: { ...EXCLUSION_VALUES, remaining_concerns: 'No remaining concerns observed, Activity still present' },
      expectedType: 'rodent_exclusion',
      enforceRequired: true,
    });
    expect(concerns.ok).toBe(false);
    expect(concerns.errors.join(' ')).toMatch(/No remaining concerns observed/);

    const limitations = validateTypedFindings({
      type: 'rodent_sanitation',
      values: { ...SANITATION_VALUES, sanitation_limitations: 'No limitations, PPE / safety limitation' },
      expectedType: 'rodent_sanitation',
      enforceRequired: true,
    });
    expect(limitations.ok).toBe(false);
    expect(limitations.errors.join(' ')).toMatch(/No limitations/);
  });

  test('inspection that found activity requires the evidence and suspected type', () => {
    const result = validateTypedFindings({
      type: 'rodent_inspection',
      values: { ...INSPECTION_VALUES, evidence_observed: '', species: '' },
      expectedType: 'rodent_inspection',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['evidence_observed', 'species']));

    // Old evidence with no current activity stays legal.
    const oldEvidence = validateTypedFindings({
      type: 'rodent_inspection',
      values: {
        areas_inspected: 'Garage',
        activity_found: 'No',
        evidence_observed: 'Droppings',
        interior_concern: 'No',
        exterior_pressure: 'No',
        photos_taken: 'Yes',
        recommended_service: 'Bait station monitoring',
        urgency: 'Routine',
      },
      expectedType: 'rodent_inspection',
      enforceRequired: true,
    });
    expect(oldEvidence.ok).toBe(true);
  });
});

describe('snapshots', () => {
  test('suspected rodent type + Y/N selects render as customer sentences; all copy-safe', () => {
    expect(customerLabelForValue('species', 'Rat')).toBe('Rats');
    expect(customerLabelForValue('species', 'Mouse')).toBe('Mice');
    expect(customerLabelForValue('exterior_pressure', 'Yes')).toBe('Exterior rodent pressure is present');
    for (const [type, values] of [
      ['rodent_exclusion', EXCLUSION_VALUES],
      ['rodent_sanitation', SANITATION_VALUES],
      ['rodent_inspection', INSPECTION_VALUES],
    ]) {
      const snapshot = buildTypedReportSnapshot({
        projectType: type,
        values,
        nextStepChips: TYPE_NEXT_STEP_CHIPS[type].slice(0, 2),
        serviceKey: type,
        serviceLabel: PROJECT_TYPES[type].label,
        visitSequence: 1,
        activity: type === 'rodent_sanitation' ? null : { indicatorKey: 'rodent_activity', label: 'Rodent Activity', score: 2, source: 'technician' },
      });
      expect(findBannedCustomerCopy(JSON.stringify(snapshot))).toEqual([]);
    }
  });
});
