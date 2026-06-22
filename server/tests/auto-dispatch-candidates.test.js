// Verify the auto-dispatch HARD constraints layered on top of find-time:
// blackout windows and deactivated-capability techs are dropped, and the row
// being moved is excluded from its own occupancy.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({ HQ: { lat: 27.39, lng: -82.39 }, haversine: () => 1 }));

const { findAvailableSlots } = require('../services/scheduling/find-time');
const {
  findValidCandidateSlots,
  inBlackout,
  violatesPreferredDay,
  violatesPreferredTime,
} = require('../services/auto-dispatch/candidate-slots');

function neighborDbStub() {
  // computeCurrentPlacement + the same-series sibling query — return none.
  return () => {
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first']
      .forEach((m) => { c[m] = () => c; });
    c.select = async () => [];
    return c;
  };
}

const SERVICE = { id: 's1', customer_id: 'c1', scheduled_date: '2026-08-04', technician_id: 't1', window_start: '09:00', estimated_duration_minutes: 60, lat: 27.4, lng: -82.5 };

function ctx() {
  return {
    db: neighborDbStub(),
    nowDate: new Date('2026-06-19T16:00:00Z'),
    lockWindowDays: 14,
    lookaheadDays: 90,
    topN: 60,
    capabilityFor: (techId) => (techId === 'tdead' ? 'deactivated' : 'qualified'),
  };
}

describe('inBlackout', () => {
  test('inclusive range check', () => {
    const b = { start: '2026-08-09', end: '2026-08-12' };
    expect(inBlackout('2026-08-09', b)).toBe(true);
    expect(inBlackout('2026-08-12', b)).toBe(true);
    expect(inBlackout('2026-08-13', b)).toBe(false);
    expect(inBlackout('2026-08-05', b)).toBe(false);
    expect(inBlackout('2026-08-05', null)).toBe(false);
  });
});

describe('findValidCandidateSlots', () => {
  const prefs = {
    blackout: { start: '2026-08-09', end: '2026-08-12' },
    service_category: 'general',
  };

  beforeEach(() => jest.clearAllMocks());

  test('drops blackout + deactivated-tech slots, keeps valid ones, and excludes own id', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 5, total_drive_minutes: 20, stops_that_day: 3, score: 5 },
        { date: '2026-08-10', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 18, stops_that_day: 4, score: 2 }, // blackout
        { date: '2026-08-06', technician: { id: 'tdead', name: 'B' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 2, score: 1 }, // capability off
      ],
    });

    const { candidates, current } = await findValidCandidateSlots(SERVICE, prefs, ctx());

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ date: '2026-08-05', technician_id: 't1', capability_level: 'qualified' });
    expect(current).toMatchObject({ is_current: true, technician_id: 't1' });

    // own row excluded from find-time occupancy
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);
    const args = findAvailableSlots.mock.calls[0][0];
    expect(args.excludeServiceIds).toEqual(['s1']);
    expect(args.slotStepMinutes).toBe(60); // on-the-hour starts
    // search window is bounded to ±7 days of the visit's date (2026-08-04),
    // not the whole horizon — so cadence isn't collapsed.
    expect(args.dateFrom).toBe('2026-07-28');
    expect(args.dateTo).toBe('2026-08-11');
  });

  test('drops candidate dates already occupied by a same-series sibling', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 },
        { date: '2026-08-07', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 3, score: 2 },
      ],
    });
    // 1st ctx.db call = sibling-date query (return a sibling on 08-05); later calls = none.
    let call = 0;
    const db = () => {
      call += 1;
      const c = {};
      ['where', 'whereNot', 'whereNotIn', 'whereIn', 'whereBetween', 'orWhere', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
      c.select = async () => (call === 1 ? [{ scheduled_date: '2026-08-05' }] : []);
      return c;
    };
    const { candidates } = await findValidCandidateSlots(SERVICE, { service_category: 'general', blackout: null }, { ...ctx(), db });
    expect(candidates.map((x) => x.date)).toEqual(['2026-08-07']);
  });

  test('drops Saturday slots for a skip_weekends series', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2026-08-08', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 }, // Saturday
        { date: '2026-08-10', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 3, score: 2 }, // Monday
      ],
    });
    const { candidates } = await findValidCandidateSlots({ ...SERVICE, skip_weekends: true }, { service_category: 'general', blackout: null }, ctx());
    expect(candidates.map((c) => c.date)).toEqual(['2026-08-10']);
  });

  test('returns no candidates (and no_geo note) when the service has no usable coordinates', async () => {
    const r = await findValidCandidateSlots({ ...SERVICE, lat: null, lng: null }, prefs, ctx());
    expect(r.candidates).toEqual([]);
    expect(findAvailableSlots).not.toHaveBeenCalled();
  });

  // 2026-08-05 = Wed, 08-06 = Thu, 08-10 = Mon (matches the Saturday test's labels).
  test('HARD-drops slots not on the customer\'s EXPLICIT preferred day (route cannot override)', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        // Thursday slot has the LOWEST detour — route would pick it, but the
        // customer explicitly chose Wednesday, so it must be dropped.
        { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 }, // Thu
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 9, total_drive_minutes: 30, stops_that_day: 3, score: 9 }, // Wed
        { date: '2026-08-10', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 3, score: 2 }, // Mon
      ],
    });
    const wedOnly = { service_category: 'general', blackout: null, preferred_day_indexes: [3] };
    const { candidates, drops } = await findValidCandidateSlots(SERVICE, wedOnly, ctx());
    expect(candidates.map((c) => c.date)).toEqual(['2026-08-05']); // only Wednesday survives
    expect(drops.preferred_day).toBe(2); // Thu + Mon dropped
  });

  test('pushes the explicit preferred-time window START into find-time (earliestStartMin) so a later preferred slot is generated, not just post-filtered', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [] });
    const amOnly = { service_category: 'general', blackout: null, preferred_time_window: { startMin: 780, endMin: 1020 } };
    await findValidCandidateSlots(SERVICE, amOnly, ctx());
    expect(findAvailableSlots.mock.calls[0][0].earliestStartMin).toBe(780);
  });

  test('does NOT set earliestStartMin when there is no explicit time preference (default time stays soft)', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [] });
    await findValidCandidateSlots(SERVICE, { service_category: 'general', blackout: null }, ctx());
    expect(findAvailableSlots.mock.calls[0][0].earliestStartMin).toBeUndefined();
  });

  test('HARD-drops slots outside the customer\'s EXPLICIT preferred time window', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '13:00', end_time: '14:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 }, // afternoon — out
        { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 9, total_drive_minutes: 30, stops_that_day: 3, score: 9 }, // morning — in
      ],
    });
    // explicit morning window [08:00, 12:00)
    const amOnly = { service_category: 'general', blackout: null, preferred_time_window: { startMin: 480, endMin: 720 } };
    const { candidates, drops } = await findValidCandidateSlots(SERVICE, amOnly, ctx());
    expect(candidates.map((c) => c.date)).toEqual(['2026-08-06']);
    expect(drops.preferred_time).toBe(1);
  });

  test('re-fetches the FULL feasible set when find-time truncated, so route ranking cannot hide a preference-matching slot', async () => {
    // 1st pass (capped at FETCH_CAP) route-ranked the off-preference Thursday slot
    // first and truncated (total_feasible > returned). A preferred-day Wednesday
    // slot sits past the cap. The re-fetch must surface it.
    findAvailableSlots
      .mockResolvedValueOnce({
        slots: [
          { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 }, // Thu — off-pref
        ],
        total_feasible: 2, // > 1 returned → truncated
      })
      .mockResolvedValueOnce({
        slots: [
          { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 }, // Thu
          { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 9, total_drive_minutes: 30, stops_that_day: 3, score: 9 }, // Wed — preferred
        ],
        total_feasible: 2,
      });
    const wedOnly = { service_category: 'general', blackout: null, preferred_day_indexes: [3] };
    const { candidates } = await findValidCandidateSlots(SERVICE, wedOnly, ctx());
    expect(findAvailableSlots).toHaveBeenCalledTimes(2);
    expect(findAvailableSlots.mock.calls[1][0].topN).toBe(2); // re-fetch asks for the full feasible set
    expect(candidates.map((c) => c.date)).toEqual(['2026-08-05']); // preferred Wednesday found
  });

  test('does NOT re-fetch when find-time returned the full feasible set (no truncation)', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 },
      ],
      total_feasible: 1, // == returned → no truncation
    });
    const { candidates } = await findValidCandidateSlots(SERVICE, { service_category: 'general', blackout: null }, ctx());
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);
    expect(candidates.map((c) => c.date)).toEqual(['2026-08-05']);
  });

  test('service-type DEFAULT time window is SOFT — does NOT hard-drop afternoon slots', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '13:00', end_time: '14:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 },
        { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 3, score: 2 },
      ],
    });
    // No explicit pref; only a service-type default window is present (soft).
    const defaultOnly = {
      service_category: 'general', blackout: null,
      preferred_day_indexes: [], preferred_time_window: null,
      default_time_window: { startMin: 480, endMin: 600 },
      effective_time_window: { startMin: 480, endMin: 600 },
    };
    const { candidates, drops } = await findValidCandidateSlots(SERVICE, defaultOnly, ctx());
    expect(candidates.map((c) => c.date).sort()).toEqual(['2026-08-05', '2026-08-06']); // both kept
    expect(drops.preferred_day).toBe(0);
    expect(drops.preferred_time).toBe(0);
  });
});

describe('violatesPreferredDay', () => {
  test('no explicit day pref → never violates (route free to pick any day)', () => {
    expect(violatesPreferredDay('2026-08-05', { preferred_day_indexes: [] })).toBe(false);
    expect(violatesPreferredDay('2026-08-05', {})).toBe(false);
  });
  test('explicit day pref → violates unless the slot falls on a preferred weekday', () => {
    const wed = { preferred_day_indexes: [3] }; // Wednesday
    expect(violatesPreferredDay('2026-08-05', wed)).toBe(false); // Wed — ok
    expect(violatesPreferredDay('2026-08-06', wed)).toBe(true);  // Thu — violates
  });
});

describe('violatesPreferredTime', () => {
  const am = { preferred_time_window: { startMin: 480, endMin: 720 } }; // [08:00,12:00)
  test('no explicit time pref → never violates', () => {
    expect(violatesPreferredTime('13:00', { preferred_time_window: null })).toBe(false);
  });
  test('explicit window → [start,end) boundary semantics', () => {
    expect(violatesPreferredTime('08:00', am)).toBe(false); // start inclusive
    expect(violatesPreferredTime('11:00', am)).toBe(false);
    expect(violatesPreferredTime('12:00', am)).toBe(true);  // end exclusive
    expect(violatesPreferredTime('07:00', am)).toBe(true);
  });
  test('unparseable start time → not hard-dropped', () => {
    expect(violatesPreferredTime(null, am)).toBe(false);
  });
});
