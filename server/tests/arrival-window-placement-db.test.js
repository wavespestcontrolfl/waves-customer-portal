// Optional real PostgreSQL verification. Use ONLY a dev/preview connection.
// All fixture tables are connection-local copies of the deployed schema,
// contain synthetic rows, and disappear when each transaction rolls back.
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
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { findConflictingVisits, acquireOccupancyLock } = require('../services/scheduling/occupancy');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { checkSlots } = require('../services/rain-out');
const { checkArrivalPlacement } = require('../services/scheduling/arrival-route');
const { geocodeAddress } = require('../services/geocoder');

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
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 1 } });
  });
  afterAll(async () => {
    await database.destroy();
    gates.forEach(k => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  });
  beforeEach(async () => {
    geocodeAddress.mockReset().mockResolvedValue(null);
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

  test('capacity finder reads live blocks, eligibility and whole-hour arrivals from PostgreSQL', async () => {
    const gate = process.env.GATE_SCHEDULING_CAPACITY;
    let trafficSpy;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      for (const table of ['tech_schedule_blocks', 'technician_capabilities', 'system_settings', 'schedule_blackout_dates']) {
        await mockConn.raw('CREATE TEMP TABLE ?? ON COMMIT DROP AS SELECT * FROM public.?? WITH NO DATA', [table, table]);
      }
      const offers = await findAvailableSlots({ ...OPTIONS, serviceType: 'Pest Control' });
      expect(offers.slots.length).toBeGreaterThan(0);
      expect((await findAvailableSlots({ ...OPTIONS, serviceType: 'Pest Control', bufferMinutes: 15 })).slots).toEqual(offers.slots);
      await mockConn('scheduled_services').where({ id: TARGET }).update({ scheduled_date: DAY });
      const moving = await findAvailableSlots({ ...OPTIONS, arrivalWindow: undefined });
      expect(moving.slots.length).toBeGreaterThan(0);
      expect(moving.slots.every(slot => slot.route_arrivals.every(row => row.id !== TARGET))).toBe(true);
      expect(offers.slots.every(slot => /^\d{2}:00$/.test(slot.start_time) && slot.start_time <= '16:00')).toBe(true);
      expect(offers.slots.every(slot => slot.travel_source === 'conservative_model')).toBe(true);
      const optimizer = require('../services/route-optimizer');
      const createTravel = optimizer.createSchedulingTravel;
      trafficSpy = jest.spyOn(optimizer, 'createSchedulingTravel').mockImplementation(opts => opts?.maxRequests === 0 ? createTravel(opts)
        : { lookup: () => ({ minutes: 0, source: 'google_traffic' }), preload: async () => {}, diagnostics: () => ({ requests: 0, elements: 0 }) });
      expect((await findAvailableSlots({ ...OPTIONS, durationMinutes: 120 })).slots.some(slot => slot.start_time === '16:00')).toBe(false);
      trafficSpy.mockRestore();
      await mockConn('tech_schedule_blocks').insert({ date: DAY, technician_id: TECH, block_type: 'unavailable', start_time: '08:00', end_time: '18:00' });
      expect((await findAvailableSlots(OPTIONS)).slots).toEqual([]);
      await mockConn('tech_schedule_blocks').delete();
      await mockConn('technician_capabilities').insert({ technician_id: TECH, service_category: 'general', active: false });
      expect((await findAvailableSlots({ ...OPTIONS, serviceType: 'Pest Control' })).slots).toEqual([]);
      await mockConn('scheduled_services').where({ id: TARGET }).update({ service_type: 'Lawn Care' });
      await mockConn('scheduled_services').where({ id: NORTH }).update({ service_type: 'Lawn Care' });
      expect((await findAvailableSlots({ ...OPTIONS, arrivalWindow: undefined, serviceTypes: ['Lawn Care'] })).slots.some(slot => slot.service_family_score > 0)).toBe(true);
      expect((await findAvailableSlots(OPTIONS)).slots.length).toBeGreaterThan(0);
      await mockConn('technician_capabilities').insert({ technician_id: TECH, service_category: 'lawn', active: false });
      expect((await findAvailableSlots(OPTIONS)).slots).toEqual([]);
      await mockConn('technician_capabilities').delete();
      await mockConn('scheduled_services').where({ id: NORTH }).update({ route_order: 1 });
      await mockConn('scheduled_services').where({ id: SOUTH }).update({ route_order: 2 });
      await mockConn('scheduled_services').where({ id: TARGET }).update({ scheduled_date: OLD_DAY });
      expect((await findAvailableSlots(OPTIONS)).slots.every(slot => slot.route_arrivals.at(-1).id === TARGET)).toBe(true);
      await mockConn('schedule_blackout_dates').insert({ date: DAY });
      expect((await findAvailableSlots(OPTIONS)).slots.length).toBeGreaterThan(0);
      expect((await findAvailableSlots({ ...OPTIONS, includeBlackoutDates: false })).slots).toEqual([]);
    } finally {
      trafficSpy?.mockRestore();
      if (gate === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = gate;
    }
  }, 30000);

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

  test('a short requested block preserves stored work in hints, live checks, and save probes', async () => {
    await mockConn('scheduled_services').where({ id: TARGET }).update({ estimated_duration_minutes: 180 });
    expect((await findAvailableSlots(OPTIONS)).slots.some(slot => slot.start_time === '09:00')).toBe(false);
    expect((await probe())[0].conflict_reason).toBe('arrival_window');
    const check = await checkSlots({ targets: [{ serviceId: TARGET, technicianId: TECH, date: DAY,
      window: { start: '09:00', end: '10:00' }, durationMinutes: 60, excludeServiceIds: [TARGET] }] });
    expect(check.results[0].conflicts[0].reason).toBe('arrival_window');
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

  test('a terminal grouped sibling does not suppress a remaining live appointment', async () => {
    const visitId = '40000000-0000-4000-8000-000000000001';
    await mockConn('scheduled_services').where({ id: TARGET }).update({ visit_id: visitId });
    await mockConn('scheduled_services').insert({
      id: BLOCKER, visit_id: visitId, scheduled_date: OLD_DAY, status: 'completed',
      technician_id: TECH, window_start: '09:00', window_end: '10:00', lat: 27.545, lng: -82.4,
    });
    expect(await probe()).toEqual([]);
    expect((await findAvailableSlots(OPTIONS)).slots[0].start_time).toBe('09:00');
    // A rescheduled sibling still counts as live visit membership.
    await mockConn('scheduled_services').where({ id: BLOCKER }).update({ status: 'rescheduled' });
    expect((await probe())[0].conflict_reason).toBe('route_unverified');
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

  test('fixed-block conflicts include the full persisted combined span and retain database row fields', async () => {
    const mix = { version: 2, allocatedServiceIds: [NORTH, SOUTH] };
    await mockConn('scheduled_services').whereIn('id', [NORTH, SOUTH]).update({
      window_start: '09:00', reservation_service_mix: mix,
    });
    await mockConn('scheduled_services').where({ id: NORTH }).update({ window_end: '09:30', estimated_duration_minutes: 30 });
    await mockConn('scheduled_services').where({ id: SOUTH }).update({ window_end: '09:40', estimated_duration_minutes: 40 });
    await mockConn('scheduled_services').where({ id: TARGET }).update({ reservation_service_mix: mix });
    const conflicts = await findConflictingVisits({
      db: mockConn, date: DAY, windowStart: '09:50', windowEnd: '10:00',
    });
    expect(conflicts.map(row => row.id).sort()).toEqual([NORTH, SOUTH].sort());
    for (const row of conflicts) {
      expect(row.reservation_service_mix).toEqual(mix);
      expect(row).not.toHaveProperty('startMin');
      expect(row).not.toHaveProperty('endMin');
    }
    expect(await findConflictingVisits({
      db: mockConn, date: DAY, windowStart: '10:10', windowEnd: '10:40',
    })).toEqual([]);
  });

  test('a divergent stamp without stored pins uses the same trusted geocode in hints, live checks and saves', async () => {
    await mockConn('customers').where({ id: CUSTOMER }).update({
      address_line1: '200 Fixture Primary Street', city: 'Bradenton', state: 'FL', zip: '34201',
      latitude: 27.1, longitude: -82.7,
    });
    await mockConn('scheduled_services').where({ id: TARGET }).update({
      lat: null, lng: null, service_address_line1: '100 Fixture Rental Street',
      service_address_city: 'Parrish', service_address_state: 'FL', service_address_zip: '34219',
    });
    geocodeAddress.mockResolvedValue({ lat: 27.545, lng: -82.4 });
    const offers = await findAvailableSlots({ ...OPTIONS, lat: 27.1, lng: -82.7 });
    expect(offers.slots[0].start_time).toBe('09:00');
    expect(await probe()).toEqual([]);
    const check = await checkSlots({ targets: [{
      serviceId: TARGET, technicianId: TECH, date: DAY,
      window: { start: '09:00', end: '10:00' }, excludeServiceIds: [TARGET],
    }] });
    expect(check.results[0].conflicts).toEqual([]);
    expect(geocodeAddress.mock.calls).toHaveLength(3);
    for (const [address] of geocodeAddress.mock.calls) {
      expect(address).toBe('100 Fixture Rental Street, Parrish, FL, 34219');
    }
    expect(await mockConn('scheduled_services').where({ id: TARGET }).first('lat', 'lng'))
      .toEqual({ lat: null, lng: null });
  });

  test('an unavailable geocode stays unverified and never borrows a divergent primary pin', async () => {
    await mockConn('customers').where({ id: CUSTOMER }).update({
      address_line1: '200 Fixture Primary Street', city: 'Bradenton', state: 'FL', zip: '34201',
      latitude: 27.545, longitude: -82.4,
    });
    await mockConn('scheduled_services').where({ id: TARGET }).update({
      lat: null, lng: null, service_address_line1: '100 Fixture Rental Street',
      service_address_city: 'Parrish', service_address_state: 'FL', service_address_zip: '34219',
    });
    expect((await findAvailableSlots(OPTIONS)).slots).toEqual([]);
    expect((await probe())[0].conflict_reason).toBe('route_unverified');
    // A failed advisory lookup leaves the writing transaction usable.
    await mockConn('scheduled_services').where({ id: TARGET }).update({ internal_notes: 'Fixture edit' });
    expect(await mockConn('scheduled_services').where({ id: TARGET }).first('lat', 'lng'))
      .toEqual({ lat: null, lng: null });
  });
});
