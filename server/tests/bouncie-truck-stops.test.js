// Truck stops from Bouncie trip-data events (pin check after a visit): what counts as a stop, and how the read is bounded.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { loadTruckStops, stopsFromTrips, tripPointsFromPayload, addToTrips } = require('../services/bouncie-truck-stops');

const T0 = Date.parse('2026-10-08T14:00:00Z');
const minutes = (n) => new Date(T0 + n * 60000).toISOString();
const point = (min, lat = 27.49, lng = -82.57) => ({ timestamp: minutes(min), gps: { lat, lon: lng }, speed: 0 });
const event = (tripId, ...points) => ({ eventType: 'tripData', transactionId: tripId, imei: 'imei-1', data: points });
const GAP = 175;

function tripsOf(...events) {
  const trips = new Map();
  for (const e of events) addToTrips(trips, tripPointsFromPayload(e));
  return trips;
}

describe('tripPointsFromPayload', () => {
  test('reads the trip id and the timestamped gps points', () => {
    const parsed = tripPointsFromPayload(event('t1', point(0), point(5, 27.5, -82.6)));
    expect(parsed.tripId).toBe('t1');
    expect(parsed.points).toHaveLength(2);
    expect(parsed.points[1]).toMatchObject({ lat: 27.5, lng: -82.6 });
  });
  test('accepts a payload stored as JSON text', () => {
    expect(tripPointsFromPayload(JSON.stringify(event('t1', point(0))))?.tripId).toBe('t1');
  });
  test.each([
    ['no trip id', { data: [point(0)] }],
    ['no points', { transactionId: 't1', data: [] }],
    ['points without a time', { transactionId: 't1', data: [{ gps: { lat: 27.49, lon: -82.57 } }] }],
    ['not an object', 'nonsense'],
    ['null', null],
  ])('ignores an event with %s', (_name, payload) => {
    expect(tripPointsFromPayload(payload)).toBeNull();
  });
});

describe('stopsFromTrips', () => {
  test('a stop runs from the last point of one trip to the first point of the next', () => {
    const trips = tripsOf(
      event('t1', point(0, 27.4, -82.5), point(10, 27.49, -82.57)),
      event('t2', point(40, 27.49, -82.57), point(50, 27.4, -82.5)),
    );
    const [stop] = stopsFromTrips(trips, { maxGapMeters: GAP });
    expect(stop).toMatchObject({ lat: 27.49, lng: -82.57, minutes: 30 });
    expect(stop.startMs).toBe(T0 + 10 * 60000);
  });

  test('batches of one trip fold into one trip, in any order, and a point seen twice counts once', () => {
    const trips = tripsOf(
      event('t1', point(8, 27.49, -82.57), point(10, 27.49, -82.57)),
      event('t1', point(0, 27.4, -82.5), point(4, 27.45, -82.55)),
      event('t1', point(8, 27.49, -82.57)),
      event('t2', point(40, 27.49, -82.57)),
    );
    expect(trips.size).toBe(2);
    const stops = stopsFromTrips(trips, { maxGapMeters: GAP });
    expect(stops).toHaveLength(1);
    expect(stops[0].minutes).toBe(30);
  });

  test('a gap shorter than 5 minutes is a traffic light, not a stop', () => {
    const trips = tripsOf(event('t1', point(0), point(10)), event('t2', point(14), point(20)));
    expect(stopsFromTrips(trips, { maxGapMeters: GAP })).toEqual([]);
    expect(stopsFromTrips(trips, { maxGapMeters: GAP, minMinutes: 3 })).toHaveLength(1);
  });

  test('a trip event that was lost (the truck is somewhere else when the next trip starts) claims no stop', () => {
    const trips = tripsOf(event('t1', point(0, 27.4, -82.5), point(10, 27.4, -82.5)), event('t2', point(40, 27.49, -82.57)));
    expect(stopsFromTrips(trips, { maxGapMeters: GAP })).toEqual([]);
  });

  test('the last trip has no next trip, so no stop', () => {
    expect(stopsFromTrips(tripsOf(event('t1', point(0), point(10))), { maxGapMeters: GAP })).toEqual([]);
  });

  test('overlapping trips make no stop', () => {
    const trips = tripsOf(event('t1', point(0), point(30)), event('t2', point(20), point(50)));
    expect(stopsFromTrips(trips, { maxGapMeters: GAP })).toEqual([]);
  });
});

describe('loadTruckStops', () => {
  // A stand-in for knex: records the where clauses, serves the rows in id-ordered pages.
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
  const row = (id, e) => ({ id, payload: e });
  const NOW = Date.parse('2026-10-09T12:00:00Z');

  test('reads one vehicle, trip-data only, from the window start to 12 hours past its end (never past now)', async () => {
    const conn = fakeConn([row(1, event('t1', point(0), point(10))), row(2, event('t2', point(40)))]);
    const stops = await loadTruckStops(conn, 'imei-1', { fromMs: T0 - 3600000, toMs: T0 + 86400000, maxGapMeters: GAP, now: NOW });
    expect(stops).toHaveLength(1);
    const wheres = conn.calls[0].wheres;
    expect(wheres[0][0]).toEqual({ vehicle_imei: 'imei-1', event_type: 'trip-data' });
    const lower = wheres.find((w) => w[0] === 'received_at' && w[1] === '>=');
    const upper = wheres.find((w) => w[0] === 'received_at' && w[1] === '<');
    expect(lower[2].getTime()).toBe(T0 - 3600000);
    expect(upper[2].getTime()).toBe(NOW);
  });

  test('keeps only the stops that START inside the window', async () => {
    const conn = fakeConn([row(1, event('t1', point(0), point(10))), row(2, event('t2', point(40)))]);
    const outside = await loadTruckStops(conn, 'imei-1', { fromMs: T0 + 15 * 60000, toMs: T0 + 86400000, maxGapMeters: GAP, now: NOW });
    expect(outside).toEqual([]);
  });

  test('pages through a long day without loading it at once', async () => {
    const many = [];
    for (let i = 1; i <= 1100; i += 1) many.push(row(i, event('t1', point(i % 10))));
    many.push(row(1101, event('t2', point(500))));
    const conn = fakeConn(many);
    await loadTruckStops(conn, 'imei-1', { fromMs: T0 - 3600000, toMs: T0 + 86400000 * 2, maxGapMeters: GAP, now: T0 + 86400000 * 2 });
    expect(conn.calls.length).toBe(3);
  });

  test('no vehicle id reads nothing', async () => {
    const conn = fakeConn([]);
    expect(await loadTruckStops(conn, '', { fromMs: 0, toMs: 1, maxGapMeters: GAP })).toEqual([]);
    expect(conn.calls).toHaveLength(0);
  });
});
