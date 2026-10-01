'use strict';

const { PROJECT_TYPES } = require('../services/project-types');
const {
  TYPED_TREATMENT_OPTIONS, typedTreatmentEvidence, typedTreatmentEvidenceForRecord, projectPoisonControl,
  projectPrimaryApplication,
} = require('../services/service-report/activity-indicators');

describe('typed treatment evidence', () => {
  test('every classified option exists in its typed field and no field is double-classified', () => {
    for (const [type, fields] of Object.entries(TYPED_TREATMENT_OPTIONS)) {
      for (const [key, lists] of Object.entries(fields)) {
        const field = PROJECT_TYPES[type].findingsFields.find((f) => f.key === key);
        expect(field).toBeDefined();
        const applied = lists.applied || [];
        const performed = lists.performed || [];
        const noWork = lists.noWork || [];
        const nonSpray = lists.nonSpray || [];
        const wait = lists.wait || [];
        [...applied, ...performed, ...noWork].forEach((label) => expect(field.options).toContain(label));
        nonSpray.forEach((label) => expect(applied).toContain(label));
        wait.forEach((label) => expect(performed).toContain(label));
        expect(applied.filter((label) => performed.includes(label) || noWork.includes(label))).toEqual([]);
        expect(performed.filter((label) => noWork.includes(label))).toEqual([]);
      }
    }
  });

  test('inspection-only style options never count as treatment', () => {
    for (const [type, fields] of Object.entries(TYPED_TREATMENT_OPTIONS)) {
      for (const [key, lists] of Object.entries(fields)) {
        const field = PROJECT_TYPES[type].findingsFields.find((f) => f.key === key);
        const classified = new Set([...(lists.applied || []), ...(lists.performed || [])]);
        field.options
          .filter((label) => /inspection|monitor|glue board|photos|flagged|deferred|not applicable|recommended|interceptor/i.test(label))
          .forEach((label) => expect(classified.has(label)).toBe(false));
      }
    }
  });

  test('a productless typed closeout with an application-bearing option is an application', () => {
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Exterior perimeter application, Nest treated' }))
      .toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true, reentryWait: false });
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Inspection / identification only' }))
      .toEqual({ applied: false, performed: false, noWork: true, dryDown: false, declared: true, reentryWait: false });
    // Bait and injection are applications but never dry-down evidence.
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Bait placement' }))
      .toEqual({ applied: true, performed: true, noWork: false, dryDown: false, declared: true, reentryWait: false });
    expect(typedTreatmentEvidence('palm_injection', { work_completed: 'Palm injection completed' }))
      .toEqual({ applied: true, performed: true, noWork: false, dryDown: false, declared: true, reentryWait: false });
    expect(typedTreatmentEvidence('german_roach_knockdown', { treatment_completed: 'Gel bait, Dust application' }).dryDown).toBe(true);
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Inspection / identification only, Nest treated' }))
      .toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true, reentryWait: false });
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Mechanical removal / vacuuming' }))
      .toEqual({ applied: false, performed: true, noWork: false, dryDown: false, declared: true, reentryWait: false });
    expect(typedTreatmentEvidence('bed_bug', { treatment_method: 'Heat only', work_completed: 'Vacuuming completed' }))
      .toEqual({ applied: false, performed: true, noWork: false, dryDown: false, declared: true, reentryWait: true });
    expect(typedTreatmentEvidence('bed_bug', { work_completed: 'Steam treatment' }).reentryWait).toBe(true);
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Mechanical removal / vacuuming' }).reentryWait).toBe(false);
    expect(typedTreatmentEvidence('bed_bug', { treatment_method: 'Chemical + heat' }))
      .toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true, reentryWait: false });
    expect(typedTreatmentEvidence('termite_treatment', { treatment_method: 'Bait station setup' }))
      .toEqual({ applied: false, performed: false, noWork: true, dryDown: false, declared: true, reentryWait: false });
    expect(typedTreatmentEvidence('termite_treatment', { treatment_method: 'Cartridge replacement' }).noWork).toBe(true);
    expect(typedTreatmentEvidence('termite_treatment', { treatment_method: 'Trenching' }))
      .toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true, reentryWait: false });
    expect(typedTreatmentEvidence('pest_inspection', { findings_observed: 'anything' }))
      .toEqual({ applied: false, performed: false, noWork: false, dryDown: false, declared: false, reentryWait: false });
    expect(typedTreatmentEvidence(null, null)).toEqual({ applied: false, performed: false, noWork: false, dryDown: false, declared: false, reentryWait: false });
  });

  test('combined visits aggregate the primary and companion snapshots', () => {
    const record = { service_data: {
      typedReportSnapshot: { type: 'one_time_lawn_treatment', values: { work_completed: 'Inspection completed' } },
      companionReportSnapshots: [{ type: 'tree_shrub', values: { treatments_completed: 'Insect treatment' } }],
    } };
    expect(typedTreatmentEvidenceForRecord(record)).toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true, reentryWait: false });
    expect(typedTreatmentEvidenceForRecord({ service_data: JSON.stringify({
      typedReportSnapshot: { type: 'one_time_lawn_treatment', values: { work_completed: 'Inspection completed' } },
      companionReportSnapshots: [{ type: 'tree_shrub', values: { treatments_completed: 'Inspection only' } }],
    }) })).toEqual({ applied: false, performed: false, dryDown: false, reentryWait: false, declared: true, noWork: true });
    expect(typedTreatmentEvidenceForRecord({ service_data: {} })).toEqual({ applied: false, performed: false, dryDown: false, reentryWait: false, declared: false, noWork: false });
  });
});

describe('project Poison Control eligibility (activity-indicators.projectPoisonControl)', () => {
  test('device-only termite work is never eligible, even with an EPA reg. no. on file', () => {
    // admin-projects.js requires epa_registration for EVERY termite_treatment
    // send, including device-only visits — recording it is not itself a
    // treatment signal (the bug this replaces read it as one).
    expect(projectPoisonControl('termite_treatment', { treatment_method: 'Cartridge replacement', epa_registration: '12345-6' })).toBe(false);
    expect(projectPoisonControl('termite_treatment', { treatment_method: 'Bait station setup', epa_registration: '12345-6' })).toBe(false);
  });

  test('a liquid termite method is eligible', () => {
    expect(projectPoisonControl('termite_treatment', { treatment_method: 'Trenching', epa_registration: '12345-6' })).toBe(true);
  });

  test('flea "Inspection only" is never eligible', () => {
    expect(projectPoisonControl('flea', { treatment_completed: 'Inspection only' })).toBe(false);
  });

  test('flea with an applied treatment is eligible', () => {
    expect(projectPoisonControl('flea', { treatment_completed: 'Exterior flea treatment' })).toBe(true);
  });

  test('rodent_bait_station is always eligible — stations hold rodenticide though servicing one is not an "application"', () => {
    expect(projectPoisonControl('rodent_bait_station', {}, null)).toBe(true);
    expect(projectPoisonControl('rodent_bait_station', null, null)).toBe(true);
  });

  test('wdo_inspection and pre_treatment_termite_certificate are never eligible', () => {
    expect(projectPoisonControl('wdo_inspection', { wdo_finding: 'Live termites observed' })).toBe(false);
    expect(projectPoisonControl('pre_treatment_termite_certificate', { treatment_method: 'Soil barrier (chemical)' })).toBe(false);
  });

  test('a bed-bug primary visit with no application still counts eligible from its follow-up', () => {
    const findings = { treatment_method: 'Inspection / monitoring only' };
    const followupFindings = { treatment_method: 'Chemical only' };
    expect(projectPoisonControl('bed_bug', findings, null)).toBe(false);
    expect(projectPoisonControl('bed_bug', findings, followupFindings)).toBe(true);
  });

  test('sanitation is outside the canonical application verdict, so it never qualifies', () => {
    expect(projectPoisonControl('rodent_sanitation', { sanitation_work_completed: 'Disinfected / sanitized affected areas' })).toBe(false);
  });

  test('the applicator belongs to the primary visit: a follow-up-only application is not a primary one', () => {
    expect(projectPrimaryApplication('bed_bug', { treatment_method: 'Heat only' })).toBe(false);
    expect(projectPrimaryApplication('bed_bug', { treatment_method: 'Chemical only' })).toBe(true);
    // a bait-station check keeps Poison Control but applied nothing, so it
    // names no applicator (codex r4)
    expect(projectPoisonControl('rodent_bait_station', {})).toBe(true);
    expect(projectPrimaryApplication('rodent_bait_station', { bait_replaced: 'Yes' })).toBe(false);
  });

  test('accepts findings/followup_findings as JSON strings (jsonb round-trip)', () => {
    expect(projectPoisonControl('flea', JSON.stringify({ treatment_completed: 'Exterior flea treatment' }))).toBe(true);
    expect(projectPoisonControl('flea', 'not json', JSON.stringify({ treatment_completed: 'Exterior flea treatment' }))).toBe(true);
  });
});
