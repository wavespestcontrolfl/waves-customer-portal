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
  async function technician(imei = IMEI) {
    const id = randomUUID();
    await mockPg('technicians').insert({ id, name: `Fixture Tech ${id.slice(0, 4)}`, bouncie_imei: imei });
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

  test('address review off: the run stops before any read (a suggestion could not be applied)', async () => {
    delete process.env.GATE_GEOCODE_REVIEW;
    try {
      expect(await run()).toEqual({ skipped: 'review_disabled' });
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

  describe('closing from the review screen (real SQL, real notification close)', () => {
    async function suggestionWithBell() {
      const techId = await technician();
      const customerId = await customer();
      await completedVisit(customerId, techId);
      await truckStopsAt(north(540), 30);
      await run();
      const [row] = await open(customerId);
      const [bell] = await mockPg('notifications').insert({
        recipient_type: 'admin', category: 'customer', title: 'Customers — check the map pin for Fixture', body: 'Truck parked 540 m from the pin.',
        metadata: JSON.stringify({ dedupeKey: `pin-suggestion:${row.id}` }),
      }).returning('*');
      return { customerId, row, bell };
    }
    const bellNow = (id) => mockPg('notifications').where({ id }).first();

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
