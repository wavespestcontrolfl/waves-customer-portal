// Verify the auto-dispatch HARD constraints layered on top of find-time:
// blackout windows and deactivated-capability techs are dropped, and the row
// being moved is excluded from its own occupancy.
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/route-optimizer', () => ({ HQ: { lat: 27.39, lng: -82.39 }, haversine: () => 1 }));

const { findAvailableSlots } = require('../services/scheduling/find-time');
const { findValidCandidateSlots, inBlackout } = require('../services/auto-dispatch/candidate-slots');

function neighborDbStub() {
  // computeCurrentPlacement queries same-day siblings — return none.
  return () => ({
    where() { return this; },
    whereNot() { return this; },
    whereNotIn() { return this; },
    leftJoin() { return this; },
    select: async () => [],
  });
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

  test('returns no candidates (and no_geo note) when the service has no usable coordinates', async () => {
    const r = await findValidCandidateSlots({ ...SERVICE, lat: null, lng: null }, prefs, ctx());
    expect(r.candidates).toEqual([]);
    expect(findAvailableSlots).not.toHaveBeenCalled();
  });
});
