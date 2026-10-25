jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../services/staff-onboarding', () => ({
  VEHICLE_AGREEMENT_KEY: 'staff.vehicle-use-commuting-agreement',
  hasCompletedIssuedRecord: jest.fn(),
}));
// Shadow only: the service must never touch time tracking.
jest.mock('../services/time-tracking', () => ({ clockIn: jest.fn() }));

const db = require('../models/db');
const { hasCompletedIssuedRecord } = require('../services/staff-onboarding');
const timeTracking = require('../services/time-tracking');
const RouteOptimizer = require('../services/route-optimizer');
const truck = require('../services/truck-clock-in');
const { truckClockInMode } = require('../config/feature-gates');

const { detectTrigger, decideClockIn, isWithinOfficeRadius } = truck._test;
const HQ = RouteOptimizer.HQ;
const TECH = { id: '00000000-0000-4000-8000-000000000001', name: 'Tech Alpha', bouncie_imei: 'imei-1' };
const NOW = new Date('2026-10-25T13:00:00.000Z');
const STOP = { lat: 27.3, lng: -82.5 };

function point(overrides = {}) {
  return { ...STOP, speed_mph: 0, ignition: false, reported_at: NOW.toISOString(), ...overrides };
}
const nearOffice = (dLat = 0.001) => ({ lat: HQ.lat + dLat, lng: HQ.lng });

// In-memory stand-in for the tables the service touches.
let shadowRows;
let activeShift;
let inserts;
let updates;
let earlierRows;
let webhookLogWheres;
let loseClaim;
function tableImpl(table) {
  if (table === 'time_entries') {
    return { where: jest.fn().mockReturnThis(), first: jest.fn().mockImplementation(async () => (activeShift ? { id: 'shift-1' } : undefined)) };
  }
  if (table === 'bouncie_webhook_log') {
    // Applies the where filters the service asks for to earlierRows, so the vehicle,
    // earlier-id and ET-day-window arguments are exercised, not just recorded.
    const filters = [];
    let distinct = false;
    let types = null;
    const chain = {
      where: jest.fn().mockImplementation((...args) => {
        webhookLogWheres.push(args);
        const [column, op, value] = args;
        if (args.length === 2) filters.push((r) => r[column] === op);
        else if (op === '<') filters.push((r) => r[column] < value);
        return chain;
      }),
      whereRaw: jest.fn().mockImplementation((...args) => {
        webhookLogWheres.push(args);
        const since = new Date(args[1][0]).getTime();
        filters.push((r) => new Date(r.received_at).getTime() >= since);
        return chain;
      }),
      whereIn: jest.fn().mockImplementation((column, values) => { types = values; return chain; }),
      distinct: jest.fn().mockImplementation(() => { distinct = true; return chain; }),
      select: jest.fn().mockImplementation(async () => {
        let rows = earlierRows.filter((r) => filters.every((f) => f(r)));
        if (types) rows = rows.filter((r) => types.includes(r.event_type));
        if (distinct) return [...new Set(rows.map((r) => r.event_type))].map((event_type) => ({ event_type }));
        return rows.map((r) => ({ id: r.id, payload: r.payload }));
      }),
    };
    return chain;
  }
  if (table === 'truck_clock_in_shadow') {
    let filter = null;
    let row = null;
    const chain = {
      where: jest.fn().mockImplementation((f) => { filter = f; return chain; }),
      first: jest.fn().mockImplementation(async () => shadowRows.find((r) => r.technician_id === filter.technician_id && r.work_date === filter.work_date)),
      insert: jest.fn().mockImplementation((r) => { row = r; return chain; }),
      onConflict: jest.fn().mockReturnThis(),
      ignore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockImplementation(async () => {
        inserts.push(row);
        if (loseClaim || shadowRows.some((r) => r.technician_id === row.technician_id && r.work_date === row.work_date)) return [];
        const saved = { id: `row-${inserts.length}`, ...row };
        shadowRows.push(saved);
        return [{ id: saved.id }];
      }),
      update: jest.fn().mockImplementation(async (patch) => {
        updates.push({ id: filter.id, patch });
        const target = shadowRows.find((r) => r.id === filter.id);
        if (target) Object.assign(target, patch);
        return 1;
      }),
    };
    return chain;
  }
  throw new Error(`unexpected table ${table}`);
}
function installDb({ shiftActive = false } = {}) {
  shadowRows = [];
  inserts = [];
  updates = [];
  earlierRows = [];
  webhookLogWheres = [];
  loseClaim = false;
  activeShift = shiftActive;
  db.mockImplementation(tableImpl);
}

describe('truckClockInMode', () => {
  const saved = process.env.GATE_TRUCK_CLOCK_IN;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = saved;
  });
  test.each([
    [undefined, 'off'], ['', 'off'], ['false', 'off'], ['1', 'off'], ['on', 'off'], ['yes', 'off'],
    ['shadow', 'shadow'], [' Shadow ', 'shadow'], ['SHADOW', 'shadow'],
    ['true', 'off'], ['TRUE', 'off'], ['live', 'off'], ['shadow,true', 'off'],
  ])('GATE_TRUCK_CLOCK_IN=%p reads %p', (value, expected) => {
    if (value === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = value;
    expect(truckClockInMode()).toBe(expected);
  });
});

describe('detectTrigger', () => {
  test('first_arrival when the detector marked an arrival on this call', () => {
    const fired = detectTrigger({ eventType: 'trip-data', point: point(), arrival: { ok: true, arrivalMarked: true, serviceId: 'svc-1' }, now: NOW });
    expect(fired).toMatchObject({ trigger: 'first_arrival', lat: STOP.lat, lng: STOP.lng });
    expect(fired.eventAt.toISOString()).toBe(NOW.toISOString());
  });

  test.each([
    ['no detector result', null],
    ['detector refused', { ok: false, reason: 'service_not_en_route' }],
    ['arrival not marked', { ok: false, arrivalMarked: false, reason: 'mark_on_property_failed' }],
  ])('no trigger for %s on a mid-day trip-data point', (_name, arrival) => {
    expect(detectTrigger({ eventType: 'trip-data', point: point(), arrival, now: NOW })).toBeNull();
  });

  test('office_trip_start for a trip-start inside 200 m of the office', () => {
    const fired = detectTrigger({ eventType: 'trip-start', point: point(nearOffice(0.001)), arrival: null, now: NOW });
    expect(fired).toMatchObject({ trigger: 'office_trip_start' });
  });

  test('office radius edge: just inside and just outside 200 m', () => {
    // 0.0017 deg of latitude is about 189 m; 0.0019 is about 211 m.
    expect(isWithinOfficeRadius(nearOffice(0.0017))).toBe(true);
    expect(isWithinOfficeRadius(nearOffice(0.0019))).toBe(false);
    expect(detectTrigger({ eventType: 'trip-start', point: point(nearOffice(0.0019)), arrival: null, now: NOW })).toBeNull();
  });

  test('a trip-start away from the office (home) fires nothing', () => {
    expect(detectTrigger({ eventType: 'trip-start', point: point(), arrival: null, now: NOW })).toBeNull();
  });

  test('a trip-data or trip-end point at the office is not a trip start', () => {
    expect(detectTrigger({ eventType: 'trip-data', point: point(nearOffice()), arrival: null, now: NOW })).toBeNull();
    expect(detectTrigger({ eventType: 'trip-end', point: point(nearOffice()), arrival: null, now: NOW })).toBeNull();
  });

  test('an arrival wins over an office trip start on the same point', () => {
    const fired = detectTrigger({ eventType: 'trip-start', point: point(nearOffice()), arrival: { arrivalMarked: true }, now: NOW });
    expect(fired.trigger).toBe('first_arrival');
  });

  test('a delayed trip-start (older than 10 minutes) fires nothing', () => {
    const old = point({ ...nearOffice(), reported_at: new Date(NOW.getTime() - 11 * 60 * 1000).toISOString() });
    expect(detectTrigger({ eventType: 'trip-start', point: old, arrival: null, now: NOW })).toBeNull();
    const fresh = point({ ...nearOffice(), reported_at: new Date(NOW.getTime() - 9 * 60 * 1000).toISOString() });
    expect(detectTrigger({ eventType: 'trip-start', point: fresh, arrival: null, now: NOW })).not.toBeNull();
  });

  test('a point without a time uses now; a point without coordinates fires nothing', () => {
    const fired = detectTrigger({ eventType: 'trip-start', point: { ...nearOffice(), reported_at: null }, arrival: null, now: NOW });
    expect(fired.eventAt.getTime()).toBe(NOW.getTime());
    expect(detectTrigger({ eventType: 'trip-start', point: { lat: null, lng: null }, arrival: { arrivalMarked: true }, now: NOW })).toBeNull();
  });
});

describe('decideClockIn', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('would clock in with no active shift and a signed agreement', async () => {
    installDb();
    hasCompletedIssuedRecord.mockResolvedValue(true);
    await expect(decideClockIn(TECH.id)).resolves.toEqual({ wouldClockIn: true, skipReason: null });
    expect(hasCompletedIssuedRecord).toHaveBeenCalledWith(db, TECH.id, 'staff.vehicle-use-commuting-agreement');
  });

  test('already clocked in skips before the agreement is read', async () => {
    installDb({ shiftActive: true });
    await expect(decideClockIn(TECH.id)).resolves.toEqual({ wouldClockIn: false, skipReason: 'already_clocked_in' });
    expect(hasCompletedIssuedRecord).not.toHaveBeenCalled();
  });

  test('unsigned agreement', async () => {
    installDb();
    hasCompletedIssuedRecord.mockResolvedValue(false);
    await expect(decideClockIn(TECH.id)).resolves.toEqual({ wouldClockIn: false, skipReason: 'agreement_not_signed' });
  });

  test('an unreadable agreement is agreement_unknown, not a guess', async () => {
    installDb();
    hasCompletedIssuedRecord.mockRejectedValue(new Error('relation does not exist'));
    await expect(decideClockIn(TECH.id)).resolves.toEqual({ wouldClockIn: false, skipReason: 'agreement_unknown' });
  });
});

describe('maybeClockInFromTruck', () => {
  const saved = process.env.GATE_TRUCK_CLOCK_IN;
  const savedMaintenance = process.env.STAFF_MAINTENANCE_MODE;
  const arrival = { ok: true, arrivalMarked: true, serviceId: 'svc-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    truck._test.resetMemo();
    delete process.env.STAFF_MAINTENANCE_MODE;
    installDb();
    hasCompletedIssuedRecord.mockResolvedValue(true);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = saved;
    if (savedMaintenance === undefined) delete process.env.STAFF_MAINTENANCE_MODE; else process.env.STAFF_MAINTENANCE_MODE = savedMaintenance;
  });

  const run = (extra = {}) => truck.maybeClockInFromTruck({
    tech: TECH, eventType: 'trip-data', point: point(), arrival, logId: 50, now: NOW, ...extra,
  });

  test('off: no database call, no clock-in', async () => {
    delete process.env.GATE_TRUCK_CLOCK_IN;
    await expect(run()).resolves.toEqual({ action: 'off' });
    expect(db).not.toHaveBeenCalled();
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
  });

  test('Staff maintenance: nothing runs', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
    process.env.STAFF_MAINTENANCE_MODE = 'true';
    await expect(run()).resolves.toEqual({ action: 'maintenance' });
    expect(db).not.toHaveBeenCalled();
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
  });

  test('shadow: records the row and never clocks in', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
    const result = await run();
    expect(result).toMatchObject({ action: 'recorded', mode: 'shadow', trigger: 'first_arrival', wouldClockIn: true, workDate: '2026-10-25' });
    expect(shadowRows).toHaveLength(1);
    expect(shadowRows[0]).toMatchObject({
      technician_id: TECH.id, work_date: '2026-10-25', trigger: 'first_arrival', would_clock_in: true, skip_reason: null,
      lat: STOP.lat, lng: STOP.lng,
    });
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
  });

  test('GATE_TRUCK_CLOCK_IN=true behaves as off: no row, no clock-in, no database call', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'true';
    await expect(run()).resolves.toEqual({ action: 'off' });
    expect(db).not.toHaveBeenCalled();
    expect(shadowRows).toHaveLength(0);
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
  });

  test('already clocked in records the skip and never clocks in', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
    installDb({ shiftActive: true });
    const result = await run();
    expect(result).toMatchObject({ wouldClockIn: false, skipReason: 'already_clocked_in' });
    expect(shadowRows[0]).toMatchObject({ would_clock_in: false, skip_reason: 'already_clocked_in' });
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
  });

  test.each([
    [false, 'agreement_not_signed'],
    [new Error('boom'), 'agreement_unknown'],
  ])('shadow: agreement %p records %s and never clocks in', async (agreement, reason) => {
    process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
    if (agreement instanceof Error) hasCompletedIssuedRecord.mockRejectedValue(agreement);
    else hasCompletedIssuedRecord.mockResolvedValue(agreement);
    const result = await run();
    expect(result).toMatchObject({ wouldClockIn: false, skipReason: reason });
    expect(shadowRows[0]).toMatchObject({ would_clock_in: false, skip_reason: reason });
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
  });

  test('office trip start records office_trip_start; the later arrival the same day does nothing', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
    const first = await run({ eventType: 'trip-start', point: point(nearOffice()), arrival: null, payload: { eventType: 'tripStart', imei: 'imei-1', transactionId: 'trip-1' } });
    expect(first).toMatchObject({ action: 'recorded', trigger: 'office_trip_start', wouldClockIn: true });

    const later = await run({ now: new Date(NOW.getTime() + 3600e3), point: point({ reported_at: new Date(NOW.getTime() + 3600e3).toISOString() }) });
    expect(later).toMatchObject({ action: 'already_decided' });
    expect(shadowRows).toHaveLength(1);
    expect(shadowRows[0].trigger).toBe('office_trip_start');
  });

  test('first trigger of the day wins even when a fresh process has an empty memo (durable row)', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
    await run();
    truck._test.resetMemo();
    inserts.length = 0;
    const second = await run();
    expect(second).toMatchObject({ action: 'already_decided' });
    expect(inserts).toHaveLength(0);
  });

  test('losing the insert race to another instance records nothing more', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
    loseClaim = true;
    const result = await run();
    expect(result).toMatchObject({ action: 'already_decided' });
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
    expect(shadowRows).toHaveLength(0);
  });

  describe('first trip of the day', () => {
    const CUR = {
      eventType: 'tripStart', imei: 'imei-1', transactionId: 'trip-current',
      start: { timestamp: NOW.toISOString(), gps: { lat: HQ.lat + 0.001, lon: HQ.lng } },
    };
    // A log row as either receiver stores it (payload already redacted, normalized or raw type).
    const row = (id, extra = {}) => ({
      id, event_type: 'trip-start', vehicle_imei: 'imei-1', received_at: '2026-10-25T12:00:00.000Z', payload: CUR, ...extra,
    });
    const tripStart = (extra = {}) => run({
      eventType: 'trip-start', point: point(nearOffice()), arrival: null, logId: 100, payload: CUR, ...extra,
    });
    const fires = (result) => expect(result).toMatchObject({ action: 'recorded', trigger: 'office_trip_start' });
    const refused = (result) => {
      expect(result).toEqual({ action: 'no_trigger', reason: 'not_first_trip' });
      expect(shadowRows).toHaveLength(0);
    };
    beforeEach(() => { process.env.GATE_TRUCK_CLOCK_IN = 'shadow'; });

    test('allowed when no earlier trip-start exists for the truck that day, scoped by truck, id and ET day', async () => {
      earlierRows = [row(90, { event_type: 'trip-data' }), row(91, { event_type: 'connect' })];
      fires(await tripStart());
      // Scoped to this truck, to earlier log rows, and to the ET work day (00:00 EDT = 04:00Z).
      expect(webhookLogWheres).toEqual(expect.arrayContaining([
        ['vehicle_imei', 'imei-1'],
        ['id', '<', 100],
        [expect.stringContaining('received_at >='), ['2026-10-25T04:00:00.000Z']],
      ]));
    });

    test('allowed when the log holds no earlier rows at all', async () => {
      fires(await tripStart());
    });

    test.each([['trip-start'], ['tripStart'], ['TripStart'], ['trip_start']])(
      'refused after an earlier, different trip-start stored as %p (first trip started away from the office)',
      async (stored) => {
        earlierRows = [row(90, { event_type: 'trip-data' }), row(91, { event_type: stored, payload: { ...CUR, transactionId: 'trip-morning' } })];
        refused(await tripStart());
        expect(timeTracking.clockIn).not.toHaveBeenCalled();
      },
    );

    test('the SAME trip-start already logged by the other receiver does not suppress it (either order)', async () => {
      // Other receiver's copy logged first (lower id), stored under the raw or the normalized name.
      earlierRows = [row(95, { event_type: 'tripStart' })];
      fires(await tripStart());
    });

    test('the same trip-start logged by the other receiver AFTER this one is never an earlier row', async () => {
      earlierRows = [row(101)];
      fires(await tripStart());
    });

    test('the same trip identity spelled transaction_id on one side is still the same trip', async () => {
      earlierRows = [row(95, { payload: { eventType: 'trip-start', imei: 'imei-1', transaction_id: 'trip-current' } })];
      // Different spelling of the key: identities are read through tripIdentity, so equal.
      fires(await tripStart({ payload: { ...CUR, transactionId: undefined, transaction_id: 'trip-current' } }));
    });

    test('a stored payload arriving as a JSON string is read too', async () => {
      earlierRows = [row(95, { payload: JSON.stringify(CUR) })];
      fires(await tripStart());
      truck._test.resetMemo();
      shadowRows.length = 0;
      earlierRows = [row(95, { payload: JSON.stringify({ ...CUR, transactionId: 'trip-morning' }) })];
      refused(await tripStart());
    });

    test('a genuinely earlier trip is not hidden by a same-trip copy: any different trip suppresses', async () => {
      earlierRows = [row(80, { payload: { ...CUR, transactionId: 'trip-morning' } }), row(95)];
      refused(await tripStart());
    });

    test('rows from the previous ET day are ignored', async () => {
      // 11:30 PM EDT on Oct 24 = 03:30Z on Oct 25, before the ET day starts at 04:00Z.
      earlierRows = [row(80, { received_at: '2026-10-25T03:30:00.000Z', payload: { ...CUR, transactionId: 'trip-last-night' } })];
      fires(await tripStart());
      // One minute after the ET day started counts.
      truck._test.resetMemo();
      shadowRows.length = 0;
      earlierRows = [row(80, { received_at: '2026-10-25T04:01:00.000Z', payload: { ...CUR, transactionId: 'trip-after-midnight' } })];
      refused(await tripStart());
    });

    test("another truck's trip-start is ignored", async () => {
      earlierRows = [row(80, { vehicle_imei: 'imei-2', payload: { ...CUR, imei: 'imei-2', transactionId: 'trip-other-truck' } })];
      fires(await tripStart());
    });

    describe('a row with no trip identity', () => {
      const NO_ID = { eventType: 'tripStart', imei: 'imei-1', start: { timestamp: NOW.toISOString(), gps: { lat: 27.43, lon: -82.4 } } };
      const at = (offsetMs) => ({ ...NO_ID, start: { ...NO_ID.start, timestamp: new Date(NOW.getTime() + offsetMs).toISOString() } });

      test('an identical payload is the same delivery, hence the same trip', async () => {
        earlierRows = [row(95, { payload: NO_ID })];
        fires(await tripStart({ payload: NO_ID }));
      });

      test('a trip-start time within 2 minutes is the same trip', async () => {
        earlierRows = [row(95, { payload: at(90 * 1000) })];
        fires(await tripStart({ payload: { ...NO_ID, extra: 'x' } }));
      });

      test('a trip-start time more than 2 minutes apart is a different trip', async () => {
        earlierRows = [row(95, { payload: at(-3 * 60 * 1000) })];
        refused(await tripStart({ payload: { ...NO_ID, extra: 'x' } }));
      });

      test('no identity and no time cannot be proven the same, so it counts as different (safe side)', async () => {
        earlierRows = [row(95, { payload: { eventType: 'tripStart', imei: 'imei-1' } })];
        refused(await tripStart({ payload: { ...NO_ID, extra: 'x' } }));
      });

      test('an identity on only one side falls back to payload and time, not to a mismatch', async () => {
        earlierRows = [row(95, { payload: NO_ID })];
        fires(await tripStart({ payload: { ...NO_ID, transactionId: 'trip-current' } }));
      });
    });

    test('refused when the event has no log id, since the order is unknowable', async () => {
      const result = await tripStart({ logId: null });
      expect(result).toEqual({ action: 'no_trigger', reason: 'trip_order_unknown' });
      expect(shadowRows).toHaveLength(0);
    });

    test('refused when the hook was given no payload', async () => {
      const result = await tripStart({ payload: null });
      expect(result).toEqual({ action: 'no_trigger', reason: 'trip_order_unknown' });
    });

    test('a refused office trip does not stop a later first arrival from firing', async () => {
      earlierRows = [row(90, { payload: { ...CUR, transactionId: 'trip-morning' } })];
      await tripStart();
      const arrived = await run({ logId: 101 });
      expect(arrived).toMatchObject({ action: 'recorded', trigger: 'first_arrival' });
    });

    test('an arrival never consults the log', async () => {
      earlierRows = [row(90, { payload: { ...CUR, transactionId: 'trip-morning' } })];
      await run({ logId: 101 });
      expect(webhookLogWheres).toHaveLength(0);
    });
  });

  test('a different technician the same day is decided separately', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
    await run();
    const other = { id: '00000000-0000-4000-8000-000000000002', name: 'Tech Beta' };
    const result = await run({ tech: other });
    expect(result).toMatchObject({ action: 'recorded' });
    expect(shadowRows).toHaveLength(2);
  });

  describe('Eastern work day boundary', () => {
    test('11:59 PM ET and 12:01 AM ET fall on different work dates', async () => {
      process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
      const beforeMidnight = new Date('2026-10-26T03:59:00.000Z'); // 11:59 PM EDT, Oct 25
      const afterMidnight = new Date('2026-10-26T04:01:00.000Z'); // 12:01 AM EDT, Oct 26
      const a = await run({ now: beforeMidnight, point: point({ reported_at: beforeMidnight.toISOString() }) });
      const b = await run({ now: afterMidnight, point: point({ reported_at: afterMidnight.toISOString() }) });
      expect(a.workDate).toBe('2026-10-25');
      expect(b.workDate).toBe('2026-10-26');
      expect(b.action).toBe('recorded');
      expect(shadowRows.map((r) => r.work_date)).toEqual(['2026-10-25', '2026-10-26']);
    });

    test('8 PM ET is the same work day as 8 AM ET, even though UTC has rolled over', async () => {
      process.env.GATE_TRUCK_CLOCK_IN = 'shadow';
      const evening = new Date('2026-10-26T00:00:00.000Z'); // 8:00 PM EDT, Oct 25
      const result = await run({ now: evening, point: point({ reported_at: evening.toISOString() }) });
      expect(result.workDate).toBe('2026-10-25');
    });
  });
});
