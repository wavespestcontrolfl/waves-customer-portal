// Optional real PostgreSQL verification. Use ONLY a dev/preview connection.
// All fixture tables are connection-local copies of the deployed schema,
// contain synthetic rows, and disappear when each transaction rolls back.
// Same convention as arrival-window-placement-db.test.js — this file proves
// the REAL arrival-route whole-route simulation used inline by
// createSelfBooking: a feasible slot remains feasible, a later same-tech stop
// outside the candidate's window passes the legacy overlap predicate but is
// invalidates the prepared proof under live row locks, and — Codex #4992 r1 P1 — when
// evaluateArrivalPlacement
// certifies feasibility through its clockOrder/storedOrderStale fallback
// (a corrected order, not the day's STALE stored route_order values),
// the shared persistArrivalOrder applies that corrected order onto the
// rows instead of leaving the stale one in place.
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
const { prepareArrivalCapacity, verifyArrivalCapacity, persistArrivalOrder } = require('../services/scheduling/arrival-route');
const { findConflictingVisits } = require('../services/scheduling/occupancy');
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
const UNASSIGNED = '20000000-0000-4000-8000-000000000015';
const CUSTOMER = '30000000-0000-4000-8000-000000000011';

// The candidate self-booking commit under test — never a stored row when the
// inline createSelfBooking gate runs.
const CANDIDATE = {
  technicianId: TECH, date: DAY, windowStart: '09:00', windowEnd: '10:00',
  durationMinutes: 60, lat: 27.545, lng: -82.4, serviceType: 'Pest Control',
};

async function insertNonOverlappingRouteOverload(conn) {
  // A legacy/other writer can add this late stop after the 09:00 candidate
  // was offered. Its 17:00 window does not overlap 09:00-10:00, so the
  // existing occupancy predicate admits the candidate; capacity mode still
  // owes the trip back to HQ after the stop's work reaches the 18:00 close.
  await conn('scheduled_services').insert({
    id: BLOCKER, customer_id: CUSTOMER, technician_id: TECH,
    scheduled_date: DAY, window_start: '17:00', window_end: '18:00',
    status: 'confirmed', estimated_duration_minutes: 60,
    lat: 27.5, lng: -82.4, created_at: '2020-01-03T12:00:00Z',
  });
}

async function insertUnassignedMorningBlocker(conn) {
  await conn('scheduled_services').insert({
    id: UNASSIGNED, customer_id: CUSTOMER, technician_id: null,
    scheduled_date: DAY, window_start: '08:00', window_end: '09:00',
    status: 'confirmed', estimated_duration_minutes: 60,
    lat: 27.7, lng: -82.4, created_at: '2020-01-04T12:00:00Z',
  });
}

const prepare = () => prepareArrivalCapacity({
  date: CANDIDATE.date,
  technicianId: CANDIDATE.technicianId,
  prospective: {
    lat: CANDIDATE.lat,
    lng: CANDIDATE.lng,
    estimated_duration_minutes: CANDIDATE.durationMinutes,
    service_type: CANDIDATE.serviceType,
  },
  windowStart: CANDIDATE.windowStart,
  windowEnd: CANDIDATE.windowEnd,
  durationMinutes: CANDIDATE.durationMinutes,
});
const verify = (prepared) => verifyArrivalCapacity(prepared, {
  conn: mockConn,
  windowStart: CANDIDATE.windowStart,
  windowEnd: CANDIDATE.windowEnd,
  durationMinutes: CANDIDATE.durationMinutes,
  serviceTypes: [CANDIDATE.serviceType],
});

describeDb('booking commit whole-route dependency on real PostgreSQL', () => {
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
    for (const table of [
      'scheduled_services', 'customers', 'technicians', 'tech_schedule_blocks',
      'technician_absences', 'technician_capabilities', 'system_settings',
      'schedule_blackout_dates', 'audit_log',
    ]) {
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

  test('feasible slot still books: resolves with the certified fit', async () => {
    await expect(prepare().then(verify))
      .resolves.toEqual(expect.objectContaining({ feasible: true }));
  });

  test('a non-overlapping later stop that overloads the route makes the slot infeasible (createSelfBooking refuses it as SLOT_TAKEN)', async () => {
    const prepared = await prepare();
    await insertNonOverlappingRouteOverload(mockConn);

    // This is the actual guard createSelfBooking runs immediately before the
    // new capacity check. The fixture must pass it, or the test would prove
    // only an overlap rejection that existed before this PR.
    await expect(findConflictingVisits({
      db: mockConn,
      date: DAY,
      windowStart: CANDIDATE.windowStart,
      windowEnd: CANDIDATE.windowEnd,
    })).resolves.toEqual([]);

    await expect(verify(prepared)).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE', reason: 'route_changed',
    });
  });

  test('an unassigned stop landing after preparation invalidates the locked proof', async () => {
    const prepared = await prepare();
    await insertUnassignedMorningBlocker(mockConn);

    await expect(findConflictingVisits({
      db: mockConn,
      date: DAY,
      windowStart: CANDIDATE.windowStart,
      windowEnd: CANDIDATE.windowEnd,
    })).resolves.toEqual([]);
    await expect(verify(prepared)).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE', reason: 'route_changed',
    });
  });

  test('an unchanged unassigned 08:00 stop can make the 09:00 candidate fail arrival capacity', async () => {
    await insertUnassignedMorningBlocker(mockConn);
    await expect(verify(await prepare())).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE', reason: 'arrival_window',
    });
  });

  test('Codex #4992 r1: a stale stored order certified through the clockOrder fallback is PERSISTED, not left stale', async () => {
    // Invert the stored positions against the promised-window chronology —
    // NORTH's window (08:00) is earlier than SOUTH's (10:00), but NORTH is
    // numbered AFTER SOUTH. storedOrderStale (route-reorder-window-fit.js)
    // flags this an 'inversion', so evaluateArrivalPlacement tries BOTH
    // currentOrder (the stale [SOUTH, NORTH] baseline — infeasible, since it
    // would demand SOUTH at 10:00 before NORTH's already-passed 08:00
    // promise) and clockOrder (the corrected [NORTH, SOUTH] baseline) and
    // certifies through whichever fits — here, only clockOrder can.
    await mockConn('scheduled_services').where({ id: NORTH }).update({ route_order: 2 });
    await mockConn('scheduled_services').where({ id: SOUTH }).update({ route_order: 1 });

    const fit = await verify(await prepare());
    expect(fit).toEqual(expect.objectContaining({ feasible: true }));

    // The real commit inserts the row BEFORE persisting the fit's order
    // (createSelfBooking's own sequencing) — mirror that here.
    const [{ id: candidateId }] = await mockConn('scheduled_services').insert({
      id: '20000000-0000-4000-8000-000000000014', customer_id: CUSTOMER, technician_id: TECH,
      scheduled_date: DAY, window_start: CANDIDATE.windowStart, window_end: CANDIDATE.windowEnd,
      status: 'confirmed', estimated_duration_minutes: CANDIDATE.durationMinutes,
      lat: CANDIDATE.lat, lng: CANDIDATE.lng,
    }).returning('id');
    await persistArrivalOrder(mockConn, fit, candidateId);

    const rows = await mockConn('scheduled_services')
      .whereIn('id', [NORTH, candidateId, SOUTH]).select('id', 'route_order');
    const byId = Object.fromEntries(rows.map((row) => [row.id, row.route_order]));
    // The corrected chronological order (NORTH, candidate, SOUTH) is what
    // got written — the stale inversion (NORTH=2, SOUTH=1) did NOT survive.
    expect(byId[NORTH]).toBeLessThan(byId[candidateId]);
    expect(byId[candidateId]).toBeLessThan(byId[SOUTH]);
    expect(byId[NORTH]).toBeLessThan(byId[SOUTH]);
  });

});
