/**
 * Picker Audit Phase 2B-2a — Core scheduling engine accuracy & transaction safety:
 *  - P1-6: arrival-route filters untimed parked placeholders in hour/plan mode and
 *          preserves fixed unassigned/hold block window_end in plan mode.
 *  - P1-7: customer-route-check floorBlocks only protects an input list that actually
 *          contains slots inside today..today+6 (never disables removals on week-2+ pools).
 *  - P1-9: estimate route-check & make-room stamp service_type / combined_services on prospective.
 *  - P1-10: savepointRead runs optional caught DB reads inside nested SAVEPOINTs on transactions.
 *  - P1-11: findCapacitySlots fails open by default / throws on strict blackout errors,
 *           strict getWeeklyDaysOff validates JSON, ADMIN_OCCUPANCY_EXCLUDE_STATUSES includes 'rescheduled'.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describe('Phase 2B-2a scheduling engine fixes', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('P1-6a: loadArrivalRouteContext drops untimed parked placeholders even when capacity mode is off', async () => {
    const prevCap = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'false';
    try {
      const { loadArrivalRouteContext } = require('../services/scheduling/arrival-route');
      const { HQ } = require('../services/route-optimizer');
      const dayRows = [
        { id: 'timed-1', technician_id: 'tech-1', status: 'confirmed', window_start: '09:00:00', window_end: '10:00:00', estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng },
        { id: 'parked-1', technician_id: 'tech-1', status: 'pending', window_start: null, window_end: null, time_window: null, estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng },
        { id: 'legacy-band', technician_id: 'tech-1', status: 'pending', window_start: null, window_end: null, time_window: 'morning', estimated_duration_minutes: 60, lat: HQ.lat, lng: HQ.lng },
      ];
      const conn = jest.fn((table) => {
        if (table === 'scheduled_services') {
          const chain = {
            leftJoin: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            whereNot: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            orWhereRaw: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(null),
            then: (resolve) => Promise.resolve(dayRows).then(resolve),
          };
          return chain;
        }
        throw new Error(`unexpected table ${table}`);
      });
      conn.raw = (sql) => sql;
      const ctx = await loadArrivalRouteContext({
        conn, date: '2035-06-10', technicianId: 'tech-1',
        prospective: { lat: HQ.lat, lng: HQ.lng, estimated_duration_minutes: 60, service_type: 'Pest Control' },
      });
      const ids = ctx.rows.map((r) => r.id);
      expect(ids).toContain('timed-1');
      expect(ids).toContain('legacy-band');
      expect(ids).not.toContain('parked-1');
    } finally {
      if (prevCap === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = prevCap;
    }
  });

  test('P1-6b: evaluateArrivalPlacement preserves a fixed unassigned/hold block window_end in plan mode', () => {
    const prevCap = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    try {
      const { evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');
      const { HQ } = require('../services/route-optimizer');
      // Fixed unassigned hold occupying 09:00-10:00 (60m booked window), even
      // though Quarterly Pest Control's plan-mode work duration is shorter (25m,
      // finishing at 09:25). A candidate at 09:45 sits AFTER 09:25 but INSIDE
      // the 09:00-10:00 booked block, so it must still be rejected.
      const context = {
        date: '2035-06-10',
        now: new Date('2035-06-09T12:00:00Z'),
        grouped: false,
        prospective: true,
        planningMinutes: true,
        target: {
          id: '__candidate__', technician_id: 'tech-1', status: 'pending',
          lat: HQ.lat, lng: HQ.lng, estimated_duration_minutes: 60, service_type: 'Quarterly Pest Control',
        },
        rows: [
          {
            id: 'unassigned-hold', technician_id: null, status: 'pending',
            window_start: '09:00:00', window_end: '10:00:00',
            estimated_duration_minutes: 60, service_type: 'Quarterly Pest Control',
            lat: HQ.lat, lng: HQ.lng, reservation_expires_at: '2035-06-10T20:00:00Z',
          },
        ],
        blocks: [],
      };
      const fit = evaluateArrivalPlacement(context, { windowStart: '09:45', windowEnd: '10:45', durationMinutes: 60 });
      expect(fit.feasible).toBe(false);
    } finally {
      if (prevCap === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = prevCap;
    }
  });

  test('P1-7: customer-route-check floorBlocks lets partial week-2 removals stand while still preventing an empty picker', () => {
    const { _internals } = require('../services/scheduling/customer-route-check');
    const today = '2027-05-01'; // floor window is 2027-05-01..2027-05-07
    const pick = (s) => ({ date: s.date });

    // Input starts on week 2 (2027-05-10): partial removals stand; removing ALL slots trips the floor.
    const week2Slots = [{ date: '2027-05-10' }, { date: '2027-05-11' }];
    expect(_internals.floorBlocks({ slots: week2Slots, remove: new Set([0]), pick, today, floor: true })).toBe(false);
    expect(_internals.floorBlocks({ slots: week2Slots, remove: new Set([0, 1]), pick, today, floor: true })).toBe(true);

    // Input HAS a slot inside today..today+6 and removal empties that window: floor MUST still protect it.
    const week1And2Slots = [{ date: '2027-05-03' }, { date: '2027-05-10' }];
    expect(_internals.floorBlocks({ slots: week1And2Slots, remove: new Set([0]), pick, today, floor: true })).toBe(true);
    // Keeping at least one slot inside today..today+6 allows removing another slot.
    expect(_internals.floorBlocks({ slots: week1And2Slots, remove: new Set([1]), pick, today, floor: true })).toBe(false);
  });

  test('P1-10: savepointRead wraps optional reads in a nested savepoint only on transactions', async () => {
    const { savepointRead } = require('../services/scheduling/savepoint-read');
    const sp = { name: 'sp' };
    const trx = { isTransaction: true, transaction: jest.fn(async (fn) => fn(sp)) };
    await expect(savepointRead(trx, async (dbh) => dbh.name)).resolves.toBe('sp');
    expect(trx.transaction).toHaveBeenCalledTimes(1);

    const pool = { name: 'pool', isTransaction: false, transaction: jest.fn() };
    await expect(savepointRead(pool, async (dbh) => dbh.name)).resolves.toBe('pool');
    expect(pool.transaction).not.toHaveBeenCalled();

    // Verify customer-move-limits dayCapReached uses a savepoint when given a transaction.
    const prevCapAll = process.env.GATE_RESCHEDULE_CAP_ALL;
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    try {
      const { dayCapReached } = require('../services/scheduling/customer-move-limits');
      const failingTrx = jest.fn();
      failingTrx.isTransaction = true;
      failingTrx.transaction = jest.fn(async () => { throw new Error('simulated read error'); });
      await expect(dayCapReached({ id: 'svc-1' }, { database: failingTrx })).resolves.toBe(false);
      expect(failingTrx.transaction).toHaveBeenCalledTimes(1);
    } finally {
      if (prevCapAll === undefined) delete process.env.GATE_RESCHEDULE_CAP_ALL; else process.env.GATE_RESCHEDULE_CAP_ALL = prevCapAll;
    }
  });

  test('P1-11: strict weekly days-off rejects malformed JSON and ADMIN_OCCUPANCY_EXCLUDE_STATUSES includes rescheduled', async () => {
    const { getWeeklyDaysOff } = require('../services/scheduling/blackout-dates');
    const { ADMIN_OCCUPANCY_EXCLUDE_STATUSES } = require('../services/scheduling/window-rules');
    expect(ADMIN_OCCUPANCY_EXCLUDE_STATUSES).toContain('rescheduled');

    const badConn = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ value: '{not-json' }),
    }));
    await expect(getWeeklyDaysOff(badConn, { strict: false })).resolves.toEqual(new Set());
    await expect(getWeeklyDaysOff(badConn, { strict: true })).rejects.toMatchObject({ code: 'MALFORMED_SETTING' });

    const badEntryConn = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ value: '["Sunday"]' }),
    }));
    await expect(getWeeklyDaysOff(badEntryConn, { strict: false })).resolves.toEqual(new Set());
    await expect(getWeeklyDaysOff(badEntryConn, { strict: true })).rejects.toMatchObject({ code: 'MALFORMED_SETTING' });
  });

  test('P1-9: verifyMakeRoomOffer passes prospectiveService on both reserve (profile) and extend (held row)', async () => {
    const bmr = require('../services/scheduling/booking-make-room');
    const verifySpy = jest.spyOn(bmr, 'verifyMakeRoomHour').mockResolvedValue({ reason: 'none' });
    const esa = require('../services/estimate-slot-availability');
    const fakeConn = jest.fn(() => ({ select: jest.fn().mockResolvedValue([]) }));
    await esa.verifyMakeRoomOffer({
      conn: fakeConn, estimate: { id: 'est-1' },
      serviceProfile: { services: [{ service: 'pest_control', label: 'Quarterly Pest Control' }] },
      coords: { lat: 27.33, lng: -82.53 }, date: '2027-05-10', windowStart: '09:00', techId: 't1', durationMinutes: 60,
    });
    expect(verifySpy).toHaveBeenLastCalledWith(expect.objectContaining({
      prospectiveService: { service_type: 'Quarterly Pest Control' },
    }));

    // Extend path: serviceProfile is null, prospectiveService rides from the held row.
    await esa.verifyMakeRoomOffer({
      conn: fakeConn, estimate: { id: 'est-1' },
      serviceProfile: null,
      prospectiveService: { service_type: 'Quarterly Pest Control', combined_services: true },
      coords: { lat: 27.33, lng: -82.53 }, date: '2027-05-10', windowStart: '09:00', techId: 't1', durationMinutes: 60,
    });
    expect(verifySpy).toHaveBeenLastCalledWith(expect.objectContaining({
      prospectiveService: { service_type: 'Quarterly Pest Control', combined_services: true },
    }));
  });
});
