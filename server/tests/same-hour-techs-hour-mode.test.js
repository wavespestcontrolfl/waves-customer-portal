/**
 * Same-hour technicians in hour mode (owner 2026-10-30, "so techs can and will book the same hr").
 * GATE_MULTI_TECH_CONFIRM alone (GATE_SCHEDULING_CAPACITY off, live today) makes each technician's
 * route separate; unset, hour mode is the one-technician rule byte for byte.
 *
 * Behavior matrix proven here (the occupancy.js findConflictingVisits SQL half is in
 * multi-tech-confirm-scope.test.js; the real-SQL half is same-hour-techs-db.test.js):
 *   gate unset + capacity off -> tech-blind          (every "gate unset" test)
 *   gate unset + capacity on  -> today's capacity     (capacity-mode tests)
 *   gate on    + capacity on  -> today's multi-tech   (capacity-mode tests)
 *   gate on    + capacity off -> NEW scoped hour mode (every "gate on" test)
 */
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/scheduling/find-time', () => ({ findAvailableSlots: jest.fn(async () => ({ slots: [], evaluated: 0, total_feasible: 0 })) }));

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const { evaluateArrivalPlacement } = require('../services/scheduling/arrival-route');
const { etDateString, addETDays } = require('../utils/datetime-et');

const { filterCollidingSlots, stopDatesInRange } = estimateSlotAvailability._internals;

const ENV_KEYS = ['GATE_MULTI_TECH_CONFIRM', 'GATE_SCHEDULING_CAPACITY', 'GATE_SLOT_TRAVEL_GAP', 'GATE_DRIVE_TIME_CALIBRATION'];
const saved = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ENV_KEYS) delete process.env[k];
  estimateSlotAvailability._internals.clearCaches();
});
afterAll(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const gateOn = () => { process.env.GATE_MULTI_TECH_CONFIRM = 'true'; };

// ---- arrival-route.js: fixed blocks on a technician's simulated route (hour mode) -------------
describe('arrival-route hour-mode fixed blocks', () => {
  const DATE = etDateString(addETDays(new Date(), 10));
  const stop = (id, windowStart, lat, overrides = {}) => ({
    id, technician_id: 'tech', scheduled_date: DATE, status: 'confirmed',
    window_start: windowStart, window_end: `${String(Number(windowStart.slice(0, 2)) + 1).padStart(2, '0')}:00`,
    estimated_duration_minutes: 60, lat, lng: -82.4, route_order: null,
    created_at: '2020-01-01T12:00:00Z', ...overrides,
  });
  const ctx = (extra) => ({
    date: DATE, now: new Date(), target: stop('target', '09:00', 27.545), rows: [stop('north', '08:00', 27.55), stop('south', '10:00', 27.45), extra], grouped: false,
  });
  const place = { windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60 };
  const blocker = (overrides) => stop('blocker', '09:00', 27.54, { window_end: '12:00', ...overrides });
  const future = () => new Date(Date.now() + 60_000);

  beforeAll(() => { process.env.GATE_DRIVE_TIME_CALIBRATION = 'true'; });

  test.each([
    ['another technician stop', { technician_id: 'other' }],
    ['another technician live hold', { technician_id: 'other', reservation_expires_at: future() }],
    ['own live hold', { reservation_expires_at: future() }],
    ['unassigned row', { technician_id: null }],
  ])('gate unset: %s still blocks (one-technician rule, byte for byte)', (_label, extra) => {
    expect(evaluateArrivalPlacement(ctx(blocker(extra)), place).feasible).toBe(false);
  });

  test.each([
    ['another technician stop', { technician_id: 'other' }],
    ['another technician live hold', { technician_id: 'other', reservation_expires_at: future() }],
  ])('gate on, capacity off: %s does NOT block this technician', (_label, extra) => {
    gateOn();
    expect(evaluateArrivalPlacement(ctx(blocker(extra)), place).feasible).toBe(true);
  });

  test.each([
    ['unassigned row', { technician_id: null }],
    ['unassigned live hold', { technician_id: null, reservation_expires_at: future() }],
    ['own live hold', { reservation_expires_at: future() }],
  ])('gate on, capacity off: %s still blocks', (_label, extra) => {
    gateOn();
    expect(evaluateArrivalPlacement(ctx(blocker(extra)), place).feasible).toBe(false);
  });
});

// ---- estimate-slot-availability.js: filterCollidingSlots ---------------------------------------
describe('filterCollidingSlots (estimate offers)', () => {
  const DATE = '2027-05-20';
  const range = { dateFrom: DATE, dateTo: DATE };
  const wireRows = (rows) => {
    const chain = {
      leftJoin: jest.fn().mockReturnThis(),
      whereBetween: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue(rows),
    };
    db.mockImplementation((table) => {
      if (table === 'scheduled_services') return chain;
      throw new Error(`unexpected table ${table}`);
    });
  };
  const row = (overrides = {}) => ({
    technician_id: 'tech-a', scheduled_date: DATE, window_start: '09:00:00', window_end: '10:00:00',
    estimated_duration_minutes: 60, customer_id: 'cust-1', reservation_expires_at: null, zone: null, customer_city: null, ...overrides,
  });
  const slot = (techId) => ({ slotId: `${DATE}_09-00_${techId}`, date: DATE, windowStart: '09:00', windowEnd: '10:00', durationMinutes: 60, techId });
  const holdFor = (techId) => row({ technician_id: techId, customer_id: null, reservation_expires_at: new Date(Date.now() + 600_000) });

  test('gate unset: technician A\'s 09:00 visit removes the 09:00 slot for technician B (tech-blind)', async () => {
    wireRows([row()]);
    expect(await filterCollidingSlots([slot('tech-b')], range)).toHaveLength(0);
  });

  test('gate on: technician A\'s 09:00 visit does not remove technician B\'s 09:00 slot, but removes A\'s own', async () => {
    gateOn();
    wireRows([row()]);
    const out = await filterCollidingSlots([slot('tech-a'), slot('tech-b')], range);
    expect(out.map((s) => s.techId)).toEqual(['tech-b']);
  });

  test('gate on: an unassigned 09:00 visit removes the slot for every technician', async () => {
    gateOn();
    wireRows([row({ technician_id: null })]);
    expect(await filterCollidingSlots([slot('tech-a'), slot('tech-b')], range)).toHaveLength(0);
  });

  test('gate on: another technician\'s live hold does not block (holds only ever blocked their own technician here)', async () => {
    gateOn();
    wireRows([holdFor('tech-a')]);
    expect((await filterCollidingSlots([slot('tech-b')], range)).map((s) => s.techId)).toEqual(['tech-b']);
    expect(await filterCollidingSlots([slot('tech-a')], range)).toHaveLength(0);
  });

  test('gate on, travel gap on: another technician\'s touching far stop is no travel-gap refusal', async () => {
    gateOn();
    process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    const far = { lat: 27.425, lng: -82.41 };
    wireRows([row({ window_start: '10:00:00', window_end: '11:00:00', ...far })]);
    const candidate = { ...slot('tech-b') };
    expect(await filterCollidingSlots([candidate], { ...range, coords: { lat: 27.545, lng: -82.545 } })).toHaveLength(1);
    // Same row on the SAME technician's route is the refusal travel-gap.js always made.
    expect(await filterCollidingSlots([slot('tech-a')], { ...range, coords: { lat: 27.545, lng: -82.545 } })).toHaveLength(0);
  });

  test('gate on, capacity on: the capacity branch is untouched (no row query at all)', async () => {
    gateOn();
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    wireRows([row()]);
    const s = { ...slot('tech-b'), routeMode: 'arrival_windows' };
    expect(await filterCollidingSlots([s], range)).toHaveLength(1);
  });
});

// ---- estimate-slot-availability.js: stopDatesInRange -------------------------------------------
describe('stopDatesInRange', () => {
  const wire = ({ plucked = [], scoped = [] } = {}) => {
    const chain = {
      whereBetween: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      whereNot: jest.fn().mockReturnThis(),
      distinct: jest.fn(() => ({ pluck: jest.fn().mockResolvedValue(plucked), then: (res, rej) => Promise.resolve(scoped).then(res, rej) })),
    };
    db.mockImplementation(() => chain);
    return chain;
  };

  test('gate unset: the date set is exactly the legacy one (a plain date pluck)', async () => {
    const chain = wire({ plucked: ['2027-05-20'] });
    const out = await stopDatesInRange('2027-05-20', '2027-05-21');
    expect([...out]).toEqual(['2027-05-20']);
    expect(chain.distinct).toHaveBeenCalledWith('scheduled_date');
  });

  test('gate on: assigned stops key by technician, unassigned stops key by date alone', async () => {
    gateOn();
    wire({ scoped: [{ scheduled_date: '2027-05-20', technician_id: 'tech-a' }, { scheduled_date: '2027-05-21', technician_id: null }] });
    const out = await stopDatesInRange('2027-05-20', '2027-05-21');
    expect([...out].sort()).toEqual(['2027-05-21', 'tech-a|2027-05-20']);
  });
});

// ---- ASAP pool wiring: dateHasStop ---------------------------------------------------------------
test('ASAP windows drop on a date with a stop only for the technician it packs (gate on)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services/estimate-slot-availability.js'), 'utf8');
  expect(src.match(/filter\(\(s\) => !dateHasStop\(stopDates, s\)\)/g)).toHaveLength(2);
  expect(src).not.toContain('!stopDates.has(s.date)');
  expect(src).toContain("return stopDates.has(slot.date) || (!!slot.techId && stopDates.has(`${slot.techId}|${slot.date}`));");
});
