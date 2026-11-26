// Estimate time picker, hour mode, on real PostgreSQL: a visit staff booked keeps its old hold timestamp
// until cleanup runs. After that timestamp passes, the picker must still treat the visit as taken, and
// must still release an unclaimed hold at expiry. Covers the two reads of estimate-slot-availability.js:
// filterCollidingSlots (the offer filter) and stopDatesInRange (the dates that pack ASAP windows).
// Each test runs on connection-local TEMP copies of the schema inside one transaction that rolls back.
// No new gate: the change only hides openings that are already taken.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
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
const TECH = '10000000-0000-4000-8000-0000000000a1';
const OTHER_TECH = '10000000-0000-4000-8000-0000000000b2';
const CUSTOMER = '30000000-0000-4000-8000-0000000000c1';
const GATES = ['GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM', 'GATE_SLOT_TRAVEL_GAP', 'GATE_BOOKING_MAKE_ROOM'];

postgres('estimate picker counts staff-booked visits (real PostgreSQL)', () => {
  let database;
  let filterCollidingSlots;
  let stopDatesInRange;
  const saved = Object.fromEntries(GATES.map((k) => [k, process.env[k]]));

  beforeAll(() => {
    const target = new URL(process.env.DATABASE_URL);
    // This worktree's OWN QA database, never another checkout's, or CI's database.
    const worktreeId = String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '');
    const privateQa = process.env.WAVES_LOCAL_DEV === '1' && /^[a-f0-9]{32}$/.test(worktreeId) && target.pathname === `/waves_qa_${worktreeId}`;
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error("Use this worktree's private QA database or the isolated CI database");
    // The driver copies every query parameter into its settings: refuse a URL with a query and
    // build the pool from the parts this guard read, never the URL text.
    if (target.search) throw new Error('DATABASE_URL must not carry query parameters');
    database = require('knex')({
      client: 'pg',
      connection: {
        host: target.hostname,
        port: target.port ? Number(target.port) : undefined,
        user: decodeURIComponent(target.username) || undefined,
        password: decodeURIComponent(target.password) || undefined,
        database: target.pathname.slice(1),
      },
      pool: { min: 0, max: 1 },
    });
    ({ filterCollidingSlots, stopDatesInRange } = require('../services/estimate-slot-availability')._internals);
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
  });
  afterEach(async () => { await mockConn.rollback(); });

  const SECONDS = { live: 600, lapsed: -600, cleared: null };
  // One 10:00-11:00 visit; `owner` is a customer (staff booked it) or null (an unclaimed hold).
  const insertVisit = (owner, expiry, extra = {}) => mockConn('scheduled_services').insert({
    customer_id: owner ? CUSTOMER : null,
    status: owner ? 'confirmed' : 'scheduled',
    scheduled_date: DAY,
    window_start: '10:00',
    window_end: '11:00',
    estimated_duration_minutes: 60,
    technician_id: TECH,
    reservation_expires_at: SECONDS[expiry] == null ? null : mockConn.raw(`NOW() + (?::int * INTERVAL '1 second')`, [SECONDS[expiry]]),
    ...extra,
  });
  const slot = (techId = TECH) => ({
    slotId: `${DAY}_10-00_${techId}`, date: DAY, windowStart: '10:00', windowEnd: '11:00', durationMinutes: 60, techId,
  });
  const range = { dateFrom: DAY, dateTo: DAY };

  describe('offer filter (filterCollidingSlots)', () => {
    test.each(['live', 'lapsed', 'cleared'])('a staff-booked visit blocks its hour, hold timestamp %s', async (expiry) => {
      await insertVisit(true, expiry);
      await expect(filterCollidingSlots([slot()], range)).resolves.toEqual([]);
    });

    test('an unclaimed hold blocks its hour while live and releases it at expiry', async () => {
      await insertVisit(false, 'live');
      await expect(filterCollidingSlots([slot()], range)).resolves.toEqual([]);
      await mockConn('scheduled_services').update({ reservation_expires_at: mockConn.raw(`NOW() - INTERVAL '10 minutes'`) });
      await expect(filterCollidingSlots([slot()], range)).resolves.toHaveLength(1);
    });

    test('a lapsed booking on one technician does not block another technician with the tech gate on', async () => {
      process.env.GATE_MULTI_TECH_CONFIRM = 'true';
      await insertVisit(true, 'lapsed');
      const kept = await filterCollidingSlots([slot(TECH), slot(OTHER_TECH)], range);
      expect(kept.map((s) => s.techId)).toEqual([OTHER_TECH]);
    });

    test("this estimate's own unclaimed hold still does not block it, a booking of the same estimate does", async () => {
      const estimateId = '40000000-0000-4000-8000-0000000000e1';
      await insertVisit(false, 'live', { source_estimate_id: estimateId });
      await expect(filterCollidingSlots([slot()], { ...range, ownEstimateId: estimateId })).resolves.toHaveLength(1);
      await mockConn('scheduled_services').del();
      await insertVisit(true, 'lapsed', { source_estimate_id: estimateId });
      await expect(filterCollidingSlots([slot()], { ...range, ownEstimateId: estimateId })).resolves.toEqual([]);
    });
  });

  describe('packed dates (stopDatesInRange)', () => {
    test.each(['live', 'lapsed', 'cleared'])('a staff-booked visit makes its date a stop date, hold timestamp %s', async (expiry) => {
      await insertVisit(true, expiry);
      expect([...await stopDatesInRange(DAY, DAY)]).toEqual([DAY]);
    });

    test('a lapsed unclaimed hold is not a stop date', async () => {
      await insertVisit(false, 'lapsed');
      expect([...await stopDatesInRange(DAY, DAY)]).toEqual([]);
    });
  });
});
