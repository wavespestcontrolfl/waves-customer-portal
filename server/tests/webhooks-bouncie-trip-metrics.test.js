jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/bouncie-mileage', () => ({
  processTripWebhook: jest.fn().mockResolvedValue({ id: 'trip-1' }),
}));
jest.mock('../services/tech-status', () => ({
  pingTechLocation: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/gps-arrival-detector', () => ({
  maybeMarkArrivedFromGps: jest.fn().mockResolvedValue({ ok: false, reason: 'no_current_job' }),
}));
jest.mock('../services/bouncie-webhook-security', () => ({
  inspectBouncieWebhook: jest.fn(),
  stringifyBounciePayload: jest.fn((payload) => JSON.stringify(payload)),
}));

const db = require('../models/db');
const mileageService = require('../services/bouncie-mileage');
const { pingTechLocation } = require('../services/tech-status');
const gpsArrivalDetector = require('../services/gps-arrival-detector');
const router = require('../routes/webhooks-bouncie');

function tableMock({ first, update } = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(first),
    update: jest.fn().mockResolvedValue(update ?? 1),
  };
}

describe('Bouncie tracking webhook trip-metrics processing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn().mockResolvedValue({});
  });

  test('persists trip-metrics through the mileage writer without requiring lat/lng', async () => {
    const technicianLookup = tableMock({
      first: { id: 'tech-1', name: 'Tech One', bouncie_imei: 'imei-1', active: true },
    });
    const logUpdate = tableMock();
    db
      .mockReturnValueOnce(technicianLookup)
      .mockReturnValueOnce(logUpdate);

    await router._test.processTrackingEvent({
      logId: 42,
      eventType: 'trip-metrics',
      payload: {
        imei: 'imei-1',
        tripId: 'trip-123',
        startTime: '2026-05-05T12:00:00.000Z',
        distanceMiles: 3.2,
        durationMinutes: 14,
      },
    });

    expect(mileageService.processTripWebhook).toHaveBeenCalledWith({
      eventType: 'tripCompleted',
      imei: 'imei-1',
      data: expect.objectContaining({
        imei: 'imei-1',
        vehicleId: 'imei-1',
        transactionId: 'trip-123',
        startTime: '2026-05-05T12:00:00.000Z',
        distance: expect.closeTo(5149.91, 1),
        duration: 840,
      }),
    });
    expect(pingTechLocation).not.toHaveBeenCalled();
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('persists official tripMetrics payloads from Bouncie docs', async () => {
    const technicianLookup = tableMock({
      first: { id: 'tech-1', name: 'Tech One', bouncie_imei: 'imei-1', active: true },
    });
    const logUpdate = tableMock();
    db
      .mockReturnValueOnce(technicianLookup)
      .mockReturnValueOnce(logUpdate);

    await router._test.processTrackingEvent({
      logId: 47,
      eventType: 'tripMetrics',
      payload: {
        eventType: 'tripMetrics',
        imei: 'imei-1',
        transactionId: 'txn-docs-1',
        metrics: {
          timestamp: '2026-05-05T13:00:00.000Z',
          tripTime: 1800,
          tripDistance: 12.5,
          totalIdlingTime: 300,
          maxSpeed: 65,
          averageDriveSpeed: 35.5,
          hardBrakingCounts: 2,
          hardAccelerationCounts: 1,
        },
      },
    });

    expect(mileageService.processTripWebhook).toHaveBeenCalledWith({
      eventType: 'tripCompleted',
      imei: 'imei-1',
      data: expect.objectContaining({
        transactionId: 'txn-docs-1',
        distanceMiles: 12.5,
        distance: expect.closeTo(20116.8, 1),
        duration: 1800,
        hardBrakes: 2,
        hardAccelerations: 1,
      }),
    });
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('marks metrics-only webhook processed when no distance or duration is present', async () => {
    const technicianLookup = tableMock({
      first: { id: 'tech-1', name: 'Tech One', bouncie_imei: 'imei-1', active: true },
    });
    const logUpdate = tableMock();
    db
      .mockReturnValueOnce(technicianLookup)
      .mockReturnValueOnce(logUpdate);

    await router._test.processTrackingEvent({
      logId: 43,
      eventType: 'trip-metrics',
      payload: { imei: 'imei-1', tripId: 'trip-empty' },
    });

    expect(mileageService.processTripWebhook).not.toHaveBeenCalled();
    expect(pingTechLocation).not.toHaveBeenCalled();
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('skips mileage write for metrics without stable trip id', async () => {
    const technicianLookup = tableMock({
      first: { id: 'tech-1', name: 'Tech One', bouncie_imei: 'imei-1', active: true },
    });
    const logUpdate = tableMock();
    db
      .mockReturnValueOnce(technicianLookup)
      .mockReturnValueOnce(logUpdate);

    await router._test.processTrackingEvent({
      logId: 46,
      eventType: 'trip-metrics',
      payload: { imei: 'imei-1', distanceMiles: 1.2, durationMinutes: 6 },
    });

    expect(mileageService.processTripWebhook).not.toHaveBeenCalled();
    expect(pingTechLocation).not.toHaveBeenCalled();
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('records unknown IMEI on the webhook log without processing metrics', async () => {
    const technicianLookup = tableMock({ first: null });
    const logUpdate = tableMock();
    db
      .mockReturnValueOnce(technicianLookup)
      .mockReturnValueOnce(logUpdate);

    await router._test.processTrackingEvent({
      logId: 44,
      eventType: 'trip-metrics',
      payload: { imei: 'missing-imei', distanceMiles: 1, durationMinutes: 5 },
    });

    expect(mileageService.processTripWebhook).not.toHaveBeenCalled();
    expect(logUpdate.update).toHaveBeenCalledWith({
      processed: true,
      error: 'unknown IMEI missing-imei',
    });
  });

  test('normalizes metric payloads from nested data objects', () => {
    expect(router._test.normalizeTripMetricsPayload({
      data: {
        vehicle_id: 'vehicle-1',
        transaction_id: 'txn-1',
        distance_meters: 1609.34,
        duration_seconds: 600,
      },
    }, 'imei-1')).toEqual({
      eventType: 'tripCompleted',
      imei: 'imei-1',
      data: expect.objectContaining({
        imei: 'imei-1',
        vehicleId: 'vehicle-1',
        transactionId: 'txn-1',
        distance: expect.closeTo(1609.34, 1),
        duration: 600,
      }),
    });
  });

  test('does not normalize metric payloads without a stable trip id', () => {
    expect(router._test.normalizeTripMetricsPayload({
      imei: 'imei-1',
      distanceMiles: 1.2,
      durationMinutes: 6,
    }, 'imei-1')).toBeNull();
  });

  test('resolves nested vehicle_id before processing trip-metrics', async () => {
    const technicianLookup = tableMock({
      first: { id: 'tech-1', name: 'Tech One', bouncie_imei: 'vehicle-1', active: true },
    });
    const logUpdate = tableMock();
    db
      .mockReturnValueOnce(technicianLookup)
      .mockReturnValueOnce(logUpdate);

    await router._test.processTrackingEvent({
      logId: 45,
      eventType: 'trip-metrics',
      payload: {
        data: {
          vehicle_id: 'vehicle-1',
          transaction_id: 'txn-1',
          distance_meters: 1609.34,
          duration_seconds: 600,
        },
      },
    });

    expect(technicianLookup.where).toHaveBeenCalledWith({ bouncie_imei: 'vehicle-1' });
    expect(mileageService.processTripWebhook).toHaveBeenCalledWith({
      eventType: 'tripCompleted',
      imei: 'vehicle-1',
      data: expect.objectContaining({
        imei: 'vehicle-1',
        vehicleId: 'vehicle-1',
        transactionId: 'txn-1',
        distance: expect.closeTo(1609.34, 1),
        duration: 600,
      }),
    });
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('updates live location from official tripData nested gps samples', async () => {
    const techStatus = {
      tech_id: 'tech-1',
      status: 'en_route',
      current_job_id: 'svc-1',
      lat: 27.2,
      lng: -82.2,
    };
    pingTechLocation.mockResolvedValueOnce(techStatus);
    const technicianLookup = tableMock({
      first: { id: 'tech-1', name: 'Tech One', bouncie_imei: 'imei-1', active: true },
    });
    const logUpdate = tableMock();
    db
      .mockReturnValueOnce(technicianLookup)
      .mockReturnValueOnce(logUpdate);

    await router._test.processTrackingEvent({
      logId: 48,
      eventType: 'tripData',
      payload: {
        eventType: 'tripData',
        imei: 'imei-1',
        transactionId: 'txn-live-1',
        data: [
          {
            timestamp: '2026-05-05T12:00:00.000Z',
            speed: 12,
            gps: { lat: 27.1, lon: -82.1, heading: 90 },
          },
          {
            timestamp: '2026-05-05T12:02:00.000Z',
            speed: 18,
            gps: { lat: 27.2, lon: -82.2, heading: 100 },
          },
        ],
      },
    });

    expect(db.raw).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO vehicle_locations'), expect.arrayContaining([
      'imei-1',
      27.2,
      -82.2,
      100,
      18,
      null,
    ]));
    expect(db.raw.mock.calls[0][0]).toContain('EXCLUDED.reported_at >= vehicle_locations.reported_at');
    expect(db.raw.mock.calls[0][0]).toContain('ELSE vehicle_locations.lat');
    expect(pingTechLocation).toHaveBeenCalledWith(expect.objectContaining({
      tech_id: 'tech-1',
      lat: 27.2,
      lng: -82.2,
      speed_mph: 18,
    }));
    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).toHaveBeenCalledWith({
      techStatus,
      point: expect.objectContaining({
        lat: 27.2,
        lng: -82.2,
        speed_mph: 18,
      }),
    });
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('clamps live location timestamps that are too far in the future', () => {
    const now = new Date('2026-05-05T12:00:00.000Z');
    expect(router._test.normalizeLocationReportedAt('2026-05-05T12:01:59.000Z', now))
      .toEqual(new Date('2026-05-05T12:01:59.000Z'));
    expect(router._test.normalizeLocationReportedAt('2026-05-05T12:02:01.000Z', now))
      .toBe(now);
    expect(router._test.normalizeLocationReportedAt('not-a-date', now))
      .toBe(now);
  });
});
