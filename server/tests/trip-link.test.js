// Trip link (GATE_TRIP_LINK): the matching and drive-leg rules (pure, synthetic points), the trips read, the nightly
// gate, the backfill script's arguments, the route's gate and validation, and the wiring. The SQL runs in
// trip-link.db.test.js. Synthetic coordinates and ids only.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockDb = jest.fn(() => { throw new Error('the database must not be touched'); });
jest.mock('../models/db', () => {
  const db = (...args) => mockDb(...args);
  db.transaction = (...args) => mockDb(...args);
  db.raw = (...args) => mockDb(...args);
  db.fn = { now: () => 'now()' };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const role = req.headers.authorization === 'Bearer admin' ? 'admin'
      : req.headers.authorization === 'Bearer tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = role;
    return next();
  },
  requireAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const tripLink = require('../services/trip-link');
const truckStops = require('../services/bouncie-truck-stops');
const backfill = require('../scripts/trip-link-backfill');
const { distanceMeters } = require('../services/gps-arrival-detector');

const { computeDay, matchVisit, visitWindow, WINDOW_BEFORE_MIN, WINDOW_AFTER_MIN } = tripLink;
const BASE = { lat: 27.49, lng: -82.57 };
const at = (north, east = 0) => ({
  lat: BASE.lat + north / 111195,
  lng: BASE.lng + east / (111195 * Math.cos((BASE.lat * Math.PI) / 180)),
});
const RADIUS = 175;
const T0 = Date.parse('2026-10-08T14:00:00Z');
const min = (n) => T0 + n * 60000;
const stop = (from, to, spot = at(0)) => ({ ...spot, startMs: min(from), endMs: min(to), minutes: to - from });
const trip = (tripId, from, to, start, end) => ({
  tripId, startMs: min(from), endMs: min(to), startLat: start.lat, startLng: start.lng, endLat: end.lat, endLng: end.lng,
});
const member = (id, completed, arrived = null) => ({ id, completed_at: new Date(min(completed)), arrived_at: arrived == null ? null : new Date(min(arrived)) });
const group = (key, members, destination = at(0)) => ({ key, members, destination });
// Stops the way the trips read derives them (the same function loadTruckStops uses).
const stopsOf = (trips) => truckStops.stopsFromTrips(new Map(trips.map((t) => [t.tripId, {
  first: { ms: t.startMs, lat: t.startLat, lng: t.startLng }, last: { ms: t.endMs, lat: t.endLat, lng: t.endLng },
}])), { maxGapMeters: RADIUS });
const miles = (...pairs) => new Map(pairs.map(([id, value], i) => [id, { id: `log-${i}`, miles: value }]));

describe('the visit window and the radius', () => {
  test('the constants are 120 minutes before the arrival stamp and 30 after completion', () => {
    expect(WINDOW_BEFORE_MIN).toBe(120);
    expect(WINDOW_AFTER_MIN).toBe(30);
    const w = visitWindow([member('a', 330, 300)]);
    expect(w.startMs).toBe(min(300 - 120));
    expect(w.endMs).toBe(min(330 + 30));
    expect(w.anchorMs).toBe(min(300));
  });

  test('without an arrival stamp the window opens before the completion stamp', () => {
    const w = visitWindow([member('a', 330)]);
    expect(w.startMs).toBe(min(330 - 120));
    expect(w.anchorMs).toBe(min(330));
  });

  const window = visitWindow([member('a', 330, 300)]); // [180, 360]
  const match = (stops, destination = at(0)) => matchVisit({ destination, window, stops, radius: RADIUS });

  test('a stop must overlap the window: one minute inside counts, ending before it or starting after it does not', () => {
    expect(match([stop(100, 181)])).toMatchObject({ status: 'matched', index: 0 });
    expect(match([stop(100, 179)])).toEqual({ status: 'no_stop' });
    expect(match([stop(359, 400)])).toMatchObject({ status: 'matched' });
    expect(match([stop(361, 400)])).toEqual({ status: 'no_stop' });
  });

  test('a stop must be inside the arrival radius of the destination', () => {
    expect(match([stop(290, 320, at(170))])).toMatchObject({ status: 'matched' });
    expect(match([stop(290, 320, at(180))])).toEqual({ status: 'no_stop' });
    expect(Math.round(distanceMeters(BASE.lat, BASE.lng, at(170).lat, at(170).lng))).toBe(170);
  });

  test('no destination and no stops are told apart', () => {
    expect(match([stop(290, 320)], null)).toEqual({ status: 'no_destination' });
    expect(match([])).toEqual({ status: 'no_stop' });
  });
});

describe('which stop a visit gets', () => {
  const window = visitWindow([member('a', 90, 60)]); // [-60, 120], anchor 60
  const match = (stops) => matchVisit({ destination: at(0), window, stops, radius: RADIUS });

  test('the greatest overlap wins', () => {
    expect(match([stop(30, 50), stop(70, 100)])).toMatchObject({ status: 'matched', index: 1 });
  });

  test('equal overlap: the stop that began nearest the arrival stamp wins', () => {
    expect(match([stop(40, 60), stop(70, 90)])).toMatchObject({ status: 'matched', index: 1 });
  });

  test('equal overlap and equal distance from the arrival stamp is ambiguous', () => {
    expect(match([stop(40, 60), stop(80, 100)])).toEqual({ status: 'ambiguous' });
  });

  test('the nearest stop in distance does not matter, only overlap then arrival time', () => {
    expect(match([stop(30, 50, at(10)), stop(70, 100, at(150))])).toMatchObject({ index: 1 });
  });
});

describe('a day of stops', () => {
  const HOME = at(-5000);
  const SUPPLIER = at(3000);
  const A = at(0);
  const B = at(1500);
  // home -> A (stop 20..50) -> supplier (stop 60..75) -> B (stop 90..110) -> home
  const trips = [
    trip('t1', 0, 20, HOME, A), trip('t2', 50, 60, A, SUPPLIER), trip('t3', 75, 90, SUPPLIER, B), trip('t4', 110, 130, B, HOME),
  ];
  const stops = stopsOf(trips);
  const fences = [{ ...SUPPLIER, radius: 100, type: 'supplier' }];
  const groups = [
    group('visit-a', [member('svc-a', 48, 22)], A),
    group('visit-b', [member('svc-b', 108, 92)], B),
  ];
  const day = (overrides = {}) => computeDay({
    groups, trips, stops, mileageByTrip: miles(['t1', 5.2], ['t2', 2.1], ['t3', 3], ['t4', 6]), radius: RADIUS, fences, home: HOME, ...overrides,
  });
  const leg = (result, id) => result.legs.find((l) => l.scheduled_service_id === id);
  const link = (result, id) => result.links.find((l) => l.bouncie_trip_id === id);

  test('the test day has the stops it claims', () => {
    expect(stops.map((s) => [s.startMs, s.endMs])).toEqual([[min(20), min(50)], [min(60), min(75)], [min(90), min(110)]]);
  });

  test('the first visit: GPS times, on-site minutes and a drive leg from home', () => {
    expect(leg(day(), 'svc-a')).toMatchObject({
      status: 'matched', gps_on_site_minutes: 30, shared_stop_count: 1, drive_minutes: 20, drive_miles: 5.2,
      drive_from_kind: 'home', drive_trip_ids: ['t1'], match_distance_m: 0,
    });
    expect(leg(day(), 'svc-a').gps_arrived_at).toEqual(new Date(min(20)));
    expect(leg(day(), 'svc-a').gps_departed_at).toEqual(new Date(min(50)));
  });

  test('a supplier stop between two visits makes the second leg come from the supplier, from the end of that stop', () => {
    expect(leg(day(), 'svc-b')).toMatchObject({ drive_from_kind: 'supplier', drive_minutes: 15, drive_miles: 3, drive_trip_ids: ['t3'] });
  });

  test('the visit before it is a visit leg', () => {
    const result = day({ groups: [groups[0], group('visit-c', [member('svc-c', 108, 92)], SUPPLIER), groups[1]] });
    expect(leg(result, 'svc-c')).toMatchObject({ drive_from_kind: 'visit', drive_minutes: 10, drive_trip_ids: ['t2'], drive_miles: 2.1 });
    expect(leg(result, 'svc-b')).toMatchObject({ drive_from_kind: 'visit' }); // the supplier stop is now a visit stop
  });

  test('the first stop starts from the day\'s first trip: home when it began at the home base, else day_start', () => {
    expect(leg(day(), 'svc-a').drive_from_kind).toBe('home');
    expect(leg(day({ home: at(9000) }), 'svc-a')).toMatchObject({ drive_from_kind: 'day_start', drive_minutes: 20 });
    expect(leg(day({ home: null }), 'svc-a').drive_from_kind).toBe('day_start');
  });

  test('drive_miles is NULL when any trip of the leg has no mileage_log row, and the trips are still listed', () => {
    const result = day({ mileageByTrip: miles(['t1', 5.2], ['t2', 2.1], ['t4', 6]) });
    expect(leg(result, 'svc-b')).toMatchObject({ drive_miles: null, drive_trip_ids: ['t3'], drive_minutes: 15 });
    expect(leg(result, 'svc-a').drive_miles).toBe(5.2);
    expect(leg(day({ mileageByTrip: new Map() }), 'svc-a').drive_miles).toBeNull();
  });

  test('a leg with several trips sums their miles', () => {
    // A short stop (3 minutes) is no stop, so the two trips make one drive leg.
    const two = [trip('u1', 0, 10, HOME, at(2000)), trip('u2', 13, 20, at(2000), A), trip('u3', 50, 60, A, HOME)];
    const result = computeDay({
      groups: [groups[0]], trips: two, stops: stopsOf(two), mileageByTrip: miles(['u1', 1.25], ['u2', 2.5]), radius: RADIUS, fences: [], home: HOME,
    });
    expect(leg(result, 'svc-a')).toMatchObject({ drive_miles: 3.75, drive_trip_ids: ['u1', 'u2'], drive_minutes: 20 });
  });

  test('every trip says where it ended and suggests a purpose', () => {
    const result = day();
    expect(link(result, 't1')).toEqual({ bouncie_trip_id: 't1', ends_at_kind: 'visit', ends_at_scheduled_service_id: 'svc-a', suggested_purpose: 'business' });
    expect(link(result, 't2')).toMatchObject({ ends_at_kind: 'supplier', ends_at_scheduled_service_id: null, suggested_purpose: 'business' });
    expect(link(result, 't3')).toMatchObject({ ends_at_kind: 'visit', ends_at_scheduled_service_id: 'svc-b' });
    expect(link(result, 't4')).toMatchObject({ ends_at_kind: 'home', suggested_purpose: 'unclassified' });
    expect(result.links).toHaveLength(4);
  });

  test('purposes: personal fence = personal, business fence = business, anywhere else = unclassified', () => {
    const fenced = (type) => computeDay({ groups: [], trips, stops, radius: RADIUS, fences: [{ ...SUPPLIER, radius: 100, type }], home: HOME });
    expect(fenced('personal').links.find((l) => l.bouncie_trip_id === 't2')).toMatchObject({ ends_at_kind: 'personal', suggested_purpose: 'personal' });
    expect(fenced('business').links.find((l) => l.bouncie_trip_id === 't2')).toMatchObject({ ends_at_kind: 'business', suggested_purpose: 'business' });
    expect(fenced('supplier').links.find((l) => l.bouncie_trip_id === 't2').suggested_purpose).toBe('business');
    const none = computeDay({ groups: [], trips, stops, radius: RADIUS, fences: [], home: HOME });
    expect(none.links.find((l) => l.bouncie_trip_id === 't2')).toMatchObject({ ends_at_kind: 'other', suggested_purpose: 'unclassified' });
    expect(['visit', 'supplier', 'business', 'personal', 'home', 'other'].map(tripLink.purposeFor))
      .toEqual(['business', 'business', 'business', 'personal', 'unclassified', 'unclassified']);
  });

  test('a visit with no stop, no pin or an ambiguous pair gets its status and no GPS values', () => {
    const result = day({
      groups: [group('far', [member('svc-far', 108, 92)], at(9000)), group('nopin', [member('svc-nopin', 48, 22)], null)],
    });
    expect(leg(result, 'svc-far')).toEqual({ scheduled_service_id: 'svc-far', leg_group_key: 'far', status: 'no_stop', shared_stop_count: 1 });
    expect(leg(result, 'svc-nopin').status).toBe('no_destination');
  });

  test('grouped members of one physical visit share one leg and one stop', () => {
    const result = day({ groups: [group('visit-a', [member('svc-a1', 48, 22), member('svc-a2', 49, 23)], A)] });
    const [one, two] = ['svc-a1', 'svc-a2'].map((id) => leg(result, id));
    expect(one).toEqual({ ...two, scheduled_service_id: 'svc-a1' });
    expect(one).toMatchObject({ leg_group_key: 'visit-a', shared_stop_count: 1, gps_on_site_minutes: 30, drive_minutes: 20 });
    expect(link(result, 't1').ends_at_scheduled_service_id).toBe('svc-a1');
  });

  test('two physical visits at the same stop split its minutes and say so', () => {
    const result = day({ groups: [group('v1', [member('svc-1', 48, 22)], A), group('v2', [member('svc-2', 49, 23)], at(40))] });
    for (const id of ['svc-1', 'svc-2']) {
      expect(leg(result, id)).toMatchObject({ gps_on_site_minutes: 15, shared_stop_count: 2, drive_minutes: 20 });
    }
  });
});

describe('the trips read agrees with the stops read', () => {
  const GAP = 175;
  const iso = (n) => new Date(min(n)).toISOString();
  const sample = (n, spot) => ({ timestamp: iso(n), gps: { lat: spot.lat, lon: spot.lng }, speed: 0 });
  const event = (tripId, ...samples) => ({ eventType: 'tripData', transactionId: tripId, imei: 'imei-1', data: samples });
  const row = (id, payload) => ({ id, payload });
  function fakeConn(rows) {
    const calls = [];
    const conn = (table) => {
      const state = { table, wheres: [], afterId: 0, limit: Infinity };
      const builder = {
        where(a, b, c) { state.wheres.push([a, b, c]); if (a === 'id') state.afterId = c; return builder; },
        orderBy() { return builder; },
        limit(n) { state.limit = n; return builder; },
        select: async () => { calls.push(state); return rows.filter((r) => r.id > state.afterId).slice(0, state.limit); },
      };
      return builder;
    };
    conn.calls = calls;
    return conn;
  }
  const NOW = Date.parse('2026-10-10T00:00:00Z');
  const FROM = min(-60);
  const TO = min(24 * 60);
  const rows = [
    row(1, event('t2', sample(40, at(0)), sample(55, at(1500)))),
    row(2, event('t1', sample(0, at(-5000)), sample(10, at(0)))),
    row(3, event('t1', sample(10, at(0)))), // the same last point, seen twice
    row(4, event('t3', sample(80, at(1500)), sample(95, at(-5000)))),
    row(5, { eventType: 'tripData', imei: 'imei-1', data: [sample(0, at(0))] }), // no trip id: ignored
  ];

  test('loadTruckStops gives what stopsFromTrips gives over the same events (the output did not change)', async () => {
    const reference = new Map();
    for (const r of rows) {
      const parsed = truckStops.tripPointsFromPayload(r.payload);
      if (parsed) truckStops.addToTrips(reference, parsed);
    }
    const expected = truckStops.stopsFromTrips(reference, { maxGapMeters: GAP }).filter((s) => s.startMs >= FROM && s.startMs < TO);
    expect(expected).toHaveLength(2);
    const stops = await truckStops.loadTruckStops(fakeConn(rows), 'imei-1', { fromMs: FROM, toMs: TO, maxGapMeters: GAP, now: NOW });
    expect(stops).toEqual(expected);
  });

  test('loadTruckTrips lists each trip once, in time order, with its first and last point', async () => {
    const trips = await truckStops.loadTruckTrips(fakeConn(rows), 'imei-1', { fromMs: FROM, toMs: TO, now: NOW });
    expect(trips.map((t) => [t.tripId, t.startMs, t.endMs])).toEqual([['t1', min(0), min(10)], ['t2', min(40), min(55)], ['t3', min(80), min(95)]]);
    expect(trips[0]).toMatchObject({ startLat: at(-5000).lat, endLat: at(0).lat, endLng: at(0).lng });
  });

  test('loadTruckDay is both reads from ONE query pass, and the window cuts trips and stops by their start', async () => {
    const conn = fakeConn(rows);
    const day = await truckStops.loadTruckDay(conn, 'imei-1', { fromMs: FROM, toMs: TO, maxGapMeters: GAP, now: NOW });
    expect(conn.calls).toHaveLength(1);
    expect(day.stops).toEqual(await truckStops.loadTruckStops(fakeConn(rows), 'imei-1', { fromMs: FROM, toMs: TO, maxGapMeters: GAP, now: NOW }));
    expect(day.trips).toEqual(await truckStops.loadTruckTrips(fakeConn(rows), 'imei-1', { fromMs: FROM, toMs: TO, now: NOW }));
    const late = await truckStops.loadTruckDay(fakeConn(rows), 'imei-1', { fromMs: min(30), toMs: min(60), maxGapMeters: GAP, now: NOW });
    expect(late.trips.map((t) => t.tripId)).toEqual(['t2']);
    // The stop at the end of t2 starts at minute 55 and ends when t3 starts at minute 80, after the window closes.
    expect(late.stops.map((s) => s.startMs)).toEqual([min(55)]);
  });

  test('both reads use the same bounded query as the stops read, and no vehicle reads nothing', async () => {
    const conn = fakeConn(rows);
    await truckStops.loadTruckTrips(conn, 'imei-1', { fromMs: FROM, toMs: TO, now: NOW });
    expect(conn.calls[0].wheres[0][0]).toEqual({ vehicle_imei: 'imei-1', event_type: 'trip-data' });
    expect(conn.calls[0].wheres.find((w) => w[0] === 'received_at' && w[1] === '<')[2].getTime()).toBe(Math.min(NOW, TO + 12 * 3600000));
    const none = fakeConn(rows);
    expect(await truckStops.loadTruckTrips(none, '', { fromMs: FROM, toMs: TO })).toEqual([]);
    expect(await truckStops.loadTruckDay(none, '', { fromMs: FROM, toMs: TO, maxGapMeters: GAP })).toEqual({ trips: [], stops: [] });
    expect(none.calls).toHaveLength(0);
  });
});

describe('the nightly days', () => {
  const now = new Date('2026-10-12T05:40:00Z'); // 01:40 ET on Oct 12

  test('yesterday, then the day before again', () => {
    expect(tripLink.nightlyDays(now)).toEqual(['2026-10-11', '2026-10-10']);
  });

  test('plus the worked day of a visit closed yesterday, up to LATE_CLOSE_DAYS back, each day once', () => {
    const arrivals = ['2026-10-08T15:32:00Z', '2026-10-08T18:00:00Z', '2026-10-10T14:00:00Z', '2026-10-05T14:00:00Z', '2026-10-04T14:00:00Z'];
    expect(tripLink.LATE_CLOSE_DAYS).toBe(7);
    expect(tripLink.nightlyDays(now, arrivals)).toEqual(['2026-10-11', '2026-10-10', '2026-10-08', '2026-10-05']);
  });

  test('an arrival late in the ET evening counts on its ET day', () => {
    // 23:30 ET on Oct 7 is 03:30Z on Oct 8.
    expect(tripLink.nightlyDays(now, ['2026-10-08T03:30:00Z'])).toEqual(['2026-10-11', '2026-10-10', '2026-10-07']);
  });
});

describe('the gate', () => {
  beforeEach(() => { mockDb.mockClear(); delete process.env.GATE_TRIP_LINK; });
  afterAll(() => { delete process.env.GATE_TRIP_LINK; });

  test('off: the nightly run reads nothing and writes nothing', async () => {
    expect(await tripLink.runTripLinkNightly({ now: new Date('2026-10-09T05:40:00Z') })).toEqual({ skipped: 'gated' });
    process.env.GATE_TRIP_LINK = 'TRUE';
    expect(tripLink.tripLinkLive()).toBe(false);
    process.env.GATE_TRIP_LINK = '1';
    expect(await tripLink.runTripLinkNightly()).toEqual({ skipped: 'gated' });
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('on: strict true, read at call time', () => {
    process.env.GATE_TRIP_LINK = 'true';
    expect(tripLink.tripLinkLive()).toBe(true);
    delete process.env.GATE_TRIP_LINK;
    expect(tripLink.tripLinkLive()).toBe(false);
  });

  test('a test double of feature-gates without the reader reads as off', () => {
    jest.isolateModules(() => {
      jest.doMock('../config/feature-gates', () => ({}));
      expect(require('../services/trip-link').tripLinkLive()).toBe(false);
    });
    jest.dontMock('../config/feature-gates');
  });
});

describe('the backfill script', () => {
  const summary = (matched = 1, total = 2) => ({
    day: 'x', technicians: 1, trips: 3, errors: 0, legs: { total, matched, no_vehicle: 0, no_destination: 0, no_stop: total - matched, ambiguous: 0 },
  });
  const deps = (over = {}) => ({ conn: {}, log: jest.fn(), linkDay: jest.fn(async () => summary()), gateOn: () => false, ...over });

  test('arguments and the 120 day cap', () => {
    expect(backfill.parseArgs(['--from', '2026-10-01', '--to', '2026-10-03', '--dry-run'])).toEqual({ from: '2026-10-01', to: '2026-10-03', dryRun: true, forceShadow: false });
    expect(() => backfill.parseArgs(['--nonsense'])).toThrow(/Unknown argument/);
    expect(backfill.daysBetween('2026-10-01', '2026-10-03')).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
    expect(backfill.daysBetween('2026-01-01', '2026-04-30')).toHaveLength(120);
    expect(() => backfill.daysBetween('2026-01-01', '2026-05-01')).toThrow(/at most 120/);
    expect(() => backfill.daysBetween('2026-10-03', '2026-10-01')).toThrow(/must not be after/);
    expect(() => backfill.daysBetween('2026-02-30', '2026-03-01')).toThrow(/YYYY-MM-DD/);
    expect(() => backfill.daysBetween(undefined, '2026-03-01')).toThrow(/required/);
  });

  test('the dry run asks for a dry run, writes nothing and works with the gate off', async () => {
    const d = deps();
    const total = await backfill.run(['--from', '2026-10-01', '--to', '2026-10-02', '--dry-run'], d);
    expect(d.linkDay).toHaveBeenCalledTimes(2);
    expect(d.linkDay.mock.calls.every(([, , opts]) => opts.dryRun === true)).toBe(true);
    expect(total).toMatchObject({ days: 2, trips: 6, legs: { total: 4, matched: 2, no_stop: 2 } });
    expect(String(d.log.mock.calls.at(-1)[0])).toMatch(/DRY RUN \(nothing written\)/);
  });

  test('a write with the gate off is refused unless --force-shadow; gate on writes', async () => {
    const refused = deps();
    await expect(backfill.run(['--from', '2026-10-01', '--to', '2026-10-01'], refused)).rejects.toThrow(/force-shadow/);
    expect(refused.linkDay).not.toHaveBeenCalled();
    const forced = deps();
    await backfill.run(['--from', '2026-10-01', '--to', '2026-10-01', '--force-shadow'], forced);
    expect(forced.linkDay).toHaveBeenCalledWith(forced.conn, '2026-10-01', { dryRun: false });
    const on = deps({ gateOn: () => true });
    await backfill.run(['--from', '2026-10-01', '--to', '2026-10-01'], on);
    expect(on.linkDay).toHaveBeenCalledTimes(1);
  });

  test('a failed technician-day fails the run', async () => {
    const d = deps({ linkDay: jest.fn(async () => ({ ...summary(), errors: 1 })), gateOn: () => true });
    await expect(backfill.run(['--from', '2026-10-01', '--to', '2026-10-01'], d)).rejects.toThrow(/failed/);
  });
});

describe('the summary route', () => {
  let server;
  let baseUrl;
  const call = async (url, token = 'admin') => {
    const res = await fetch(`${baseUrl}${url}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  beforeAll(async () => {
    const app = express();
    app.use('/api/admin/trip-link', require('../routes/admin-trip-link'));
    server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    delete process.env.GATE_TRIP_LINK;
    if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  beforeEach(() => { mockDb.mockClear(); delete process.env.GATE_TRIP_LINK; });

  test('gate off: 404 for staff, and the database is not touched', async () => {
    const res = await call('/api/admin/trip-link/summary?from=2026-10-01&to=2026-10-02');
    expect(res.status).toBe(404);
    expect(mockDb).not.toHaveBeenCalled();
  });

  test('staff only', async () => {
    process.env.GATE_TRIP_LINK = 'true';
    expect((await call('/api/admin/trip-link/summary?from=2026-10-01&to=2026-10-02', 'tech')).status).toBe(403);
    expect((await call('/api/admin/trip-link/summary?from=2026-10-01&to=2026-10-02', 'nobody')).status).toBe(401);
  });

  test.each([
    ['no dates', ''],
    ['a bad date', '?from=2026-02-30&to=2026-03-01'],
    ['a reversed range', '?from=2026-10-03&to=2026-10-01'],
    ['more than 120 days', '?from=2026-01-01&to=2026-05-01'],
  ])('gate on: %s is a 400 before any query', async (_name, query) => {
    process.env.GATE_TRIP_LINK = 'true';
    expect((await call(`/api/admin/trip-link/summary${query}`)).status).toBe(400);
    expect(mockDb).not.toHaveBeenCalled();
  });
});

describe('wiring and the shadow-only promise', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

  test('the scheduler runs the nightly job at 01:40 ET through runExclusive (job health) and records a skipped tick', () => {
    const source = read('services/scheduler.js');
    const block = source.slice(source.indexOf("cron.schedule('40 1 * * *'"), source.indexOf("DAILY 07:20 — agreement renewal"));
    expect(block).toMatch(/runExclusive\('trip-link'/);
    expect(block).toMatch(/runTripLinkNightly\(\)/);
    expect(block).toMatch(/timezone: 'America\/New_York'/);
    expect(block).toMatch(/recordJobStart\('trip-link'\)[\s\S]*recordJobEnd\('trip-link'/);
  });

  test('the service writes only visit_gps_legs and trip_links; mileage_log and scheduled_services are read, never written', () => {
    const full = read('services/trip-link.js');
    const source = full.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const tables = new Set([...source.matchAll(/\b(?:conn|trx)\('([a-z_]+)'\)/g)].map((m) => m[1]));
    expect([...tables].sort()).toEqual(['mileage_log', 'scheduled_services', 'technicians', 'trip_links', 'visit_gps_legs']);
    expect(source).not.toMatch(/mileage_log'\)[^;]*\.(insert|update|del|merge)\(/);
    expect(source).not.toMatch(/scheduled_services'\)[^;]*\.(insert|update|del|merge)\(/);
    expect(source).not.toMatch(/job_costs|raiseAdminAlert|notifyAdmin|sendSMS|customer_pin/);
    expect(source).not.toMatch(/_private/);
    expect(read('services/visit-gps-context.js')).not.toMatch(/_private/);
  });

  test('pin-parked-check imports the shared helpers instead of keeping its own copies', () => {
    const source = read('services/pin-parked-check.js');
    expect(source).toMatch(/require\('\.\/visit-gps-context'\)/);
    for (const name of ['function destinationOf', 'function oneRowPerVisit', 'function homeBaseFrom', 'function loadFences', 'function etDayBounds']) {
      expect(source).not.toContain(name);
    }
  });
});
