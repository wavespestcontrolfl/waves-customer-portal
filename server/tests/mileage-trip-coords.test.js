// Fills NULL mileage_log trip coordinates from the first and last trip-data point of the same transactionId.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { makeFakeDb } = require('./helpers/mileage-coords-fake-db');
const {
  fillTripCoordinates, fillRecentTripCoordinates, fillTripCoordinatesForTrip, groupRows, fillsFor,
} = require('../services/mileage-trip-coords');

const IMEI = 'imei-1';
const T0 = Date.parse('2026-10-08T14:00:00Z');
const NOW = Date.parse('2026-10-09T12:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();
const sample = (min, lat, lng) => ({ timestamp: at(min), gps: { lat, lon: lng }, speed: 10 });
let nextLogId = 1;
const logRow = (tripId, samples, extra = {}) => ({
  id: nextLogId++, vehicle_imei: IMEI, event_type: 'trip-data', received_at: new Date(T0 + 60000),
  payload: JSON.stringify({ eventType: 'tripData', transactionId: tripId, imei: IMEI, data: samples }), ...extra,
});
const trip = (id, tripId, extra = {}) => ({
  id, vehicle_id: IMEI, bouncie_trip_id: tripId, source: 'bouncie', trip_date: '2026-10-08',
  start_lat: null, start_lng: null, end_lat: null, end_lng: null,
  is_business: false, purpose: 'unclassified', deduction_amount: 0, classification_method: 'needs_review', ...extra,
});

beforeEach(() => { nextLogId = 1; delete process.env.GATE_MILEAGE_TRIP_COORDS; });
afterAll(() => { delete process.env.GATE_MILEAGE_TRIP_COORDS; });

describe('fillTripCoordinates', () => {
  test('start = earliest point, end = latest point, across batches that arrive out of order', async () => {
    process.env.GATE_MILEAGE_TRIP_COORDS = 'true';
    const conn = makeFakeDb({
      mileage: [trip(1, 't1')],
      log: [
        logRow('t1', [sample(8, 27.49, -82.57), sample(10, 27.5, -82.58)]),
        logRow('t1', [sample(0, 27.4, -82.5), sample(4, 27.45, -82.55)]),
      ],
    });
    const result = await fillTripCoordinates(conn, { apply: true, now: NOW });
    expect(result).toMatchObject({ candidates: 1, rowsFilled: 1, startFilled: 1, endFilled: 1, noPoints: 0 });
    expect(conn.tables.mileage_log[0]).toMatchObject({ start_lat: 27.4, start_lng: -82.5, end_lat: 27.5, end_lng: -82.58 });
  });

  test('fills only NULL pairs and never overwrites or touches classification columns', async () => {
    process.env.GATE_MILEAGE_TRIP_COORDS = 'true';
    const conn = makeFakeDb({
      mileage: [
        trip(1, 't1', { start_lat: 1.5, start_lng: 2.5 }),
        trip(2, 't2', { start_lat: 3.5 }),
      ],
      log: [
        logRow('t1', [sample(0, 27.4, -82.5), sample(10, 27.5, -82.58)]),
        logRow('t2', [sample(0, 27.4, -82.5), sample(10, 27.5, -82.58)]),
      ],
    });
    await fillTripCoordinates(conn, { apply: true, now: NOW });
    const [one, two] = conn.tables.mileage_log;
    expect(one).toMatchObject({ start_lat: 1.5, start_lng: 2.5, end_lat: 27.5, end_lng: -82.58 });
    // A half-filled start pair is left for a person; its empty end pair is still filled.
    expect(two).toMatchObject({ start_lat: 3.5, start_lng: null, end_lat: 27.5, end_lng: -82.58 });
    for (const row of [one, two]) {
      expect(row).toMatchObject({ is_business: false, purpose: 'unclassified', deduction_amount: 0, classification_method: 'needs_review' });
    }
  });

  test('a trip with no trip-data, another vehicle or another trip id is left alone', async () => {
    process.env.GATE_MILEAGE_TRIP_COORDS = 'true';
    const conn = makeFakeDb({
      mileage: [trip(1, 'no-data'), trip(2, 't2')],
      log: [
        logRow('t2', [sample(0, 27.4, -82.5)], { vehicle_imei: 'other-imei' }),
        logRow('someone-else', [sample(0, 27.4, -82.5)]),
        logRow('t2', [sample(0, 27.4, -82.5)], { event_type: 'trip-end' }),
      ],
    });
    const result = await fillTripCoordinates(conn, { apply: true, now: NOW });
    expect(result).toMatchObject({ candidates: 2, rowsFilled: 0, noPoints: 2 });
    expect(conn.tables.mileage_log.every((row) => row.start_lat == null && row.end_lat == null)).toBe(true);
  });

  test('gate off: apply writes nothing; a dry run counts without writing', async () => {
    const conn = makeFakeDb({
      mileage: [trip(1, 't1')],
      log: [logRow('t1', [sample(0, 27.4, -82.5), sample(10, 27.5, -82.58)])],
    });
    expect(await fillTripCoordinates(conn, { apply: true, now: NOW })).toMatchObject({ skipped: 'gate_off', rowsFilled: 0 });
    expect(conn).not.toHaveBeenCalled();
    const dry = await fillTripCoordinates(conn, { now: NOW });
    expect(dry).toMatchObject({ candidates: 1, rowsFilled: 1, startFilled: 1, endFilled: 1 });
    expect(conn.tables.mileage_log[0].start_lat).toBeNull();
  });

  test('is idempotent and pages through rows in small batches', async () => {
    process.env.GATE_MILEAGE_TRIP_COORDS = 'true';
    const conn = makeFakeDb({
      mileage: [trip(1, 't1'), trip(2, 't2'), trip(3, 't3')],
      log: ['t1', 't2', 't3'].map((id) => logRow(id, [sample(0, 27.4, -82.5), sample(5, 27.5, -82.6)])),
    });
    const first = await fillTripCoordinates(conn, { apply: true, batchSize: 1, now: NOW });
    expect(first).toMatchObject({ candidates: 3, rowsFilled: 3 });
    const second = await fillTripCoordinates(conn, { apply: true, batchSize: 1, now: NOW });
    expect(second).toMatchObject({ candidates: 0, rowsFilled: 0 });
  });

  test('sinceDate and tripId narrow the candidates', async () => {
    process.env.GATE_MILEAGE_TRIP_COORDS = 'true';
    const conn = makeFakeDb({
      mileage: [trip(1, 't1', { trip_date: '2026-09-01' }), trip(2, 't2')],
      log: [logRow('t2', [sample(0, 27.4, -82.5)])],
    });
    expect((await fillTripCoordinates(conn, { sinceDate: '2026-10-01', now: NOW })).candidates).toBe(1);
    expect((await fillTripCoordinates(conn, { tripId: 't1', now: NOW })).candidates).toBe(1);
  });
});

describe('fillRecentTripCoordinates and fillTripCoordinatesForTrip', () => {
  test('gate off is a no-op that does not touch the database', async () => {
    const conn = makeFakeDb({ mileage: [trip(1, 't1')], log: [] });
    expect(await fillRecentTripCoordinates(conn, { now: NOW })).toEqual({ skipped: 'gate_off' });
    expect(await fillTripCoordinatesForTrip(conn, 't1')).toEqual({ skipped: 'gate_off' });
    expect(conn).not.toHaveBeenCalled();
  });

  test('gate on fills a recent trip and the single-trip path fills just that one', async () => {
    process.env.GATE_MILEAGE_TRIP_COORDS = 'true';
    const log = [logRow('t1', [sample(0, 27.4, -82.5), sample(5, 27.5, -82.6)]), logRow('t2', [sample(0, 27.1, -82.1)])];
    const conn = makeFakeDb({ mileage: [trip(1, 't1'), trip(2, 't2')], log });
    const one = await fillTripCoordinatesForTrip(conn, 't2');
    expect(one).toMatchObject({ candidates: 1, rowsFilled: 1 });
    expect(conn.tables.mileage_log[0].start_lat).toBeNull();
    expect(conn.tables.mileage_log[1]).toMatchObject({ start_lat: 27.1, end_lat: 27.1 });
    const recent = await fillRecentTripCoordinates(conn, { now: NOW });
    expect(recent).toMatchObject({ candidates: 1, rowsFilled: 1 });
    expect(conn.tables.mileage_log[0]).toMatchObject({ start_lat: 27.4, end_lat: 27.5 });
  });

  test('a database error never throws out of either entry point', async () => {
    process.env.GATE_MILEAGE_TRIP_COORDS = 'true';
    const conn = jest.fn(() => { throw new Error('db down'); });
    await expect(fillRecentTripCoordinates(conn, { now: NOW })).resolves.toMatchObject({ skipped: 'error' });
    await expect(fillTripCoordinatesForTrip(conn, 't1')).resolves.toMatchObject({ skipped: 'error' });
  });
});

describe('helpers', () => {
  test('groupRows keeps vehicles apart and cuts a vehicle into 7-day groups', () => {
    const rows = [
      { id: 1, vehicle_id: 'a', trip_date: '2026-10-01' },
      { id: 2, vehicle_id: 'a', trip_date: new Date('2026-10-06T00:00:00Z') },
      { id: 3, vehicle_id: 'a', trip_date: '2026-10-09' },
      { id: 4, vehicle_id: 'b', trip_date: '2026-10-02' },
    ];
    const groups = groupRows(rows);
    expect(groups.map((g) => [g.vehicle, g.firstDay, g.lastDay, g.rows.length])).toEqual([
      ['a', '2026-10-01', '2026-10-06', 2], ['a', '2026-10-09', '2026-10-09', 1], ['b', '2026-10-02', '2026-10-02', 1],
    ]);
  });

  test('fillsFor returns only the missing pairs', () => {
    const logged = { startLat: 1, startLng: 2, endLat: 3, endLng: 4 };
    expect(fillsFor(trip(1, 't'), logged)).toEqual({
      start: { start_lat: 1, start_lng: 2 }, end: { end_lat: 3, end_lng: 4 },
    });
    expect(fillsFor(trip(1, 't', { end_lat: 9, end_lng: 9 }), logged)).toEqual({ start: { start_lat: 1, start_lng: 2 } });
  });
});
