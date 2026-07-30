/**
 * Assessment visits must display under their real admin-catalog name,
 * "Waves Assessment" — the old normalized label "Property Assessment" was
 * not a catalog service and confused the schedule views (owner report
 * 2026-07-30: a booked Waves Assessment rendered as a service that does
 * not exist).
 */

const { normalizeServiceType } = require('../utils/service-normalizer');

describe('assessment display label', () => {
  test('catalog name passes through unchanged', () => {
    expect(normalizeServiceType('Waves Assessment')).toBe('Waves Assessment');
  });

  test('estimate/assessment/consultation raw labels normalize to the catalog name', () => {
    expect(normalizeServiceType('Property Assessment')).toBe('Waves Assessment');
    expect(normalizeServiceType('In-person estimate')).toBe('Waves Assessment');
    expect(normalizeServiceType('Consultation - 30 min')).toBe('Waves Assessment');
  });
});
