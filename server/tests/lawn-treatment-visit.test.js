const { isLawnTreatmentServiceType, isLawnTreatmentVisit } = require('../services/lawn-treatment-visit');

describe('lawn treatment visit', () => {
  test('a recurring or one-time lawn treatment is a lawn treatment visit', () => {
    expect(isLawnTreatmentServiceType('Every 6 Weeks Lawn Care Service')).toBe(true);
    expect(isLawnTreatmentServiceType('Monthly Lawn Care Service')).toBe(true);
    expect(isLawnTreatmentServiceType('One-Time Lawn Treatment')).toBe(true);
  });

  test('lawn work that applies no product, and an inspection-only or assessment-only name, is not', () => {
    for (const name of ['Lawn Dethatching', 'Lawn Plugging', 'Lawn Top Dressing', 'Lawn Health Inspection', 'Lawn Assessment']) {
      expect(isLawnTreatmentServiceType(name)).toBe(false);
    }
  });

  test('an inspection word beside a treatment cue keeps the visit', () => {
    expect(isLawnTreatmentServiceType('Lawn Treatment & Inspection')).toBe(true);
  });

  test('a service with no lawn word, or no name, is not', () => {
    expect(isLawnTreatmentServiceType('Quarterly Pest Control Service')).toBe(false);
    expect(isLawnTreatmentServiceType('')).toBe(false);
    expect(isLawnTreatmentServiceType(null)).toBe(false);
  });

  test('a grouped stop is judged one member at a time', () => {
    expect(isLawnTreatmentVisit(['Quarterly Pest Control Service', 'Every 6 Weeks Lawn Care Service'])).toBe(true);
    expect(isLawnTreatmentVisit(['Termite Inspection', 'Every 6 Weeks Lawn Care Service'])).toBe(true);
    expect(isLawnTreatmentVisit(['Quarterly Pest Control Service'])).toBe(false);
    expect(isLawnTreatmentVisit([])).toBe(false);
    expect(isLawnTreatmentVisit('Monthly Lawn Care Service')).toBe(true);
  });
});
