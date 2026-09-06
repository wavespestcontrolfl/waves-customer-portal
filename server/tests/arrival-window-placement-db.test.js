// Optional real PostgreSQL verification. Use ONLY a dev/preview connection.
// All fixture tables are connection-local copies of the deployed schema,
// contain synthetic rows, and disappear when each transaction rolls back.
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const knex = require('knex');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { findConflictingVisits, acquireOccupancyLock } = require('../services/scheduling/occupancy');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { checkSlots } = require('../services/rain-out');
const { checkArrivalPlacement } = require('../services/scheduling/arrival-route');

const connection = process.env.ARRIVAL_ROUTE_TEST_DATABASE_URL;
const describeDb = connection ? describe : describe.skip;
const DAY = etDateString(addETDays(new Date(), 10));
const OLD_DAY = etDateString(addETDays(new Date(), 9));
const TECH = '10000000-0000-4000-8000-000000000001';
const TARGET = '20000000-0000-4000-8000-000000000001';
const NORTH = '20000000-0000-4000-8000-000000000002';
const SOUTH = '20000000-0000-4000-8000-000000000003';
const BLOCKER = '20000000-0000-4000-8000-000000000004';
const CUSTOMER = '30000000-0000-4000-8000-000000000001';
const OPTIONS = {
  lat: 27.545, lng: -82.4, dateFrom: DAY, dateTo: DAY, durationMinutes: 60,
  technicianId: TECH, includeWeekends: true, includeBlackoutDates: true,
  excludeServiceIds: [TARGET], arrivalWindow: { serviceId: TARGET }, topN: 12,
};
const probe = (extras = {}) => findConflictingVisits({
  db: mockConn, date: DAY, windowStart: '09:00', windowEnd: '10:00', excludeServiceIds: [TARGET],
  arrivalWindow: { serviceId: TARGET, technicianId: TECH }, ...extras,
});

describeDb('arrival-window offer/save agreement on real PostgreSQL', () => {
  let database;
  const gates = ['GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_DRIVE_TIME_CALIBRATION'];
  const saved = Object.fromEntries(gates.map(k => [k, process.env[k]]));
  beforeAll(() => {
    gates.forEach(k => { process.env[k] = 'true'; });
    database = knex({ client: 'pg', connection: { connectionString: connection, ssl: { rejectUnauthorized: false } }, pool: { min: 0, max: 1 } });
  });
  afterAll(async () => {
    await database.destroy();
    gates.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });
  beforeEach(async () => {
    mockConn = await database.transaction();
    // No production URL, permanent tables, migration execution, or triggers.
    for (const table of ['scheduled_services', 'customers', 'technicians']) {
      await mockConn.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
    }
    await mockConn('technicians').insert({ id: TECH, name: 'Fixture technician', active: true, employment_status: 'active', field_dispatchable: true });
    await mockConn('customers').insert({ id: CUSTOMER, first_name: 'Fixture', last_name: 'Account' });
    const base = { customer_id: CUSTOMER, technician_id: TECH, status: 'confirmed', estimated_duration_minutes: 60, lng: -82.4, created_at: '2020-01-01T12:00:00Z' };
    await mockConn('scheduled_services').insert([
      { ...base, id: NORTH, scheduled_date: DAY, window_start: '08:00', window_end: '09:00', lat: 27.55 },
      { ...base, id: SOUTH, scheduled_date: DAY, window_start: '10:00', window_end: '11:00', lat: 27.45 },
      { ...base, id: TARGET, scheduled_date: OLD_DAY, window_start: '09:00', window_end: '10:00', lat: 27.545, created_at: '2020-01-02T12:00:00Z' },
    ]);
    await acquireOccupancyLock(mockConn, DAY);
  });
  afterEach(async () => { await mockConn.rollback(); });

  test('ranks the nearby morning placement first, and picker/live-check/save agree without rewriting other promises', async () => {
    const offers = await findAvailableSlots(OPTIONS);
    expect(offers.slots[0]).toMatchObject({ start_time: '09:00', route_mode: 'arrival_windows' });
    expect(offers.slots[0].route_arrivals.map(s => s.id)).toEqual([NORTH, TARGET, SOUTH]);
    expect(offers.slots[0].route_arrivals.find(s => s.id === SOUTH).arrival < '12:00').toBe(true);
    expect(await probe()).toEqual([]);
    const check = await checkSlots({ targets: [{ serviceId: TARGET, technicianId: TECH, date: DAY, window: { start: '09:00', end: '10:00' }, excludeServiceIds: [TARGET] }] });
    expect(check.results[0].conflicts).toEqual([]);
    await mockConn('scheduled_services').where({ id: TARGET }).update({ scheduled_date: DAY, window_start: '09:00', window_end: '10:00' });
    const neighbours = await mockConn('scheduled_services').whereIn('id', [NORTH, SOUTH]).select('id', 'window_start', 'window_end').orderBy('window_start');
    expect(neighbours).toEqual([
      { id: NORTH, window_start: '08:00:00', window_end: '09:00:00' },
      { id: SOUTH, window_start: '10:00:00', window_end: '11:00:00' },
    ]);
  });

  test('fresh save check catches work added after the suggestion, including technician-NULL rows', async () => {
    expect((await findAvailableSlots(OPTIONS)).slots.some(s => s.start_time === '09:00')).toBe(true);
    await mockConn('scheduled_services').insert({ id: BLOCKER, scheduled_date: DAY, window_start: '09:00', window_end: '12:00', status: 'confirmed', estimated_duration_minutes: 180, technician_id: null });
    expect((await probe())[0]).toMatchObject({ conflict_reason: 'arrival_window' });
    expect((await findAvailableSlots(OPTIONS)).slots.some(s => s.start_time === '09:00')).toBe(false);
  });

  test('live holds block actual work; expired holds release it in both offer and save queries', async () => {
    await mockConn('scheduled_services').insert({ id: BLOCKER, scheduled_date: DAY, window_start: '09:00', window_end: '12:00', status: 'pending', technician_id: TECH, reservation_expires_at: new Date(Date.now() + 60_000) });
    expect((await probe())[0].conflict_reason).toBe('arrival_window');
    await mockConn('scheduled_services').where({ id: BLOCKER }).update({ reservation_expires_at: new Date(Date.now() - 60_000) });
    expect(await probe()).toEqual([]);
    expect((await findAvailableSlots(OPTIONS)).slots[0].start_time).toBe('09:00');
  });

  test('a grouped target remains unverified when its sibling is still on the source date', async () => {
    const visitId = '40000000-0000-4000-8000-000000000001';
    await mockConn('scheduled_services').where({ id: TARGET }).update({ visit_id: visitId });
    await mockConn('scheduled_services').insert({
      id: BLOCKER, visit_id: visitId, scheduled_date: OLD_DAY, status: 'confirmed',
      technician_id: TECH, window_start: '09:00', window_end: '10:00', lat: 27.545, lng: -82.4,
    });
    expect((await probe())[0].conflict_reason).toBe('route_unverified');
    expect((await findAvailableSlots(OPTIONS)).slots).toEqual([]);
  });

  test('a same-day active target cannot be simulated as an unused technician at HQ', async () => {
    await mockConn('scheduled_services').where({ id: TARGET }).update({ scheduled_date: DAY, status: 'on_site' });
    const fit = await checkArrivalPlacement({
      conn: mockConn, serviceId: TARGET, date: DAY, technicianId: TECH,
      windowStart: '09:00', windowEnd: '10:00', now: parseETDateTime(`${DAY}T08:00:00`),
      // Rebooker resets status for the saved row; that must not erase the
      // evidence that its technician is currently carrying out this stop.
      changes: { status: 'confirmed' },
    });
    expect(fit.reason).toBe('route_unverified');
  });

  test('kill switch retains the existing fixed-block offer and save contracts', async () => {
    process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'false';
    try {
      const offers = await findAvailableSlots(OPTIONS);
      expect(offers.slots.some(s => s.start_time === '09:00')).toBe(false);
      expect(offers.slots.every(s => s.route_mode === undefined)).toBe(true);
      expect(await probe()).toEqual([]); // adjacent work blocks remain advisory, as before
    } finally { process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true'; }
  });
});
