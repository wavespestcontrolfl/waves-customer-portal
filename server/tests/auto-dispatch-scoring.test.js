const { scoreAppointmentPlacement, weekdayOf } = require('../services/auto-dispatch/scoring');
const { TIME_WINDOWS } = require('../services/auto-dispatch/service-category');

const NEUTRAL_PREFS = {
  preferred_day_indexes: [],
  effective_time_window: null,
  preferred_time_window: null,
  blackout: null,
};

function placement(overrides = {}) {
  return {
    is_current: false,
    detour_minutes: 10,
    stops_that_day: 4,
    technician_id: 't1',
    date: '2026-08-04', // a Tuesday
    start_time: '08:00',
    capability_level: 'qualified',
    ...overrides,
  };
}

describe('weekdayOf', () => {
  test('computes calendar weekday tz-independently', () => {
    expect(weekdayOf('2026-08-04')).toBe(2); // Tuesday
    expect(weekdayOf('2026-08-02')).toBe(0); // Sunday
  });
});

describe('scoreAppointmentPlacement', () => {
  test('lower detour scores higher on route efficiency', () => {
    const low = scoreAppointmentPlacement(placement({ detour_minutes: 0 }), NEUTRAL_PREFS, {});
    const high = scoreAppointmentPlacement(placement({ detour_minutes: 40 }), NEUTRAL_PREFS, {});
    expect(low.route_efficiency_score).toBeGreaterThan(high.route_efficiency_score);
    expect(low.total_score).toBeGreaterThan(high.total_score);
  });

  test('matching preferred day adds preference credit + reason', () => {
    const prefs = { ...NEUTRAL_PREFS, preferred_day_indexes: [2] }; // Tuesday
    const onPref = scoreAppointmentPlacement(placement({ date: '2026-08-04' }), prefs, {});
    const offPref = scoreAppointmentPlacement(placement({ date: '2026-08-05' }), prefs, {}); // Wednesday
    expect(onPref.reason_codes).toContain('MATCHES_PREFERRED_DAY');
    expect(onPref.customer_preference_score).toBeGreaterThan(offPref.customer_preference_score);
  });

  test('start time inside the effective window scores full time credit', () => {
    const prefs = { ...NEUTRAL_PREFS, effective_time_window: TIME_WINDOWS.early_morning, preferred_time_window: TIME_WINDOWS.early_morning };
    const inWin = scoreAppointmentPlacement(placement({ start_time: '08:30' }), prefs, {});
    const outWin = scoreAppointmentPlacement(placement({ start_time: '15:00' }), prefs, {});
    expect(inWin.reason_codes).toContain('MATCHES_PREFERRED_TIME');
    expect(inWin.customer_preference_score).toBeGreaterThan(outWin.customer_preference_score);
  });

  test('service-time default match is flagged distinctly from explicit pref', () => {
    const prefs = { ...NEUTRAL_PREFS, effective_time_window: TIME_WINDOWS.early_morning, preferred_time_window: null };
    const r = scoreAppointmentPlacement(placement({ start_time: '08:30' }), prefs, {});
    expect(r.reason_codes).toContain('MATCHES_SERVICE_TIME_DEFAULT');
  });

  test('technician skill scales the technician component', () => {
    const qualified = scoreAppointmentPlacement(placement({ capability_level: 'qualified' }), NEUTRAL_PREFS, {});
    const review = scoreAppointmentPlacement(placement({ capability_level: 'review_required' }), NEUTRAL_PREFS, {});
    expect(qualified.technician_score).toBeGreaterThan(review.technician_score);
  });

  test('changing technician forfeits the continuity credit vs same-tech', () => {
    const sameTech = scoreAppointmentPlacement(placement({ technician_id: 't1' }), NEUTRAL_PREFS, { currentTechnicianId: 't1' });
    const diffTech = scoreAppointmentPlacement(placement({ technician_id: 't2' }), NEUTRAL_PREFS, { currentTechnicianId: 't1' });
    expect(sameTech.continuity_score).toBeGreaterThan(diffTech.continuity_score);
  });

  test('stability penalty applies only to candidates that were already moved', () => {
    const fresh = scoreAppointmentPlacement(placement(), NEUTRAL_PREFS, { changeCount: 0 });
    const moved = scoreAppointmentPlacement(placement(), NEUTRAL_PREFS, { changeCount: 2 });
    expect(fresh.stability_penalty).toBe(0);
    expect(moved.stability_penalty).toBeGreaterThan(0);
    expect(moved.total_score).toBeLessThan(fresh.total_score);
    // current placement never gets a stability penalty
    const current = scoreAppointmentPlacement(placement({ is_current: true }), NEUTRAL_PREFS, { changeCount: 2 });
    expect(current.stability_penalty).toBe(0);
  });

  test('total score stays within 0..100', () => {
    const r = scoreAppointmentPlacement(placement({ detour_minutes: 0, stops_that_day: 6 }), NEUTRAL_PREFS, {});
    expect(r.total_score).toBeGreaterThanOrEqual(0);
    expect(r.total_score).toBeLessThanOrEqual(100);
  });
});
