// Optional real PostgreSQL verification. Use ONLY a dev/preview connection.
// All fixture tables are connection-local copies of the deployed schema,
// contain synthetic rows, and disappear when each transaction rolls back.
// Same convention as arrival-window-placement-db.test.js — this file proves
// createSelfBooking's assertBookCapacityCommit (GATE_BOOK_CAPACITY_COMMIT)
// against the REAL arrival-route whole-route simulation instead of a mock:
// a feasible slot still books, and a later booking landing on the same
// tech-day (never overlapping the candidate's own window) is refused with
// the SLOT_TAKEN shape once checkArrivalPlacement genuinely finds the route
// infeasible.
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/geocoder', () => ({
  ...jest.requireActual('../services/geocoder'),
  geocodeAddress: jest.fn(),
}));

const knex = require('knex');
const { assertBookCapacityCommit } = require('../routes/booking')._internals;
const { etDateString, addETDays } = require('../utils/datetime-et');
const { geocodeAddress } = require('../services/geocoder');

const connection = process.env.BOOK_CAPACITY_COMMIT_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;
jest.setTimeout(30000);
const DAY = etDateString(addETDays(new Date(), 10));
const TECH = '10000000-0000-4000-8000-000000000011';
const NORTH = '20000000-0000-4000-8000-000000000011';
const SOUTH = '20000000-0000-4000-8000-000000000012';
const BLOCKER = '20000000-0000-4000-8000-000000000013';
const CUSTOMER = '30000000-0000-4000-8000-000000000011';

// The candidate self-booking commit under test — never a stored row (the
// booking hasn't inserted yet at the point assertBookCapacityCommit runs).
const CANDIDATE = {
  technicianId: TECH, date: DAY, windowStart: '09:00', windowEnd: '10:00',
  durationMinutes: 60, lat: 27.545, lng: -82.4, serviceType: 'Pest Control',
};

describeDb('createSelfBooking commit-time capacity re-check on real PostgreSQL', () => {
  let database;
  const gates = ['GATE_SCHEDULING_CAPACITY', 'GATE_BOOK_CAPACITY_COMMIT'];
  const saved = Object.fromEntries(gates.map((k) => [k, process.env[k]]));
  beforeAll(() => {
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  });
  afterAll(async () => {
    await database.destroy();
    gates.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });
  beforeEach(async () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    process.env.GATE_BOOK_CAPACITY_COMMIT = 'true';
    geocodeAddress.mockReset().mockResolvedValue(null);
    mockConn = await database.transaction();
    // No production URL, permanent tables, migration execution, or triggers —
    // connection-local temp copies of the deployed schema, empty, dropped on
    // commit (this test always rolls back instead).
    for (const table of ['scheduled_services', 'customers', 'technicians', 'tech_schedule_blocks']) {
      await mockConn.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
    }
    await mockConn('technicians').insert({ id: TECH, name: 'Fixture technician', active: true, employment_status: 'active', field_dispatchable: true });
    await mockConn('customers').insert({ id: CUSTOMER, first_name: 'Fixture', last_name: 'Account' });
    const base = { customer_id: CUSTOMER, technician_id: TECH, status: 'confirmed', estimated_duration_minutes: 60, lng: -82.4, created_at: '2020-01-01T12:00:00Z' };
    await mockConn('scheduled_services').insert([
      { ...base, id: NORTH, scheduled_date: DAY, window_start: '08:00', window_end: '09:00', lat: 27.55 },
      { ...base, id: SOUTH, scheduled_date: DAY, window_start: '10:00', window_end: '11:00', lat: 27.45 },
    ]);
  });
  afterEach(async () => { await mockConn.rollback(); });

  test('feasible slot still books: resolves without throwing', async () => {
    await expect(assertBookCapacityCommit({ ...CANDIDATE, trx: mockConn })).resolves.toBeUndefined();
  });

  test('a slot made infeasible by a later booking on the same tech-day is refused with the SLOT_TAKEN shape', async () => {
    // Same tuple that already books cleanly above. Then another booking
    // lands on this tech-day between offer and confirm — a committed,
    // technician-unassigned visit occupying 09:00-12:00 (the exact fixture
    // arrival-window-placement-db.test.js uses to prove the offer/save
    // engine detects this class of blocker) — before the candidate's own
    // insert. It never overlaps the candidate in the traditional per-tech
    // sense (it isn't even assigned to TECH), so this is precisely the case
    // findConflictingVisits' overlap predicate is narrow for and this gate
    // exists to close.
    await expect(assertBookCapacityCommit({ ...CANDIDATE, trx: mockConn })).resolves.toBeUndefined();
    await mockConn('scheduled_services').insert({
      id: BLOCKER, scheduled_date: DAY, window_start: '09:00', window_end: '12:00',
      status: 'confirmed', estimated_duration_minutes: 180, technician_id: null,
    });
    await expect(assertBookCapacityCommit({ ...CANDIDATE, trx: mockConn })).rejects.toMatchObject({
      code: 'SLOT_TAKEN', statusCode: 409, isOperational: true,
    });
  });

  test('GATE_BOOK_CAPACITY_COMMIT off: no new check even on an infeasible day (gate-off byte-identical)', async () => {
    await mockConn('scheduled_services').insert({
      id: BLOCKER, scheduled_date: DAY, window_start: '09:00', window_end: '12:00',
      status: 'confirmed', estimated_duration_minutes: 180, technician_id: null,
    });
    delete process.env.GATE_BOOK_CAPACITY_COMMIT;
    await expect(assertBookCapacityCommit({ ...CANDIDATE, trx: mockConn })).resolves.toBeUndefined();
  });

  test('GATE_SCHEDULING_CAPACITY off: no new check either, even with GATE_BOOK_CAPACITY_COMMIT on', async () => {
    await mockConn('scheduled_services').insert({
      id: BLOCKER, scheduled_date: DAY, window_start: '09:00', window_end: '12:00',
      status: 'confirmed', estimated_duration_minutes: 180, technician_id: null,
    });
    delete process.env.GATE_SCHEDULING_CAPACITY;
    await expect(assertBookCapacityCommit({ ...CANDIDATE, trx: mockConn })).resolves.toBeUndefined();
  });
});
