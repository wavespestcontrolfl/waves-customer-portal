/**
 * find-time bufferMinutes (GATE_SLOT_TRAVEL_GAP): on top of the modeled drive,
 * a fixed turnaround separates the new job from a NEIGHBOURING STOP — never
 * from the HQ start/end legs. latest_start_min inherits it so /book's hourly
 * fan-out stays inside the buffered gap. Gate off → legacy geometry exactly.
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = (sql) => ({ toString: () => sql });
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  const PINNED_NOW = new Date('2026-08-31T16:00:00Z');
  return {
    ...actual,
    etParts: (date) => actual.etParts(date || PINNED_NOW),
    etDateString: (date) => actual.etDateString(date || PINNED_NOW),
  };
});
// Pin every leg to 0.5 straight-line miles → 1 legacy minute, so the buffer's
// contribution is visible to the minute.
jest.mock('../services/route-optimizer', () => ({
  HQ: { lat: 27.39, lng: -82.39 },
  haversine: () => 0.5,
  milesToDriveMinutes: jest.requireActual('../services/route-optimizer').milesToDriveMinutes,
}));

const db = require('../models/db');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { customerFacingBufferMinutes } = require('../services/scheduling/travel-gap');

const ENV_KEYS = ['GATE_SLOT_TRAVEL_GAP', 'SLOT_TRAVEL_BUFFER_MINUTES', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function chain(result) {
  const c = {};
  ['whereNotNull', 'where', 'whereBetween', 'whereIn', 'whereNotIn', 'leftJoin', 'orderBy', 'first'].forEach((m) => { c[m] = () => c; });
  c.select = async () => result;
  return c;
}

function nextBookableDate(from) {
  const date = new Date(from);
  do date.setUTCDate(date.getUTCDate() + 1);
  while (date.getUTCDay() === 0);
  return date;
}
const FUTURE_DATE = nextBookableDate(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const BASE = { lat: 27.4, lng: -82.5, durationMinutes: 60, dateFrom: FUTURE_DATE, dateTo: FUTURE_DATE, topN: 5 };

// One geocoded stop 10:00–11:00 on the day.
const STOP = {
  id: 's1', scheduled_date: FUTURE_DATE, technician_id: 't1',
  window_start: '10:00', window_end: '11:00', service_type: 'pest',
  estimated_duration_minutes: 60,
  svc_lat: 27.45, svc_lng: -82.45, cust_lat: null, cust_lng: null,
  first_name: 'Neighbour', last_name: 'Stop', city: 'Bradenton',
};

beforeEach(() => {
  db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 't1', name: 'A' }]) : chain([STOP])));
});

const byInsertion = (slots) => ({
  before: slots.find((s) => s.insertion.before_stop_id === 's1'),
  after: slots.find((s) => s.insertion.after_stop_id === 's1'),
});

test('gate off: legacy geometry — drive only, no buffer', async () => {
  const { before, after } = byInsertion((await findAvailableSlots(BASE)).slots);
  expect(before.start_time).toBe('08:01');                 // HQ leg: 1 min drive
  expect(before.latest_start_min).toBe(600 - 1 - 60);      // 10:00 − drive − duration
  expect(after.start_time).toBe('11:01');                  // 11:00 + drive
});

test('gate on but no bufferMinutes opt (staff / optimizer callers): legacy geometry, the buffer never leaks in', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  const { before, after } = byInsertion((await findAvailableSlots(BASE)).slots);
  expect(before.latest_start_min).toBe(600 - 1 - 60);
  expect(after.start_time).toBe('11:01');
  expect(customerFacingBufferMinutes()).toBe(15);
  delete process.env.GATE_SLOT_TRAVEL_GAP;
  expect(customerFacingBufferMinutes()).toBe(0);
});

test('gate on, customer-facing buffer passed: 15 minutes against the stop on both sides, never on the HQ legs', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  const { before, after } = byInsertion((await findAvailableSlots({ ...BASE, bufferMinutes: customerFacingBufferMinutes() })).slots);
  expect(before.start_time).toBe('08:01');                 // HQ start leg unbuffered
  expect(before.latest_start_min).toBe(600 - 1 - 15 - 60); // 08:44
  expect(after.start_time).toBe('11:16');                  // 11:00 + 1 drive + 15 buffer
});

test('gate on: the env buffer is honoured, and an explicit bufferMinutes opt overrides it', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  process.env.SLOT_TRAVEL_BUFFER_MINUTES = '30';
  const env = byInsertion((await findAvailableSlots({ ...BASE, bufferMinutes: customerFacingBufferMinutes() })).slots);
  expect(env.after.start_time).toBe('11:31');
  const explicit = byInsertion((await findAvailableSlots({ ...BASE, bufferMinutes: 5 })).slots);
  expect(explicit.after.start_time).toBe('11:06');
});

test('gate on: a gap too small for duration + drive + buffer disappears', async () => {
  process.env.GATE_SLOT_TRAVEL_GAP = 'true';
  // Second stop 12:00–13:00: the 11:00–12:00 hole holds a 60-min job only with
  // zero turnaround — it must not be offered once the buffer applies.
  const second = { ...STOP, id: 's2', window_start: '12:00', window_end: '13:00' };
  db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 't1', name: 'A' }]) : chain([STOP, second])));
  const { slots } = await findAvailableSlots({ ...BASE, bufferMinutes: customerFacingBufferMinutes() });
  expect(slots.some((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id === 's2')).toBe(false);
  delete process.env.GATE_SLOT_TRAVEL_GAP;
  const legacy = await findAvailableSlots(BASE);
  // Legacy: 11:01–12:01 > 11:59 latestEnd → also infeasible with 1-min drives
  // each side; widen the hole by a minute to prove the buffer is the difference.
  const wide = { ...second, window_start: '12:03', window_end: '13:03' };
  db.mockImplementation((table) => (table === 'technicians' ? chain([{ id: 't1', name: 'A' }]) : chain([STOP, wide])));
  const legacyWide = await findAvailableSlots(BASE);
  expect(legacyWide.slots.some((s) => s.insertion.after_stop_id === 's1' && s.insertion.before_stop_id === 's2')).toBe(true);
  expect(legacy.slots.length).toBeGreaterThan(0);
});
