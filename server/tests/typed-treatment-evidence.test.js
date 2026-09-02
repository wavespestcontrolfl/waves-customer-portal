'use strict';

const { PROJECT_TYPES } = require('../services/project-types');
const { TYPED_TREATMENT_OPTIONS, typedTreatmentEvidence, typedTreatmentEvidenceForRecord } = require('../services/service-report/activity-indicators');

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
        [...applied, ...performed, ...noWork].forEach((label) => expect(field.options).toContain(label));
        nonSpray.forEach((label) => expect(applied).toContain(label));
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
      .toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true });
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Inspection / identification only' }))
      .toEqual({ applied: false, performed: false, noWork: true, dryDown: false, declared: true });
    // Bait and injection are applications but never dry-down evidence.
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Bait placement' }))
      .toEqual({ applied: true, performed: true, noWork: false, dryDown: false, declared: true });
    expect(typedTreatmentEvidence('palm_injection', { work_completed: 'Palm injection completed' }))
      .toEqual({ applied: true, performed: true, noWork: false, dryDown: false, declared: true });
    expect(typedTreatmentEvidence('german_roach_knockdown', { treatment_completed: 'Gel bait, Dust application' }).dryDown).toBe(true);
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Inspection / identification only, Nest treated' }))
      .toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true });
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Mechanical removal / vacuuming' }))
      .toEqual({ applied: false, performed: true, noWork: false, dryDown: false, declared: true });
    expect(typedTreatmentEvidence('bed_bug', { treatment_method: 'Heat only', work_completed: 'Vacuuming completed' }))
      .toEqual({ applied: false, performed: true, noWork: false, dryDown: false, declared: true });
    expect(typedTreatmentEvidence('bed_bug', { treatment_method: 'Chemical + heat' }))
      .toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true });
    expect(typedTreatmentEvidence('termite_treatment', { treatment_method: 'Bait station setup' }))
      .toEqual({ applied: false, performed: false, noWork: true, dryDown: false, declared: true });
    expect(typedTreatmentEvidence('termite_treatment', { treatment_method: 'Cartridge replacement' }).noWork).toBe(true);
    expect(typedTreatmentEvidence('termite_treatment', { treatment_method: 'Trenching' }))
      .toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true });
    expect(typedTreatmentEvidence('pest_inspection', { findings_observed: 'anything' }))
      .toEqual({ applied: false, performed: false, noWork: false, dryDown: false, declared: false });
    expect(typedTreatmentEvidence(null, null)).toEqual({ applied: false, performed: false, noWork: false, dryDown: false, declared: false });
  });

  test('combined visits aggregate the primary and companion snapshots', () => {
    const record = { service_data: {
      typedReportSnapshot: { type: 'one_time_lawn_treatment', values: { work_completed: 'Inspection completed' } },
      companionReportSnapshots: [{ type: 'tree_shrub', values: { treatments_completed: 'Insect treatment' } }],
    } };
    expect(typedTreatmentEvidenceForRecord(record)).toMatchObject({ applied: true, performed: true, noWork: false, dryDown: true, declared: true });
    expect(typedTreatmentEvidenceForRecord({ service_data: JSON.stringify({
      typedReportSnapshot: { type: 'one_time_lawn_treatment', values: { work_completed: 'Inspection completed' } },
      companionReportSnapshots: [{ type: 'tree_shrub', values: { treatments_completed: 'Inspection only' } }],
    }) })).toEqual({ applied: false, performed: false, dryDown: false, declared: true, noWork: true });
    expect(typedTreatmentEvidenceForRecord({ service_data: {} })).toEqual({ applied: false, performed: false, dryDown: false, declared: false, noWork: false });
  });
});
