/**
 * GATE_TECH_SHIFT_HOURS on the hour finder (owner 2026-11-19, ad budget rule v2
 * page item D4: "offers and confirmations allow only jobs that end by that tech's
 * shift end"). find-time.js's hour finder (findAvailableSlots' own search, the
 * customer path in production) reads every technician's shift once
 * (technician-eligibility.js loadTechShifts: the real reader runs here, over a
 * database double) and offers a technician with set hours only a job that starts
 * at or after the shift start and ends by the shift end.
 *
 * A failure here means one of two things. A customer was offered an hour the
 * technician does not work. Or the shift took an hour away from a technician
 * without set hours, or with the gate off.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  // The stop query selects db.raw(...) coordinate expressions.
  fn.raw = (sql) => ({ toString: () => sql });
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/scheduling/blackout-dates', () => ({
  getBlackoutDates: jest.fn(async () => new Set()),
  getBlackoutLayers: jest.fn(async () => ({ dates: new Set() })),
}));
jest.mock('../services/technician-capabilities', () => ({ inactiveCapabilitiesForServices: jest.fn(async () => []) }));
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  // Every leg is half a mile, on the real miles-to-minutes model.
  haversine: () => 0.5,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
  createSchedulingTravel: jest.fn(() => ({ preload: async () => {}, diagnostics: () => ({}) })),
}));
// find-time.js loads the route engine. This suite never routes an hour.
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: jest.fn(() => true),
  loadArrivalRouteContext: jest.fn(),
  enumerateArrivalPlacements: jest.fn(),
  evaluateArrivalPlacement: jest.fn(),
}));

const db = require('../models/db');
const { milesToDriveMinutes } = require('../services/route-optimizer');
const { findAvailableSlots } = require('../services/scheduling/find-time');

// 2031-03-04 is a Tuesday before the spring-forward (EST, UTC-5): 15:00Z = 10:00 AM.
const NOW = new Date('2031-03-04T15:00:00Z');
const TODAY = '2031-03-04';
const WED = '2031-03-05';
// The drive clock's minutes for one half-mile leg.
const DRIVE = milesToDriveMinutes(0.5);

// A knex-builder double: every method chains, and awaiting it yields `rows`.
function chain(rows) {
  const builder = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
      return () => builder;
    },
  });
  return builder;
}

let tables;
const reads = (table) => db.mock.calls.filter(([name]) => name === table).length;
const tech = (id, hours) => ({ id, name: `Fixture ${id}`, shift_start: hours ? hours[0] : null, shift_end: hours ? hours[1] : null });
// One stop on a technician's route (the columns the legacy finder reads).
const stop = (id, technicianId, date, start, end) => ({
  id, technician_id: technicianId, scheduled_date: date, window_start: start, window_end: end,
  service_type: 'Pest Control', estimated_duration_minutes: 60, svc_lat: 27.41, svc_lng: -82.41,
  first_name: 'Fixture', last_name: id,
});

const GATES = ['GATE_TECH_SHIFT_HOURS', 'GATE_SCHEDULING_CAPACITY', 'GATE_TECH_WORK_DAYS', 'GATE_SLOT_TRAVEL_GAP'];
const SAVED = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));

// Only the clock is pinned: the timers stay real.
const ALL_BUT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
beforeAll(() => { jest.useFakeTimers({ now: NOW, doNotFake: ALL_BUT_DATE }); });
afterAll(() => {
  jest.useRealTimers();
  for (const name of GATES) {
    if (SAVED[name] === undefined) delete process.env[name];
    else process.env[name] = SAVED[name];
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  for (const name of GATES) delete process.env[name];
  process.env.GATE_TECH_SHIFT_HOURS = 'true';
  tables = { technicians: [tech('t1', ['10:00:00', '15:00:00'])] };
  db.mockImplementation((table) => chain(tables[table] || []));
});

const startsOf = (result, technicianId = 't1', date = WED) => result.slots
  .filter((slot) => slot.technician.id === technicianId && slot.date === date)
  .map((slot) => slot.start_time)
  .sort();

describe('the hour finder (findAvailableSlots, the customer path in production)', () => {
  // Every whole-hour start a day can hold, for one technician.
  const EVERY_HOUR = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: WED, dateTo: WED, topN: 50, slotStepMinutes: 60, everyStepStart: true };
  // The path's own day with no shift: 08:00 open plus the drive in, and the 17:00 close less the drive home.
  const OWN_DAY = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00'];

  test('a 10:00 to 15:00 shift: the first start is 10:00 and the last job ends at 15:00', async () => {
    expect(startsOf(await findAvailableSlots(EVERY_HOUR))).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
  });

  test('the gate off: the set hours change nothing, and no shift or clock-in read is made', async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    expect(startsOf(await findAvailableSlots(EVERY_HOUR))).toEqual(OWN_DAY);
    expect(reads('time_entries')).toBe(0);
    expect(reads('technicians')).toBe(1);
  });

  test('a technician without set hours keeps the path\'s own day', async () => {
    tables.technicians = [tech('t1', null)];
    expect(startsOf(await findAvailableSlots(EVERY_HOUR))).toEqual(OWN_DAY);
  });

  test('the shift only narrows: hours wider than the path\'s day add nothing', async () => {
    tables.technicians = [tech('t1', ['06:00:00', '21:00:00'])];
    expect(startsOf(await findAvailableSlots(EVERY_HOUR))).toEqual(OWN_DAY);
  });

  test('a shift that starts before the path opens keeps the path\'s open, and still ends the day', async () => {
    tables.technicians = [tech('t1', ['07:00:00', '12:00:00'])];
    expect(startsOf(await findAvailableSlots(EVERY_HOUR))).toEqual(['09:00', '10:00', '11:00']);
  });

  test('each technician has their own hours', async () => {
    tables.technicians = [tech('t1', ['10:00:00', '15:00:00']), tech('t2', null), tech('t3', ['12:00:00', '14:00:00'])];
    const result = await findAvailableSlots(EVERY_HOUR);
    expect(startsOf(result, 't1')).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
    expect(startsOf(result, 't2')).toEqual(OWN_DAY);
    expect(startsOf(result, 't3')).toEqual(['12:00', '13:00']);
  });

  test('a job longer than an hour must still end by the shift end', async () => {
    expect(startsOf(await findAvailableSlots({ ...EVERY_HOUR, durationMinutes: 120 }))).toEqual(['10:00', '11:00', '12:00', '13:00']);
  });

  test('one start a gap (the default): the gap opens at the shift start, and its close is the shift end', async () => {
    const { slots } = await findAvailableSlots({ lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: WED, dateTo: WED, topN: 5 });
    expect(slots.map((slot) => slot.start_time)).toEqual(['10:00']);
    // A surface that walks the gap stops where a job would pass this.
    expect(slots[0].day_close_min).toBe(15 * 60);
    // The gap's own last start is still the drive home before the path's 17:00 close.
    expect(slots[0].latest_start_min).toBe(17 * 60 - DRIVE - 60);
  });

  test('a caller\'s own later floor wins over the shift start, and an earlier one does not lower it', async () => {
    expect(startsOf(await findAvailableSlots({ ...EVERY_HOUR, earliestStartMin: 13 * 60 }))).toEqual(['13:00', '14:00']);
    expect(startsOf(await findAvailableSlots({ ...EVERY_HOUR, earliestStartMin: 8 * 60 }))).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
    expect(startsOf(await findAvailableSlots({ ...EVERY_HOUR, startFloorByDate: { [WED]: 12 * 60 + 1 } }))).toEqual(['13:00', '14:00']);
  });

  test('no start fits a shift shorter than the job: the day offers nothing', async () => {
    tables.technicians = [tech('t1', ['10:00:00', '10:30:00'])];
    const result = await findAvailableSlots(EVERY_HOUR);
    expect(result.slots).toEqual([]);
    // The day was still searched: the technician works it.
    expect(result.searched_dates).toEqual([WED]);
  });

  describe('packed ends (the customer pages)', () => {
    const PACKED = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: WED, dateTo: WED, topN: 50, packEnds: true };
    beforeEach(() => { tables.scheduled_services = [stop('s12', 't1', WED, '12:00:00', '13:00:00')]; });

    test('no set hours: the hour before the stop and the hour after it', async () => {
      tables.technicians = [tech('t1', null)];
      expect(startsOf(await findAvailableSlots(PACKED))).toEqual(['10:00', '14:00']);
    });

    test('a shift that holds both ends keeps both', async () => {
      expect(startsOf(await findAvailableSlots(PACKED))).toEqual(['10:00', '14:00']);
    });

    test('a shift that ends at 14:30 drops the 14:00 end (it would end at 15:00)', async () => {
      tables.technicians = [tech('t1', ['10:00:00', '14:30:00'])];
      expect(startsOf(await findAvailableSlots(PACKED))).toEqual(['10:00']);
    });

    test('a shift that starts at 11:00 drops the 10:00 end and offers no earlier hour in its place', async () => {
      tables.technicians = [tech('t1', ['11:00:00', '15:00:00'])];
      expect(startsOf(await findAvailableSlots(PACKED))).toEqual(['14:00']);
    });
  });

  describe('today follows the clock-in', () => {
    const TODAY_HOURS = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: TODAY, dateTo: WED, topN: 50, slotStepMinutes: 60, everyStepStart: true };
    beforeEach(() => { tables.technicians = [tech('t1', ['08:00:00', '14:00:00'])]; });

    test('before a clock-in the set hours stand (the 30-minute lead still applies)', async () => {
      const result = await findAvailableSlots(TODAY_HOURS);
      expect(startsOf(result, 't1', TODAY)).toEqual(['11:00', '12:00', '13:00']);
      expect(reads('time_entries')).toBe(1);
    });

    test('a 07:30 clock-in ends today at 13:30; tomorrow keeps the set hours', async () => {
      tables.time_entries = [{ technician_id: 't1', clock_in: new Date('2031-03-04T12:30:00Z') }];
      const result = await findAvailableSlots(TODAY_HOURS);
      expect(startsOf(result, 't1', TODAY)).toEqual(['11:00', '12:00']);
      expect(startsOf(result, 't1', WED)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00']);
    });
  });
});

describe('a failed read of the hours fails the search: no hour is offered on a guess', () => {
  const BASE = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: WED, dateTo: WED, topN: 50 };
  // The finder reads `technicians` twice: the technician list, then the hours. The second read fails.
  beforeEach(() => {
    let technicianReads = 0;
    db.mockImplementation((table) => {
      if (table === 'technicians' && ++technicianReads === 2) throw new Error('hours read refused');
      return chain(tables[table] || []);
    });
  });

  test('the hour finder', async () => {
    await expect(findAvailableSlots(BASE)).rejects.toThrow('hours read refused');
  });
});
