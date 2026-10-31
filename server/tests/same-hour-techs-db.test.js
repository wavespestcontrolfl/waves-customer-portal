const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;
/**
 * Same-hour technicians in hour mode on real PostgreSQL (owner 2026-10-30): with GATE_MULTI_TECH_CONFIRM
 * on and GATE_SCHEDULING_CAPACITY off (live today), technician A's 09:00 visit does not take technician
 * B's 09:00 hour. An unassigned 09:00 row blocks both. With the gate unset, 09:00 is refused to B.
 * Covers the REAL SQL of the commit probe every /book, hold and pick path runs (findConflictingVisits,
 * plain and travel-gap), the estimate offer filter (filterCollidingSlots), the ASAP packing dates
 * (stopDatesInRange) and the pick's free-time check (technicianFreeAt). Connection-local TEMP copies of
 * the schema inside one transaction that always rolls back; it refuses any database but a private QA
 * one or CI's.
 */
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { etDateString, addETDays } = require('../utils/datetime-et');

jest.setTimeout(60000);
const DAY = etDateString(addETDays(new Date(), 10));
const TECH_A = '10000000-0000-4000-8000-0000000000a1';
const TECH_B = '10000000-0000-4000-8000-0000000000b2';
const CUSTOMER = '30000000-0000-4000-8000-0000000000c1';
const ROW_A = '20000000-0000-4000-8000-0000000000a1';
const ROW_UNASSIGNED = '20000000-0000-4000-8000-0000000000a2';
const GATES = ['GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM', 'GATE_SLOT_TRAVEL_GAP'];

maybeDescribe('same-hour technicians, hour mode (real PostgreSQL)', () => {
  let database;
  let findConflictingVisits;
  let filterCollidingSlots;
  let stopDatesInRange;
  let technicianFreeAt;
  const saved = Object.fromEntries(GATES.map((k) => [k, process.env[k]]));

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
    ({ findConflictingVisits } = require('../services/scheduling/occupancy'));
    ({ filterCollidingSlots, stopDatesInRange } = require('../services/estimate-slot-availability')._internals);
    ({ technicianFreeAt } = require('../services/scheduling/pick-technician'));
  });
  afterAll(async () => {
    if (database) await database.destroy();
    GATES.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });
  beforeEach(async () => {
    GATES.forEach((k) => delete process.env[k]);
    mockConn = await database.transaction();
    for (const table of ['scheduled_services', 'customers', 'technicians', 'tech_schedule_blocks', 'technician_absences', 'services', 'system_settings']) {
      await mockConn.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
    }
    await mockConn('customers').insert({ id: CUSTOMER, first_name: 'Fixture', last_name: 'Account' });
    const base = { customer_id: CUSTOMER, status: 'confirmed', estimated_duration_minutes: 60, scheduled_date: DAY, lat: 27.5, lng: -82.4 };
    await mockConn('scheduled_services').insert([
      // Technician A's 09:00-10:00 stop.
      { ...base, id: ROW_A, technician_id: TECH_A, window_start: '09:00', window_end: '10:00' },
      // An unassigned 13:00-14:00 stop.
      { ...base, id: ROW_UNASSIGNED, technician_id: null, window_start: '13:00', window_end: '14:00' },
    ]);
  });
  afterEach(async () => { await mockConn.rollback(); });

  const gateOn = () => { process.env.GATE_MULTI_TECH_CONFIRM = 'true'; }; // capacity stays off
  const probe = (windowStart, windowEnd, extra = {}) => findConflictingVisits({
    db: mockConn, date: DAY, windowStart, windowEnd, ...extra,
  }).then((rows) => rows.map((r) => r.id).sort());

  test.each([
    ['plain overlap SQL', {}],
    ['travel-gap variant', { travel: { lat: 27.5, lng: -82.4 } }],
  ])('%s, gate unset: 09:00 is refused to technician B (tech-blind hour mode, today)', async (_n, extra) => {
    if (extra.travel) process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    await expect(probe('09:00', '10:00', { ...extra, technicianId: TECH_B })).resolves.toEqual([ROW_A]);
  });

  test.each([
    ['plain overlap SQL', {}],
    ['travel-gap variant', { travel: { lat: 27.5, lng: -82.4 } }],
  ])('%s, gate on + capacity off: technician B gets 09:00; A\'s own and unassigned rows still block', async (_n, extra) => {
    gateOn();
    if (extra.travel) process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    await expect(probe('09:00', '10:00', { ...extra, technicianId: TECH_B })).resolves.toEqual([]);
    await expect(probe('09:00', '10:00', { ...extra, technicianId: TECH_A })).resolves.toEqual([ROW_A]);
    await expect(probe('13:00', '14:00', { ...extra, technicianId: TECH_A })).resolves.toEqual([ROW_UNASSIGNED]);
    await expect(probe('13:00', '14:00', { ...extra, technicianId: TECH_B })).resolves.toEqual([ROW_UNASSIGNED]);
  });

  test('gate on, no technicianId (admin, rebooker callers): stays tech-blind', async () => {
    gateOn();
    await expect(probe('09:00', '10:00')).resolves.toEqual([ROW_A]);
  });

  describe('estimate offers', () => {
    const slot = (techId, start = '09:00', end = '10:00') => ({
      slotId: `${DAY}_${start.replace(':', '-')}_${techId}`, date: DAY, windowStart: start, windowEnd: end, durationMinutes: 60, techId,
    });
    const range = { dateFrom: DAY, dateTo: DAY };

    test('filterCollidingSlots: gate unset drops B\'s 09:00; gate on keeps it, still drops A\'s 09:00 and unassigned 13:00 for both', async () => {
      const all = [slot(TECH_A), slot(TECH_B), slot(TECH_A, '13:00', '14:00'), slot(TECH_B, '13:00', '14:00')];
      const unset = await filterCollidingSlots(all, range);
      expect(unset).toHaveLength(0);
      gateOn();
      const on = await filterCollidingSlots(all, range);
      expect(on.map((s) => `${s.techId}@${s.windowStart}`)).toEqual([`${TECH_B}@09:00`]);
    });

    test('stopDatesInRange: gate unset is the date set; gate on keys A\'s stop by technician and the unassigned stop by date', async () => {
      const unset = await stopDatesInRange(DAY, DAY);
      expect([...unset]).toEqual([DAY]);
      gateOn();
      const on = await stopDatesInRange(DAY, DAY);
      expect([...on].sort()).toEqual([DAY, `${TECH_A}|${DAY}`].sort());
    });
  });

  describe('the pick (technicianFreeAt)', () => {
    const free = (technicianId, windowStart, windowEnd) => technicianFreeAt({
      conn: mockConn, technicianId, date: DAY, windowStart, windowEnd,
    });
    test('gate unset: nobody is free at 09:00; gate on: B is free, A is not; unassigned 13:00 blocks both', async () => {
      await expect(free(TECH_B, '09:00', '10:00')).resolves.toBe(false);
      gateOn();
      await expect(free(TECH_B, '09:00', '10:00')).resolves.toBe(true);
      await expect(free(TECH_A, '09:00', '10:00')).resolves.toBe(false);
      await expect(free(TECH_A, '13:00', '14:00')).resolves.toBe(false);
      await expect(free(TECH_B, '13:00', '14:00')).resolves.toBe(false);
    });
  });
});
