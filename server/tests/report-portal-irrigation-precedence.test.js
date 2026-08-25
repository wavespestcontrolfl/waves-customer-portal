/**
 * Mixed-source irrigation precedence — the customer's portal schedule
 * (explicit inches, or the figure derived from minutes × days × head type)
 * outranks technician turf/assessment readings everywhere a report reads
 * irrigation, so the lawn-profile figure and the water balance can never
 * come from different sources (pre-push audit P1 on 9a2c33a2a).
 */
const { buildLawnWaterContext, portalIrrigationInches } = require('../services/service-report/report-data');

const DERIVED_PREFS = {
  // 20 min × 4 days on spray (1.5"/hr) → 2.00"
  irrigation_inches_per_week: null,
  irrigation_run_minutes: 20,
  watering_days: ['Mon', 'Wed', 'Fri', 'Sun'],
  irrigation_system_type: ['spray'],
};

describe('portalIrrigationInches', () => {
  test('explicit portal inches outrank the derived figure', () => {
    expect(portalIrrigationInches({ ...DERIVED_PREFS, irrigation_inches_per_week: '1.25' })).toBe(1.25);
  });

  test('derives from runtime entries when inches are blank', () => {
    expect(portalIrrigationInches(DERIVED_PREFS)).toBe(2);
  });

  test('declines to null when derivation cannot be honest', () => {
    expect(portalIrrigationInches({ ...DERIVED_PREFS, irrigation_system_type: ['spray', 'rotor'] })).toBeNull();
    expect(portalIrrigationInches(null)).toBeNull();
  });
});

describe('mixed sources agree across the report', () => {
  test('derived portal schedule beats turf and assessment readings in the water balance', () => {
    const ctx = buildLawnWaterContext({
      assessment: { irrigation_inches_per_week: '0.4' },
      turfProfile: { irrigation_inches_per_week: '0.75' },
      propertyPrefs: DERIVED_PREFS,
    });
    expect(ctx.irrigationInchesPerWeek).toBe(2);
  });

  test('tech readings still fill in when the portal has nothing usable', () => {
    const ctx = buildLawnWaterContext({
      assessment: { irrigation_inches_per_week: '0.4' },
      turfProfile: { irrigation_inches_per_week: '0.75' },
      propertyPrefs: { ...DERIVED_PREFS, irrigation_run_minutes: null },
    });
    expect(ctx.irrigationInchesPerWeek).toBe(0.75);
  });
});
