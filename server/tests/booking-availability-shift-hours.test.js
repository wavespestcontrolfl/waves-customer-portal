/**
 * GATE_TECH_SHIFT_HOURS on the /book availability builder (owner 2026-11-19, ad
 * budget rule v2 page item D4: "offers and confirmations allow only jobs that end
 * by that tech's shift end"). buildBookingAvailability serves /book, the public
 * reschedule and re-service pages, the inspection link, the voice agent and the
 * text offers. The slot finder holds its own starts inside the shift
 * (find-time-shift-hours.test.js), but this builder adds hours of its own: the
 * whole block of an open day, every later hour a gap holds, and a start it snaps
 * to the grid. Each of those must lie inside its technician's shift.
 *
 * The finder is mocked here, and its slots are the ones a shift would still let
 * through, so every case below is decided by the builder's own check. The shift
 * reader (technician-eligibility.js loadTechShifts) is real.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn() }));
jest.mock('../services/scheduling/occupancy', () => ({ listOccupiedWindows: jest.fn() }));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { listOccupiedWindows } = require('../services/scheduling/occupancy');
const { buildBookingAvailability } = require('../routes/booking')._internals;

// 2031-03-04 is a Tuesday before the spring-forward (EST, UTC-5): 15:00Z = 10:00 AM.
const NOW = new Date('2031-03-04T15:00:00Z');
const TODAY = '2031-03-04';
const D = '2031-03-12';

const CONFIG = {
  advance_days_min: 1, advance_days_max: 14,
  slot_duration_minutes: 60,
  day_start: '08:00', day_end: '18:00',
  max_self_books_per_day: 3,
};

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
const tech = (id, hours) => ({ id, shift_start: hours ? hours[0] : null, shift_end: hours ? hours[1] : null });

// One finder slot: an open day (no stops) unless `extra` says otherwise.
function finderSlot(startTime, extra = {}) {
  return {
    date: D,
    start_time: startTime,
    end_time: null,
    technician: { id: 'tech-1' },
    detour_minutes: 3,
    stops_that_day: 0,
    rank: 1,
    score: 10,
    insertion: {},
    // The gap's own last start: the path's 18:00 close, less the drive home.
    latest_start_min: 17 * 60 - 9,
    ...extra,
  };
}

async function build(extra = {}) {
  return buildBookingAvailability({
    lat: 27.4, lng: -82.4, duration: 60,
    rangeFrom: D, rangeTo: D,
    config: CONFIG, today: new Date(), serviceKey: '', ...extra,
  });
}

const offers = (availability, date = D) => ((availability.days || []).find((day) => day.date === date)?.slots || [])
  .map((slot) => `${slot.start_time} ${slot.technician_id}`)
  .sort();
const startTimes = (availability, date = D) => offers(availability, date).map((offer) => offer.split(' ')[0]);

const ALL_BUT_DATE = ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
  'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'];
const GATES = ['GATE_TECH_SHIFT_HOURS', 'GATE_SCHEDULING_CAPACITY'];
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
  tables = { technicians: [tech('tech-1', ['10:00:00', '15:00:00'])] };
  db.mockImplementation((table) => chain(tables[table] || []));
  db.raw = jest.fn((sql) => sql);
  listOccupiedWindows.mockResolvedValue([]);
});

describe('buildBookingAvailability: every offer lies inside its technician\'s shift', () => {
  test('an open day\'s whole block: only 10:00 through 14:00 of a 10:00 to 15:00 shift', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [finderSlot('10:00')], total_feasible: 1 });
    expect(startTimes(await build({ expandOpenDays: true }))).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
  });

  test('a gap\'s later hours stop where a job would pass the shift end', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [finderSlot('10:00')], total_feasible: 1 });
    expect(startTimes(await build())).toEqual(['10:00', '11:00', '12:00', '13:00', '14:00']);
  });

  test('a start the builder snaps back to the day\'s open is dropped when the shift starts later', async () => {
    // The finder's first start of an 08:30 shift is 08:30; the builder snaps a first start to 08:00.
    tables.technicians = [tech('tech-1', ['08:30:00', '12:00:00'])];
    findAvailableSlots.mockResolvedValue({ slots: [finderSlot('08:30')], total_feasible: 1 });
    expect(startTimes(await build())).toEqual(['09:00', '10:00', '11:00']);
  });

  test('a packed end before the next stop is dropped when it would end after the shift', async () => {
    // The gap before a 17:30 stop: the finder's start is 13:00, the packed-before-next end is 16:00.
    findAvailableSlots.mockResolvedValue({
      slots: [finderSlot('13:00', {
        stops_that_day: 2, latest_start_min: 16 * 60 + 20, insertion: { after_stop_id: 'stop-1', before_stop_id: 'stop-2' },
      })],
      total_feasible: 1,
    });
    expect(startTimes(await build())).toEqual(['13:00']);
    tables.technicians = [tech('tech-1', null)];
    expect(startTimes(await build())).toEqual(['13:00', '16:00']);
  });

  test('each technician has their own hours: an hour outside one shift goes to the technician who works it', async () => {
    tables.technicians = [tech('tech-1', ['10:00:00', '15:00:00']), tech('tech-2', null)];
    findAvailableSlots.mockResolvedValue({
      slots: [finderSlot('10:00'), finderSlot('09:00', { technician: { id: 'tech-2' }, rank: 2, score: 20 })],
      total_feasible: 2,
    });
    expect(offers(await build({ expandOpenDays: true }))).toEqual([
      '09:00 tech-2', '10:00 tech-1', '11:00 tech-1', '12:00 tech-1', '13:00 tech-1', '14:00 tech-1',
      '15:00 tech-2', '16:00 tech-2', '17:00 tech-2',
    ]);
  });

  test('a technician without set hours keeps the builder\'s own day', async () => {
    tables.technicians = [tech('tech-1', null)];
    findAvailableSlots.mockResolvedValue({ slots: [finderSlot('09:00')], total_feasible: 1 });
    expect(startTimes(await build({ expandOpenDays: true }))).toEqual(
      ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'],
    );
  });

  test('the shift only narrows: hours wider than the builder\'s day add nothing', async () => {
    tables.technicians = [tech('tech-1', ['06:00:00', '21:00:00'])];
    // A gap whose next stop is after hours: its own last start is 18:00, past the builder's 18:00 close.
    findAvailableSlots.mockResolvedValue({ slots: [finderSlot('08:30', { latest_start_min: 18 * 60 })], total_feasible: 1 });
    expect(startTimes(await build())).toEqual(
      ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'],
    );
  });

  test('capacity mode: a start outside the shift is not offered', async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    findAvailableSlots.mockResolvedValue({
      slots: [finderSlot('09:00', { latest_start_min: 540 }), finderSlot('14:00', { latest_start_min: 840 }), finderSlot('15:00', { latest_start_min: 900 })],
      total_feasible: 3,
    });
    expect(startTimes(await build())).toEqual(['14:00']);
    // Wider hours never bring back a start before the builder's own 08:00 open.
    tables.technicians = [tech('tech-1', ['06:00:00', '21:00:00'])];
    findAvailableSlots.mockResolvedValue({
      slots: [finderSlot('07:00', { latest_start_min: 420 }), finderSlot('08:00', { latest_start_min: 480 })], total_feasible: 2,
    });
    expect(startTimes(await build())).toEqual(['08:00']);
  });

  test('today follows the clock-in: a 07:30 clock-in on 08:00 to 14:00 hours ends today at 13:30', async () => {
    tables.technicians = [tech('tech-1', ['08:00:00', '14:00:00'])];
    findAvailableSlots.mockResolvedValue({
      slots: [finderSlot('11:00', { date: TODAY }), finderSlot('09:00', { rank: 2, score: 20 })],
      total_feasible: 2,
    });
    const before = await build({ rangeFrom: TODAY });
    expect(startTimes(before, TODAY)).toEqual(['11:00', '12:00', '13:00']);
    tables.time_entries = [{ technician_id: 'tech-1', clock_in: new Date('2031-03-04T12:30:00Z') }];
    const after = await build({ rangeFrom: TODAY });
    expect(startTimes(after, TODAY)).toEqual(['11:00', '12:00']);
    // Another day keeps the set hours.
    expect(startTimes(after)).toEqual(['09:00', '10:00', '11:00', '12:00', '13:00']);
  });

  test('the gate off: the set hours change nothing, and no shift read is made', async () => {
    delete process.env.GATE_TECH_SHIFT_HOURS;
    findAvailableSlots.mockResolvedValue({ slots: [finderSlot('09:00')], total_feasible: 1 });
    expect(startTimes(await build({ expandOpenDays: true }))).toEqual(
      ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'],
    );
    expect(reads('technicians')).toBe(0);
    expect(reads('time_entries')).toBe(0);
  });

  test('a failed read of the hours fails the build: no hour is offered on a guess', async () => {
    findAvailableSlots.mockResolvedValue({ slots: [finderSlot('09:00')], total_feasible: 1 });
    db.mockImplementation((table) => {
      if (table === 'technicians') throw new Error('connection refused');
      return chain(tables[table] || []);
    });
    await expect(build({ expandOpenDays: true })).rejects.toThrow('connection refused');
  });
});
