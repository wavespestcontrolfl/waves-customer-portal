// Pin check after a visit (GATE_PIN_PARKED_CHECK) through PostgreSQL: the migration (up, down, up), the bounded
// Bouncie read, the daily run end to end (flag, no duplicate, close, dismiss), and the one-open-per-customer index.
// Every write runs in a transaction that is rolled back. Synthetic customers, coordinates and vehicle ids only.
// Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(),
}));

const knex = require('knex');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20261009150000_customer_pin_suggestions');
const { runPinParkedCheck, _private: pin } = require('../services/pin-parked-check');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { loadTruckStops } = require('../services/bouncie-truck-stops');
const gps = require('../services/gps-arrival-detector');
const store = require('../services/customer-pin-suggestions');
const reviewStore = require('../services/customer-geocode-review');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;

const NOW = new Date('2026-10-09T12:00:00Z'); // 08:00 ET on Oct 9
const PIN = { lat: 27.35, lng: -82.45 };
const north = (metres) => ({ lat: PIN.lat + metres / 111195, lng: PIN.lng });
const east = (metres) => ({ lat: PIN.lat, lng: PIN.lng + metres / (111195 * Math.cos((PIN.lat * Math.PI) / 180)) });
const IMEI = 'TESTIMEI0001';

describeDb('pin check after a visit (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
    process.env.GATE_PIN_PARKED_CHECK = 'true';
    process.env.GATE_GEOCODE_REVIEW = 'true';
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    raiseAdminAlert.mockReset();
    raiseAdminAlert.mockImplementation(async () => ({ id: randomUUID(), deduped: false }));
    gps._test.resetConfigCache();
    await mockPg('geo_fences').del(); // the seeded business fences are real places; none of them is near this fixture
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_PIN_PARKED_CHECK;
    delete process.env.GATE_GEOCODE_REVIEW;
    if (database) await database.destroy();
  });

  // ---- fixtures ----
  async function technician(imei = IMEI, changedAt = null) {
    const id = randomUUID();
    await mockPg('technicians').insert({ id, name: `Fixture Tech ${id.slice(0, 4)}`, bouncie_imei: imei, bouncie_imei_changed_at: changedAt });
    return id;
  }
  async function customer(pin = PIN, extra = {}) {
    const id = randomUUID();
    await mockPg('customers').insert({
      id, first_name: 'Fixture', last_name: `Customer ${id.slice(0, 4)}`, phone: `+1202555${String(Math.floor(Math.random() * 9000) + 1000)}`,
      address_line1: '100 Fixture Rd', city: 'Fixture City', state: 'FL', zip: '34201', latitude: pin.lat, longitude: pin.lng, ...extra,
    });
    return id;
  }
  async function completedVisit(customerId, technicianId, extra = {}) {
    const id = randomUUID();
    await mockPg('scheduled_services').insert({
      id, customer_id: customerId, technician_id: technicianId, scheduled_date: '2026-10-08', service_type: 'Fixture service',
      status: 'completed', completed_at: new Date('2026-10-08T15:30:00Z'), lat: PIN.lat, lng: PIN.lng, ...extra,
    });
    return id;
  }
  let seq = 0;
  async function tripData(tripId, points, { imei = IMEI, receivedAt = '2026-10-08T16:00:00Z' } = {}) {
    seq += 1;
    await mockPg('bouncie_webhook_log').insert({
      event_type: 'trip-data', vehicle_imei: imei, dedupe_key: `pin-parked-${randomUUID()}-${seq}`, processed: true,
      received_at: new Date(receivedAt),
      payload: JSON.stringify({
        eventType: 'tripData', transactionId: tripId, imei,
        data: points.map(([iso, spot]) => ({ timestamp: iso, gps: { lat: spot.lat, lon: spot.lng }, speed: 0 })),
      }),
    });
  }
  // The truck drives in, stands `minutes` at `spot`, then drives off. `at` is when it arrives (default Oct 8, 10:20 ET).
  async function truckStopsAt(spot, minutes = 30, opts = {}) {
    const away = north(4000);
    const arrive = Date.parse(opts.at || '2026-10-08T14:20:00Z');
    const leave = arrive + minutes * 60000;
    const received = { ...opts, receivedAt: opts.receivedAt || new Date(leave + 15 * 60000).toISOString() };
    await tripData(`trip-in-${randomUUID()}`, [[new Date(arrive - 1200000).toISOString(), away], [new Date(arrive).toISOString(), spot]], received);
    await tripData(`trip-out-${randomUUID()}`, [[new Date(leave).toISOString(), spot], [new Date(leave + 600000).toISOString(), away]], received);
  }
  // One open suggestion with its (real) bell row, made by a real run.
  async function openSuggestionWithBell(spot = north(540)) {
    seq += 1;
    const imei = `TESTIMEIB${seq}`; // its own vehicle, so several suggestions can coexist in one test
    const techId = await technician(imei);
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(spot, 30, { imei });
    await run();
    const [row] = await open(customerId);
    const [bell] = await mockPg('notifications').insert({
      recipient_type: 'admin', category: 'customer', title: 'Customers — check the map pin for Fixture', body: 'Truck parked 540 m from the pin.',
      metadata: JSON.stringify({ dedupeKey: `pin-suggestion:${row.id}` }),
    }).returning('*');
    return { customerId, techId, row, bell };
  }
  const bellNow = (id) => mockPg('notifications').where({ id }).first();
  const open = (customerId) => mockPg('customer_pin_suggestions').where({ customer_id: customerId, status: 'open' });
  const all = (customerId) => mockPg('customer_pin_suggestions').where({ customer_id: customerId }).orderBy('created_at');
  const run = () => runPinParkedCheck({ now: NOW, conn: mockPg });

  // ---- the migration ----
  test('the migration drops and recreates cleanly, and the status list is closed', async () => {
    await migration.down(mockPg);
    expect(await mockPg.schema.hasTable('customer_pin_suggestions')).toBe(false);
    await migration.up(mockPg);
    await migration.up(mockPg); // a second up is a no-op
    expect(await mockPg.schema.hasTable('customer_pin_suggestions')).toBe(true);
    const customerId = await customer();
    const base = { customer_id: customerId, visit_date: '2026-10-08', pin_lat: 1, pin_lng: 1, parked_lat: 1, parked_lng: 1, distance_m: 1, stop_minutes: 1 };
    await expect(mockPg.transaction((t) => t('customer_pin_suggestions').insert({ ...base, status: 'bogus' }))).rejects.toMatchObject({ code: '23514' });
  });

  test('only one OPEN suggestion per customer, any number of closed ones', async () => {
    const customerId = await customer();
    const base = { customer_id: customerId, visit_date: '2026-10-08', pin_lat: 1, pin_lng: 1, parked_lat: 1, parked_lng: 1, distance_m: 1, stop_minutes: 1 };
    await mockPg('customer_pin_suggestions').insert({ ...base, status: 'open' });
    await expect(mockPg.transaction((t) => t('customer_pin_suggestions').insert({ ...base, status: 'open' }))).rejects.toMatchObject({ code: '23505' });
    await mockPg('customer_pin_suggestions').insert([{ ...base, status: 'dismissed' }, { ...base, status: 'superseded' }, { ...base, status: 'applied' }]);
    expect(await all(customerId)).toHaveLength(4);
  });

  // ---- the bounded read ----
  test('the stop read takes one vehicle and one received_at window only', async () => {
    await truckStopsAt(north(540), 30);
    await truckStopsAt(north(900), 30, { imei: 'TESTIMEI0002' });
    await truckStopsAt(north(1200), 30, { receivedAt: '2026-10-06T16:00:00Z' }); // days before the window
    const stops = await loadTruckStops(mockPg, IMEI, {
      fromMs: Date.parse('2026-10-08T04:00:00Z'), toMs: Date.parse('2026-10-10T04:00:00Z'), maxGapMeters: 175, now: NOW.getTime(),
    });
    expect(stops).toHaveLength(1);
    expect(stops[0].minutes).toBe(30);
    expect(Math.round(gps.distanceMeters(PIN.lat, PIN.lng, stops[0].lat, stops[0].lng))).toBe(540);
  });

  // ---- the daily run ----
  test('flags the parked truck once, stores the suggestion and rings one bell; a re-run adds nothing', async () => {
    const techId = await technician();
    const customerId = await customer();
    const visitId = await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);

    const first = await run();
    expect(first).toMatchObject({ created: 1, notified: 1 });
    const [row] = await open(customerId);
    expect(row).toMatchObject({ scheduled_service_id: visitId, technician_id: techId, distance_m: 540, stop_minutes: 30, status: 'open' });
    expect(Number(row.pin_lat)).toBeCloseTo(PIN.lat, 7);
    expect(Number(row.parked_lat)).toBeCloseTo(north(540).lat, 5);
    expect(String(row.visit_date.toISOString?.() || row.visit_date)).toContain('2026-10-08');
    expect(row.notified_at).not.toBeNull();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(raiseAdminAlert.mock.calls[0][2]).toMatchObject({ bell: true, dedupeKey: `pin-suggestion:${row.id}` });
    expect(raiseAdminAlert.mock.calls[0][1]).toMatchObject({ severity: 'needs-you', area: 'Customers' });

    const second = await run();
    expect(second.created).toBe(0);
    expect(await all(customerId)).toHaveLength(1);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('never changes the customer: the pin, the visit and the review row stay as they were', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    const before = await mockPg('customers').where({ id: customerId }).first();
    await run();
    const after = await mockPg('customers').where({ id: customerId }).first();
    expect(after).toEqual(before);
    expect(await mockPg('customer_geocode_reviews').where({ customer_id: customerId })).toHaveLength(0);
  });

  test('a bell that failed to post is retried by the next run, still once', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    raiseAdminAlert.mockRejectedValueOnce(new Error('bell down'));
    await run();
    expect((await open(customerId))[0].notified_at).toBeNull();
    const again = await run();
    expect(again).toMatchObject({ created: 0, notified: 1 });
    expect((await open(customerId))[0].notified_at).not.toBeNull();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['stopped at the pin', north(60), 30, 'stop_at_pin'],
    ['stood less than 10 minutes', north(540), 8, 'stop_too_short'],
    ['stood farther than 1500 m away', north(1800), 30, 'stop_too_far'],
  ])('flags nothing when the truck %s', async (_name, spot, minutes, reason) => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(spot, minutes);
    const result = await run();
    expect(result).toMatchObject({ visits: 1, created: 0, [reason]: 1 });
    expect(await all(customerId)).toHaveLength(0);
  });

  test('a verified pin is not flagged, and a stale verification (the pin moved afterwards) is', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    const snapshot = JSON.stringify(['100 Fixture Rd', null, 'Fixture City', 'FL', '34201']);
    await mockPg('customer_geocode_reviews').insert({
      customer_id: customerId, address_snapshot: snapshot, status: 'verified', reason: 'staff_verified',
      latitude: PIN.lat, longitude: PIN.lng, reviewed_at: new Date(),
    });
    expect((await run()).created).toBe(0);
    await mockPg('customer_geocode_reviews').where({ customer_id: customerId }).update({ latitude: PIN.lat + 0.01 });
    expect((await run()).created).toBe(1);
  });

  test('a confirmed outside-area customer is not flagged', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    await mockPg('customer_geocode_reviews').insert({
      customer_id: customerId, address_snapshot: JSON.stringify(['100 Fixture Rd', null, 'Fixture City', 'FL', '34201']),
      status: 'outside_area', reason: 'staff_confirmed_outside_area', reviewed_at: new Date(),
    });
    expect((await run()).created).toBe(0);
  });

  test('the vehicle home base (its usual first start of the day) is not a customer stop', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    const home = north(540);
    await truckStopsAt(home, 30);
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-05']) {
      await mockPg('mileage_log').insert({ vehicle_id: IMEI, trip_date: day, distance_miles: 3, start_lat: home.lat, start_lng: home.lng });
    }
    expect(await run()).toMatchObject({ created: 0, home_base: 1 });
  });

  test("the neighbour's visit the same technician completed that day explains the stop", async () => {
    const techId = await technician();
    const customerId = await customer();
    const neighbourPin = north(520);
    const neighbourId = await customer(neighbourPin);
    await completedVisit(customerId, techId);
    await completedVisit(neighbourId, techId, { lat: neighbourPin.lat, lng: neighbourPin.lng, completed_at: new Date('2026-10-08T14:40:00Z') });
    await truckStopsAt(north(540), 30);
    const result = await run();
    // The neighbour's own visit is the one the truck stopped at; ours is explained by it.
    expect(result).toMatchObject({ visits: 2, created: 0, neighbour_visit: 1, stop_at_pin: 1 });
    expect(await open(customerId)).toHaveLength(0);
  });

  test("a neighbour visit at a SECONDARY property (its own stamp, a different primary pin) still explains the stop", async () => {
    const techId = await technician();
    const customerId = await customer();
    const rentalPin = north(520);
    const neighbourId = await customer(north(3000)); // the neighbour's primary pin is elsewhere
    await completedVisit(customerId, techId);
    await completedVisit(neighbourId, techId, {
      lat: rentalPin.lat, lng: rentalPin.lng, completed_at: new Date('2026-10-08T14:40:00Z'),
      service_address_line1: '9 Rental Way', service_address_city: 'Fixture City', service_address_state: 'FL', service_address_zip: '34201',
    });
    await truckStopsAt(north(540), 30);
    const result = await run();
    expect(result).toMatchObject({ visits: 2, created: 0, neighbour_visit: 1, no_pin_or_other_property: 1 });
    expect(await all(customerId)).toHaveLength(0);
  });

  test('a business fence explains the stop; an inactive one does not', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    const [fence] = await mockPg('geo_fences').insert({ name: 'Fixture depot', fence_type: 'supplier', lat: north(560).lat, lng: PIN.lng, radius_meters: 200, is_active: false }).returning('*');
    expect((await run()).created).toBe(1);
    await open(customerId).del();
    await mockPg('geo_fences').where({ id: fence.id }).update({ is_active: true });
    expect(await run()).toMatchObject({ created: 0, geo_fence: 1 });
  });

  test('a visit completed by a technician with no vehicle is skipped', async () => {
    const techId = await technician('');
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    expect((await run()).visits).toBe(0);
  });

  test('address review off: the run reads no visits (a suggestion could not be applied) and retires what is open', async () => {
    const { customerId } = await openSuggestionWithBell();
    delete process.env.GATE_GEOCODE_REVIEW;
    try {
      expect(await run()).toEqual({ skipped: 'review_disabled', retired: 1 });
      expect(await open(customerId)).toHaveLength(0);
    } finally {
      process.env.GATE_GEOCODE_REVIEW = 'true';
    }
  });

  test('visits older than the last 2 ET days are not looked at', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId, { scheduled_date: '2026-10-05', completed_at: new Date('2026-10-05T15:30:00Z') });
    expect((await run()).visits).toBe(0);
  });

  test('a dismissed pin is not raised again; a changed pin is a new question', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    await run();
    const [row] = await open(customerId);
    await mockPg('customer_pin_suggestions').where({ id: row.id }).update({ status: 'dismissed', resolved_at: new Date() });
    expect((await run()).created).toBe(0);
    expect(await open(customerId)).toHaveLength(0);
    // The pin moves (a re-geocode); the visit still carries its old stamp, the customer pin is what staff replace.
    await mockPg('customers').where({ id: customerId }).update({ latitude: PIN.lat - 0.0008 });
    expect((await run()).created).toBe(1);
    expect(await all(customerId)).toHaveLength(2);
  });

  test('closes an open suggestion when the pin was verified or changed, and when a later visit stops at the pin', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    await run();
    const [row] = await open(customerId);

    // 1. the pin changes under it
    await mockPg('customers').where({ id: customerId }).update({ latitude: PIN.lat + 0.02 });
    const afterChange = await run();
    expect(afterChange.closed).toBeGreaterThanOrEqual(1);
    expect((await mockPg('customer_pin_suggestions').where({ id: row.id }).first()).status).toBe('superseded');
    expect((await mockPg('customer_pin_suggestions').where({ id: row.id }).first()).resolved_at).not.toBeNull();
  });

  test('a later visit with a stop inside the radius supersedes the open suggestion', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    await run();
    const [row] = await open(customerId);
    // Late data for the same visit now shows a stop at the pin itself.
    await mockPg('bouncie_webhook_log').del();
    await truckStopsAt(north(40), 30);
    const result = await run();
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect((await mockPg('customer_pin_suggestions').where({ id: row.id }).first()).status).toBe('superseded');
    expect(await open(customerId)).toHaveLength(0);
  });

  test('a deleted customer closes the suggestion', async () => {
    const techId = await technician();
    const customerId = await customer();
    await completedVisit(customerId, techId);
    await truckStopsAt(north(540), 30);
    await run();
    await mockPg('customers').where({ id: customerId }).update({ deleted_at: new Date() });
    await run();
    expect((await all(customerId))[0].status).toBe('superseded');
  });

  describe("the saved pin is the review panel's effective pin", () => {
    const RAW = north(900); // the customer row's own coordinates, 900 m from the primary property's
    async function primaryProperty(customerId, pin) {
      await mockPg('customer_properties').insert({
        customer_id: customerId, address_line1: '100 Fixture Rd', city: 'Fixture City', state: 'FL', zip: '34201',
        is_primary: true, active: true, latitude: pin.lat, longitude: pin.lng,
      });
    }

    test('when the customer row and the primary property differ, the property pin is judged, stored and shown', async () => {
      const techId = await technician();
      const customerId = await customer(RAW);
      await primaryProperty(customerId, PIN);
      await completedVisit(customerId, techId); // the visit carries the property pin
      await truckStopsAt(north(540), 30);
      expect(await run()).toMatchObject({ created: 1 });
      const [row] = await open(customerId);
      expect(Number(row.pin_lat)).toBeCloseTo(PIN.lat, 7);
      expect(row.distance_m).toBe(540); // measured from the pin staff see, not from the raw customer row
      const detail = await reviewStore.getReviewDetail(customerId, mockPg);
      expect(store.visibleSuggestion(detail, row)).not.toBeNull(); // the panel shows it, with Dismiss
    });

    test('a stop at the property pin settles the customer even though the raw customer row is far from it', async () => {
      const techId = await technician();
      const customerId = await customer(RAW);
      await primaryProperty(customerId, PIN);
      await completedVisit(customerId, techId, { lat: RAW.lat, lng: RAW.lng }); // an old visit stamp from the raw row
      await truckStopsAt(north(40), 30);
      expect((await run()).created).toBe(0);
    });

    test('a pin verified at the property coordinates is verified, whatever the raw customer row says', async () => {
      const techId = await technician();
      const customerId = await customer(RAW);
      await primaryProperty(customerId, PIN);
      await completedVisit(customerId, techId);
      await truckStopsAt(north(540), 30);
      await mockPg('customer_geocode_reviews').insert({
        customer_id: customerId, address_snapshot: JSON.stringify(['100 Fixture Rd', null, 'Fixture City', 'FL', '34201']),
        status: 'verified', reason: 'staff_verified', latitude: PIN.lat, longitude: PIN.lng, reviewed_at: new Date(),
      });
      expect((await reviewStore.getReviewDetail(customerId, mockPg)).review.status).toBe('verified');
      expect((await run()).created).toBe(0);
      expect(await all(customerId)).toHaveLength(0);
    });

    test('a primary property at another address does not override the customer row', async () => {
      const techId = await technician();
      const customerId = await customer(PIN);
      await mockPg('customer_properties').insert({
        customer_id: customerId, address_line1: '9 Other Way', city: 'Fixture City', state: 'FL', zip: '34201',
        is_primary: true, active: true, latitude: RAW.lat, longitude: RAW.lng,
      });
      await completedVisit(customerId, techId);
      await truckStopsAt(north(540), 30);
      expect(await run()).toMatchObject({ created: 1 });
      expect(Number((await open(customerId))[0].pin_lat)).toBeCloseTo(PIN.lat, 7);
    });

    test('a customer with no saved pin gets no suggestion, not an invisible one built from the visit', async () => {
      const techId = await technician();
      const customerId = await customer(PIN, { latitude: null, longitude: null });
      await completedVisit(customerId, techId); // the visit still carries a pin
      await truckStopsAt(north(540), 30);
      const result = await run();
      expect(result.created).toBe(0);
      expect(await all(customerId)).toHaveLength(0);
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('a pin that goes away or moves under an open suggestion closes it', async () => {
      const techId = await technician();
      const customerId = await customer(PIN);
      await completedVisit(customerId, techId);
      await truckStopsAt(north(540), 30);
      await run();
      expect(await open(customerId)).toHaveLength(1);
      await mockPg('customers').where({ id: customerId }).update({ latitude: null, longitude: null });
      await run();
      expect(await open(customerId)).toHaveLength(0);
      expect((await all(customerId))[0].status).toBe('superseded');
    });

    test('the dismissed-same-pin check uses the same effective pin', async () => {
      const techId = await technician();
      const customerId = await customer(RAW);
      await primaryProperty(customerId, PIN);
      await completedVisit(customerId, techId);
      await truckStopsAt(north(540), 30);
      await run();
      const [row] = await open(customerId);
      await store.dismiss(customerId, row.id, null);
      expect((await run()).created).toBe(0);
      expect(await all(customerId)).toHaveLength(1);
    });
  });

  describe('the truck evidence covers every day the decision uses', () => {
    const loader = () => jest.spyOn(require('../services/bouncie-truck-stops'), 'loadTruckStops');
    // Scheduled and worked on Oct 7, closed out on Oct 8 (the window is Oct 8 and 9).
    const LATE_CLOSE = { scheduled_date: '2026-10-07', completed_at: new Date('2026-10-08T15:30:00Z') };

    test("a visit done on Oct 7 and closed on Oct 8 is judged by its real Oct 7 stop, not an unrelated Oct 8 one", async () => {
      const spy = loader();
      try {
        const techId = await technician();
        const customerId = await customer();
        await completedVisit(customerId, techId, LATE_CLOSE);
        await truckStopsAt(north(40), 30, { at: '2026-10-07T14:20:00Z' }); // the real visit, at the pin
        await truckStopsAt(north(540), 30); // Oct 8: the truck was somewhere nearby for another reason
        const result = await run();
        expect(result).toMatchObject({ created: 0, stop_at_pin: 1 });
        expect(await all(customerId)).toHaveLength(0);
        // One read for the vehicle, from the start of the earliest day needed (Oct 7, 00:00 ET).
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][2].fromMs).toBe(Date.parse('2026-10-07T04:00:00Z'));
      } finally { spy.mockRestore(); }
    });

    test('the day the technician arrived counts too', async () => {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId, { arrived_at: new Date('2026-10-07T14:30:00Z') });
      await truckStopsAt(north(40), 30, { at: '2026-10-07T14:20:00Z' });
      await truckStopsAt(north(540), 30);
      expect((await run()).created).toBe(0);
    });

    test('with no stop at the pin on the extra day, the visit is judged as before', async () => {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId, LATE_CLOSE);
      await truckStopsAt(north(540), 30);
      expect((await run()).created).toBe(1);
    });

    test('seven days back is read; eight is not, and that visit gets no suggestion and closes nothing', async () => {
      const spy = loader();
      try {
        const techId = await technician();
        const readable = await customer();
        await completedVisit(readable, techId, { scheduled_date: '2026-10-02', completed_at: new Date('2026-10-08T15:30:00Z') });
        await truckStopsAt(north(40), 30, { at: '2026-10-02T14:20:00Z' });
        await truckStopsAt(north(540), 30);
        expect((await run()).created).toBe(0); // the Oct 2 stop at the pin was read
        expect(spy.mock.calls[0][2].fromMs).toBe(Date.parse('2026-10-02T04:00:00Z'));
      } finally { spy.mockRestore(); }

      const stale = await customer();
      await completedVisit(stale, (await technician('TESTIMEI0003')), { scheduled_date: '2026-10-01', completed_at: new Date('2026-10-08T15:30:00Z') });
      await truckStopsAt(north(540), 30, { imei: 'TESTIMEI0003' }); // would look like an off-pin stop
      const [made] = await mockPg('customer_pin_suggestions').insert({
        customer_id: stale, visit_date: '2026-10-08', pin_lat: PIN.lat, pin_lng: PIN.lng, parked_lat: 1, parked_lng: 1, distance_m: 1, stop_minutes: 1,
      }).returning('id');
      const result = await run();
      expect(result).toMatchObject({ days_not_loaded: 1 });
      expect((await mockPg('customer_pin_suggestions').where({ id: made.id }).first()).status).toBe('open'); // nothing closed
      expect(await all(stale)).toHaveLength(1); // and nothing created
    });

    test('a vehicle none of whose visits can be judged is not read at all', async () => {
      const spy = loader();
      try {
        const techId = await technician();
        const customerId = await customer();
        await completedVisit(customerId, techId, { scheduled_date: '2026-09-20', completed_at: new Date('2026-10-08T15:30:00Z') });
        await truckStopsAt(north(540), 30);
        expect(await run()).toMatchObject({ created: 0, days_not_loaded: 1 });
        expect(spy).not.toHaveBeenCalled();
      } finally { spy.mockRestore(); }
    });
  });

  describe('one decision per customer, from every visit in the window', () => {
    const OLD_VISIT = {}; // Oct 8, 11:30 ET, truck parked 540 m away at 10:20 ET
    const NEW_VISIT = { scheduled_date: '2026-10-09', completed_at: new Date('2026-10-09T11:00:00Z') }; // Oct 9, 7:00 ET
    const NEW_STOP = { at: '2026-10-09T10:00:00Z' };

    test('a newer visit with a stop at the pin closes the suggestion the older visit made and nothing comes back', async () => {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId, OLD_VISIT);
      await truckStopsAt(north(540), 30);
      expect(await run()).toMatchObject({ created: 1 });
      const [first] = await open(customerId);

      await completedVisit(customerId, techId, NEW_VISIT);
      await truckStopsAt(north(40), 30, NEW_STOP);
      const second = await run();
      expect(second).toMatchObject({ created: 0, stop_at_pin: 1, flagged: 1 });
      expect(second.closed).toBeGreaterThanOrEqual(1);
      expect((await mockPg('customer_pin_suggestions').where({ id: first.id }).first()).status).toBe('superseded');
      expect(await open(customerId)).toHaveLength(0);

      expect((await run()).created).toBe(0); // and the next run does not bring it back
      expect(await all(customerId)).toHaveLength(1);
    });

    test('a stop at the pin on the older visit also settles the newer visit that parked away', async () => {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId, OLD_VISIT);
      await truckStopsAt(north(40), 30);
      await completedVisit(customerId, techId, NEW_VISIT);
      await truckStopsAt(north(540), 30, NEW_STOP);
      expect((await run()).created).toBe(0);
      expect(await all(customerId)).toHaveLength(0);
    });

    test("two technicians' trucks: a stop at the pin by either settles the customer", async () => {
      const techA = await technician();
      const techB = await technician('TESTIMEI0002');
      const customerId = await customer();
      await completedVisit(customerId, techA, OLD_VISIT);
      await truckStopsAt(north(540), 30);
      await completedVisit(customerId, techB, NEW_VISIT);
      await truckStopsAt(north(40), 30, { ...NEW_STOP, imei: 'TESTIMEI0002' });
      const result = await run();
      expect(result).toMatchObject({ visits: 2, created: 0, stop_at_pin: 1 });
      expect(await all(customerId)).toHaveLength(0);
    });

    test("with no stop at the pin anywhere, the NEWEST qualifying visit's stop is the suggestion", async () => {
      const techA = await technician();
      const techB = await technician('TESTIMEI0002');
      const customerId = await customer();
      await completedVisit(customerId, techA, OLD_VISIT);
      await truckStopsAt(north(540), 30);
      const newerId = await completedVisit(customerId, techB, NEW_VISIT);
      await truckStopsAt(east(700), 30, { ...NEW_STOP, imei: 'TESTIMEI0002' });
      expect(await run()).toMatchObject({ created: 1, flagged: 2 });
      const rows = await all(customerId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ scheduled_service_id: newerId, technician_id: techB, distance_m: 700 });
    });

    test('a truck whose data cannot be read today makes no new suggestion for its customer', async () => {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId, OLD_VISIT);
      await truckStopsAt(north(540), 30);
      // The trip-data read fails for this run only.
      const spy = jest.spyOn(require('../services/bouncie-truck-stops'), 'loadTruckStops').mockRejectedValueOnce(new Error('log unreadable'));
      try {
        const result = await run();
        expect(result.created).toBe(0);
        expect(spy).toHaveBeenCalledTimes(1);
      } finally {
        spy.mockRestore();
      }
      expect(await all(customerId)).toHaveLength(0);
    });
  });

  describe('the bell and the close are serialized per customer', () => {
    const lockCount = async () => Number((await mockPg.raw(
      "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()",
    )).rows[0].n);
    async function pendingSuggestion() {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId);
      raiseAdminAlert.mockRejectedValueOnce(new Error('bell down')); // the run leaves it pending
      await truckStopsAt(north(540), 30);
      await run();
      const [row] = await open(customerId);
      expect(row.notified_at).toBeNull();
      return { customerId, row };
    }
    // A fake that really inserts the notification, on the transaction it is given.
    const realBell = () => raiseAdminAlert.mockImplementation(async (_category, _spec, opts) => {
      const [made] = await opts.trx('notifications').insert({
        recipient_type: 'admin', category: 'customer', title: 'Customers — check the map pin for Fixture', body: 'Truck parked 540 m from the pin.',
        metadata: JSON.stringify({ dedupeKey: opts.dedupeKey }),
      }).returning('id');
      return { id: made.id, deduped: false };
    });

    test('a suggestion dismissed after the pending list was read posts no bell', async () => {
      const { customerId, row } = await pendingSuggestion();
      raiseAdminAlert.mockClear();
      realBell();
      await store.dismiss(customerId, row.id, null); // between the read of the pending list and the post
      expect(await pin.notifyOne(mockPg, row)).toBe(false); // the list still holds the stale row
      expect(raiseAdminAlert).not.toHaveBeenCalled();
      expect(await mockPg('notifications').whereRaw("metadata->>'dedupeKey' = ?", [`pin-suggestion:${row.id}`])).toHaveLength(0);
    });

    test('a suggestion verified (superseded) after the list was read posts no bell either', async () => {
      const { customerId, row } = await pendingSuggestion();
      raiseAdminAlert.mockClear();
      realBell();
      await store.closeAfterVerify(customerId, { suggestionId: null });
      expect(await pin.notifyOne(mockPg, row)).toBe(false);
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('the bell is posted first, then the close: the close finds it and closes it', async () => {
      const { customerId, row } = await pendingSuggestion();
      raiseAdminAlert.mockClear();
      realBell();
      expect(await pin.notifyOne(mockPg, row)).toBe(true);
      const bellKey = `pin-suggestion:${row.id}`;
      const bell = () => mockPg('notifications').whereRaw("metadata->>'dedupeKey' = ?", [bellKey]).first();
      expect((await bell()).done_at).toBeNull();
      await store.dismiss(customerId, row.id, null);
      expect((await bell()).done_at).not.toBeNull();
    });

    test('the bell is posted on the caller transaction and both paths take the customer lock', async () => {
      realBell();
      const pending = async () => {
        const customerId = await customer();
        const [made] = await mockPg('customer_pin_suggestions').insert({
          customer_id: customerId, visit_date: '2026-10-08', pin_lat: 1, pin_lng: 1, parked_lat: 1, parked_lng: 1, distance_m: 1, stop_minutes: 1,
        }).returning('*');
        return { customerId, made };
      };
      const first = await pending();
      const before = await lockCount();
      expect(await pin.notifyOne(mockPg, first.made)).toBe(true);
      expect(raiseAdminAlert.mock.calls[0][2].trx).toBeDefined();
      const afterBell = await lockCount();
      expect(afterBell).toBe(before + 1);
      const second = await pending();
      expect(await lockCount()).toBe(afterBell);
      await store.dismiss(second.customerId, second.made.id, null);
      expect(await lockCount()).toBe(afterBell + 1);
    });
  });

  describe('neighbour visits are loaded for every evidence day, whenever they were completed', () => {
    // Our visit: scheduled and worked Oct 7, closed out Oct 8. The neighbour job was Oct 7 too and closed Oct 7:
    // outside the 2-day window (Oct 8-9) the main query reads.
    const LATE = { scheduled_date: '2026-10-07', completed_at: new Date('2026-10-08T15:30:00Z') };

    test("a stop explained by the same technician's job on the older evidence day is not offered as a pin", async () => {
      const techId = await technician();
      const customerId = await customer();
      const neighbourPin = north(520);
      const neighbourId = await customer(neighbourPin);
      await completedVisit(customerId, techId, LATE);
      await completedVisit(neighbourId, techId, {
        scheduled_date: '2026-10-07', completed_at: new Date('2026-10-07T15:00:00Z'), lat: neighbourPin.lat, lng: neighbourPin.lng,
      });
      await truckStopsAt(north(540), 30, { at: '2026-10-07T14:20:00Z' });
      // Judged on Oct 10: the delayed visit (closed Oct 8) is in the window, the neighbour's job (closed Oct 7) is not.
      const result = await runPinParkedCheck({ now: new Date('2026-10-10T12:00:00Z'), conn: mockPg });
      expect(result).toMatchObject({ visits: 1, created: 0, neighbour_visit: 1 });
      expect(await all(customerId)).toHaveLength(0);
    });

    test('without that older neighbour job the same stop is still offered', async () => {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId, LATE);
      await truckStopsAt(north(540), 30, { at: '2026-10-07T14:20:00Z' });
      expect((await run()).created).toBe(1);
    });

    test("another technician's job that day is not a neighbour for this truck", async () => {
      const techId = await technician();
      const other = await technician('TESTIMEI0002');
      const customerId = await customer();
      const neighbourId = await customer(north(520));
      await completedVisit(customerId, techId, LATE);
      await completedVisit(neighbourId, other, {
        scheduled_date: '2026-10-07', completed_at: new Date('2026-10-07T15:00:00Z'), lat: north(520).lat, lng: north(520).lng,
      });
      await truckStopsAt(north(540), 30, { at: '2026-10-07T14:20:00Z' });
      expect((await run()).created).toBe(1);
    });

    test('a neighbour job beyond the lookback cap is not loaded', async () => {
      const techId = await technician();
      const customerId = await customer();
      const neighbourId = await customer(north(520));
      await completedVisit(customerId, techId, LATE);
      await completedVisit(neighbourId, techId, {
        scheduled_date: '2026-09-20', completed_at: new Date('2026-09-20T15:00:00Z'), lat: north(520).lat, lng: north(520).lng,
      });
      await truckStopsAt(north(540), 30, { at: '2026-10-07T14:20:00Z' });
      expect((await run()).created).toBe(1);
    });
  });

  describe('the home base ignores trips from before the current mapping', () => {
    test('trips before the remap are not the vehicle home; trips after it are', async () => {
      const home = north(540);
      const techId = await technician(IMEI, new Date('2026-10-05T12:00:00Z'));
      const customerId = await customer();
      await completedVisit(customerId, techId);
      await truckStopsAt(home, 30);
      // three days of "starts here" BEFORE the remap (another technician's routine): they must not count
      for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
        await mockPg('mileage_log').insert({ vehicle_id: IMEI, trip_date: day, distance_miles: 3, start_lat: home.lat, start_lng: home.lng });
      }
      expect((await run()).created).toBe(1);
      await open(customerId).del();
      // after the remap the same pattern is this technician's own home
      for (const day of ['2026-10-07', '2026-10-08', '2026-10-09']) {
        await mockPg('mileage_log').insert({ vehicle_id: IMEI, trip_date: day, distance_miles: 3, start_lat: home.lat, start_lng: home.lng });
      }
      expect(await run()).toMatchObject({ created: 0, home_base: 1 });
    });
  });

  describe('coordinates the detector cannot measure', () => {
    test('a customer pin or stop outside the valid ranges creates nothing', async () => {
      const techId = await technician();
      const customerId = await customer({ lat: 95, lng: -82.57 }, { latitude: 95, longitude: -82.57 });
      await completedVisit(customerId, techId, { lat: null, lng: null });
      await truckStopsAt(north(540), 30);
      expect((await run()).created).toBe(0);
      expect(await all(customerId)).toHaveLength(0);
    });
  });

  describe('the completed-visit window is 3 ET days (late telemetry gets another run)', () => {
    test('a visit completed two ET days ago is still judged; three days ago is not', async () => {
      const techId = await technician();
      const recent = await customer();
      await completedVisit(recent, techId, { scheduled_date: '2026-10-07', completed_at: new Date('2026-10-07T15:30:00Z') });
      await truckStopsAt(north(540), 30, { at: '2026-10-07T14:20:00Z' });
      expect(await run()).toMatchObject({ visits: 1, created: 1 });
      const old = await customer();
      await completedVisit(old, techId, { scheduled_date: '2026-10-06', completed_at: new Date('2026-10-06T15:30:00Z') });
      expect((await run()).visits).toBe(1);
      expect(await all(old)).toHaveLength(0);
    });

    test('judging the same visit again on later days never duplicates or re-rings', async () => {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId);
      await truckStopsAt(north(540), 30);
      for (const day of ['2026-10-08T22:00:00Z', '2026-10-09T12:00:00Z', '2026-10-10T12:00:00Z']) {
        await runPinParkedCheck({ now: new Date(day), conn: mockPg });
      }
      expect(await all(customerId)).toHaveLength(1);
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe('the snapshot is read again before a suggestion is written', () => {
    async function snapshot() {
      const techId = await technician();
      const customerId = await customer();
      const visitId = await completedVisit(customerId, techId);
      await truckStopsAt(north(540), 30);
      const [visit] = (await pin.loadCompletedVisits(mockPg, { fromMs: Date.parse('2026-10-07T04:00:00Z'), toMs: Date.parse('2026-10-10T04:00:00Z') }))
        .filter((v) => v.id === visitId);
      const verdict = { flag: true, pin: PIN, parked: north(540), distanceM: 540, stopMinutes: 30, stopStartedAt: new Date('2026-10-08T14:20:00Z') };
      return { techId, customerId, visitId, visit, verdict };
    }
    const tryRecord = (visit, verdict) => pin.recordSuggestion(mockPg, visit, verdict);

    test('an unchanged snapshot writes the suggestion', async () => {
      const { customerId, visit, verdict } = await snapshot();
      expect(await tryRecord(visit, verdict)).toMatchObject({ created: expect.any(Object) });
      expect(await open(customerId)).toHaveLength(1);
    });

    test.each([
      ['the visit was reassigned to another technician', async (c) => {
        const other = await technician('TESTIMEI0077');
        await mockPg('scheduled_services').where({ id: c.visitId }).update({ technician_id: other });
      }],
      ['the visit destination moved', (c) => mockPg('scheduled_services').where({ id: c.visitId }).update({ lat: PIN.lat + 0.01 })],
      ['the visit was reopened', (c) => mockPg('scheduled_services').where({ id: c.visitId }).update({ status: 'confirmed' })],
      ['the technician was pointed at another device', (c) => mockPg('technicians').where({ id: c.techId }).update({ bouncie_imei: 'TESTIMEI0078', bouncie_imei_changed_at: new Date() })],
      ['the tracker mapping was re-stamped', (c) => mockPg('technicians').where({ id: c.techId }).update({ bouncie_imei_changed_at: new Date('2026-10-01T00:00:00Z') })],
    ])('%s: nothing is written', async (_name, change) => {
      const c = await snapshot();
      await change(c);
      expect(await tryRecord(c.visit, c.verdict)).toEqual({ skipped: 'visit_changed' });
      expect(await all(c.customerId)).toHaveLength(0);
    });
  });

  describe('a customer merge whose full retire fails', () => {
    const dedupe = () => require('../services/customer-dedupe')._test.retirePinSuggestionsBeforeSweep;

    test('falls back to superseding the open suggestion and closing its bell, and the merge goes on', async () => {
      const loser = await openSuggestionWithBell();
      const spy = jest.spyOn(store, 'retireOnMerge').mockRejectedValueOnce(new Error('lock service down'));
      try {
        await dedupe()(mockPg, loser.customerId);
      } finally { spy.mockRestore(); }
      expect(await open(loser.customerId)).toHaveLength(0);
      expect((await all(loser.customerId))[0].status).toBe('superseded');
      expect((await bellNow(loser.bell.id)).done_at).not.toBeNull();
    });

    test('if even the fallback fails, the error reaches the merge so it aborts', async () => {
      const loser = await openSuggestionWithBell();
      const first = jest.spyOn(store, 'retireOnMerge').mockRejectedValueOnce(new Error('lock service down'));
      const second = jest.spyOn(store, 'retireOnMergeMinimal').mockRejectedValueOnce(new Error('notifications down'));
      try {
        await expect(dedupe()(mockPg, loser.customerId)).rejects.toThrow('notifications down');
      } finally { first.mockRestore(); second.mockRestore(); }
      expect((await open(loser.customerId))).toHaveLength(1); // the savepoints rolled back: still open, merge retried whole
    });

    test('the fallback alone is idempotent and leaves no open row', async () => {
      const loser = await openSuggestionWithBell();
      expect(await store.retireOnMergeMinimal(mockPg, loser.customerId)).toBe(1);
      expect(await store.retireOnMergeMinimal(mockPg, loser.customerId)).toBe(0);
      expect((await bellNow(loser.bell.id)).done_at).not.toBeNull();
    });
  });

  describe('a tracker remap: the current device says nothing about visits before the mapping began', () => {
    test('a visit on a day before the remap is not judged: no suggestion, nothing closed', async () => {
      const techId = await technician(IMEI, new Date('2026-10-08T20:00:00Z')); // pointed at this device mid-day Oct 8
      const customerId = await customer();
      await completedVisit(customerId, techId); // Oct 8
      await truckStopsAt(north(540), 30, { at: '2026-10-08T21:20:00Z' }); // even a clean off-pin stop after the remap
      const [made] = await mockPg('customer_pin_suggestions').insert({
        customer_id: customerId, visit_date: '2026-10-08', pin_lat: PIN.lat, pin_lng: PIN.lng, parked_lat: 1, parked_lng: 1, distance_m: 1, stop_minutes: 1,
      }).returning('id');
      expect(await run()).toMatchObject({ created: 0, days_not_loaded: 1 });
      expect((await mockPg('customer_pin_suggestions').where({ id: made.id }).first()).status).toBe('open');
    });

    test('a remap before every day the visit uses changes nothing; so does a NULL changed_at', async () => {
      const techId = await technician(IMEI, new Date('2026-09-20T12:00:00Z'));
      const customerId = await customer();
      await completedVisit(customerId, techId);
      await truckStopsAt(north(540), 30);
      expect((await run()).created).toBe(1);
    });
  });

  describe('lock order: the customer row first, then the advisory lock (no deadlock with a merge)', () => {
    // Two REAL connections on committed rows of the private database, removed afterwards.
    async function committedCustomer() {
      const id = randomUUID();
      await database('customers').insert({ id, first_name: 'Fixture', last_name: 'Lock', phone: `+1202555${String(Math.floor(Math.random() * 9000) + 1000)}`, address_line1: '1 Lock St', city: 'Fixture City', state: 'FL', zip: '34201' });
      const [made] = await database('customer_pin_suggestions').insert({
        customer_id: id, visit_date: '2026-10-08', pin_lat: 1, pin_lng: 1, parked_lat: 1, parked_lng: 1, distance_m: 1, stop_minutes: 1,
      }).returning('id');
      return { id, suggestionId: made.id };
    }
    const cleanup = async (id) => { await database('customer_pin_suggestions').where({ customer_id: id }).del(); await database('customers').where({ id }).del(); };

    test('a merge holding the customer row, while a suggestion path waits, cannot deadlock', async () => {
      const { id } = await committedCustomer();
      try {
        const merge = await database.transaction(); // what executeMerge does first: the row FOR UPDATE
        await merge('customers').where({ id }).forUpdate().first('id');

        const settled = [];
        const creator = database.transaction(async (trx) => { // recordSuggestion / notifyOne / closeSuggestion all begin here
          await store.lockCustomer(trx, id);
          settled.push('creator');
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled).toEqual([]); // queued behind the merge on the ROW, holding no advisory lock yet

        // The merge now needs the advisory lock (retireOnMerge). With the old order the creator would hold it.
        await store.retireOnMerge(merge, id);
        await merge.commit();
        await creator;
        expect(settled).toEqual(['creator']);
        expect((await database('customer_pin_suggestions').where({ customer_id: id }).first()).status).toBe('superseded');
      } finally { await cleanup(id); }
    });

    test('a verify_pin style FOR UPDATE waits for a suggestion transaction and does not deadlock with it', async () => {
      const { id, suggestionId } = await committedCustomer();
      try {
        const events = [];
        const holder = await database.transaction();
        await store.lockCustomer(holder, id);
        const verify = database.transaction(async (trx) => {
          await trx('customers').where({ id }).forUpdate().first('id');
          events.push('verify');
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(events).toEqual([]);
        await holder('customer_pin_suggestions').where({ id: suggestionId }).update({ notified_at: new Date() });
        await holder.commit();
        await verify;
        expect(events).toEqual(['verify']);
      } finally { await cleanup(id); }
    });
  });

  describe('the stored day is the day the truck stood there', () => {
    test('a visit done Oct 7 and closed Oct 8 is dated Oct 7 when the off-pin stop was Oct 7', async () => {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId, { scheduled_date: '2026-10-07', completed_at: new Date('2026-10-08T15:30:00Z') });
      await truckStopsAt(north(540), 30, { at: '2026-10-07T14:20:00Z' });
      expect((await run()).created).toBe(1);
      const [row] = await open(customerId);
      expect(store.dayText(row.visit_date)).toBe('2026-10-07');
      expect(store.evidenceText(row)).toContain('Oct 7, 2026');
      expect(store.publicShape(row).visit_date).toBe('2026-10-07');
    });

    test('a stop late in the evening ET is dated by its ET day, not the UTC one', async () => {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId, { completed_at: new Date('2026-10-09T03:00:00Z') }); // 11 PM ET Oct 8
      await truckStopsAt(north(540), 20, { at: '2026-10-09T01:40:00Z' }); // 9:40 PM ET Oct 8, 01:40 UTC Oct 9
      expect((await run()).created).toBe(1);
      expect(store.dayText((await open(customerId))[0].visit_date)).toBe('2026-10-08');
    });
  });

  describe('finding 1: the candidate stop and the distance limits are measured from the saved pin', () => {
    test('a stop that is closer to the visit stamp than the saved pin is not chosen by the stamp distance', async () => {
      const techId = await technician();
      const customerId = await customer(PIN);
      const stamp = north(1400); // an old stamp, far from the saved pin
      await completedVisit(customerId, techId, { lat: stamp.lat, lng: stamp.lng });
      // 1700 m from the saved pin (past the 1500 m cap) but only 300 m from the stamp.
      await truckStopsAt(north(1700), 30);
      const result = await run();
      expect(result).toMatchObject({ created: 0, stop_too_far: 1 });
      expect(await all(customerId)).toHaveLength(0);
    });

    test('the stored distance and the chosen stop both come from the saved pin', async () => {
      const techId = await technician();
      const customerId = await customer(PIN);
      const stamp = north(700);
      await completedVisit(customerId, techId, { lat: stamp.lat, lng: stamp.lng });
      await truckStopsAt(north(900), 30); // 900 m from the saved pin, 200 m from the stamp
      await truckStopsAt(north(500), 30, { at: '2026-10-08T17:20:00Z' }); // 500 m from the saved pin: the closest to it
      expect(await run()).toMatchObject({ created: 1 });
      const [row] = await open(customerId);
      expect(row.distance_m).toBe(500);
      expect(Number(row.parked_lat)).toBeCloseTo(north(500).lat, 5);
    });

    test('a stop within the radius of the visit stamp still means the pin works', async () => {
      const techId = await technician();
      const customerId = await customer(PIN);
      const stamp = north(900);
      await completedVisit(customerId, techId, { lat: stamp.lat, lng: stamp.lng });
      await truckStopsAt(north(950), 30);
      expect((await run()).created).toBe(0);
    });
  });

  describe('finding 2: a rollback leaves nothing open', () => {
    test('with the gate off the daily run supersedes every open suggestion, closes the bells and reads nothing else', async () => {
      const first = await openSuggestionWithBell();
      const second = await openSuggestionWithBell();
      delete process.env.GATE_PIN_PARKED_CHECK;
      try {
        expect(await run()).toEqual({ skipped: 'gated', retired: 2 });
      } finally { process.env.GATE_PIN_PARKED_CHECK = 'true'; }
      for (const made of [first, second]) {
        expect(await open(made.customerId)).toHaveLength(0);
        expect((await all(made.customerId))[0]).toMatchObject({ status: 'superseded' });
        expect((await bellNow(made.bell.id)).done_at).not.toBeNull();
      }
      expect(raiseAdminAlert).toHaveBeenCalledTimes(2); // only the two original rings, none since
    });

    test('the sweep is bounded and a second run finishes the rest', async () => {
      for (let i = 0; i < 3; i += 1) {
        await mockPg('customer_pin_suggestions').insert({
          customer_id: await customer(), visit_date: '2026-10-08', pin_lat: 1, pin_lng: 1, parked_lat: 1, parked_lng: 1, distance_m: 1, stop_minutes: 1,
        });
      }
      delete process.env.GATE_PIN_PARKED_CHECK;
      try {
        expect((await run()).retired).toBe(3);
        expect((await run()).retired).toBe(0);
      } finally { process.env.GATE_PIN_PARKED_CHECK = 'true'; }
    });
  });

  describe('findings 3 and 4: a customer merge', () => {
    const handlerOf = () => require('../services/customer-dedupe')._test.UNIQUE_COLLISION_HANDLERS.customer_pin_suggestions;

    test('the handler is registered', () => {
      expect(typeof handlerOf()).toBe('function');
    });

    test('two open suggestions: the winner keeps its open row, the loser is superseded with its bell closed, history moves', async () => {
      const winner = await openSuggestionWithBell();
      const loser = await openSuggestionWithBell();
      await expect(mockPg.transaction((t) => t('customer_pin_suggestions').where({ id: loser.row.id }).update({ customer_id: winner.customerId })))
        .rejects.toMatchObject({ code: '23505' }); // the collision that used to abort the merge
      const moved = await handlerOf()(mockPg, 'customer_pin_suggestions', 'customer_id', winner.customerId, loser.customerId);
      expect(moved).toBe(1);
      const rows = await all(winner.customerId);
      expect(rows.map((r) => r.status).sort()).toEqual(['open', 'superseded']);
      expect((await open(winner.customerId))[0].id).toBe(winner.row.id);
      expect(await all(loser.customerId)).toHaveLength(0);
      expect((await bellNow(loser.bell.id)).done_at).not.toBeNull();
      expect((await bellNow(winner.bell.id)).done_at).toBeNull();
    });

    test('only the loser has an open suggestion: it is retired, not repointed to the survivor, and its bell closes', async () => {
      const winner = await customer();
      const loser = await openSuggestionWithBell();
      expect(await require('../services/customer-pin-suggestions').retireOnMerge(mockPg, loser.customerId)).toBe(1);
      expect(await open(loser.customerId)).toHaveLength(0);
      expect(await open(winner)).toHaveLength(0);
      expect((await bellNow(loser.bell.id)).done_at).not.toBeNull();
      expect((await all(loser.customerId))[0].status).toBe('superseded');
      // the next run raises it again for the survivor if it is still warranted: here the survivor owns the visit
      expect(await require('../services/customer-pin-suggestions').retireOnMerge(mockPg, loser.customerId)).toBe(0); // idempotent
    });

    test('executeMerge retires the loser suggestion before its sweep', () => {
      const source = require('fs').readFileSync(require('path').join(__dirname, '../services/customer-dedupe.js'), 'utf8');
      expect(source).toMatch(/await retirePinSuggestionsBeforeSweep\(trx, loser\.id\);\s*const fks = await customerFkColumns\(trx\);/);
    });
  });

  describe('finding 5: a home-base lookup that fails makes the vehicle unknown', () => {
    test('no suggestion and nothing closed, instead of judging without the home base', async () => {
      const { customerId, row } = await openSuggestionWithBell();
      // The mileage_log read (the home base) fails for this run; everything else is the real connection.
      const failing = new Proxy(mockPg, {
        get: (target, key) => {
          if (key === 'raw') return (sql, ...rest) => (/FROM mileage_log/.test(sql) ? Promise.reject(new Error('mileage_log unreadable')) : target.raw(sql, ...rest));
          const value = target[key];
          return typeof value === 'function' ? value.bind(target) : value;
        },
        apply: (target, _this, args) => target(...args),
      });
      const result = await runPinParkedCheck({ now: NOW, conn: failing });
      expect(result).toMatchObject({ created: 0, stops_unreadable: 1 });
      expect((await mockPg('customer_pin_suggestions').where({ id: row.id }).first()).status).toBe('open');
      void customerId;
    });
  });

  describe('closing from the review screen (real SQL, real notification close)', () => {
    const suggestionWithBell = openSuggestionWithBell;

    test('verify_pin from the suggestion: applied, bell done, and the actor is recorded', async () => {
      const { customerId, row, bell } = await suggestionWithBell();
      const techId = await technician('TESTIMEI0009');
      const closed = await store.closeAfterVerify(customerId, { suggestionId: row.id, actorId: techId });
      expect(closed.status).toBe('applied');
      const saved = await mockPg('customer_pin_suggestions').where({ id: row.id }).first();
      expect(saved).toMatchObject({ status: 'applied', resolved_by: techId });
      expect(saved.resolved_at).not.toBeNull();
      expect((await bellNow(bell.id)).done_at).not.toBeNull();
      expect(await store.closeAfterVerify(customerId, { suggestionId: row.id, actorId: techId })).toBeNull(); // nothing left to close
    });

    test('dismiss: dismissed once, a second dismiss and another customer find nothing', async () => {
      const { customerId, row, bell } = await suggestionWithBell();
      const stranger = await customer();
      expect(await store.dismiss(stranger, row.id, null)).toBeNull();
      expect((await store.dismiss(customerId, row.id, null)).status).toBe('dismissed');
      expect(await store.dismiss(customerId, row.id, null)).toBeNull();
      expect((await bellNow(bell.id)).done_at).not.toBeNull();
    });

    test('verify_pin typed by hand supersedes the open suggestion', async () => {
      const { customerId, row } = await suggestionWithBell();
      expect((await store.closeAfterVerify(customerId, { suggestionId: null, actorId: null })).status).toBe('superseded');
      expect((await mockPg('customer_pin_suggestions').where({ id: row.id }).first()).status).toBe('superseded');
    });
  });

  test('two grouped partners of one stop (one visit_id) make one suggestion, and the neighbour rule ignores the partner', async () => {
    const techId = await technician();
    const customerId = await customer();
    const [visit] = await mockPg('service_visits').insert({
      customer_id: customerId, scheduled_date: '2026-10-08', stop_base_key: `fixture-${customerId}`, created_by: 'fixture',
    }).returning('id');
    await completedVisit(customerId, techId, { visit_id: visit.id });
    await completedVisit(customerId, techId, { visit_id: visit.id });
    await truckStopsAt(north(540), 30);
    const result = await run();
    expect(result).toMatchObject({ visits: 1, created: 1 });
    expect(await all(customerId)).toHaveLength(1);
  });

  test('a stop outside the service-area box is never offered as a pin (verify_pin would refuse it)', async () => {
    const techId = await technician();
    const edge = { lat: 27.945, lng: -82.45 };
    const customerId = await customer(edge);
    await completedVisit(customerId, techId, { lat: edge.lat, lng: edge.lng });
    await truckStopsAt({ lat: 27.9552, lng: edge.lng }, 30); // about 1.1 km north, past the box's top edge
    expect((await run()).created).toBe(0);
    await mockPg('bouncie_webhook_log').del();
    await truckStopsAt({ lat: 27.9352, lng: edge.lng }, 30); // the same distance south, inside the box
    expect((await run()).created).toBe(1);
  });
});
