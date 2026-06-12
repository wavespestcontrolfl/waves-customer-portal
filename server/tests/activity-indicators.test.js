const {
  ACTIVITY_INDICATORS,
  REQUIRED_FINDINGS_FIELDS,
  SCHEMA_VERSION,
  SCORE_LEVEL_WORDS,
  findBannedCustomerCopy,
  nextStepRequiredForType,
  deriveActivityScore,
  validateTypedFindings,
  validateNextStepChips,
  trendWordForScores,
  trendDirection,
  buildTypedReportSnapshot,
  findingsSchemaForType,
} = require('../services/service-report/activity-indicators');
const { PROJECT_TYPES, isValidProjectType } = require('../services/project-types');

const BANNED_CUSTOMER_WORDS = [
  'clear', 'cleared', 'gone', 'eliminated', 'no infestation', 'guaranteed', 'resolved',
];

function assertNoBannedWords(text) {
  const lower = String(text || '').toLowerCase();
  for (const word of BANNED_CUSTOMER_WORDS) {
    expect(lower.includes(word)).toBe(false);
  }
}

describe('registry consistency', () => {
  test('every indicator + required-fields key is a valid project type', () => {
    for (const key of Object.keys(ACTIVITY_INDICATORS)) {
      expect(isValidProjectType(key)).toBe(true);
    }
    for (const key of Object.keys(REQUIRED_FINDINGS_FIELDS)) {
      expect(isValidProjectType(key)).toBe(true);
    }
  });

  test('required fields exist in the registry schema for their type', () => {
    for (const [type, required] of Object.entries(REQUIRED_FINDINGS_FIELDS)) {
      const keys = new Set(PROJECT_TYPES[type].findingsFields.map((f) => f.key));
      for (const key of required) expect(keys.has(key)).toBe(true);
    }
  });

  test('every derivable gauge type has a registry option mapping to 0 (cleared state)', () => {
    for (const [type, indicator] of Object.entries(ACTIVITY_INDICATORS)) {
      if (!indicator.derive) continue;
      const field = PROJECT_TYPES[type].findingsFields.find((f) => f.key === indicator.derive.field);
      expect(field).toBeTruthy();
      const zeroValues = Object.entries(indicator.derive.scores)
        .filter(([, score]) => score === 0)
        .map(([value]) => value);
      expect(zeroValues.length).toBeGreaterThan(0);
      for (const value of zeroValues) {
        expect(field.options).toContain(value);
      }
      // Every select option must be derivable — no dead options.
      for (const option of field.options) {
        expect(indicator.derive.scores[option]).toBeDefined();
      }
    }
  });

  test('customer score wording never exposes banned words', () => {
    for (const word of Object.values(SCORE_LEVEL_WORDS)) assertNoBannedWords(word);
  });
});

describe('deriveActivityScore', () => {
  test('cockroach level select derives 0/1/3/4/5', () => {
    expect(deriveActivityScore('cockroach', { activity_level: 'None observed' }).score).toBe(0);
    expect(deriveActivityScore('cockroach', { activity_level: 'Low' }).score).toBe(1);
    expect(deriveActivityScore('cockroach', { activity_level: 'Moderate' }).score).toBe(3);
    expect(deriveActivityScore('cockroach', { activity_level: 'Heavy' }).score).toBe(4);
    expect(deriveActivityScore('cockroach', { activity_level: 'Severe' }).score).toBe(5);
  });

  test('bed bug zero state derives 0', () => {
    expect(deriveActivityScore('bed_bug', { evidence_level: 'No active signs observed' }).score).toBe(0);
    expect(deriveActivityScore('bed_bug', { evidence_level: 'Severe infestation' }).score).toBe(5);
  });

  test('termite inspection status derives 0/1/4', () => {
    expect(deriveActivityScore('termite_inspection', { activity_status: 'No activity' }).score).toBe(0);
    expect(deriveActivityScore('termite_inspection', { activity_status: 'Old / inactive damage' }).score).toBe(1);
    expect(deriveActivityScore('termite_inspection', { activity_status: 'Active infestation' }).score).toBe(4);
  });

  test('tech-set types and unknown values return null', () => {
    expect(deriveActivityScore('rodent_trapping', { species: 'Roof rat' })).toBeNull();
    expect(deriveActivityScore('wildlife_trapping', {})).toBeNull();
    expect(deriveActivityScore('cockroach', { activity_level: 'Bananas' })).toBeNull();
    expect(deriveActivityScore('mosquito_event', {})).toBeNull();
  });
});

describe('validateTypedFindings', () => {
  test('rejects unknown type, mismatched type, and unknown keys', () => {
    expect(validateTypedFindings({ type: 'nope', values: {}, expectedType: 'cockroach' }).ok).toBe(false);
    expect(validateTypedFindings({ type: 'flea', values: {}, expectedType: 'cockroach' }).ok).toBe(false);
    const unknownKey = validateTypedFindings({
      type: 'cockroach',
      values: { species: 'German', activity_level: 'Low', bogus_field: 'x' },
      expectedType: 'cockroach',
    });
    expect(unknownKey.ok).toBe(false);
    expect(unknownKey.errors.join(' ')).toContain('bogus_field');
  });

  test('rejects invalid select values', () => {
    const result = validateTypedFindings({
      type: 'cockroach',
      values: { species: 'Martian', activity_level: 'Low' },
      expectedType: 'cockroach',
    });
    expect(result.ok).toBe(false);
  });

  test('enforces required fields only when asked', () => {
    const lenient = validateTypedFindings({
      type: 'cockroach', values: {}, expectedType: 'cockroach', enforceRequired: false,
    });
    expect(lenient.ok).toBe(true);
    const strict = validateTypedFindings({
      type: 'cockroach', values: {}, expectedType: 'cockroach', enforceRequired: true,
    });
    expect(strict.ok).toBe(false);
    expect(strict.missing).toEqual(expect.arrayContaining(['species', 'activity_level']));
  });

  test('accepts a complete valid submission', () => {
    const result = validateTypedFindings({
      type: 'bed_bug',
      values: {
        rooms_treated: 'Master bedroom',
        evidence_level: 'Moderate',
        treatment_method: 'Steam + chemical',
      },
      expectedType: 'bed_bug',
      enforceRequired: true,
    });
    expect(result).toEqual({ ok: true, errors: [], missing: [] });
  });
});

describe('validateNextStepChips', () => {
  test('accepts known chips, dedupes, rejects unknown and oversize', () => {
    expect(validateNextStepChips(null)).toEqual({ ok: true, chips: [] });
    expect(validateNextStepChips(['Monitor activity', 'Monitor activity']).chips).toEqual(['Monitor activity']);
    expect(validateNextStepChips(['Definitely Not A Chip']).ok).toBe(false);
    expect(validateNextStepChips(['Monitor activity', 'Sanitation recommended', 'Reduce moisture', 'Seal entry gaps', 'No action needed']).ok).toBe(false);
  });

  test('chips are scoped per type — lawn/mosquito copy cannot enter a cockroach snapshot', () => {
    expect(validateNextStepChips(['Follow watering guidance'], 'cockroach').ok).toBe(false);
    expect(validateNextStepChips(['Dump standing water weekly'], 'bed_bug').ok).toBe(false);
    expect(validateNextStepChips(['Monitor activity'], 'cockroach').ok).toBe(true);
    expect(validateNextStepChips(['14-day follow-up scheduled'], 'bed_bug').ok).toBe(true);
    const schema = findingsSchemaForType('mosquito_event');
    expect(schema.nextStepChips).toContain('Dump standing water weekly');
    expect(schema.nextStepChips).not.toContain('Trap check scheduled');
  });
});

describe('trend words', () => {
  test('first visit claims no trend', () => {
    expect(trendWordForScores(3, null)).toBeNull();
    expect(trendDirection(3, null)).toBeNull();
  });
  test('second visit maps direction', () => {
    expect(trendWordForScores(1, 3)).toBe('decreased since the last visit');
    expect(trendWordForScores(4, 3)).toBe('increased since the last visit');
    expect(trendWordForScores(3, 3)).toBe('about the same as the last visit');
    expect(trendDirection(1, 3)).toBe('improving');
    expect(trendDirection(4, 3)).toBe('worsening');
  });
});

describe('buildTypedReportSnapshot', () => {
  test('cockroach initial visit: gauge baseline, customer labels, German value label', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'cockroach',
      values: {
        species: 'German',
        activity_level: 'Moderate',
        treatment_performed: 'Gel bait placements, IGR application',
        areas_inspected: 'Kitchen, both bathrooms',
      },
      nextStepChips: ['Follow-up recommended'],
      serviceKey: 'cockroach_control',
      serviceLabel: 'Cockroach Control Service',
      visitSequence: 1,
      activity: {
        indicatorKey: 'roach_activity',
        label: 'Roach Activity',
        score: 3,
        source: 'derived',
        derivedFrom: { field: 'activity_level', value: 'Moderate', initialDerivedScore: 3 },
        trend: null,
        trendWord: null,
      },
    });
    expect(snapshot.schemaVersion).toBe(SCHEMA_VERSION);
    expect(snapshot.reportTypeLabel).toBe('Cockroach Control Service Summary');
    expect(snapshot.todaysResult.headline).toBe('Cockroach activity was moderate today.');
    expect(snapshot.todaysResult.body).toContain('Gel bait placements');
    const species = snapshot.findings.find((f) => f.fieldKey === 'species');
    expect(species.customerLabel).toBe('What we found');
    expect(species.customerValueLabel).toBe('German cockroaches');
    const level = snapshot.findings.find((f) => f.fieldKey === 'activity_level');
    expect(level.customerLabel).toBe('Activity observed');
    expect(snapshot.activity.levelWord).toBe('Moderate activity');
    assertNoBannedWords(JSON.stringify(snapshot.todaysResult));
  });

  test('progress visit gets program framing and trend headline', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      values: { species: 'Roof rat', traps_set: 'Reset 6 attic traps' },
      nextStepChips: ['Trap check scheduled'],
      serviceKey: 'rodent_trapping_setup',
      serviceLabel: 'Rodent Trapping',
      visitSequence: 3,
      activity: {
        indicatorKey: 'rodent_activity',
        label: 'Rodent Activity',
        score: 2,
        source: 'technician',
        derivedFrom: null,
        trend: 'improving',
        trendWord: 'decreased since the last visit',
      },
    });
    expect(snapshot.reportTypeLabel).toBe('Rodent Program — Progress Visit');
    expect(snapshot.todaysResult.headline).toBe('Rodent activity has decreased since our last visit.');
    assertNoBannedWords(JSON.stringify(snapshot.todaysResult));
  });

  test('stable progress visit gets grammatical headline (Codex P2)', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      values: { species: 'Roof rat', traps_set: 'Reset traps' },
      nextStepChips: ['Trap check scheduled'],
      serviceKey: 'rodent_trapping_setup',
      serviceLabel: 'Rodent Trapping',
      visitSequence: 2,
      activity: {
        indicatorKey: 'rodent_activity',
        label: 'Rodent Activity',
        score: 3,
        source: 'technician',
        derivedFrom: null,
        trend: 'stable',
        trendWord: 'about the same as the last visit',
      },
    });
    expect(snapshot.todaysResult.headline).toBe('Rodent activity is about the same as our last visit.');
    const worsening = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      values: { species: 'Roof rat' },
      nextStepChips: [],
      serviceKey: 'rodent_trapping_setup',
      serviceLabel: 'Rodent Trapping',
      visitSequence: 2,
      activity: {
        indicatorKey: 'rodent_activity', label: 'Rodent Activity', score: 4,
        source: 'technician', derivedFrom: null,
        trend: 'worsening', trendWord: 'increased since the last visit',
      },
    });
    expect(worsening.todaysResult.headline).toBe('Rodent activity has increased since our last visit.');
  });

  test('bed bug zero state uses the fixed approved copy', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'bed_bug',
      values: {
        rooms_treated: 'Master bedroom, guest bedroom',
        evidence_level: 'No active signs observed',
        treatment_method: 'Steam + chemical',
      },
      nextStepChips: ['Continue monitoring'],
      serviceKey: 'bed_bug_treatment',
      serviceLabel: 'Bed Bug Treatment',
      visitSequence: 2,
      activity: {
        indicatorKey: 'bed_bug_activity',
        label: 'Bed Bug Activity',
        score: 0,
        source: 'derived',
        derivedFrom: { field: 'evidence_level', value: 'No active signs observed', initialDerivedScore: 0 },
        trend: 'improving',
        trendWord: 'decreased since the last visit',
      },
    });
    expect(snapshot.todaysResult.headline).toBe("No active signs observed during today's service.");
    expect(snapshot.todaysResult.body).toContain('Continue monitoring');
    const evidence = snapshot.findings.find((f) => f.fieldKey === 'evidence_level');
    expect(evidence.customerValueLabel).toBe('No active signs observed today');
    assertNoBannedWords(JSON.stringify(snapshot.todaysResult));
    assertNoBannedWords(evidence.customerValueLabel);
  });

  test('zero-state select values render as findings items (not skipped)', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'pest_inspection',
      values: { severity: 'None observed', areas_inspected: 'Kitchen, garage' },
      nextStepChips: ['No action needed'],
      serviceKey: 'pest_inspection',
      serviceLabel: 'Pest Inspection',
      visitSequence: 1,
      activity: null,
    });
    const severity = snapshot.findings.find((f) => f.fieldKey === 'severity');
    expect(severity).toBeTruthy();
    expect(severity.customerValueLabel).toBe('No active signs observed today');
    expect(snapshot.todaysResult.headline).toBe('No active signs of pest activity observed today.');
  });

  test('non-gauge subtype-aware report label', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'one_time_pest_treatment',
      values: { target_pest: 'Paper wasps', activity_level: 'Moderate', treatment_performed: 'Removed two nests' },
      nextStepChips: ['Monitor activity'],
      serviceKey: 'bee_wasp_removal',
      serviceLabel: 'Bee/Wasp Removal',
      visitSequence: 1,
      activity: null,
    });
    expect(snapshot.reportTypeLabel).toBe('Bee/Wasp Removal Summary');
    expect(snapshot.activity).toBeNull();
  });

  test('only null/undefined/empty are skipped from findings items', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'cockroach',
      values: {
        species: 'German',
        activity_level: 'None observed',
        areas_inspected: '',
        harborage_locations: null,
      },
      nextStepChips: [],
      serviceKey: 'cockroach_control',
      serviceLabel: 'Cockroach Control Service',
      visitSequence: 1,
      activity: null,
    });
    const keys = snapshot.findings.map((f) => f.fieldKey);
    expect(keys).toContain('activity_level');
    expect(keys).not.toContain('areas_inspected');
    expect(keys).not.toContain('harborage_locations');
  });
});

describe('findingsSchemaForType', () => {
  test('embeds fields, required flags, and gauge config for the client', () => {
    const schema = findingsSchemaForType('cockroach');
    expect(schema.type).toBe('cockroach');
    const species = schema.fields.find((f) => f.key === 'species');
    expect(species.required).toBe(true);
    expect(schema.requiredFields).toEqual(['species', 'activity_level']);
    expect(schema.activity.indicatorKey).toBe('roach_activity');
    expect(schema.activity.deriveField).toBe('activity_level');
    expect(schema.photoCategories).toContain('kitchen');
  });

  test('returns null gauge config for non-gauge types and null for unknown types', () => {
    expect(findingsSchemaForType('mosquito_event').activity).toBeNull();
    expect(findingsSchemaForType('not_a_type')).toBeNull();
  });
});

describe('banned customer copy', () => {
  const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');

  test('flags absolute and promissory claims', () => {
    expect(findBannedCustomerCopy('The roaches have been eliminated.')).toContain('eliminated');
    expect(findBannedCustomerCopy('We guarantee your home is pest-free!').length).toBeGreaterThanOrEqual(2);
    expect(findBannedCustomerCopy('All clear — no infestation remains.').length).toBeGreaterThanOrEqual(2);
    expect(findBannedCustomerCopy('The treated areas are clear.').length).toBeGreaterThanOrEqual(1);
    expect(findBannedCustomerCopy('Activity cleared after service.')).toContain('cleared');
    expect(findBannedCustomerCopy('Your kitchen is now clear of roaches.').length).toBeGreaterThanOrEqual(1);
    expect(findBannedCustomerCopy('The problem is gone for good.')).toContain('gone');
    expect(findBannedCustomerCopy('The issue is resolved.')).toContain('resolved');
    expect(findBannedCustomerCopy('Activity is gone.')).toContain('gone');
  });

  test('allows observational wording and legitimate sanitation advice', () => {
    expect(findBannedCustomerCopy('No active signs observed in accessible areas today.')).toEqual([]);
    expect(findBannedCustomerCopy('Please clear food debris from under the fridge.')).toEqual([]);
    expect(findBannedCustomerCopy('Activity has decreased since our last visit.')).toEqual([]);
    expect(findBannedCustomerCopy('Keep counters clear of food debris.')).toEqual([]);
    expect(findBannedCustomerCopy('Keep vegetation clear of the foundation.')).toEqual([]);
  });
});

describe('rodent trapping sectioned checklist (schema v2)', () => {
  const V2_VALUES = {
    species: 'Roof rat',
    evidence_observed: 'Droppings, Gnaw marks, Noises reported by customer',
    traps_checked: '8',
    captures: '2',
    trap_actions: 'Traps reset, Bait/lure refreshed',
    trap_activity_locations: 'Attic near A/C plenum',
    trap_quiet_locations: 'Garage, crawlspace',
    conducive_conditions: 'A/C line penetrations, Garage door seal gaps, Pet food / bird seed accessible',
    work_completed: 'Traps checked, Captures removed, Exterior inspection completed',
    sanitation_recommendations: 'Remove pet food overnight, Reduce garage clutter',
    exclusion_recommendation: 'Recommended after activity stops',
    exclusion_notes: 'A/C line gap, garage door corner',
    customer_reported: 'Heard noises in attic',
    customer_discussed: 'Informed of capture(s), Reviewed exclusion recommendation',
  };

  test('chips fields validate each element against options', () => {
    const ok = validateTypedFindings({
      type: 'rodent_trapping',
      values: V2_VALUES,
      expectedType: 'rodent_trapping',
      enforceRequired: true,
    });
    expect(ok.ok).toBe(true);

    const bad = validateTypedFindings({
      type: 'rodent_trapping',
      values: { ...V2_VALUES, evidence_observed: 'Droppings, Customer was rude' },
      expectedType: 'rodent_trapping',
      enforceRequired: true,
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toContain('Customer was rude');
  });

  test('count fields reject non-integers and negatives', () => {
    for (const invalid of ['-1', '2.5', 'eight', '10000']) {
      const result = validateTypedFindings({
        type: 'rodent_trapping',
        values: { species: 'Roof rat', traps_checked: invalid },
        expectedType: 'rodent_trapping',
        enforceRequired: true,
      });
      expect(result.ok).toBe(false);
    }
    const zero = validateTypedFindings({
      type: 'rodent_trapping',
      values: { species: 'Roof rat', captures: '0' },
      expectedType: 'rodent_trapping',
      enforceRequired: true,
    });
    expect(zero.ok).toBe(true);
  });

  test('snapshot composes trap sentence from counts + actions, maps exclusion copy', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      serviceKey: 'rodent_trapping_check',
      serviceLabel: 'Rodent Trapping',
      values: V2_VALUES,
      nextStepChips: ['Continue trapping', 'Await exclusion approval'],
      visitSequence: 2,
      activity: {
        indicatorKey: 'rodent_activity',
        label: 'Rodent Activity',
        score: 2,
        source: 'tech',
        trend: 'improving',
        trendWord: 'decreased',
      },
    });
    expect(snapshot.todaysResult.headline).toBe('Rodent activity has decreased since our last visit.');
    expect(snapshot.todaysResult.body).toContain('checked 8 traps');
    expect(snapshot.todaysResult.body).toContain('removed 2 captures');
    expect(snapshot.todaysResult.body).toContain('refreshed the bait');
    expect(snapshot.todaysResult.nextStep).toContain('Trapping will continue until activity is reduced.');

    const exclusion = snapshot.findings.find((f) => f.fieldKey === 'exclusion_recommendation');
    expect(exclusion.customerValueLabel).toBe('Exclusion repairs are recommended to reduce rodent access once trapping activity stops.');
    expect(exclusion.customerValueLabel).not.toMatch(/rodent[\s-]?proof/i);

    const evidence = snapshot.findings.find((f) => f.fieldKey === 'evidence_observed');
    expect(evidence.customerLabel).toBe('Evidence observed today');
    expect(evidence.customerValueLabel).toBe('Droppings, Gnaw marks, Noises reported by customer');

    for (const item of snapshot.findings) {
      expect(findBannedCustomerCopy(String(item.customerValueLabel))).toEqual([]);
    }
    expect(findBannedCustomerCopy(snapshot.todaysResult.headline)).toEqual([]);
    expect(findBannedCustomerCopy(snapshot.todaysResult.body)).toEqual([]);
  });

  test('zero captures reads as "found no new captures" alongside checked traps', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      serviceKey: 'rodent_trapping_check',
      serviceLabel: 'Rodent Trapping',
      values: { species: 'Roof rat', traps_checked: '6', captures: '0' },
      nextStepChips: ['Monitor after no activity'],
      visitSequence: 3,
      activity: {
        indicatorKey: 'rodent_activity',
        label: 'Rodent Activity',
        score: 0,
        source: 'tech',
        trend: 'improving',
        trendWord: 'decreased',
      },
    });
    expect(snapshot.todaysResult.body).toContain('checked 6 traps');
    expect(snapshot.todaysResult.body).toContain('found no new captures');
  });

  test('"rodent-proof" is banned customer copy in every spelling', () => {
    expect(findBannedCustomerCopy('Your home is now rodent-proof.')).not.toEqual([]);
    expect(findBannedCustomerCopy('This makes the home rodent proof.')).not.toEqual([]);
    expect(findBannedCustomerCopy('We will rodentproof the soffits.')).not.toEqual([]);
    expect(findBannedCustomerCopy('Exclusion repairs are recommended to reduce rodent access.')).toEqual([]);
  });

  test('schema slice carries sections and the required next step flag', () => {
    const schema = findingsSchemaForType('rodent_trapping');
    expect(schema.nextStepRequired).toBe(true);
    expect(nextStepRequiredForType('cockroach')).toBe(false);
    const sections = [...new Set(schema.fields.map((f) => f.section))];
    expect(sections).toEqual([
      'Evidence observed', 'Trap activity', 'Conducive conditions',
      'Work completed', 'Recommendations', 'Customer communication',
    ]);
    expect(schema.nextStepChips).toContain('Continue trapping');
    expect(schema.nextStepChips).toContain('Remove traps after inactivity');
    const chips = schema.fields.filter((f) => f.type === 'chips');
    expect(chips.length).toBeGreaterThanOrEqual(6);
    for (const field of chips) {
      expect(Array.isArray(field.options)).toBe(true);
      expect(field.options.length).toBeGreaterThan(0);
    }
  });
});

describe('chips storage safety', () => {
  // chips persist as a comma-joined string — a comma INSIDE an option value
  // would shatter on the validation round-trip and reject the completion
  // (Codex P2 on #1646). Registry-wide guard.
  test('no chips option in any type contains a comma', () => {
    for (const [type, cfg] of Object.entries(PROJECT_TYPES)) {
      for (const field of cfg.findingsFields || []) {
        if (field.type !== 'chips') continue;
        for (const option of field.options || []) {
          expect({ type, field: field.key, option, hasComma: option.includes(',') })
            .toEqual({ type, field: field.key, option, hasComma: false });
        }
      }
    }
  });
});
