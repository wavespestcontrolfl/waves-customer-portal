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

// GATE_AUTO_DISPATCH_SHARED_MODEL (owner-approved 2026-09-26, dispatch
// backlog item 3): the stop-count density term is replaced by the
// same-area clustering term at the SAME 10-point weight.
describe('density/cluster term (GATE_AUTO_DISPATCH_SHARED_MODEL)', () => {
  const ORIGINAL_GATE = process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
  afterEach(() => {
    if (ORIGINAL_GATE === undefined) delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL; else process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = ORIGINAL_GATE;
  });

  test('gate off: same_area_share is ignored — legacy stop-count density term', () => {
    delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
    const sparse = scoreAppointmentPlacement(placement({ stops_that_day: 1, same_area_share: 1 }), NEUTRAL_PREFS, {});
    const dense = scoreAppointmentPlacement(placement({ stops_that_day: 6, same_area_share: 0 }), NEUTRAL_PREFS, {});
    expect(dense.density_score).toBeGreaterThan(sparse.density_score); // stop count still wins
  });

  test('gate on: a clustered day beats a busier-but-scattered day on the density term', () => {
    process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
    const clustered = scoreAppointmentPlacement(placement({ stops_that_day: 2, same_area_share: 1 }), NEUTRAL_PREFS, {});
    const scattered = scoreAppointmentPlacement(placement({ stops_that_day: 6, same_area_share: 0 }), NEUTRAL_PREFS, {});
    expect(clustered.density_score).toBeGreaterThan(scattered.density_score); // cluster share wins, not stop count
    expect(clustered.density_score).toBe(10); // full 10-point credit at share 1
    expect(scattered.density_score).toBe(0);
  });

  test('gate on but no same_area_share on the placement: falls back to the legacy stop-count term (defensive)', () => {
    process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
    const legacyShape = placement({ stops_that_day: 6 });
    delete legacyShape.same_area_share;
    const r = scoreAppointmentPlacement(legacyShape, NEUTRAL_PREFS, {});
    expect(r.density_score).toBe(10); // stops_that_day=6 hits DENSITY_CAP → full legacy credit
  });

  // Codex r1 (PRRT_kwDOR3YQi86mPzgn): the day's planned route minutes
  // (drive + owner planning minutes of every stop) reach the comparison.
  test('gate on: workload reads route_minutes — a heavier planned day scores lower; gate off ignores it', () => {
    process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
    const light = scoreAppointmentPlacement(placement({ stops_that_day: 3, route_minutes: 300 }), NEUTRAL_PREFS, {});
    const heavy = scoreAppointmentPlacement(placement({ stops_that_day: 3, route_minutes: 540 }), NEUTRAL_PREFS, {});
    const overfull = scoreAppointmentPlacement(placement({ stops_that_day: 3, route_minutes: 650 }), NEUTRAL_PREFS, {});
    expect(light.workload_score).toBe(5);
    expect(heavy.workload_score).toBeCloseTo(5 * (1 - (540 - 360) / 240), 2);
    expect(overfull.workload_score).toBe(0);
    delete process.env.GATE_AUTO_DISPATCH_SHARED_MODEL;
    const legacy = scoreAppointmentPlacement(placement({ stops_that_day: 3, route_minutes: 650 }), NEUTRAL_PREFS, {});
    expect(legacy.workload_score).toBe(5); // 3 stops: full legacy credit
  });

  test('total weights are unchanged (cluster term still worth exactly 10 of 100)', () => {
    process.env.GATE_AUTO_DISPATCH_SHARED_MODEL = 'true';
    const full = scoreAppointmentPlacement(placement({ detour_minutes: 0, stops_that_day: 6, same_area_share: 1, capability_level: 'qualified', is_current: true }), { ...NEUTRAL_PREFS, preferred_day_indexes: [2] }, {});
    expect(full.total_score).toBeLessThanOrEqual(100);
  });
});
