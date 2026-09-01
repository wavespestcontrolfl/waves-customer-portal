const { PROJECT_TYPES, TERMITE_PERIMETER_METHODS } = require('../services/project-types');
const { validateTypedFindings } = require('../services/service-report/activity-indicators');

function validate(type, values) {
  return validateTypedFindings({ type, values, expectedType: type, enforceRequired: false });
}

describe('editable service-report findings consistency', () => {
  test.each(Object.entries({
    termite_inspection: 'activity_status',
    pest_inspection: 'findings_observed',
    flea: 'evidence_level',
    cockroach: 'evidence_observed',
    german_roach_knockdown: 'activity_level',
    palmetto_roach_knockdown: 'activity_level',
    rodent_exclusion: 'remaining_concerns',
    rodent_sanitation: 'contamination_level',
    rodent_inspection: 'evidence_observed',
    rodent_trapping: 'evidence_observed',
    rodent_bait_station: 'evidence_observed',
    wildlife_trapping: 'evidence_observed',
    one_time_pest_treatment: 'pests_observed',
    one_time_lawn_treatment: 'turf_issues',
    mosquito_event: 'activity_level',
    palm_injection: 'condition_observations',
    tree_shrub: 'landscape_condition',
    termite_treatment: 'termite_evidence',
    termite_bait_station: 'termite_activity',
    bed_bug: 'evidence_observed',
  }))('%s has a structured findings or condition field', (type, fieldKey) => {
    const field = PROJECT_TYPES[type].findingsFields.find(({ key }) => key === fieldKey);
    expect(field).toBeDefined();
    expect(['select', 'chips', 'multi_select']).toContain(field.type);
  });

  test.each([
    ['pest_inspection', { findings_observed: 'No live activity observed, Active pest activity' }],
    ['cockroach', { activity_level: 'None observed', activity_locations: 'Kitchen' }],
    ['mosquito_event', { activity_level: 'None observed', activity_locations: 'Backyard' }],
    ['bed_bug', { evidence_level: 'No active signs observed', evidence_observed: 'Live bed bugs' }],
    ['bed_bug', { evidence_observed: 'No visible evidence, Cast skins' }],
    ['one_time_pest_treatment', { pests_observed: 'No pest activity observed, Fire ants' }],
    ['one_time_pest_treatment', { evidence_observed: 'No evidence observed, Live pests observed' }],
    ['one_time_pest_treatment', { work_completed: 'Inspection / identification only, Bait placement' }],
    ['one_time_pest_treatment', { work_completed: 'Treatment deferred, Exterior perimeter application' }],
    ['termite_treatment', { termite_evidence: 'Preventive treatment — no activity observed, Live termites observed' }],
    ['palm_injection', { pest_disease_signs: 'None observed today, Scale' }],
  ])('%s rejects a zero-state paired with positive technician evidence', (type, values) => {
    expect(validate(type, values).ok).toBe(false);
  });

  test('customer-reported activity remains compatible with no technician-observed evidence', () => {
    expect(validate('one_time_pest_treatment', {
      activity_level: 'None observed',
      pests_observed: 'Customer-reported activity only, No pest activity observed',
      evidence_observed: 'Customer-reported activity only, No evidence observed',
    }).ok).toBe(true);
  });

  test('one-time pest and standard termite reports have dedicated findings dropdowns', () => {
    const oneTimeKeys = new Set(PROJECT_TYPES.one_time_pest_treatment.findingsFields.map(({ key }) => key));
    expect(oneTimeKeys.has('pests_observed')).toBe(true);
    expect(oneTimeKeys.has('evidence_observed')).toBe(true);
    const termiteEvidence = PROJECT_TYPES.termite_treatment.findingsFields.find(({ key }) => key === 'termite_evidence');
    expect(termiteEvidence?.type).toBe('chips');
    expect(termiteEvidence.options).toContain('Preventive treatment — no activity observed');
  });

  test('rodding carries the termite perimeter posted-notice classification', () => {
    expect(TERMITE_PERIMETER_METHODS).toContain('Rodding');
  });

  test('general one-time pest work uses controlled, field-accurate protocol choices', () => {
    const fields = PROJECT_TYPES.one_time_pest_treatment.findingsFields;
    const work = fields.find(({ key }) => key === 'work_completed');
    expect(work?.type).toBe('chips');
    expect(work.options).toEqual(expect.arrayContaining([
      'Exterior perimeter application',
      'Interior crack & crevice application',
      'Bait placement',
      'Nest treated',
      'Individual mound treatment',
      'Broadcast lawn application',
      'Monitoring devices installed or checked',
    ]));
    expect(fields.find(({ key }) => key === 'treatment_performed')).toEqual(expect.objectContaining({
      detail: true,
      label: 'Additional work details',
    }));
  });

  test('general one-time pest requires a performed-work lane at closeout', () => {
    expect(validateTypedFindings({
      type: 'one_time_pest_treatment',
      expectedType: 'one_time_pest_treatment',
      values: { activity_level: 'Low' },
      enforceRequired: true,
    }).ok).toBe(false);
    expect(validateTypedFindings({
      type: 'one_time_pest_treatment',
      expectedType: 'one_time_pest_treatment',
      values: { activity_level: 'Low', work_completed: 'Targeted spot treatment' },
      enforceRequired: true,
    }).ok).toBe(true);
  });

  test('bed-bug treatment methods describe the heat/hybrid service model', () => {
    const method = PROJECT_TYPES.bed_bug.findingsFields.find(({ key }) => key === 'treatment_method');
    expect(method?.options).toEqual(expect.arrayContaining([
      'Heat treatment',
      'Hybrid heat + chemical treatment',
      'Chemical / IPM treatment',
      'Targeted follow-up treatment',
      'Inspection / monitoring only',
    ]));
    expect(method?.options).toEqual(expect.arrayContaining([
      'Chemical only', 'Heat only', 'Chemical + heat', 'Steam + chemical',
    ]));
  });

  test('protected report schemas are not part of this findings pass', () => {
    expect(PROJECT_TYPES.wdo_inspection).toBeDefined();
    expect(PROJECT_TYPES.pre_treatment_termite_certificate).toBeDefined();
  });
});
