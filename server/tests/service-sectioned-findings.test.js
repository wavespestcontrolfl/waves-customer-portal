/**
 * Sectioned tap-to-fill findings for the seven services beyond rodent
 * trapping (owner spec, 2026-06-12): schema shape, customer copy safety,
 * required next steps, and the composed "what we did" sentences.
 */
const {
  REQUIRED_FINDINGS_FIELDS,
  customerLabelForField,
  customerLabelForValue,
  findBannedCustomerCopy,
  buildTypedReportSnapshot,
  findingsSchemaForType,
  validateTypedFindings,
} = require('../services/service-report/activity-indicators');
const { PROJECT_TYPES } = require('../services/project-types');

const SECTIONED_TYPES = [
  'mosquito_event', 'palm_injection', 'one_time_lawn_treatment', 'pest_inspection',
  'cockroach', 'wildlife_trapping', 'bed_bug', 'rodent_trapping',
];

describe('registry-wide customer copy safety', () => {
  test('every chip option, select option, and value label is banned-copy clean', () => {
    for (const [type, cfg] of Object.entries(PROJECT_TYPES)) {
      for (const field of cfg.findingsFields || []) {
        for (const option of field.options || []) {
          const label = customerLabelForValue(field.key, option);
          expect({ type, field: field.key, option, violations: findBannedCustomerCopy(label) })
            .toEqual({ type, field: field.key, option, violations: [] });
        }
        const fieldLabel = customerLabelForField(field.key, field.label);
        expect(findBannedCustomerCopy(fieldLabel)).toEqual([]);
      }
    }
  });
});

// The "Next steps" chip picker was retired (owner ruling 2026-09-27) —
// Recommendations is the single tech-advice field for every typed service
// type now, so the schema slice no longer serves a required flag or a
// per-type chip list for any of the eight sectioned services.
describe('next-step picker retirement (owner ruling 2026-09-27)', () => {
  test('none of the eight sectioned services serve the retired picker fields', () => {
    for (const type of SECTIONED_TYPES) {
      const schema = findingsSchemaForType(type);
      expect(schema.nextStepRequired).toBeUndefined();
      expect(schema.nextStepChips).toBeUndefined();
    }
  });

  test('required fields exist and validate', () => {
    expect(REQUIRED_FINDINGS_FIELDS.mosquito_event).toEqual(['activity_level', 'standing_water']);
    expect(REQUIRED_FINDINGS_FIELDS.palm_injection).toEqual(['palm_condition']);
    expect(REQUIRED_FINDINGS_FIELDS.one_time_lawn_treatment).toEqual(['lawn_condition']);
    expect(REQUIRED_FINDINGS_FIELDS.wildlife_trapping).toEqual(['target_animal']);
    const missing = validateTypedFindings({
      type: 'mosquito_event', values: {}, expectedType: 'mosquito_event', enforceRequired: true,
    });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(expect.arrayContaining(['activity_level', 'standing_water']));
  });
});

describe('mosquito snapshot', () => {
  const VALUES = {
    activity_level: 'Light',
    activity_locations: 'Shaded vegetation, Pool cage',
    treatment_completed: 'Barrier treatment, Larvicide applied',
    treatment_zones: 'Backyard, Fence lines, Pool cage perimeter',
    standing_water: 'Yes',
    breeding_sources: 'Plant saucers, Buckets',
    source_reduction: 'Emptied standing water, Flipped containers',
    sensitive_areas: 'Blooming plants / pollinators',
    sensitive_areas_avoided: 'Avoided',
    weather_conditions: 'Calm conditions',
    customer_recommendations: 'Empty standing water weekly, Trim dense vegetation',
  };

  test('level headline + composed treatment sentence + standing-water copy', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'mosquito_event',
      serviceKey: 'mosquito_event',
      serviceLabel: 'Mosquito Event Spray',
      values: VALUES,
      visitSequence: 1,
      activity: null,
    });
    expect(snapshot.todaysResult.headline).toBe('Mosquito activity was light today.');
    expect(snapshot.todaysResult.body).toContain('completed a mosquito barrier treatment');
    expect(snapshot.todaysResult.body).toContain('applied larvicide to water-holding areas');
    const water = snapshot.findings.find((f) => f.fieldKey === 'standing_water');
    expect(water.customerValueLabel).toBe('Standing water was found — see the breeding sources noted below');
    const sensitive = snapshot.findings.find((f) => f.fieldKey === 'sensitive_areas_avoided');
    expect(sensitive.customerValueLabel).toBe('Sensitive areas were avoided during treatment');
    expect(findBannedCustomerCopy(JSON.stringify(snapshot.todaysResult))).toEqual([]);
  });

  test('zero state stays observational', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'mosquito_event',
      serviceKey: 'mosquito_event',
      serviceLabel: 'Mosquito Event Spray',
      values: { ...VALUES, activity_level: 'None observed' },
      visitSequence: 1,
      activity: null,
    });
    expect(snapshot.todaysResult.headline).toBe('No active signs of mosquito activity observed today.');
  });
});

describe('wildlife snapshot', () => {
  test('trap sentence composes from wildlife vocabulary', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'wildlife_trapping',
      serviceKey: 'wildlife_trapping',
      serviceLabel: 'Wildlife Trapping',
      values: {
        target_animal: 'Squirrel',
        evidence_observed: 'Chewing marks, Nesting material, Noises reported',
        entry_points: 'Roof returns, Tree limbs touching roof',
        traps_checked: '2',
        captures: '0',
        trap_actions: 'Traps reset, Bait/lure refreshed',
        customer_recommendations: 'Trim branches off roofline',
      },
      visitSequence: 2,
      activity: {
        indicatorKey: 'wildlife_activity',
        label: 'Wildlife Activity',
        score: 2,
        source: 'tech',
        trend: 'stable',
        trendWord: 'about the same as the last visit',
      },
    });
    expect(snapshot.todaysResult.body).toContain('checked 2 traps');
    expect(snapshot.todaysResult.body).toContain('found no new captures');
    // Next-step chip picker retired (owner ruling 2026-09-27) — no
    // chip-derived sentence on a new completion.
    expect(snapshot.todaysResult.nextStep).toBeNull();
    expect(findBannedCustomerCopy(JSON.stringify(snapshot.todaysResult))).toEqual([]);
  });
});

describe('inspection snapshot', () => {
  test('what-we-did composes from areas inspected', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'pest_inspection',
      serviceKey: 'pest_inspection',
      serviceLabel: 'Pest Inspection',
      values: {
        inspection_type: 'General pest inspection',
        areas_inspected: 'Exterior perimeter, Garage, Kitchen',
        severity: 'Low',
        findings_observed: 'Entry points found, Moisture concern',
        access_limitations: 'Stored items limited inspection',
        customer_recommendations: 'Seal entry gaps, Trim vegetation',
      },
      visitSequence: 1,
      activity: null,
    });
    expect(snapshot.todaysResult.body).toContain('We inspected the exterior perimeter, garage and kitchen.');
    // Next-step chip picker retired (owner ruling 2026-09-27).
    expect(snapshot.todaysResult.nextStep).toBeNull();
  });
});

describe('bed bug required core', () => {
  test('rooms_treated is required — the only location capture with the areas picker hidden (codex P2 on #2963)', () => {
    const missing = validateTypedFindings({
      type: 'bed_bug',
      values: { evidence_level: 'Low (few bugs)', treatment_method: 'Chemical only' },
      expectedType: 'bed_bug',
      enforceRequired: true,
    });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toContain('rooms_treated');

    const complete = validateTypedFindings({
      type: 'bed_bug',
      values: { rooms_treated: 'Primary bedroom', evidence_level: 'Low (few bugs)', treatment_method: 'Chemical only' },
      expectedType: 'bed_bug',
      enforceRequired: true,
    });
    expect(complete.ok).toBe(true);
  });
});

describe('cockroach + bed bug + palm + lawn snapshots', () => {
  test('cockroach work sentence + prep copy', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'cockroach',
      serviceKey: 'cockroach_treatment',
      serviceLabel: 'Cockroach Treatment',
      values: {
        species: 'German',
        activity_level: 'Moderate',
        activity_locations: 'Under sink, Behind refrigerator, Cabinet hinges',
        evidence_observed: 'Live roaches, Droppings',
        work_completed: 'Bait placement, Insect growth regulator, Crack & crevice treatment',
        customer_prep: 'No over-the-counter sprays, Remove food debris',
      },
      visitSequence: 1,
      activity: {
        indicatorKey: 'roach_activity', label: 'Roach Activity', score: 3, source: 'derived',
      },
    });
    expect(snapshot.todaysResult.headline).toBe('Cockroach activity was moderate today.');
    expect(snapshot.todaysResult.body).toContain('placed targeted bait');
    // Next-step chip picker retired (owner ruling 2026-09-27).
    expect(snapshot.todaysResult.nextStep).toBeNull();
  });

  test('bed bug work sentence, prep status copy, palm + lawn composition', () => {
    const bedBug = buildTypedReportSnapshot({
      projectType: 'bed_bug',
      serviceKey: 'bed_bug_treatment',
      serviceLabel: 'Bed Bug Treatment',
      values: {
        rooms_treated: 'Primary bedroom',
        evidence_level: 'Low (few bugs)',
        evidence_observed: 'Fecal spotting, Live bed bugs',
        treatment_method: 'Chemical only',
        work_completed: 'Mattress / box spring treatment, Interceptors installed',
        prep_status: 'Partial',
        customer_prep: 'Dry bedding on high heat, Do not move items between rooms',
      },
      visitSequence: 1,
      activity: {
        indicatorKey: 'bed_bug_activity', label: 'Bed Bug Activity', score: 1, source: 'derived',
      },
    });
    expect(bedBug.todaysResult.body).toContain('treated the mattress and box spring');
    expect(bedBug.findings.find((f) => f.fieldKey === 'prep_status').customerValueLabel)
      .toBe('Prep partially completed — see the prep list below');

    const palm = buildTypedReportSnapshot({
      projectType: 'palm_injection',
      serviceKey: 'palm_injection',
      serviceLabel: 'Palm Injection',
      values: {
        palms_serviced: '4',
        palm_condition: 'Fair',
        condition_observations: 'Yellowing lower fronds, Firm spear leaf, New growth present',
        deficiency_signs: 'Potassium deficiency signs',
        pest_disease_signs: 'None observed today',
        work_completed: 'Palm fertilizer applied, Canopy / crown inspection',
        customer_recommendations: 'Avoid over-pruning, Keep mulch away from trunks',
      },
      visitSequence: 1,
      activity: null,
    });
    expect(palm.todaysResult.body).toContain('applied palm fertilizer around the root zone');
    expect(palm.findings.find((f) => f.fieldKey === 'pest_disease_signs').customerValueLabel)
      .toBe("No visible pest or disease indicators were observed at today's service");

    const lawn = buildTypedReportSnapshot({
      projectType: 'one_time_lawn_treatment',
      serviceKey: 'lawn_care_one_time',
      serviceLabel: 'One-Time Lawn Treatment',
      values: {
        turf_type: 'St. Augustine',
        lawn_condition: 'Fair',
        turf_color: 'Moderate',
        weed_pressure: 'Light',
        insect_pressure: 'None observed',
        turf_issues: 'Sedge, Drought stress',
        irrigation_mowing: 'Dry zones, Poor coverage',
        work_completed: 'Iron / micronutrients applied, Spot treatment completed',
        spot_treatment_areas: 'Front right lawn',
        customer_recommendations: 'Adjust irrigation coverage, Avoid mowing too low',
      },
      visitSequence: 1,
      activity: null,
    });
    expect(lawn.todaysResult.body).toContain('applied iron and micronutrients');
    expect(lawn.todaysResult.body).toContain('spot-treated the noted areas');
    expect(lawn.findings.find((f) => f.fieldKey === 'insect_pressure').customerValueLabel)
      .toBe('No signs observed today');
  });
});
