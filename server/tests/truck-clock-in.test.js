jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../services/staff-onboarding', () => ({
  VEHICLE_AGREEMENT_KEY: 'staff.vehicle-use-commuting-agreement',
  hasCompletedIssuedRecord: jest.fn(),
}));
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

// In-memory stand-in for the two tables the service touches.
let shadowRows;
let activeShift;
let inserts;
let updates;
function installDb({ shiftActive = false } = {}) {
  shadowRows = [];
  inserts = [];
  updates = [];
  activeShift = shiftActive;
  db.mockImplementation((table) => {
    if (table === 'time_entries') {
      return { where: jest.fn().mockReturnThis(), first: jest.fn().mockImplementation(async () => (activeShift ? { id: 'shift-1' } : undefined)) };
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
          if (shadowRows.some((r) => r.technician_id === row.technician_id && r.work_date === row.work_date)) return [];
          const saved = { id: `row-${shadowRows.length + 1}`, ...row };
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
  });
}

describe('truckClockInMode', () => {
  const saved = process.env.GATE_TRUCK_CLOCK_IN;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = saved;
  });
  test.each([
    [undefined, 'off'], ['', 'off'], ['false', 'off'], ['1', 'off'], ['on', 'off'], ['yes', 'off'],
    ['shadow', 'shadow'], [' Shadow ', 'shadow'], ['true', 'true'], ['TRUE', 'true'],
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
    timeTracking.clockIn.mockResolvedValue({ id: 'shift-new' });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_TRUCK_CLOCK_IN; else process.env.GATE_TRUCK_CLOCK_IN = saved;
    if (savedMaintenance === undefined) delete process.env.STAFF_MAINTENANCE_MODE; else process.env.STAFF_MAINTENANCE_MODE = savedMaintenance;
  });

  const run = (extra = {}) => truck.maybeClockInFromTruck({
    tech: TECH, eventType: 'trip-data', point: point(), arrival, now: NOW, ...extra,
  });

  test('off: no database call, no clock-in', async () => {
    delete process.env.GATE_TRUCK_CLOCK_IN;
    await expect(run()).resolves.toEqual({ action: 'off' });
    expect(db).not.toHaveBeenCalled();
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
  });

  test('Staff maintenance: nothing runs', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'true';
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

  test('true: records the row and clocks in with source truck_gps', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'true';
    const result = await run();
    expect(result).toMatchObject({ action: 'recorded', mode: 'true', wouldClockIn: true });
    expect(timeTracking.clockIn).toHaveBeenCalledTimes(1);
    expect(timeTracking.clockIn).toHaveBeenCalledWith(TECH.id, expect.objectContaining({
      source: 'truck_gps', lat: STOP.lat, lng: STOP.lng, notes: expect.stringContaining('first GPS arrival'),
    }));
    expect(shadowRows[0]).toMatchObject({ would_clock_in: true, skip_reason: null });
  });

  test('true: ALREADY_CLOCKED_IN from the race is a no-op, and the row says so', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'true';
    const err = new Error('Already clocked in.');
    err.code = 'ALREADY_CLOCKED_IN';
    timeTracking.clockIn.mockRejectedValue(err);
    const result = await run();
    expect(result).toMatchObject({ action: 'recorded', wouldClockIn: false, skipReason: 'already_clocked_in' });
    expect(shadowRows[0]).toMatchObject({ would_clock_in: false, skip_reason: 'already_clocked_in' });
  });

  test('true: any other clock-in error is recorded as clock_in_failed and does not throw', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'true';
    timeTracking.clockIn.mockRejectedValue(new Error('db down'));
    const result = await run();
    expect(result).toMatchObject({ wouldClockIn: false, skipReason: 'clock_in_failed' });
    expect(shadowRows[0]).toMatchObject({ would_clock_in: false, skip_reason: 'clock_in_failed' });
  });

  test.each(['shadow', 'true'])('%s: already clocked in records the skip and never clocks in', async (mode) => {
    process.env.GATE_TRUCK_CLOCK_IN = mode;
    installDb({ shiftActive: true });
    const result = await run();
    expect(result).toMatchObject({ wouldClockIn: false, skipReason: 'already_clocked_in' });
    expect(shadowRows[0]).toMatchObject({ would_clock_in: false, skip_reason: 'already_clocked_in' });
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
  });

  test.each([
    [false, 'agreement_not_signed'],
    [new Error('boom'), 'agreement_unknown'],
  ])('true: agreement %p records %s and never clocks in', async (agreement, reason) => {
    process.env.GATE_TRUCK_CLOCK_IN = 'true';
    if (agreement instanceof Error) hasCompletedIssuedRecord.mockRejectedValue(agreement);
    else hasCompletedIssuedRecord.mockResolvedValue(agreement);
    const result = await run();
    expect(result).toMatchObject({ wouldClockIn: false, skipReason: reason });
    expect(shadowRows[0]).toMatchObject({ would_clock_in: false, skip_reason: reason });
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
  });

  test('office trip start records office_trip_start; the later arrival the same day does nothing', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'true';
    const first = await run({ eventType: 'trip-start', point: point(nearOffice()), arrival: null });
    expect(first).toMatchObject({ action: 'recorded', trigger: 'office_trip_start', wouldClockIn: true });
    expect(timeTracking.clockIn).toHaveBeenCalledWith(TECH.id, expect.objectContaining({ notes: expect.stringContaining('office') }));

    const later = await run({ now: new Date(NOW.getTime() + 3600e3), point: point({ reported_at: new Date(NOW.getTime() + 3600e3).toISOString() }) });
    expect(later).toMatchObject({ action: 'already_decided' });
    expect(shadowRows).toHaveLength(1);
    expect(shadowRows[0].trigger).toBe('office_trip_start');
    expect(timeTracking.clockIn).toHaveBeenCalledTimes(1);
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

  test('losing the insert race to another instance does not clock in', async () => {
    process.env.GATE_TRUCK_CLOCK_IN = 'true';
    const realImpl = db.getMockImplementation();
    db.mockImplementation((table) => {
      const chain = realImpl(table);
      if (table === 'truck_clock_in_shadow' && chain.first) {
        // The pre-check sees no row; the insert finds the other instance's row.
        chain.first.mockResolvedValue(undefined);
        chain.returning.mockResolvedValue([]);
      }
      return chain;
    });
    const result = await run();
    expect(result).toMatchObject({ action: 'already_decided' });
    expect(timeTracking.clockIn).not.toHaveBeenCalled();
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
