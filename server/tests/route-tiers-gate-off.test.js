// GATE OFF MUST BE BYTE-FOR-BYTE THE LEGACY BEHAVIOR (standing rule).
// With GATE_ROUTE_TIERS off: eligibility runs the flat 14-day lock exactly as
// before, and candidate-slots computes exactly the legacy search window
// (orig ± tolerance clamped to lockFloor/horizon). With the gate on, the tier
// window replaces it. Both sides asserted on the same fixtures.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const { findAvailableSlots } = require('../services/scheduling/find-time');
const { isEligibleForAutoDispatch } = require('../services/auto-dispatch/eligibility');
const { findValidCandidateSlots } = require('../services/auto-dispatch/candidate-slots');
const { getAutoDispatchConfig } = require('../services/auto-dispatch/config');

// today=2026-06-18 → flat lock boundary today+14 = 2026-07-02 (inclusive)
const LEGACY_CTX = { today: '2026-06-18', lockBoundary: '2026-07-02', lockWindowDays: 14 };
const TIER_CTX = { ...LEGACY_CTX, routeTiers: { enabled: true, today: '2026-06-18' } };

function svc(overrides = {}) {
  return {
    id: 's1',
    customer_id: 'c1',
    is_recurring: true,
    recurring_parent_id: 'p1',
    status: 'confirmed',
    scheduled_date: '2026-07-20',
    auto_dispatch_locked: false,
    auto_dispatch_excluded: false,
    customer_active: true,
    lat: 27.4,
    lng: -82.5,
    ...overrides,
  };
}

describe('config: GATE_ROUTE_TIERS resolution', () => {
  const orig = process.env.GATE_ROUTE_TIERS;
  afterEach(() => {
    if (orig === undefined) delete process.env.GATE_ROUTE_TIERS;
    else process.env.GATE_ROUTE_TIERS = orig;
  });
  test('unset ⇒ off (dark in every environment)', () => {
    delete process.env.GATE_ROUTE_TIERS;
    expect(getAutoDispatchConfig().routeTiersEnabled).toBe(false);
  });
  test('true ⇒ on; overrides win either way', () => {
    process.env.GATE_ROUTE_TIERS = 'true';
    expect(getAutoDispatchConfig().routeTiersEnabled).toBe(true);
    expect(getAutoDispatchConfig({ routeTiersEnabled: false }).routeTiersEnabled).toBe(false);
  });
});

describe('eligibility: gate off ⇒ legacy flat lock, byte for byte', () => {
  // Every date band the two regimes could disagree on. The legacy expectation
  // is the ORIGINAL flat-lock behavior (dateStr <= lockBoundary ⇒ locked).
  const CASES = [
    ['2026-06-20', false, 'INSIDE_LOCK_WINDOW'], // 2 days out
    ['2026-06-25', false, 'INSIDE_LOCK_WINDOW'], // 7 days out (tier 2 would allow!)
    ['2026-07-01', false, 'INSIDE_LOCK_WINDOW'], // 13 days out (tier 2 would allow!)
    ['2026-07-02', false, 'INSIDE_LOCK_WINDOW'], // exactly today+14 (inclusive lock)
    ['2026-07-03', true, null],                  // today+15
    ['2026-07-20', true, null],
  ];
  test.each(CASES)('%s ⇒ eligible=%s (%s)', (date, eligible, reason) => {
    const r = isEligibleForAutoDispatch(svc({ scheduled_date: date }), LEGACY_CTX);
    expect(r.eligible).toBe(eligible);
    if (reason) expect(r.reason_code).toBe(reason);
  });
  test('full result object matches the legacy shape exactly on the fixture', () => {
    expect(isEligibleForAutoDispatch(svc(), LEGACY_CTX))
      .toEqual({ eligible: true, reason_code: null, reason_description: null });
    expect(isEligibleForAutoDispatch(svc({ scheduled_date: '2026-06-25' }), LEGACY_CTX))
      .toEqual({
        eligible: false,
        reason_code: 'INSIDE_LOCK_WINDOW',
        reason_description: 'Within 14-day lock window (on/before 2026-07-02)',
      });
  });
});

describe('eligibility: gate on ⇒ tier ladder replaces the flat lock', () => {
  test('7 days out (tier 2) is now eligible for day-moves', () => {
    expect(isEligibleForAutoDispatch(svc({ scheduled_date: '2026-06-25' }), TIER_CTX).eligible).toBe(true);
  });
  test('14 days out (tier 1) is eligible', () => {
    expect(isEligibleForAutoDispatch(svc({ scheduled_date: '2026-07-02' }), TIER_CTX).eligible).toBe(true);
  });
  test('6 days out (tier 3) is TIER_LOCKED — reorder only, no day-moves', () => {
    const r = isEligibleForAutoDispatch(svc({ scheduled_date: '2026-06-24' }), TIER_CTX);
    expect(r).toMatchObject({ eligible: false, reason_code: 'TIER_LOCKED' });
  });
  test('under 72h is TIER_LOCKED too (nothing day-moves)', () => {
    expect(isEligibleForAutoDispatch(svc({ scheduled_date: '2026-06-19' }), TIER_CTX).reason_code).toBe('TIER_LOCKED');
  });
  test('every non-lock exclusion is untouched by the gate (same in both regimes)', () => {
    for (const CTX of [LEGACY_CTX, TIER_CTX]) {
      expect(isEligibleForAutoDispatch(svc({ is_recurring: false }), CTX).reason_code).toBe('NON_RECURRING');
      expect(isEligibleForAutoDispatch(svc({ recurring_parent_id: null }), CTX).reason_code).toBe('PARENT_TEMPLATE_ROW');
      expect(isEligibleForAutoDispatch(svc({ status: 'rescheduled' }), CTX).reason_code).toBe('RESCHEDULE_REQUEST_PENDING');
      expect(isEligibleForAutoDispatch(svc({ auto_dispatch_locked: true }), CTX).reason_code).toBe('MANUALLY_LOCKED');
      expect(isEligibleForAutoDispatch(svc({ auto_dispatch_excluded: true }), CTX).reason_code).toBe('AUTO_DISPATCH_EXCLUDED');
      expect(isEligibleForAutoDispatch(svc({ customer_active: false }), CTX).reason_code).toBe('CUSTOMER_INACTIVE');
      expect(isEligibleForAutoDispatch(svc({ lat: null, lng: null }), CTX).reason_code).toBe('MISSING_GEO');
    }
  });
});

describe('candidate-slots search window: legacy vs tier', () => {
  function dbStub() {
    return () => {
      const c = {};
      ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
        .forEach((m) => { c[m] = () => c; });
      c.select = async () => [];
      return c;
    };
  }
  const SERVICE = { id: 's1', customer_id: 'c1', scheduled_date: '2026-07-20', technician_id: 't1', window_start: '09:00', estimated_duration_minutes: 60, lat: 27.4, lng: -82.5 };
  const PREFS = { blackout: null, service_category: 'general' };
  // nowDate ET day = 2026-06-18
  const NOW = new Date('2026-06-18T16:00:00Z');

  function baseCtx() {
    return {
      db: dbStub(),
      nowDate: NOW,
      lockWindowDays: 14,
      lookaheadDays: 90,
      dateToleranceDays: 7,
      topN: 60,
      capabilityFor: () => 'qualified',
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    findAvailableSlots.mockResolvedValue({ slots: [] });
  });

  test('gate off (no tierWindow): find-time gets EXACTLY the legacy window', async () => {
    await findValidCandidateSlots(SERVICE, PREFS, baseCtx());
    // Legacy math: orig ± 7 clamped to lockFloor(today+15=2026-07-03)/horizon.
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      dateFrom: '2026-07-13',
      dateTo: '2026-07-27',
      excludeServiceIds: ['s1'],
      slotStepMinutes: 60,
    }));
  });

  test('gate off: lock floor clamps a near-boundary visit exactly as before', async () => {
    await findValidCandidateSlots({ ...SERVICE, scheduled_date: '2026-07-05' }, PREFS, baseCtx());
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      dateFrom: '2026-07-03', // legacy lockFloor = today + lockWindowDays + 1
      dateTo: '2026-07-12',
    }));
  });

  test('gate on: the pre-intersected tier window replaces the legacy math', async () => {
    const ctx = { ...baseCtx(), tierWindow: { dateFrom: '2026-07-17', dateTo: '2026-07-23' } };
    await findValidCandidateSlots(SERVICE, PREFS, ctx);
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      dateFrom: '2026-07-17',
      dateTo: '2026-07-23',
    }));
  });

  test('gate on: the lookahead horizon still caps the tier window', async () => {
    const ctx = { ...baseCtx(), lookaheadDays: 30, tierWindow: { dateFrom: '2026-07-17', dateTo: '2026-07-23' } };
    // horizon = today+30 = 2026-07-18
    await findValidCandidateSlots(SERVICE, PREFS, ctx);
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      dateFrom: '2026-07-17',
      dateTo: '2026-07-18',
    }));
  });
});
