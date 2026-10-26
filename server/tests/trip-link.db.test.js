// Trip link (GATE_TRIP_LINK) through PostgreSQL: the migration (up, down, up, constraints), linkDay end to end from
// bouncie_webhook_log trip-data events, mileage_log rows, technicians, customers and completed visits; a re-run is
// idempotent and replaces the day; gate off writes nothing; a dry run writes nothing; the tracker remap rule; and the
// admin summary numbers. Every write runs in a transaction that is rolled back. Synthetic customers, coordinates
// and vehicle ids only. Skips without DATABASE_URL (CI runs it against the migrated database).
const SKIP = !process.env.DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const db = (...args) => mockPg(...args);
  for (const name of ['raw', 'transaction', 'queryBuilder', 'ref']) db[name] = (...args) => mockPg[name](...args);
  for (const name of ['schema', 'fn']) Object.defineProperty(db, name, { get: () => mockPg[name] });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { req.techRole = 'admin'; next(); },
  requireAdmin: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const knex = require('knex');
const express = require('express');
const { randomUUID } = require('crypto');
const migration = require('../models/migrations/20261026210000_trip_link');
const tripLink = require('../services/trip-link');
const backfill = require('../scripts/trip-link-backfill');
const gps = require('../services/gps-arrival-detector');
const truckStops = require('../services/bouncie-truck-stops');

const describeDb = SKIP ? describe.skip : describe;
jest.setTimeout(60000);
let database;
let mockPg;
let server;
let baseUrl;

const DAY = '2026-10-08';
const PIN = { lat: 27.35, lng: -82.45 };
const north = (metres) => ({ lat: PIN.lat + metres / 111195, lng: PIN.lng });
const HOME = north(-6000);
const SUPPLIER = north(3000);
const B_PIN = north(1500);
const IMEI = 'TESTIMEI0001';
const iso = (hhmm) => `2026-10-08T${hhmm}:00Z`; // the fixture day, in UTC clock times (10:00 ET = 14:00Z)

describeDb('trip link (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 4 } });
    mockPg = database;
    const app = express();
    app.use('/api/admin/trip-link', require('../routes/admin-trip-link'));
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  beforeEach(async () => {
    mockPg = await database.transaction();
    delete process.env.GATE_TRIP_LINK;
    gps._test.resetConfigCache();
    await mockPg('geo_fences').del(); // the seeded business fences are real places; none of them is near this fixture
  });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => {
    delete process.env.GATE_TRIP_LINK;
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    if (database) await database.destroy();
  });

  // ---- fixtures ----
  async function technician(imei = IMEI, changedAt = null) {
    const id = randomUUID();
    await mockPg('technicians').insert({ id, name: `Fixture Tech ${id.slice(0, 4)}`, bouncie_imei: imei, bouncie_imei_changed_at: changedAt });
    return id;
  }
  async function customer(spot = PIN) {
    const id = randomUUID();
    await mockPg('customers').insert({
      id, first_name: 'Fixture', last_name: `Customer ${id.slice(0, 4)}`, phone: `+1202555${String(Math.floor(Math.random() * 9000) + 1000)}`,
      address_line1: '100 Fixture Rd', city: 'Fixture City', state: 'FL', zip: '34201',
      latitude: spot ? spot.lat : null, longitude: spot ? spot.lng : null,
    });
    return id;
  }
  async function visit(customerId, technicianId, completed, arrived, spot = undefined, extra = {}) {
    const id = randomUUID();
    await mockPg('scheduled_services').insert({
      id, customer_id: customerId, technician_id: technicianId, scheduled_date: DAY, service_type: 'Fixture service', status: 'completed',
      completed_at: new Date(iso(completed)), arrived_at: arrived ? new Date(iso(arrived)) : null,
      ...(spot === undefined ? {} : { lat: spot ? spot.lat : null, lng: spot ? spot.lng : null }), ...extra,
    });
    return id;
  }
  let seq = 0;
  async function tripData(tripId, points, imei = IMEI, receivedAt = new Date(iso('18:00'))) {
    seq += 1;
    await mockPg('bouncie_webhook_log').insert({
      event_type: 'trip-data', vehicle_imei: imei, dedupe_key: `trip-link-${randomUUID()}-${seq}`, processed: true,
      received_at: receivedAt,
      payload: JSON.stringify({
        eventType: 'tripData', transactionId: tripId, imei,
        data: points.map(([time, spot]) => ({ timestamp: iso(time), gps: { lat: spot.lat, lon: spot.lng }, speed: 0 })),
      }),
    });
  }
  async function mileage(tripId, miles, { date = DAY, start = null, imei = IMEI } = {}) {
    const id = randomUUID();
    await mockPg('mileage_log').insert({
      id, trip_date: date, distance_miles: miles, vehicle_id: imei, bouncie_trip_id: tripId,
      start_lat: start ? start.lat : null, start_lng: start ? start.lng : null,
    });
    return id;
  }
  // Three earlier days that began at HOME make it the vehicle's home base.
  async function homeHistory(imei = IMEI) {
    for (const date of ['2026-10-05', '2026-10-06', '2026-10-07']) await mileage(null, 1, { date, start: HOME, imei });
  }
  // home -> A (stop 14:20..14:50) -> supplier (stop 15:00..15:15) -> B (stop 15:30..15:50) -> home
  async function truckDay(imei = IMEI) {
    await tripData('trip-1', [['14:00', HOME], ['14:20', PIN]], imei);
    await tripData('trip-2', [['14:50', PIN], ['15:00', SUPPLIER]], imei);
    await tripData('trip-3', [['15:15', SUPPLIER], ['15:30', B_PIN]], imei);
    await tripData('trip-4', [['15:50', B_PIN], ['16:10', HOME]], imei);
  }
  async function mileageRows(imei = IMEI) {
    const ids = {};
    ids['trip-1'] = await mileage('trip-1', 5.2, { start: HOME, imei });
    ids['trip-2'] = await mileage('trip-2', 2.1, { imei });
    ids['trip-3'] = await mileage('trip-3', 3, { imei });
    ids['trip-4'] = await mileage('trip-4', 6, { imei });
    return ids;
  }
  async function fixture() {
    const tech = await technician();
    await homeHistory();
    await truckDay();
    const logIds = await mileageRows();
    await mockPg('geo_fences').insert({ name: 'Fixture supplier', fence_type: 'supplier', lat: SUPPLIER.lat, lng: SUPPLIER.lng, radius_meters: 100, is_active: true });
    const a = await customer(PIN);
    const b = await customer(B_PIN);
    const [{ id: visitId }] = await mockPg('service_visits').insert({
      customer_id: a, scheduled_date: DAY, stop_base_key: `fixture-${a}`, created_by: 'fixture',
    }).returning('id');
    const ids = {
      a: await visit(a, tech, '14:48', '14:22', undefined, { visit_id: visitId }),
      aPartner: await visit(a, tech, '14:49', '14:23', undefined, { visit_id: visitId }),
      b: await visit(b, tech, '15:48', '15:32'),
    };
    return { tech, logIds, ids, customers: { a, b } };
  }
  const legs = () => mockPg('visit_gps_legs').orderBy('scheduled_service_id');
  const legOf = (id) => mockPg('visit_gps_legs').where({ scheduled_service_id: id }).first();
  const links = () => mockPg('trip_links').orderBy('bouncie_trip_id');
  const counts = async () => ({
    legs: Number((await mockPg('visit_gps_legs').count({ n: '*' }).first()).n),
    links: Number((await mockPg('trip_links').count({ n: '*' }).first()).n),
  });
  const link = (opts = {}) => tripLink.linkDay(mockPg, DAY, { now: new Date('2026-10-09T06:00:00Z'), ...opts });
  const summary = async (query = `from=${DAY}&to=${DAY}`) => {
    // The route reads through the shared (mocked) db handle, which is this test's transaction.
    const res = await fetch(`${baseUrl}/api/admin/trip-link/summary?${query}`);
    return { status: res.status, body: await res.json() };
  };

  // ---- the migration ----
  test('the migration drops and recreates cleanly, and its lists are closed', async () => {
    await migration.down(mockPg);
    expect(await mockPg.schema.hasTable('visit_gps_legs')).toBe(false);
    expect(await mockPg.schema.hasTable('trip_links')).toBe(false);
    await migration.up(mockPg);
    await migration.up(mockPg); // a second up is a no-op
    expect(await mockPg.schema.hasTable('visit_gps_legs')).toBe(true);
    expect(await mockPg.schema.hasTable('trip_links')).toBe(true);
    const tech = await technician();
    const c = await customer();
    const id = await visit(c, tech, '14:48', null);
    const base = { scheduled_service_id: id, leg_group_key: id, service_date: DAY, algorithm_version: 1 };
    const bad = (row) => expect(mockPg.transaction((t) => t('visit_gps_legs').insert(row))).rejects.toMatchObject({ code: '23514' });
    await bad({ ...base, status: 'bogus' });
    await bad({ ...base, status: 'matched', drive_from_kind: 'bogus' });
    await expect(mockPg.transaction((t) => t('trip_links').insert({ bouncie_trip_id: 'x', suggested_purpose: 'bogus', algorithm_version: 1 })))
      .rejects.toMatchObject({ code: '23514' });
    await expect(mockPg.transaction((t) => t('trip_links').insert({ bouncie_trip_id: 'x', suggested_purpose: 'business', ends_at_kind: 'bogus', algorithm_version: 1 })))
      .rejects.toMatchObject({ code: '23514' });
  });

  test('deleting a visit deletes its leg; deleting a mileage row only unlinks the trip', async () => {
    const f = await fixture();
    await link();
    await mockPg('scheduled_services').where({ id: f.ids.b }).del();
    expect(await legOf(f.ids.b)).toBeUndefined();
    await mockPg('mileage_log').where({ id: f.logIds['trip-1'] }).del();
    expect(await mockPg('trip_links').where({ bouncie_trip_id: 'trip-1' }).first()).toMatchObject({ mileage_log_id: null });
  });

  // ---- linkDay ----
  test('writes the expected leg and trip rows', async () => {
    const f = await fixture();
    const result = await link();
    expect(result).toMatchObject({ day: DAY, technicians: 1, trips: 4, errors: 0, legs: { total: 3, matched: 3 } });

    const a = await legOf(f.ids.a);
    expect(a).toMatchObject({
      status: 'matched', leg_group_key: a.leg_group_key, technician_id: f.tech, vehicle_imei: IMEI, shared_stop_count: 1, algorithm_version: 1,
      drive_from_kind: 'home', drive_trip_ids: ['trip-1'], match_distance_m: '0.0',
    });
    expect(a.service_date).toBeTruthy();
    expect(new Date(a.gps_arrived_at).toISOString()).toBe(new Date(iso('14:20')).toISOString());
    expect(new Date(a.gps_departed_at).toISOString()).toBe(new Date(iso('14:50')).toISOString());
    expect(Number(a.gps_on_site_minutes)).toBe(30);
    expect(Number(a.drive_minutes)).toBe(20);
    expect(Number(a.drive_miles)).toBe(5.2);
    // The grouped partner shares the one physical arrival and leg.
    const partner = await legOf(f.ids.aPartner);
    expect(partner.leg_group_key).toBe(a.leg_group_key);
    for (const key of ['status', 'gps_arrived_at', 'gps_on_site_minutes', 'drive_minutes', 'drive_miles', 'drive_from_kind']) expect(partner[key]).toEqual(a[key]);

    const b = await legOf(f.ids.b);
    expect(b).toMatchObject({ status: 'matched', drive_from_kind: 'supplier', drive_trip_ids: ['trip-3'] });
    expect(Number(b.gps_on_site_minutes)).toBe(20);
    expect(Number(b.drive_minutes)).toBe(15);
    expect(Number(b.drive_miles)).toBe(3);

    const rows = await links();
    expect(rows.map((r) => [r.bouncie_trip_id, r.ends_at_kind, r.suggested_purpose])).toEqual([
      ['trip-1', 'visit', 'business'], ['trip-2', 'supplier', 'business'], ['trip-3', 'visit', 'business'], ['trip-4', 'home', 'unclassified'],
    ]);
    expect(rows[0]).toMatchObject({ mileage_log_id: f.logIds['trip-1'], technician_id: f.tech, vehicle_imei: IMEI, algorithm_version: 1 });
    expect(Number(rows[0].distance_miles)).toBe(5.2);
    expect(rows[0].ends_at_scheduled_service_id).toBe(f.ids.a); // the first member of the group: the earliest completed
    expect(rows[1].ends_at_scheduled_service_id).toBeNull();
    expect(new Date(rows[0].trip_start).toISOString()).toBe(new Date(iso('14:00')).toISOString());
    expect(new Date(rows[0].trip_end).toISOString()).toBe(new Date(iso('14:20')).toISOString());
  });

  test('a trip without a mileage_log row makes drive_miles NULL and keeps the trip', async () => {
    const f = await fixture();
    await mockPg('mileage_log').where({ id: f.logIds['trip-3'] }).del();
    await link();
    expect(await legOf(f.ids.b)).toMatchObject({ status: 'matched', drive_miles: null, drive_trip_ids: ['trip-3'] });
    expect(await mockPg('trip_links').where({ bouncie_trip_id: 'trip-3' }).first()).toMatchObject({ mileage_log_id: null, distance_miles: null });
  });

  test('statuses: no stop, no destination, no vehicle', async () => {
    const f = await fixture();
    const far = await customer(north(9000));
    const noPin = await customer(null);
    const other = await technician('');
    const noStop = await visit(far, f.tech, '15:00', '14:55');
    const noDestination = await visit(noPin, f.tech, '15:00', '14:55');
    const noVehicle = await visit(await customer(PIN), other, '14:48', '14:22');
    await link();
    expect(await legOf(noStop)).toMatchObject({ status: 'no_stop', gps_arrived_at: null, drive_minutes: null, shared_stop_count: 1 });
    expect(await legOf(noDestination)).toMatchObject({ status: 'no_destination' });
    expect(await legOf(noVehicle)).toMatchObject({ status: 'no_vehicle', vehicle_imei: null, technician_id: other });
  });

  test('two physical visits at one stop split its minutes', async () => {
    const f = await fixture();
    const neighbour = await customer(north(40));
    const sharer = await visit(neighbour, f.tech, '14:47', '14:24');
    await link();
    const [first, second] = [await legOf(f.ids.a), await legOf(sharer)];
    expect([Number(first.gps_on_site_minutes), Number(second.gps_on_site_minutes)]).toEqual([15, 15]);
    expect([first.shared_stop_count, second.shared_stop_count]).toEqual([2, 2]);
    expect(await legOf(f.ids.aPartner)).toMatchObject({ shared_stop_count: 2 });
  });

  test('a re-run is idempotent and replaces the day', async () => {
    const f = await fixture();
    await link();
    const strip = (rows) => rows.map(({ computed_at, ...rest }) => rest);
    const first = { legs: strip(await legs()), links: strip(await links()), counts: await counts() };
    await link();
    expect({ legs: strip(await legs()), links: strip(await links()), counts: await counts() }).toEqual(first);
    expect(first.counts).toEqual({ legs: 3, links: 4 });

    // The day changes: one visit is no longer completed, one trip's mileage row is gone, a trip is no longer read.
    await mockPg('scheduled_services').where({ id: f.ids.b }).update({ status: 'cancelled' });
    await mockPg('mileage_log').where({ id: f.logIds['trip-1'] }).del();
    await mockPg('bouncie_webhook_log').whereRaw("payload::text LIKE '%trip-4%'").del();
    const result = await link();
    expect(result.trips).toBe(3);
    expect(await legOf(f.ids.b)).toBeUndefined();
    expect(await legOf(f.ids.a)).toMatchObject({ drive_miles: null });
    expect((await links()).map((r) => r.bouncie_trip_id)).toEqual(['trip-1', 'trip-2', 'trip-3']);
    expect(await counts()).toEqual({ legs: 2, links: 3 });
  });

  test('a dry run computes the rows and writes nothing', async () => {
    await fixture();
    const result = await link({ dryRun: true });
    expect(result.rows.legs).toHaveLength(3);
    expect(result.rows.links).toHaveLength(4);
    expect(await counts()).toEqual({ legs: 0, links: 0 });
    const out = jest.fn();
    await backfill.run(['--from', DAY, '--to', DAY, '--dry-run'], { conn: mockPg, log: out });
    expect(await counts()).toEqual({ legs: 0, links: 0 });
    expect(out.mock.calls.at(-1)[0]).toMatch(/DRY RUN/);
    await backfill.run(['--from', DAY, '--to', DAY, '--force-shadow'], { conn: mockPg, log: out });
    expect(await counts()).toEqual({ legs: 3, links: 4 });
  });

  test('the nightly run: gate off reads and writes nothing, gate on links yesterday and the day before again', async () => {
    await fixture();
    const now = new Date('2026-10-09T05:40:00Z'); // 01:40 ET on Oct 9
    expect(await tripLink.runTripLinkNightly({ now, conn: mockPg })).toEqual({ skipped: 'gated' });
    expect(await counts()).toEqual({ legs: 0, links: 0 });
    process.env.GATE_TRIP_LINK = 'true';
    const result = await tripLink.runTripLinkNightly({ now, conn: mockPg });
    expect(result).toMatchObject({ day: DAY, trips: 4, relinked: [{ day: '2026-10-07', trips: 0, errors: 0 }] });
    expect(await counts()).toEqual({ legs: 3, links: 4 });
    // A trip event that reached us late: the next night links the fixture day again, as the day before yesterday.
    await mockPg('visit_gps_legs').del();
    await mockPg('trip_links').del();
    const nextNight = await tripLink.runTripLinkNightly({ now: new Date('2026-10-10T05:40:00Z'), conn: mockPg });
    expect(nextNight).toMatchObject({ day: '2026-10-09', trips: 0, relinked: [{ day: DAY, trips: 4, errors: 0 }] });
    expect(await counts()).toEqual({ legs: 3, links: 4 });
  });

  test('a visit closed out on a later day is linked on the day it was worked, and the nightly run re-links that day', async () => {
    const f = await fixture();
    // B was worked on the fixture day (arrived 15:32Z) but closed out three days later.
    await mockPg('scheduled_services').where({ id: f.ids.b }).update({ completed_at: new Date('2026-10-11T13:00:00Z') });
    await link();
    expect(await mockPg('visit_gps_legs').where({ scheduled_service_id: f.ids.b, service_date: DAY }).first())
      .toMatchObject({ status: 'matched' });
    expect(new Date((await legOf(f.ids.b)).gps_arrived_at).toISOString()).toBe(new Date(iso('15:30')).toISOString());
    // The close-out day has no truck stop for it and does not take it.
    await tripLink.linkDay(mockPg, '2026-10-11', { now: new Date('2026-10-12T06:00:00Z') });
    expect(await legOf(f.ids.b)).toMatchObject({ status: 'matched' });
    expect(await counts()).toEqual({ legs: 3, links: 4 });
    // The night after the close-out re-links the worked day (four days back).
    await mockPg('visit_gps_legs').del();
    await mockPg('trip_links').del();
    process.env.GATE_TRIP_LINK = 'true';
    const night = await tripLink.runTripLinkNightly({ now: new Date('2026-10-12T05:40:00Z'), conn: mockPg });
    expect(night.relinked.map((r) => r.day)).toEqual(['2026-10-10', DAY]);
    expect(await legOf(f.ids.b)).toMatchObject({ status: 'matched' });
    expect(await counts()).toEqual({ legs: 3, links: 4 });
  });

  test('a tracker cleared after a run: the re-run removes that day\'s trip links and the legs read no_vehicle', async () => {
    const f = await fixture();
    await link();
    expect(await counts()).toEqual({ legs: 3, links: 4 });
    await mockPg('technicians').where({ id: f.tech }).update({ bouncie_imei: null });
    await link();
    expect((await legs()).map((r) => r.status)).toEqual(['no_vehicle', 'no_vehicle', 'no_vehicle']);
    expect(await counts()).toEqual({ legs: 3, links: 0 });
  });

  test('a technician that holds only trip links for the day is re-run, so its stale links go', async () => {
    const f = await fixture();
    await link();
    // Its visits move to another technician and its tracker is cleared: only its trip links are left for the day.
    const other = await technician('TESTIMEI0002');
    await mockPg('scheduled_services').where({ technician_id: f.tech }).update({ technician_id: other });
    await mockPg('visit_gps_legs').where({ technician_id: f.tech }).del();
    await mockPg('technicians').where({ id: f.tech }).update({ bouncie_imei: '' });
    await link();
    expect(Number((await mockPg('trip_links').where({ technician_id: f.tech }).count({ n: '*' }).first()).n)).toBe(0);
  });

  test('a trip across midnight belongs to the day it ended, read whole, and never to both days', async () => {
    await technician();
    // 23:55 ET on Oct 7 (03:55Z) to 00:05 ET on Oct 8; its two batches were received either side of midnight.
    await tripData('trip-x', [['03:55', HOME]], IMEI, new Date(iso('03:56')));
    await tripData('trip-x', [['04:05', north(-5500)]], IMEI, new Date(iso('04:06')));
    await mileage('trip-x', 1.5, { date: '2026-10-07' });
    const now = new Date('2026-10-10T00:00:00Z');
    const window = (day) => ({ fromMs: Date.parse(`${day}T04:00:00Z`), toMs: Date.parse(`${day}T04:00:00Z`) + 86400000 });
    const oct7 = await truckStops.loadTruckDay(mockPg, IMEI, { ...window('2026-10-07'), maxGapMeters: 175, now: now.getTime() });
    expect(oct7.trips.map((t) => t.tripId)).not.toContain('trip-x');
    const oct8 = await truckStops.loadTruckTrips(mockPg, IMEI, { ...window('2026-10-08'), now: now.getTime() });
    expect(oct8.map((t) => [t.tripId, t.startMs, t.endMs])).toEqual([['trip-x', Date.parse(iso('03:55')), Date.parse(iso('04:05'))]]);
    await tripLink.linkDay(mockPg, '2026-10-07', { now });
    expect(await mockPg('trip_links').where({ bouncie_trip_id: 'trip-x' }).first()).toBeUndefined();
    await tripLink.linkDay(mockPg, DAY, { now });
    const linked = await mockPg('trip_links').where({ bouncie_trip_id: 'trip-x' }).first();
    expect(new Date(linked.trip_start).toISOString()).toBe(new Date(iso('03:55')).toISOString());
    await tripLink.linkDay(mockPg, '2026-10-07', { now }); // the other day's re-run leaves it alone
    expect(await mockPg('trip_links').where({ bouncie_trip_id: 'trip-x' }).first()).toMatchObject({ bouncie_trip_id: 'trip-x' });
  });

  test('a visit just after midnight: the drive that began before midnight is its leg, and that trip links to it', async () => {
    const tech = await technician();
    await homeHistory();
    // Home at 23:55 ET on Oct 7 (03:55Z) to the customer at 00:05 ET on Oct 8; on site until 00:35; then home.
    await tripData('trip-x', [['03:55', HOME]], IMEI, new Date(iso('03:56')));
    await tripData('trip-x', [['04:05', PIN]], IMEI, new Date(iso('04:06')));
    await tripData('trip-y', [['04:35', PIN], ['04:50', HOME]], IMEI, new Date(iso('04:51')));
    await mileage('trip-x', 4.4, { date: '2026-10-07', start: HOME });
    await mileage('trip-y', 4.4);
    const c = await customer(PIN);
    const id = await visit(c, tech, '04:34', '04:06');
    await tripLink.linkDay(mockPg, DAY, { now: new Date('2026-10-09T06:00:00Z') });
    const leg = await legOf(id);
    expect(leg).toMatchObject({ status: 'matched', drive_from_kind: 'home', drive_trip_ids: ['trip-x'] });
    expect(Number(leg.drive_minutes)).toBe(10);
    expect(Number(leg.drive_miles)).toBe(4.4);
    expect((await links()).map((r) => [r.bouncie_trip_id, r.ends_at_kind, r.ends_at_scheduled_service_id, r.suggested_purpose]))
      .toEqual([['trip-x', 'visit', id, 'business'], ['trip-y', 'home', null, 'unclassified']]);
    // The day the drive began does not take it back.
    await tripLink.linkDay(mockPg, '2026-10-07', { now: new Date('2026-10-09T06:00:00Z') });
    expect(await mockPg('trip_links').where({ bouncie_trip_id: 'trip-x' }).first()).toMatchObject({ ends_at_kind: 'visit' });
  });

  test('a completed visit with no technician is recorded as no_vehicle with no technician, and a re-run replaces it', async () => {
    const f = await fixture();
    const c = await customer(PIN);
    const loose = await visit(c, null, '14:40', '14:21');
    await link();
    expect(await legOf(loose)).toMatchObject({ status: 'no_vehicle', technician_id: null, vehicle_imei: null });
    expect(await counts()).toEqual({ legs: 4, links: 4 });
    // Assigned later: the re-run moves it to the technician and the unassigned row is not left behind.
    await mockPg('scheduled_services').where({ id: loose }).update({ technician_id: f.tech });
    await link();
    expect(await legOf(loose)).toMatchObject({ technician_id: f.tech });
    expect(Number((await mockPg('visit_gps_legs').whereNull('technician_id').count({ n: '*' }).first()).n)).toBe(0);
    const { body } = await (async () => { process.env.GATE_TRIP_LINK = 'true'; return summary(); })();
    expect(body.services).toBe(4);
  });

  test('it never writes mileage_log, scheduled_services, pins or alerts', async () => {
    await fixture();
    const snapshot = async () => ({
      mileage: await mockPg('mileage_log').select('id', 'purpose', 'is_business', 'customer_id', 'job_id', 'updated_at').orderBy('id'),
      services: await mockPg('scheduled_services').select('id', 'status', 'drive_time_minutes', 'arrived_at', 'completed_at', 'updated_at').orderBy('id'),
      customers: await mockPg('customers').select('id', 'latitude', 'longitude').orderBy('id'),
      notifications: Number((await mockPg('notifications').count({ n: '*' }).first()).n),
    });
    const before = await snapshot();
    await link();
    expect(await snapshot()).toEqual(before);
  });

  test('a tracker remapped on the day (bouncie_imei_changed_at) is not judged; one remapped earlier is', async () => {
    const f = await fixture();
    await mockPg('technicians').where({ id: f.tech }).update({ bouncie_imei_changed_at: new Date(iso('12:00')) });
    await link();
    expect((await legs()).map((r) => r.status)).toEqual(['no_vehicle', 'no_vehicle', 'no_vehicle']);
    expect(await counts()).toEqual({ legs: 3, links: 0 });
    await mockPg('technicians').where({ id: f.tech }).update({ bouncie_imei_changed_at: new Date('2026-10-07T12:00:00Z') });
    await link();
    expect((await legs()).map((r) => r.status)).toEqual(['matched', 'matched', 'matched']);
    expect((await counts()).links).toBe(4);
  });

  test('only the vehicle of the technician is read', async () => {
    const f = await fixture();
    await tripData('other-trip-1', [['14:00', HOME], ['14:20', north(9000)]], 'OTHERIMEI');
    await tripData('other-trip-2', [['14:50', north(9000)], ['15:00', HOME]], 'OTHERIMEI');
    await link({ technicianIds: [f.tech] });
    expect((await links()).map((r) => r.bouncie_trip_id)).toEqual(['trip-1', 'trip-2', 'trip-3', 'trip-4']);
  });

  // ---- the summary route ----
  test('the summary: gate off answers 404; on, the counts, medians and trip tallies', async () => {
    const f = await fixture();
    const far = await customer(north(9000));
    const noPin = await customer(null);
    const other = await technician('');
    await visit(far, f.tech, '15:00', '14:55');
    await visit(noPin, f.tech, '15:00', '14:55');
    await visit(await customer(PIN), other, '14:48', '14:22');
    await link();
    expect((await summary()).status).toBe(404);

    process.env.GATE_TRIP_LINK = 'true';
    const { status, body } = await summary();
    expect(status).toBe(200);
    expect(body).toMatchObject({ from: DAY, to: DAY, days: 1, services: 6, visits: 5, matched_pct: 40 });
    expect(body.by_status).toEqual({ matched: 2, no_vehicle: 1, no_destination: 1, no_stop: 1, ambiguous: 0 });
    // Visit A: 30 GPS minutes, stamped 27 (the group's earliest arrival 14:22 to its latest completion 14:49), 20 drive
    // minutes, 5.2 miles. Visit B: 20, 16, 15, 3.
    expect(body.medians).toEqual({ gps_on_site_minutes: 25, stamped_on_site_minutes: 21.5, drive_minutes: 17.5, drive_miles: 4.1 });
    expect(body.trips_by_suggested_purpose).toEqual([{ key: 'business', trips: 3, miles: 10.3 }, { key: 'unclassified', trips: 1, miles: 6 }]);
    expect(body.trips_by_ends_at_kind).toEqual([
      { key: 'visit', trips: 2, miles: 8.2 }, { key: 'home', trips: 1, miles: 6 }, { key: 'supplier', trips: 1, miles: 2.1 },
    ]);
    expect((await summary('from=2026-10-09&to=2026-10-09')).body).toMatchObject({ services: 0, visits: 0, matched_pct: null, medians: { gps_on_site_minutes: null } });
    expect((await summary('from=2026-01-01&to=2026-05-01')).status).toBe(400);
  });
});
