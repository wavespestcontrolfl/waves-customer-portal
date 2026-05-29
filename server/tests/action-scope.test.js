const { classifyActionScope, scopeFromText, isNonTreatmentText } = require('../services/service-report/action-scope');

describe('classifyActionScope', () => {
  test('interior treatment label', () => {
    expect(classifyActionScope('Applied interior treatment')).toEqual({ scope: 'interior', treatmentApplied: true });
    expect(classifyActionScope('Gel bait in kitchen, bath, voids')).toEqual({ scope: 'interior', treatmentApplied: true });
    expect(classifyActionScope('Crack and crevice treatment')).toEqual({ scope: 'interior', treatmentApplied: true });
  });

  test('exterior treatment label', () => {
    expect(classifyActionScope('Applied non-repellent solutions (exterior)')).toEqual({ scope: 'exterior', treatmentApplied: true });
    expect(classifyActionScope('Exterior perimeter band')).toEqual({ scope: 'exterior', treatmentApplied: true });
  });

  test('inspection is not a treatment, even when interior', () => {
    expect(classifyActionScope('Interior inspection')).toEqual({ scope: 'interior', treatmentApplied: false });
    expect(classifyActionScope('Monitored interior bait stations')).toEqual({ scope: 'interior', treatmentApplied: false });
  });

  test('declined / no-access interior is not a treatment', () => {
    expect(classifyActionScope('Customer declined interior treatment')).toMatchObject({ scope: 'interior', treatmentApplied: false });
    expect(classifyActionScope('Interior — no access')).toMatchObject({ scope: 'interior', treatmentApplied: false });
  });

  test('prioritizes interior on a mixed line', () => {
    expect(scopeFromText('Exterior/interior non-repellent treatment for ghost ants')).toBe('interior');
  });

  test('no scope keyword → null, not a treatment', () => {
    expect(classifyActionScope('Completed protocol item')).toEqual({ scope: null, treatmentApplied: false });
    expect(classifyActionScope('')).toEqual({ scope: null, treatmentApplied: false });
    expect(classifyActionScope(null)).toEqual({ scope: null, treatmentApplied: false });
  });

  test('isNonTreatmentText flags inspection/monitor language', () => {
    expect(isNonTreatmentText('Interior inspection')).toBe(true);
    expect(isNonTreatmentText('Applied interior treatment')).toBe(false);
  });
});
