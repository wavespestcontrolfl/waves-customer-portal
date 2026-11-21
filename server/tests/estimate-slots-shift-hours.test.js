/**
 * GATE_TECH_SHIFT_HOURS on the estimate page's time list (owner 2026-11-19, ad
 * budget rule v2 page item D4: "offers and confirmations allow only jobs that end
 * by that tech's shift end"). The slot finder holds its own starts inside the
 * shift (find-time-shift-hours.test.js), but this page makes windows of its own:
 * the ASAP lane is an hourly grid the finder never sees, and a route start is
 * rounded up to the hour. filterCollidingSlots is the one filter every window on
 * the page passes, so the shift is held there.
 *
 * A failure here means the estimate page offered a customer a window its
 * technician does not work, or lost a window with the gate off.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn(async () => null) }));
jest.mock('../services/customer-moves', () => ({ moveForEstimate: jest.fn(async () => null) }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => false),
  zoneRouteDaysLive: jest.fn(() => false),
  movingEstimateLive: jest.fn(() => false),
  gateEnvValue: jest.requireActual('../config/feature-gates').gateEnvValue,
  multiTechConfirmLive: jest.requireActual('../config/feature-gates').multiTechConfirmLive,
  // The real call-time reader: GATE_TECH_SHIFT_HOURS in the environment decides.
  techShiftHoursLive: jest.requireActual('../config/feature-gates').techShiftHoursLive,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const estimateSlotAvailability = require('../services/estimate-slot-availability');

const { getAvailableSlots } = estimateSlotAvailability;
const { filterCollidingSlots, classifySlot } = estimateSlotAvailability._internals;

// 2027-05-14 is a Friday on daylight time (EDT, UTC-4): 15:00Z = 11:00 AM.
const NOW = new Date('2027-05-14T15:00:00Z');
const TODAY = '2027-05-14';
const DATE = '2027-05-20';
const range = { dateFrom: DATE, dateTo: DATE };

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

const ESTIMATE_ROW = {
  id: 'est-shift-1', status: 'sent', expires_at: null, customer_id: 'cust-1',
  address: '123 Test St, Sarasota, FL 34231', estimate_data: null, service_interest: 'Pest Control',
};
const CUSTOMER_ROW = {
  latitude: 27.3364, longitude: -82.5307,
  address_line1: '123 Test St', city: 'Sarasota', state: 'FL', zip: '34231',
};

let tables;
const reads = (table) => db.mock.calls.filter(([name]) => name === table).length;
const tech = (id, hours) => ({ id, name: `Fixture ${id}`, shift_start: hours ? hours[0] : null, shift_end: hours ? hours[1] : null });
const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
// One window as the page builds it.
const windowAt = (start, techId = 'tech-1', extra = {}) => ({
  slotId: `${extra.date || DATE}_${start.replace(':', '-')}_${techId || 'unassigned'}`,
  date: DATE, windowStart: start, windowEnd: hhmm(minutes(start) + 60), durationMinutes: 60,
  techFirstName: 'Fixture', techId, routeOptimal: false, nearbyJob: null, ...extra,
});
const startsOf = (slots, techId = 'tech-1') => slots.filter((slot) => slot.techId === techId).map((slot) => slot.windowStart).sort();
const HOURS = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

const ALL_BUT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
const GATES = ['GATE_TECH_SHIFT_HOURS', 'GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM', 'GATE_SLOT_TRAVEL_GAP'];
const SAVED = Object.fromEntries(GATES.map((name) => [name, process.env[name]]));

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
  estimateSlotAvailability._internals.clearCaches();
  tables = {
    estimates: ESTIMATE_ROW,
    customers: CUSTOMER_ROW,
    technicians: [tech('tech-1', ['10:00:00', '15:00:00'])],
    scheduled_services: [],
    service_zones: [],
    technician_absences: [],
    time_entries: [],
  };
  db.mockImplementation((table) => {
    if (!(table in tables)) throw new Error(`unexpected table ${table}`);
    return chain(tables[table]);
  });
});

describe('filterCollidingSlots: a window outside its technician\'s shift is dropped', () => {
  const everyHour = (techId = 'tech-1', extra = {}) => HOURS.map((start) => windowAt(start, techId, extra));

  test('a 10:00 to 15:00 shift keeps 10:00 through 14:00', async () => {
    expect(startsOf(await filterCollidingSlots(everyHour(), range))).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
  });

  test('each technician has their own hours, and a window with no technician is left as it was', async () => {
    tables.technicians = [tech('tech-1', ['10:00:00', '15:00:00']), tech('tech-2', null)];
    const kept = await filterCollidingSlots([...everyHour(), ...everyHour('tech-2'), ...everyHour(null)], range);
    expect(startsOf(kept)).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
    expect(startsOf(kept, 'tech-2')).toEqual(HOURS);
    expect(startsOf(kept, null)).toEqual(HOURS);
  });

  test('a route start the page rounds up past the shift end is dropped', async () => {
    const technician = { id: 'tech-1', name: 'Fixture One' };
    // The finder's 14:20 start ends at 15:20, inside nothing: the page shows it as 15:00 to 16:00.
    const late = classifySlot({ date: DATE, start_time: '14:20', technician, detour_minutes: 4, stops_that_day: 3 }, 10, 60);
    const fine = classifySlot({ date: DATE, start_time: '13:20', technician, detour_minutes: 4, stops_that_day: 3 }, 10, 60);
    expect([late.windowStart, fine.windowStart]).toEqual(['15:00', '14:00']);
    expect(startsOf(await filterCollidingSlots([late, fine], range))).toEqual(['14:00']);
  });

  test('the shift only narrows: wider hours bring back no window the page\'s own day refuses', async () => {
    tables.technicians = [tech('tech-1', ['06:00:00', '21:00:00'])];
    const kept = await filterCollidingSlots([windowAt('08:00'), ...everyHour(), windowAt('18:00')], range);
    // 08:00 is before the customer grid and 18:00 passes the page's close, shift or no shift.
    expect(startsOf(kept)).toEqual(HOURS);
  });

  test('today follows the clock-in: a 09:10 clock-in on 08:00 to 14:00 hours ends today at 15:10', async () => {
    tables.technicians = [tech('tech-1', ['08:00:00', '14:00:00'])];
    const days = { dateFrom: TODAY, dateTo: DATE };
    const bothDays = () => [...HOURS.map((start) => windowAt(start, 'tech-1', { date: TODAY })), ...everyHour()];
    const on = (slots, date) => startsOf(slots.filter((slot) => slot.date === date));
    const before = await filterCollidingSlots(bothDays(), days);
    expect(on(before, TODAY)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00']);
    tables.time_entries = [{ technician_id: 'tech-1', clock_in: new Date('2027-05-14T13:10:00Z') }];
    const after = await filterCollidingSlots(bothDays(), days);
    expect(on(after, TODAY)).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
    // Another day keeps the set hours.
    expect(on(after, DATE)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00']);
  });

  test('capacity mode: the same rule on the route windows', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const kept = await filterCollidingSlots(everyHour('tech-1', { routeMode: 'arrival_windows' }), range);
    expect(startsOf(kept)).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
    // A window with no readable time is left to the page's other checks, as before.
    const unread = windowAt('10:00', 'tech-1', { routeMode: 'arrival_windows', windowStart: null, windowEnd: null });
    expect(await filterCollidingSlots([unread], range)).toEqual([unread]);
  });

  test('the gate off: every window is kept, and no shift or clock-in read is made', async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    expect(startsOf(await filterCollidingSlots(everyHour(), range))).toEqual(HOURS);
    expect(reads('technicians')).toBe(0);
    expect(reads('time_entries')).toBe(0);
  });

  test('a technician without set hours keeps every window', async () => {
    tables.technicians = [tech('tech-1', null)];
    expect(startsOf(await filterCollidingSlots(everyHour(), range))).toEqual(HOURS);
  });
});

describe('getAvailableSlots: the page\'s whole list (the route lane and the ASAP lane)', () => {
  const opts = { dateFrom: DATE, dateTo: DATE };
  const offered = (result) => [...(result.primary || []), ...(result.expander || [])];
  const outsideShift = (slot) => minutes(slot.windowStart) < 10 * 60 || minutes(slot.windowEnd) > 15 * 60;

  beforeEach(() => {
    const technician = { id: 'tech-1', name: 'Fixture tech-1' };
    findAvailableSlots.mockResolvedValue({
      slots: [
        { date: DATE, start_time: '10:00', technician, detour_minutes: 4, stops_that_day: 3 },
        // Rounded up by the page to 15:00 to 16:00.
        { date: DATE, start_time: '14:20', technician, detour_minutes: 2, stops_that_day: 3 },
      ],
      evaluated: 2,
      total_feasible: 2,
    });
  });

  test('with a 10:00 to 15:00 shift, no offered window starts before 10:00 or ends after 15:00', async () => {
    const list = offered(await getAvailableSlots('est-shift-1', opts));
    expect(list.length).toBeGreaterThan(0);
    expect(list.filter(outsideShift)).toEqual([]);
  });

  test('the gate off: the same request offers windows outside those hours', async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    const list = offered(await getAvailableSlots('est-shift-1', opts));
    expect(list.filter(outsideShift).length).toBeGreaterThan(0);
  });

  test('a gate flip never serves the other list from the 5-minute cache', async () => {
    // Built and cached with the gate off: windows outside 10:00 to 15:00 are on the list.
    delete process.env.GATE_TECH_SHIFT_HOURS;
    expect(offered(await getAvailableSlots('est-shift-1', opts)).filter(outsideShift).length).toBeGreaterThan(0);
    // The gate goes on inside the TTL: the same request must not answer from that entry.
    process.env.GATE_TECH_SHIFT_HOURS = 'true';
    const on = offered(await getAvailableSlots('est-shift-1', opts));
    expect(on.length).toBeGreaterThan(0);
    expect(on.filter(outsideShift)).toEqual([]);
    // And back off: the list built under the gate is not served either.
    delete process.env.GATE_TECH_SHIFT_HOURS;
    expect(offered(await getAvailableSlots('est-shift-1', opts)).filter(outsideShift).length).toBeGreaterThan(0);
  });
});
