// Optional real PostgreSQL verification (same convention as
// booking-capacity-commit-db.test.js): connection-local TEMP copies of the
// deployed schema, synthetic rows, everything rolled back. Proves the REAL SQL
// of occupancy.js's tech-aware confirm scope (GATE_MULTI_TECH_CONFIRM, dark) —
// both the plain overlap query and the GATE_SLOT_TRAVEL_GAP variant — with two
// technicians, plus the /book confirm-side zone/hold predicate shape.
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const { probeMoveConflicts } = require('../services/rebooker');
const { etDateString, addETDays } = require('../utils/datetime-et');

const connection = process.env.BOOK_CAPACITY_COMMIT_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;
jest.setTimeout(30000);
const DAY = etDateString(addETDays(new Date(), 10));
const TECH_A = '10000000-0000-4000-8000-0000000000a1';
const TECH_B = '10000000-0000-4000-8000-0000000000b2';
const CUSTOMER = '30000000-0000-4000-8000-0000000000c1';
const ROW_A = '20000000-0000-4000-8000-0000000000a1';
const ROW_UNASSIGNED = '20000000-0000-4000-8000-0000000000a2';
const ROW_B = '20000000-0000-4000-8000-0000000000b1';

const GATES = ['GATE_SCHEDULING_CAPACITY', 'GATE_MULTI_TECH_CONFIRM', 'GATE_SLOT_TRAVEL_GAP'];

describeDb('tech-aware confirm scope on real PostgreSQL', () => {
  let database;
  const saved = Object.fromEntries(GATES.map((k) => [k, process.env[k]]));
  beforeAll(() => { database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } }); });
  afterAll(async () => {
    await database.destroy();
    GATES.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });
  beforeEach(async () => {
    GATES.forEach((k) => delete process.env[k]);
    mockConn = await database.transaction();
    for (const table of ['scheduled_services', 'customers', 'services', 'system_settings']) {
      await mockConn.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
    }
    await mockConn('customers').insert({ id: CUSTOMER, first_name: 'Fixture', last_name: 'Account' });
    const base = { customer_id: CUSTOMER, status: 'confirmed', estimated_duration_minutes: 60, scheduled_date: DAY, lat: 27.5, lng: -82.4 };
    await mockConn('scheduled_services').insert([
      // Technician A's stop right at 09:00-10:00.
      { ...base, id: ROW_A, technician_id: TECH_A, window_start: '09:00', window_end: '10:00' },
      // An unassigned stop at 13:00-14:00.
      { ...base, id: ROW_UNASSIGNED, technician_id: null, window_start: '13:00', window_end: '14:00' },
      // Technician B's own stop at 15:00-16:00.
      { ...base, id: ROW_B, technician_id: TECH_B, window_start: '15:00', window_end: '16:00' },
    ]);
  });
  afterEach(async () => { await mockConn.rollback(); });

  const probe = (windowStart, windowEnd, extra = {}) => findConflictingVisits({
    db: mockConn, date: DAY, windowStart, windowEnd, ...extra,
  }).then((rows) => rows.map((r) => r.id).sort());
  const scopeOn = () => { process.env.GATE_SCHEDULING_CAPACITY = 'true'; process.env.GATE_MULTI_TECH_CONFIRM = 'true'; };

  test.each([
    ['plain overlap SQL', {}],
    ['travel-gap variant', { travel: { lat: 27.5, lng: -82.4 } }],
  ])('%s: gate off stays tech-blind even when a technicianId is passed (current behavior)', async (_n, extra) => {
    if (extra.travel) process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    // Technician B's slot next to technician A's stop is refused today.
    await expect(probe('09:00', '10:00', { ...extra, technicianId: TECH_B })).resolves.toEqual([ROW_A]);
  });

  test.each([
    ['plain overlap SQL', {}],
    ['travel-gap variant', { travel: { lat: 27.5, lng: -82.4 } }],
  ])('%s: gate on + capacity, technician B is not blocked by technician A\'s overlapping stop', async (_n, extra) => {
    scopeOn();
    if (extra.travel) process.env.GATE_SLOT_TRAVEL_GAP = 'true';
    await expect(probe('09:00', '10:00', { ...extra, technicianId: TECH_B })).resolves.toEqual([]);
    // Same-tech overlap is still refused.
    await expect(probe('09:00', '10:00', { ...extra, technicianId: TECH_A })).resolves.toEqual([ROW_A]);
    // An UNASSIGNED row still blocks both technicians.
    await expect(probe('13:00', '14:00', { ...extra, technicianId: TECH_A })).resolves.toEqual([ROW_UNASSIGNED]);
    await expect(probe('13:00', '14:00', { ...extra, technicianId: TECH_B })).resolves.toEqual([ROW_UNASSIGNED]);
    // Technician B's own stop blocks B, not A.
    await expect(probe('15:00', '16:00', { ...extra, technicianId: TECH_B })).resolves.toEqual([ROW_B]);
    await expect(probe('15:00', '16:00', { ...extra, technicianId: TECH_A })).resolves.toEqual([]);
  });

  test('no technicianId (admin, rebooker, phone agent) stays tech-blind with the gate on', async () => {
    scopeOn();
    await expect(probe('09:00', '10:00')).resolves.toEqual([ROW_A]);
    await expect(probe('15:00', '16:00')).resolves.toEqual([ROW_B]);
  });

  // Owner 2026-10-03, "Moves": the rebooker's move probe scopes to the technician the row is
  // SAVED with, with no capacityPlacement needed. Runs only in CI (needs the database URL).
  describe('rebooker probeMoveConflicts (moves)', () => {
    // The temp table keeps the real UUID id column: the moving row's id (and the
    // exclusion list) must be UUIDs or Postgres rejects the query.
    const MOVING_ROW = '20000000-0000-4000-8000-0000000000f1';
    const move = (technicianId, windowStart, windowEnd, options = {}) => probeMoveConflicts({
      conn: mockConn,
      target: { id: MOVING_ROW, date: DAY, windowStart, windowEnd, technicianId },
      excludeServiceIds: [MOVING_ROW],
      options,
    }).then(({ rows }) => rows.map((r) => r.id).sort());

    test('gate on + capacity: a move that keeps technician B is not blocked by technician A\'s stop; unassigned still blocks', async () => {
      scopeOn();
      await expect(move(TECH_B, '09:00', '10:00')).resolves.toEqual([]);
      await expect(move(TECH_A, '09:00', '10:00')).resolves.toEqual([ROW_A]);
      await expect(move(TECH_B, '13:00', '14:00')).resolves.toEqual([ROW_UNASSIGNED]);
      // A move that unassigns the row (no technician) or opts out stays tech-blind.
      await expect(move(null, '09:00', '10:00')).resolves.toEqual([ROW_A]);
      await expect(move(TECH_B, '09:00', '10:00', { occupancyTechBlind: true })).resolves.toEqual([ROW_A]);
    });

    test('gate off: tech-blind whatever technician the row keeps (current behavior)', async () => {
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      await expect(move(TECH_B, '09:00', '10:00')).resolves.toEqual([ROW_A]);
    });
  });

  test('gate on but capacity mode off: scope is not applied (offer side is tech-blind too)', async () => {
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';
    await expect(probe('09:00', '10:00', { technicianId: TECH_B })).resolves.toEqual([ROW_A]);
  });
});
