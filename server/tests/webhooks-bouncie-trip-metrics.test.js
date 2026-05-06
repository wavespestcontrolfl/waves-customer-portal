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
jest.mock('../services/bouncie-webhook-security', () => ({
  inspectBouncieWebhook: jest.fn(),
  stringifyBounciePayload: jest.fn((payload) => JSON.stringify(payload)),
}));

const db = require('../models/db');
const mileageService = require('../services/bouncie-mileage');
const { pingTechLocation } = require('../services/tech-status');
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
        distance: 1609.34,
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
        distance: 1609.34,
        duration: 600,
      }),
    });
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });
});
