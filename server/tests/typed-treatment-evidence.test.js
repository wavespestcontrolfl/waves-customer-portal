'use strict';

const { PROJECT_TYPES } = require('../services/project-types');
const { TYPED_TREATMENT_OPTIONS, typedTreatmentEvidence } = require('../services/service-report/activity-indicators');

describe('typed treatment evidence', () => {
  test('every classified option exists in its typed field and no field is double-classified', () => {
    for (const [type, fields] of Object.entries(TYPED_TREATMENT_OPTIONS)) {
      for (const [key, lists] of Object.entries(fields)) {
        const field = PROJECT_TYPES[type].findingsFields.find((f) => f.key === key);
        expect(field).toBeDefined();
        const applied = lists.applied || [];
        const performed = lists.performed || [];
        [...applied, ...performed].forEach((label) => expect(field.options).toContain(label));
        expect(applied.filter((label) => performed.includes(label))).toEqual([]);
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
      .toEqual({ applied: true, performed: true });
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Inspection / identification only' }))
      .toEqual({ applied: false, performed: false });
    expect(typedTreatmentEvidence('one_time_pest_treatment', { work_completed: 'Mechanical removal / vacuuming' }))
      .toEqual({ applied: false, performed: true });
    expect(typedTreatmentEvidence('bed_bug', { treatment_method: 'Heat only', work_completed: 'Vacuuming completed' }))
      .toEqual({ applied: false, performed: true });
    expect(typedTreatmentEvidence('bed_bug', { treatment_method: 'Chemical + heat' }))
      .toEqual({ applied: true, performed: true });
    expect(typedTreatmentEvidence('termite_treatment', { treatment_method: 'Bait station setup' }))
      .toEqual({ applied: false, performed: false });
    expect(typedTreatmentEvidence('termite_treatment', { treatment_method: 'Trenching' }))
      .toEqual({ applied: true, performed: true });
    expect(typedTreatmentEvidence('pest_inspection', { findings_observed: 'anything' }))
      .toEqual({ applied: false, performed: false });
    expect(typedTreatmentEvidence(null, null)).toEqual({ applied: false, performed: false });
  });
});
