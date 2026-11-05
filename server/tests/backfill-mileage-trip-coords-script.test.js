// The backfill script: dry run by default (counts, writes nothing), --apply needs the gate, idempotent.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { makeFakeDb } = require('./helpers/mileage-coords-fake-db');
const { main, parseArgs } = require('../scripts/backfill-mileage-trip-coords');

const T0 = Date.parse('2026-10-08T14:00:00Z');
const sample = (min, lat, lng) => ({ timestamp: new Date(T0 + min * 60000).toISOString(), gps: { lat, lon: lng } });
const fixture = () => makeFakeDb({
  mileage: [
    { id: 1, vehicle_id: 'imei-1', bouncie_trip_id: 't1', source: 'bouncie', trip_date: '2026-10-08', start_lat: null, start_lng: null, end_lat: null, end_lng: null },
    { id: 2, vehicle_id: 'imei-1', bouncie_trip_id: 'lost', source: 'bouncie', trip_date: '2026-10-08', start_lat: null, start_lng: null, end_lat: null, end_lng: null },
  ],
  log: [{
    id: 1, vehicle_imei: 'imei-1', event_type: 'trip-data', received_at: new Date(T0 + 60000),
    payload: JSON.stringify({ transactionId: 't1', data: [sample(0, 27.4, -82.5), sample(9, 27.5, -82.6)] }),
  }],
});

let logSpy;
beforeEach(() => { logSpy = jest.spyOn(console, 'log').mockImplementation(() => {}); delete process.env.GATE_MILEAGE_TRIP_COORDS; });
afterEach(() => { logSpy.mockRestore(); delete process.env.GATE_MILEAGE_TRIP_COORDS; });

test('dry run prints counts and writes nothing, even with the gate off', async () => {
  const conn = fixture();
  const { result, text } = await main([], conn);
  expect(result).toMatchObject({ candidates: 2, rowsFilled: 1, noPoints: 1 });
  expect(text).toMatch(/DRY RUN/);
  expect(text).toMatch(/would be filled: 1/);
  expect(text).toMatch(/Re-run with --apply/);
  expect(conn.tables.mileage_log.every((row) => row.start_lat == null)).toBe(true);
});

test('--apply without the gate writes nothing and says so', async () => {
  const conn = fixture();
  const { text } = await main(['--apply'], conn);
  expect(text).toMatch(/GATE_MILEAGE_TRIP_COORDS is not "true"/);
  expect(conn.tables.mileage_log[0].start_lat).toBeNull();
});

test('--apply with the gate on fills once and a second run finds nothing to fill', async () => {
  process.env.GATE_MILEAGE_TRIP_COORDS = 'true';
  const conn = fixture();
  const first = await main(['--apply', '--since', '2026-05-01', '--batch', '1'], conn);
  expect(first.result).toMatchObject({ rowsFilled: 1, startFilled: 1, endFilled: 1 });
  expect(conn.tables.mileage_log[0]).toMatchObject({ start_lat: 27.4, end_lat: 27.5 });
  const second = await main(['--apply'], conn);
  expect(second.result).toMatchObject({ candidates: 1, rowsFilled: 0, noPoints: 1 });
});

test('bad arguments are refused', () => {
  expect(() => parseArgs(['--since', 'May'])).toThrow(/--since/);
  expect(() => parseArgs(['--batch', '0'])).toThrow(/--batch/);
  expect(parseArgs([])).toEqual({ apply: false, sinceDate: null, batchSize: 300 });
});
