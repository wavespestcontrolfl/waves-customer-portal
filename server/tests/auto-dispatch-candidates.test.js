// Verify the auto-dispatch HARD constraints layered on top of find-time:
// blackout windows and deactivated-capability techs are dropped, and the row
// being moved is excluded from its own occupancy.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 1,
  // Keep the REAL miles->minutes model so this suite stays honest about the
  // estimator (and its gate) while still pinning geometry to 1 mile a leg.
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const { findAvailableSlots } = require('../services/scheduling/find-time');

// These assertions assume LEGACY drive times (see the mocked haversine above),
// and the mock deliberately pulls the REAL gate-sensitive estimator. Pin the
// gate off so the suite does not depend on the ambient environment; the
// calibrated model is covered by drive-time-calibration.test.js.
const ORIGINAL_DRIVE_GATE = process.env.GATE_DRIVE_TIME_CALIBRATION;
beforeAll(() => { delete process.env.GATE_DRIVE_TIME_CALIBRATION; });
afterAll(() => {
  if (ORIGINAL_DRIVE_GATE === undefined) delete process.env.GATE_DRIVE_TIME_CALIBRATION;
  else process.env.GATE_DRIVE_TIME_CALIBRATION = ORIGINAL_DRIVE_GATE;
});

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
    expect(args.strictBlackout).toBe(true); // an unreadable closed-day list stops the search (owner 2026-10-09)
    // search window is bounded to ±7 days of the visit's date (2026-08-04),
    // not the whole horizon — so cadence isn't collapsed.
    expect(args.dateFrom).toBe('2026-07-28');
    expect(args.dateTo).toBe('2026-08-11');
  });

  // Codex r2 P1 on #4663: once GATE_SCHEDULING_CAPACITY is on, find-time's
  // shared admission bound is the CUSTOMER day close (18:00), not an
  // auto-dispatch one — a 17:00 candidate ending at 18:00 must not reach
  // auto-dispatch's route optimizer, which keeps its own 17:00 operating
  // close (this module's DAY_CLOSE, used for the current-placement anchor).
  test('drops a candidate ending after the 17:00 auto-dispatch day close, even one find-time capacity mode would offer a customer', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '16:00', end_time: '17:00', detour_minutes: 3, total_drive_minutes: 15, stops_that_day: 2, score: 3 },
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '17:00', end_time: '18:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 2, score: 1 }, // ends after 17:00 close
      ],
    });

    const { candidates } = await findValidCandidateSlots(SERVICE, prefs, ctx());

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ start_time: '16:00', end_time: '17:00' });
  });

  // Codex #4995 P1: the flex window keeps the visit's own date open for a
  // same-day re-time, so an EARLIER slot that day can sit inside the 73h
  // freeze even though the visit's current time does not.
  test('flex tier: drops a destination slot inside the 73h freeze or below the destination floor; later that day and on/after the floor stay; other modes unaffected', async () => {
    // Mon 2026-10-05 13:00 ET (17:00Z). Thu 10-08 09:00 ET is 68h away;
    // 15:00 is 74h. The destination floor is 10-10, so Fri 10-09 is not a
    // legal day move (only the visit's own 10-08 is exempt from the floor).
    const slots = [
      { date: '2026-10-08', technician: { id: 't1', name: 'A' }, start_time: '09:00', end_time: '10:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 2, score: 1 },
      { date: '2026-10-08', technician: { id: 't1', name: 'A' }, start_time: '15:00', end_time: '16:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 2, score: 2 },
      { date: '2026-10-09', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 3, total_drive_minutes: 14, stops_that_day: 2, score: 3 },
      { date: '2026-10-10', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 4, total_drive_minutes: 16, stops_that_day: 2, score: 4 },
    ];
    findAvailableSlots.mockResolvedValue({ slots });
    const service = { ...SERVICE, scheduled_date: '2026-10-08', window_start: '15:00' };
    const nowDate = new Date('2026-10-05T17:00:00Z');
    const flexCtx = {
      ...ctx(), nowDate, tierWindow: { dateFrom: '2026-10-08', dateTo: '2026-10-13', dayMoveFrom: '2026-10-10' }, tierMeta: { mode: 'flex' },
    };

    const flex = await findValidCandidateSlots(service, prefs, flexCtx);
    expect(flex.candidates.map((c) => `${c.date} ${c.start_time}`)).toEqual(['2026-10-08 15:00', '2026-10-10 08:00']);
    expect(flex.drops.flex_frozen).toBe(1);
    expect(flex.drops.flex_floor).toBe(1);
    // Generation is floored too: the freeze ends Thu 10-08 14:00 ET, so
    // find-time starts that date's gaps at 14:01 (Codex #4995 pre-push P1).
    expect(findAvailableSlots.mock.calls[0][0].startFloorByDate).toEqual({ '2026-10-08': 14 * 60 + 1 });

    // Route tiers (same window, its own mode): never these filters.
    findAvailableSlots.mockClear();
    const tiers = await findValidCandidateSlots(service, prefs, { ...flexCtx, tierMeta: { mode: 'tiers' } });
    expect(tiers.candidates).toHaveLength(4);
    expect(tiers.drops.flex_frozen).toBe(0);
    expect(tiers.drops.flex_floor).toBe(0);
    expect(findAvailableSlots.mock.calls[0][0].startFloorByDate).toBeUndefined();
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

  // "skip weekends" is Saturday AND Sunday (the seeder's rule). Sundays only
  // reach this filter with GATE_AUTO_DISPATCH_DAY_RULES on (ctx.dayRules).
  test('drops Sunday slots for a skip_weekends series too', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2026-08-09', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 }, // Sunday
        { date: '2026-08-10', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 3, score: 2 }, // Monday
      ],
    });
    const plan = await findValidCandidateSlots({ ...SERVICE, skip_weekends: true }, { service_category: 'general', blackout: null }, { ...ctx(), dayRules: true });
    expect(plan.candidates.map((c) => c.date)).toEqual(['2026-08-10']);
    expect(plan.drops.weekend).toBe(1);
    // A plan that allows weekends keeps the Sunday.
    const open = await findValidCandidateSlots(SERVICE, { service_category: 'general', blackout: null }, { ...ctx(), dayRules: true });
    expect(open.candidates.map((c) => c.date)).toEqual(['2026-08-09', '2026-08-10']);
  });

  test('day rules: the search asks for Sundays, and the arrival search for the run\'s departure; off, neither', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [] });
    const prefsNone = { service_category: 'general', blackout: null };
    await findValidCandidateSlots(SERVICE, prefsNone, ctx());
    expect(findAvailableSlots.mock.calls[0][0]).not.toHaveProperty('includeWeekends');
    expect(findAvailableSlots.mock.calls[0][0]).not.toHaveProperty('departureMinutes');
    await findValidCandidateSlots(SERVICE, prefsNone, { ...ctx(), dayRules: true, departureMinutes: 450 });
    expect(findAvailableSlots.mock.calls[1][0]).toMatchObject({ includeWeekends: true });
    // The hour-block search has no departure to set (being retired).
    expect(findAvailableSlots.mock.calls[1][0]).not.toHaveProperty('departureMinutes');
    await findValidCandidateSlots(SERVICE, prefsNone, { ...ctx(), dayRules: true, departureMinutes: 450, arrivalSearch: true });
    expect(findAvailableSlots.mock.calls[2][0]).toMatchObject({ includeWeekends: true, arrivalSearch: true, departureMinutes: 450 });
  });

  test('records what the search saw: the window and each searched day\'s open starts before any filter, so a full week reads as full (owner audit 2026-10-22, finding 6)', async () => {
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '08:00', end_time: '09:00', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 },
        { date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: '13:00', end_time: '14:00', detour_minutes: 2, total_drive_minutes: 12, stops_that_day: 3, score: 2 },
        // Dropped later (ends after the 17:00 close), still counted: the count is what find-time offered.
        { date: '2026-08-06', technician: { id: 't1', name: 'A' }, start_time: '16:30', end_time: '17:30', detour_minutes: 1, total_drive_minutes: 10, stops_that_day: 3, score: 1 },
      ],
      total_feasible: 3,
      // The days find-time really searched: 08-07 was closed or nobody worked, so it is not here.
      searched_dates: ['2026-08-04', '2026-08-05', '2026-08-06', '2026-08-08'],
    });
    const { search, drops } = await findValidCandidateSlots(SERVICE, { service_category: 'general', blackout: null }, ctx());
    expect(drops.after_hours).toBe(1);
    // Exactly the searched days, a full one as 0; a day the finder skipped is not listed (Codex #6468 r1).
    expect(search.open_starts_by_date).toEqual({ '2026-08-04': 0, '2026-08-05': 2, '2026-08-06': 1, '2026-08-08': 0 });
    expect(typeof search.date_from).toBe('string');
    expect(typeof search.date_to).toBe('string');
  });

  test('a finder that reports no searched days lists none (never a made-up full day)', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [], total_feasible: 0 });
    const { search } = await findValidCandidateSlots(SERVICE, { service_category: 'general', blackout: null }, ctx());
    expect(search.open_starts_by_date).toEqual({});
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


describe('customer recurring due-date placement', () => {
  beforeEach(() => { findAvailableSlots.mockReset().mockResolvedValue({ slots: [] }); });

  test.each([null, { dateFrom: '2026-07-20', dateTo: '2026-08-15' }])('keeps the original ±3-day bound with tier window %j', async (tierWindow) => {
    await findValidCandidateSlots({
      ...SERVICE, scheduled_date: '2026-08-06', recurring_dispatch_due_date: '2026-08-04',
    }, { service_category: 'general' }, { ...ctx(), tierWindow });
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      dateFrom: '2026-08-01', dateTo: '2026-08-07',
    }));
  });

  test('an untimed visit inside the lock window can be placed tomorrow without inventing a current appointment', async () => {
    await findValidCandidateSlots({
      ...SERVICE, scheduled_date: '2026-06-21', recurring_dispatch_due_date: '2026-06-21',
      window_start: null, window_end: null,
    }, { service_category: 'general' }, ctx());
    expect(findAvailableSlots).toHaveBeenCalledWith(expect.objectContaining({
      dateFrom: '2026-06-20', dateTo: '2026-06-24',
    }));
  });

  test('no available date in the bounded period returns no candidates', async () => {
    const result = await findValidCandidateSlots({
      ...SERVICE, scheduled_date: '2026-06-10', recurring_dispatch_due_date: '2026-06-10',
      window_start: null, window_end: null,
    }, { service_category: 'general' }, ctx());
    expect(result.candidates).toEqual([]);
    expect(findAvailableSlots).not.toHaveBeenCalled();
  });
});

test('current placement excludes an ungeocoded secondary-property neighbor', async () => {
  const { computeCurrentPlacement } = require('../services/auto-dispatch/candidate-slots');
  const selected = [];
  const fixture = {
    service_address_line1: '200 Sample Avenue', service_address_city: 'Sample City', service_address_zip: '00001',
    customer_address_line1: '100 Example Street', customer_city: 'Example City', customer_zip: '00000',
    svc_lat: null, svc_lng: null, customer_latitude: 27.4, customer_longitude: -82.5,
    window_start: '08:00', window_end: '09:00',
  };
  const db = () => {
    const c = {};
    ['where', 'whereNot', 'whereNotIn', 'leftJoin'].forEach((m) => { c[m] = () => c; });
    c.select = async (...fields) => {
      selected.push(...fields);
      return [Object.fromEntries(fields.map((field) => {
        const alias = field.split(' as ').pop().split('.').pop();
        return [alias, fixture[alias]];
      }))];
    };
    return c;
  };
  const result = await computeCurrentPlacement(SERVICE, 'general', { ...ctx(), db });
  expect(result.stops_that_day).toBe(1);
  expect(selected).toContain('scheduled_services.service_address_line1');
});

test('legacy current placement marks a grouped visit: its detour is measured against its own siblings (Codex #6207 r1 P1)', async () => {
  const { computeCurrentPlacement } = require('../services/auto-dispatch/candidate-slots');
  const withSibling = { excludeIds: new Set(['s1', 's2']), siblings: [{ id: 's2' }], visitWindowStart: null };
  const grouped = await computeCurrentPlacement({ ...SERVICE, visit_id: 'v1' }, 'general', { ...ctx(), groupContext: withSibling });
  expect(grouped.detour_group_blind).toBe(true);
  // A visit_id whose other members are all terminal: the detour is valid (r7 P2).
  const alone = { excludeIds: new Set(['s1']), siblings: [], visitWindowStart: null };
  expect(await computeCurrentPlacement({ ...SERVICE, visit_id: 'v1' }, 'general', { ...ctx(), groupContext: alone })).not.toHaveProperty('detour_group_blind');
  const standalone = await computeCurrentPlacement(SERVICE, 'general', ctx());
  expect(standalone).not.toHaveProperty('detour_group_blind');
});

test('legacy cap keeps a same-day candidate that sits beyond the cap when conflict moves are on (pre-push P1)', () => {
  const { _internals: { legacyCap } } = require('../services/auto-dispatch/candidate-slots');
  const other = Array.from({ length: 3 }, (_, i) => ({ date: '2026-08-06', start_time: `0${8 + i}:00` }));
  const sameDay = { date: '2026-08-04', start_time: '14:00' };
  const evalConflict = { kind: 'overlap', date: '2026-08-04', with: ['o1'] };
  // The capped set stays; the same-day slot past the cap is added, marked (r11 P2).
  expect(legacyCap(SERVICE, [...other, sameDay], { scoreCap: 2, conflictMoves: true, evalConflict })).toEqual([other[0], other[1], { ...sameDay, past_cap: true }]);
  expect(legacyCap(SERVICE, [...other, sameDay], { scoreCap: 2 })).toEqual([other[0], other[1]]);
  // Gate on, visit NOT in conflict: find-time's route-ranked order stays (Codex #6207 r8 P2).
  expect(legacyCap(SERVICE, [...other, sameDay], { scoreCap: 2, conflictMoves: true, evalConflict: null })).toEqual([other[0], other[1]]);
});

// A grouped visit that overlaps another stop may be repaired by a same-day
// shift into a sibling's old window: find-time must ignore the whole moving
// unit (Codex #6207 r8 P1). Any other visit excludes itself only.
test('find-time ignores the whole moving unit for a visit in an overlap, itself only otherwise', async () => {
  const { _internals: { movingUnitIds } } = require('../services/auto-dispatch/candidate-slots');
  const groupContext = { excludeIds: new Set(['s1', 'sib1']), siblings: [{ id: 'sib1' }] };
  const overlap = { kind: 'overlap', date: '2026-08-04', with: ['o1'] };
  expect(await movingUnitIds(SERVICE, { evalConflict: overlap, groupContext })).toEqual(['s1', 'sib1']);
  expect(await movingUnitIds(SERVICE, { evalConflict: null, groupContext })).toEqual(['s1']);
  expect(await movingUnitIds(SERVICE, { evalConflict: { kind: 'closed_day', date: '2026-08-04' }, groupContext })).toEqual(['s1']);
});

// GATE_AUTO_DISPATCH_DRY_TIME_ORDER: find-time offers only each gap's earliest
// start, so the rain-proof 1-5 PM window needs its own generation pass.
describe('dry-window candidate generation', () => {
  const slot = (start, end, extra = {}) => ({
    date: '2026-08-05', technician: { id: 't1', name: 'A' }, start_time: start, end_time: end, detour_minutes: 5, total_drive_minutes: 20, stops_that_day: 3, score: 5, ...extra,
  });
  const EARLY = slot('08:00', '09:00');
  const AFTERNOON = slot('13:00', '14:00', { detour_minutes: 9 });
  const dryTimeInfo = (extra = {}) => ({
    mode: 'true', hours: 0, class: 'proof', source: 'service_rule', window_key: 'dry_proof', customer_time: false, ...extra,
  });
  const prefsWith = (dry_time) => ({ blackout: null, service_category: 'general', ...(dry_time ? { dry_time } : {}) });
  // The first search returns the early start; the floored search returns the afternoon start (and the early one again).
  const mockSearches = () => findAvailableSlots.mockImplementation(async (args) => (
    { slots: args.earliestStartMin >= 780 ? [AFTERNOON, EARLY] : [EARLY], total_feasible: 1 }
  ));

  beforeEach(() => jest.clearAllMocks());

  test('gate off: one search, no extra generation', async () => {
    mockSearches();
    const res = await findValidCandidateSlots(SERVICE, prefsWith(null), ctx());
    expect(findAvailableSlots).toHaveBeenCalledTimes(1);
    expect(res.candidates.map((c) => c.start_time)).toEqual(['08:00']);
    expect(res).not.toHaveProperty('shadow_candidates');
  });

  test("'true': a second search floored at the window start; its starts join the live list after the route options", async () => {
    mockSearches();
    const res = await findValidCandidateSlots(SERVICE, prefsWith(dryTimeInfo()), ctx());
    expect(findAvailableSlots).toHaveBeenCalledTimes(2);
    expect(findAvailableSlots.mock.calls[1][0].earliestStartMin).toBe(13 * 60);
    expect(findAvailableSlots.mock.calls[1][0].excludeServiceIds).toEqual(['s1']);
    expect(res.candidates.map((c) => c.start_time)).toEqual(['08:00', '13:00']); // the early start is not duplicated
    expect(res).not.toHaveProperty('shadow_candidates');
  });

  test("'shadow': the live list and its drop tally are exactly the gate-off result; the extra starts ride shadow_candidates", async () => {
    mockSearches();
    const off = await findValidCandidateSlots(SERVICE, prefsWith(null), ctx());
    jest.clearAllMocks();
    mockSearches();
    const res = await findValidCandidateSlots(SERVICE, prefsWith(dryTimeInfo({ mode: 'shadow' })), ctx());
    expect(findAvailableSlots).toHaveBeenCalledTimes(2);
    expect(res.candidates).toEqual(off.candidates);
    expect(res.drops).toEqual(off.drops);
    expect(res.feasible).toBe(off.feasible);
    expect(res.search).toEqual(off.search);
    expect(res.shadow_candidates.map((c) => c.start_time)).toEqual(['13:00']);
  });

  test('a window that opens with the day, a customer-set time, or the arrival search adds no search', async () => {
    mockSearches();
    await findValidCandidateSlots(SERVICE, prefsWith(dryTimeInfo({ window_key: 'dry_long', class: 'long' })), ctx());
    await findValidCandidateSlots(SERVICE, prefsWith(dryTimeInfo({ customer_time: true })), ctx());
    await findValidCandidateSlots(SERVICE, prefsWith(dryTimeInfo({ window_key: null })), ctx());
    await findValidCandidateSlots(SERVICE, prefsWith(dryTimeInfo()), { ...ctx(), arrivalSearch: true });
    expect(findAvailableSlots).toHaveBeenCalledTimes(4); // one each
  });

  test("the extra starts pass the same HARD filters (blackout, 17:00 close)", async () => {
    findAvailableSlots.mockImplementation(async (args) => (
      { slots: args.earliestStartMin >= 780 ? [slot('13:00', '14:00', { date: '2026-08-10' }), slot('17:00', '18:00'), AFTERNOON] : [EARLY], total_feasible: 1 }
    ));
    const prefs = { blackout: { start: '2026-08-09', end: '2026-08-12' }, service_category: 'general', dry_time: dryTimeInfo() };
    const res = await findValidCandidateSlots(SERVICE, prefs, ctx());
    expect(res.candidates.map((c) => `${c.date} ${c.start_time}`)).toEqual(['2026-08-05 08:00', '2026-08-05 13:00']);
    expect(res.drops.blackout).toBe(1);
    expect(res.drops.after_hours).toBe(1);
  });
});
