jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn().mockResolvedValue(false) };
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const bouncie = require('../services/bouncie');

describe('Bouncie REST normalization helpers', () => {
  test('chunks trip pulls into Bouncie one-week windows', () => {
    expect(bouncie._test.dateChunks('2026-05-01', '2026-05-14')).toEqual([
      ['2026-05-01', '2026-05-07'],
      ['2026-05-08', '2026-05-14'],
    ]);
  });

  test('builds Bouncie trip query windows from Eastern business dates', () => {
    expect(bouncie._test.etDateChunkWindow('2026-05-01', '2026-05-07')).toEqual({
      startsAfter: '2026-05-01T04:00:00.000Z',
      endsBefore: '2026-05-08T03:59:59.000Z',
    });
  });

  test('normalizes REST trip distance from meters to miles', () => {
    expect(bouncie._test.normalizeRestTrip({
      transactionId: 'txn-1',
      startTime: '2026-05-05T12:00:00.000Z',
      endTime: '2026-05-05T12:10:00.000Z',
      distance: 1609.344,
    }, 'imei-1')).toMatchObject({
      tripId: 'txn-1',
      distance: 1609.344,
      distanceMeters: 1609.344,
      distanceMiles: 1,
      durationSeconds: 600,
      durationMinutes: 10,
    });
  });

  test('extracts start and end locations from GeoJSON GPS routes', () => {
    expect(bouncie._test.routeEndpointsFromGps({
      type: 'LineString',
      coordinates: [
        [-82.1, 27.1],
        [-82.2, 27.2],
      ],
    })).toEqual({
      start: { lon: -82.1, lng: -82.1, lat: 27.1 },
      end: { lon: -82.2, lng: -82.2, lat: 27.2 },
    });
  });
});
