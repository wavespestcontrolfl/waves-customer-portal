const {
  eventTypeFromPayload,
  extractImei,
  normalizeTripMetricsPayload,
  pointFromPayload,
  tripIdentity,
  webhookDedupeKey,
} = require('../services/bouncie-payload');

describe('Bouncie payload normalization', () => {
  test('normalizes official event names to internal routing names', () => {
    expect(eventTypeFromPayload({ eventType: 'tripData' })).toBe('trip-data');
    expect(eventTypeFromPayload({ eventType: 'tripMetrics' })).toBe('trip-metrics');
    expect(eventTypeFromPayload({ eventType: 'tripStart' })).toBe('trip-start');
    expect(eventTypeFromPayload({ eventType: 'tripEnd' })).toBe('trip-end');
    expect(eventTypeFromPayload({ eventType: 'userGeozone' })).toBe('userGeozone');
  });

  test('extracts IMEI from official top-level payloads', () => {
    expect(extractImei({ eventType: 'tripData', imei: '123456789012345', data: [] })).toBe('123456789012345');
  });

  test('picks latest official tripData gps sample', () => {
    expect(pointFromPayload({
      eventType: 'tripData',
      imei: 'imei-1',
      data: [
        {
          timestamp: '2026-05-05T12:00:00.000Z',
          speed: 4,
          gps: { lat: 27.1, lon: -82.1, heading: 45 },
        },
        {
          timestamp: '2026-05-05T12:01:00.000Z',
          speed: 22,
          gps: { lat: 27.2, lon: -82.2, heading: 90 },
        },
      ],
    }, 'trip-data')).toEqual({
      lat: 27.2,
      lng: -82.2,
      heading: 90,
      speed_mph: 22,
      ignition: null,
      reported_at: '2026-05-05T12:01:00.000Z',
    });
  });

  test('normalizes official tripMetrics miles and seconds', () => {
    expect(normalizeTripMetricsPayload({
      eventType: 'tripMetrics',
      imei: 'imei-1',
      transactionId: 'txn-1',
      metrics: {
        timestamp: '2026-05-05T12:30:00.000Z',
        tripTime: 1800,
        tripDistance: 12.5,
        totalIdlingTime: 300,
        maxSpeed: 65,
        averageDriveSpeed: 35.5,
        hardBrakingCounts: 2,
        hardAccelerationCounts: 1,
      },
    })).toEqual({
      eventType: 'tripCompleted',
      imei: 'imei-1',
      data: expect.objectContaining({
        transactionId: 'txn-1',
        distanceMiles: 12.5,
        distance: expect.closeTo(20116.8, 1),
        duration: 1800,
        idleTime: 300,
        hardBrakes: 2,
        hardAccelerations: 1,
      }),
    });
  });

  test('scopes webhook dedupe keys by receiver namespace', () => {
    const payload = {
      eventType: 'tripData',
      imei: 'imei-1',
      transactionId: 'txn-1',
      data: [{ timestamp: '2026-05-05T12:00:00.000Z', gps: { lat: 27.1, lon: -82.1 } }],
    };

    expect(webhookDedupeKey(payload, 'trip-data', 'bouncie-mileage-geofence'))
      .not.toBe(webhookDedupeKey(payload, 'trip-data', 'bouncie-live-tracking'));
    expect(webhookDedupeKey(payload, 'trip-data', 'bouncie-live-tracking'))
      .toBe(webhookDedupeKey(payload, 'trip-data', 'bouncie-live-tracking'));
  });

  test('reads the trip identity from the same fields the dedupe key uses', () => {
    expect(tripIdentity({ transactionId: 'txn-1' })).toBe('txn-1');
    expect(tripIdentity({ transaction_id: 'txn-2' })).toBe('txn-2');
    expect(tripIdentity({ tripId: 'trip-3' })).toBe('trip-3');
    expect(tripIdentity({ trip_id: 4 })).toBe('4');
    expect(tripIdentity({ transactionId: '', tripId: 'trip-5' })).toBe('trip-5');
    expect(tripIdentity({ eventType: 'tripStart', imei: 'imei-1' })).toBeNull();
    expect(tripIdentity()).toBeNull();
  });
});
