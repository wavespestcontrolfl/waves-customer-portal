/**
 * GATE_TECH_SHIFT_HOURS on the slot finders (owner 2026-11-19, ad budget rule v2
 * page item D4: "offers and confirmations allow only jobs that end by that tech's
 * shift end"). Each of find-time.js's three finders reads every technician's
 * shift once (technician-eligibility.js loadTechShifts: the real reader runs
 * here, over a database double) and offers a technician with set hours only a
 * job that starts at or after the shift start and ends by the shift end. The two
 * finders that check an hour on the route also tell the route engine the shift
 * end, so it certifies only a stop order that ends the visit by then. The engine
 * is a double here: its own rule is in arrival-route-shift-end.test.js, and its
 * real run over real rows in tech-shift-hours-postgres.test.js.
 *
 * A failure here means one of two things. A customer or the office was offered
 * an hour the technician does not work. Or the shift took an hour away from a
 * technician without set hours, or with the gate off.
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
jest.mock('../services/scheduling/arrival-route', () => ({
  arrivalWindowRoutingEnabled: jest.fn(() => true),
  loadArrivalRouteContext: jest.fn(),
  enumerateArrivalPlacements: jest.fn(),
  evaluateArrivalPlacement: jest.fn(),
}));

const db = require('../models/db');
const { milesToDriveMinutes } = require('../services/route-optimizer');
const { loadArrivalRouteContext, enumerateArrivalPlacements, evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');
const { findAvailableSlots } = require('../services/scheduling/find-time');

// 2031-03-04 is a Tuesday before the spring-forward (EST, UTC-5): 15:00Z = 10:00 AM.
const NOW = new Date('2031-03-04T15:00:00Z');
const TODAY = '2031-03-04';
const WED = '2031-03-05';
const THU = '2031-03-06';
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

describe('the staff arrival finder (findArrivalWindowSlots, the office and technician pickers)', () => {
  const fit = {
    feasible: true, routeOrder: ['candidate'], detourMinutes: 4, driveMinutes: 10, occupiedMinutes: 60, waitingMinutes: 0,
    arrivalDelayMinutes: 0, estimatedArrival: '10:00', arrivals: [{ id: 'candidate' }], finishMinute: 700,
  };
  const STAFF = {
    lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: TODAY, dateTo: THU, topN: 50,
    arrivalWindow: { prospective: { lat: 27.4, lng: -82.5, estimated_duration_minutes: 60 } },
  };
  // What the finder hands the route engine for each technician and date.
  const limitsOf = () => Object.fromEntries(enumerateArrivalPlacements.mock.calls
    .map(([context, limits]) => [`${context.technicianId}:${context.date}`, [limits.earliestStartMin, limits.latestServiceEndMin]]));
  // The shift end it hands the engine, which then ends the visit by it in the order it certifies.
  const shiftEndsOf = () => Object.fromEntries(enumerateArrivalPlacements.mock.calls
    .map(([context, limits]) => [`${context.technicianId}:${context.date}`, 'shiftEndMin' in limits ? limits.shiftEndMin : 'not passed']));

  beforeEach(() => {
    loadArrivalRouteContext.mockImplementation(async ({ date, technicianId }) => ({ date, technicianId, target: { id: 'candidate' }, rows: [] }));
    enumerateArrivalPlacements.mockReturnValue({ placements: [{ windowStart: '10:00', windowEnd: '11:00', fit }], evaluated: 1, rejections: {} });
  });

  test('the route engine is asked for hours from the shift start, with the job ended by the shift end', async () => {
    tables.technicians = [tech('t1', ['10:00:00', '15:00:00']), tech('t2', null), tech('t3', ['06:00:00', '21:00:00'])];
    await findAvailableSlots(STAFF);
    expect(limitsOf()).toEqual({
      // Today at 10:00 AM: the 30-minute lead is later than the shift start.
      [`t1:${TODAY}`]: [10 * 60 + 30, 15 * 60],
      [`t1:${WED}`]: [10 * 60, 15 * 60],
      [`t1:${THU}`]: [10 * 60, 15 * 60],
      // No set hours: the picker's own day, 08:00 to the 20:00 office close.
      [`t2:${TODAY}`]: [10 * 60 + 30, 20 * 60],
      [`t2:${WED}`]: [8 * 60, 20 * 60],
      [`t2:${THU}`]: [8 * 60, 20 * 60],
      // Wider hours add nothing.
      [`t3:${TODAY}`]: [10 * 60 + 30, 20 * 60],
      [`t3:${WED}`]: [8 * 60, 20 * 60],
      [`t3:${THU}`]: [8 * 60, 20 * 60],
    });
  });

  test('the route engine is told each technician\'s own shift end, and nothing for a technician without set hours', async () => {
    tables.technicians = [tech('t1', ['10:00:00', '15:00:00']), tech('t2', null), tech('t3', ['06:00:00', '21:00:00'])];
    await findAvailableSlots({ ...STAFF, dateFrom: WED, dateTo: WED });
    // t3's hours are wider than the picker's day: the engine's own 20:00 day end still stands.
    expect(shiftEndsOf()).toEqual({ [`t1:${WED}`]: 15 * 60, [`t2:${WED}`]: 'not passed', [`t3:${WED}`]: 21 * 60 });
  });

  test('today follows the clock-in', async () => {
    tables.technicians = [tech('t1', ['12:00:00', '18:00:00'])];
    // 09:40 AM: today runs 09:40 to 15:40.
    tables.time_entries = [{ technician_id: 't1', clock_in: new Date('2031-03-04T14:40:00Z') }];
    await findAvailableSlots(STAFF);
    expect(limitsOf()).toEqual({
      [`t1:${TODAY}`]: [10 * 60 + 30, 15 * 60 + 40],
      [`t1:${WED}`]: [12 * 60, 18 * 60],
      [`t1:${THU}`]: [12 * 60, 18 * 60],
    });
    expect(shiftEndsOf()).toEqual({ [`t1:${TODAY}`]: 15 * 60 + 40, [`t1:${WED}`]: 18 * 60, [`t1:${THU}`]: 18 * 60 });
  });

  test('an hour the route engine refuses for the shift end is counted for its date', async () => {
    enumerateArrivalPlacements.mockReturnValue({
      placements: [{ windowStart: '13:00', windowEnd: '14:00', fit }], evaluated: 2, rejections: { shift_end: 1 },
    });
    const result = await findAvailableSlots({ ...STAFF, dateFrom: WED, dateTo: WED });
    expect(startsOf(result)).toEqual(['13:00']);
    expect(result.rejections_by_date).toEqual({ [WED]: { shift_end: 1 } });
  });

  test('no technician matches the search: the hours are not read', async () => {
    tables.technicians = [];
    expect((await findAvailableSlots({ ...STAFF, technicianId: 't9' })).slots).toEqual([]);
    expect(reads('technicians')).toBe(1);
  });

  test('the gate off: the picker\'s own day for everyone, and no shift or clock-in read', async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    await findAvailableSlots({ ...STAFF, dateFrom: WED, dateTo: WED });
    expect(limitsOf()).toEqual({ [`t1:${WED}`]: [8 * 60, 20 * 60] });
    expect(shiftEndsOf()).toEqual({ [`t1:${WED}`]: 'not passed' });
    expect(reads('time_entries')).toBe(0);
    expect(reads('technicians')).toBe(1);
  });
});

describe('the capacity finder (findCapacitySlots: capacity mode, and the night search)', () => {
  const CAPACITY = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: WED, dateTo: WED, topN: 50, serviceType: 'pest_control' };
  const fit = {
    feasible: true, routeOrder: ['candidate'], detourMinutes: 5, driveMinutes: 0, occupiedMinutes: 0, waitingMinutes: 0,
    estimatedArrival: null, arrivals: [{}], finishMinute: 1080, travelSource: 'none', travelReasons: [],
  };
  beforeEach(() => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    loadArrivalRouteContext.mockImplementation(async ({ date, technicianId }) => ({
      date, technicianId, target: { id: 'candidate', service_type: 'pest_control' }, rows: [],
    }));
    evaluateArrivalPlacement.mockReturnValue(fit);
  });

  test('no set hours: every hour of the shared 08:00 to 18:00 shift', async () => {
    tables.technicians = [tech('t1', null)];
    expect(startsOf(await findAvailableSlots(CAPACITY))).toEqual(
      ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'],
    );
  });

  test('a 10:00 to 15:00 shift: 10:00 through 14:00 only, and only for that technician', async () => {
    tables.technicians = [tech('t1', ['10:00:00', '15:00:00']), tech('t2', null)];
    const result = await findAvailableSlots(CAPACITY);
    expect(startsOf(result, 't1')).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
    expect(startsOf(result, 't2')).toHaveLength(10);
  });

  test('a ninety-minute job must end by the shift end, and an hour that cannot hold it is not sent to the route engine', async () => {
    const result = await findAvailableSlots({ ...CAPACITY, durationMinutes: 90 });
    expect(startsOf(result)).toEqual(['10:00', '11:00', '12:00', '13:00']);
    expect(result.evaluated).toBe(4);
    expect(result.rejections).toEqual({});
  });

  test('the shift only narrows the shared shift: 06:00 to 21:00 offers no hour before 08:00 or ending after 18:00', async () => {
    tables.technicians = [tech('t1', ['06:00:00', '21:00:00'])];
    expect(startsOf(await findAvailableSlots(CAPACITY))).toHaveLength(10);
  });

  test('today follows the clock-in; another day keeps the set hours', async () => {
    tables.technicians = [tech('t1', ['08:00:00', '14:00:00'])];
    // A 07:30 clock-in: today runs 07:30 to 13:30, and the 30-minute lead makes 11:00 the first start.
    tables.time_entries = [{ technician_id: 't1', clock_in: new Date('2031-03-04T12:30:00Z') }];
    const result = await findAvailableSlots({ ...CAPACITY, dateFrom: TODAY });
    expect(startsOf(result, 't1', TODAY)).toEqual(['11:00', '12:00']);
    expect(startsOf(result, 't1', WED)).toEqual(['08:00', '09:00', '10:00', '11:00', '12:00', '13:00']);
  });

  test('the route engine is told the shift end for every hour, in both of its checks, and nothing for a technician without set hours', async () => {
    tables.technicians = [tech('t1', ['10:00:00', '15:00:00']), tech('t2', null)];
    await findAvailableSlots(CAPACITY);
    const checks = (technicianId) => evaluateArrivalPlacement.mock.calls.filter(([context]) => context.technicianId === technicianId);
    // Each of the five hours is checked with the drive times loaded, and again without them (travel: null, the times a save uses).
    expect(checks('t1').filter(([context]) => context.travel === null)).toHaveLength(5);
    expect(checks('t1').every(([, options]) => options.shiftEndMin === 15 * 60)).toBe(true);
    expect(checks('t2').length).toBeGreaterThan(0);
    expect(checks('t2').some(([, options]) => 'shiftEndMin' in options)).toBe(false);
  });

  test('today the engine gets the shift end that follows the clock-in', async () => {
    tables.technicians = [tech('t1', ['08:00:00', '14:00:00'])];
    tables.time_entries = [{ technician_id: 't1', clock_in: new Date('2031-03-04T12:30:00Z') }];
    await findAvailableSlots({ ...CAPACITY, dateFrom: TODAY });
    const endsOn = (date) => [...new Set(evaluateArrivalPlacement.mock.calls.filter(([context]) => context.date === date).map(([, options]) => options.shiftEndMin))];
    expect(endsOn(TODAY)).toEqual([13 * 60 + 30]);
    expect(endsOn(WED)).toEqual([14 * 60]);
  });

  test('an hour the route engine refuses for the shift end is counted', async () => {
    evaluateArrivalPlacement.mockImplementation((_context, { windowStart }) => (windowStart === '14:00' ? { feasible: false, reason: 'shift_end' } : fit));
    const result = await findAvailableSlots(CAPACITY);
    expect(startsOf(result)).toEqual(['10:00', '11:00', '12:00', '13:00']);
    expect(result.rejections).toEqual({ shift_end: 1 });
    expect(result.rejections_by_date).toEqual({ [WED]: { shift_end: 1 } });
  });

  test('no technician matches the search: the hours are not read', async () => {
    tables.technicians = [];
    expect((await findAvailableSlots({ ...CAPACITY, technicianId: 't9' })).slots).toEqual([]);
    expect(reads('technicians')).toBe(1);
  });

  test('the night search (arrivalSearch) gets the same hours with the capacity gate off', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const result = await findAvailableSlots({ ...CAPACITY, technicianId: 't1', arrivalSearch: true, providerTravel: false, techStartPoints: true });
    expect(startsOf(result)).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
  });

  test('the gate off: the shared shift for a technician with set hours', async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    expect(startsOf(await findAvailableSlots(CAPACITY))).toHaveLength(10);
    expect(reads('time_entries')).toBe(0);
  });
});

describe('a failed read of the hours fails the search: no hour is offered on a guess', () => {
  const BASE = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: WED, dateTo: WED, topN: 50 };
  // Each finder reads `technicians` twice: the technician list, then the hours. The second read fails.
  beforeEach(() => {
    let technicianReads = 0;
    db.mockImplementation((table) => {
      if (table === 'technicians' && ++technicianReads === 2) throw new Error('hours read refused');
      return chain(tables[table] || []);
    });
    loadArrivalRouteContext.mockImplementation(async ({ date, technicianId }) => ({ date, technicianId, target: { id: 'candidate' }, rows: [] }));
  });

  test('the hour finder', async () => {
    await expect(findAvailableSlots(BASE)).rejects.toThrow('hours read refused');
  });

  test('the staff arrival finder', async () => {
    const prospective = { lat: 27.4, lng: -82.5, estimated_duration_minutes: 60 };
    await expect(findAvailableSlots({ ...BASE, arrivalWindow: { prospective } })).rejects.toThrow('hours read refused');
    expect(enumerateArrivalPlacements).not.toHaveBeenCalled();
  });

  test('the capacity finder', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    await expect(findAvailableSlots({ ...BASE, serviceType: 'pest_control' })).rejects.toThrow('hours read refused');
    expect(evaluateArrivalPlacement).not.toHaveBeenCalled();
  });
});
