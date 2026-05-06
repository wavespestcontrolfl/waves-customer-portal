jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/bouncie-mileage', () => ({
  processTripWebhook: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/geofence-handler', () => ({
  handleGeozoneEvent: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/bouncie-webhook-security', () => ({
  inspectBouncieWebhook: jest.fn().mockReturnValue({
    accepted: true,
    matched: true,
    reason: 'matched',
    mode: 'enforce',
  }),
  stringifyBounciePayload: jest.fn((payload) => JSON.stringify(payload)),
}));

const db = require('../models/db');
const mileageService = require('../services/bouncie-mileage');
const geofenceHandler = require('../services/geofence-handler');
const webhookSecurity = require('../services/bouncie-webhook-security');
const router = require('../routes/bouncie-webhook');

function insertMock(row = { id: 99 }) {
  return {
    insert: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([row]),
  };
}

function updateMock() {
  return {
    where: jest.fn().mockReturnThis(),
    update: jest.fn().mockResolvedValue(1),
  };
}

function resMock() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  };
}

describe('legacy Bouncie webhook ignored events', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    webhookSecurity.inspectBouncieWebhook.mockReturnValue({
      accepted: true,
      matched: true,
      reason: 'matched',
      mode: 'enforce',
    });
  });

  test('marks intentionally ignored event logs processed', async () => {
    const insert = insertMock({ id: 42 });
    const update = updateMock();
    db
      .mockReturnValueOnce(insert)
      .mockReturnValueOnce(update);

    const res = resMock();
    await router._test.handleBouncieWebhook({
      body: {
        eventType: 'trip-data',
        data: { vehicle_id: 'imei-1' },
      },
    }, res);

    expect(insert.insert).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'trip-data',
      vehicle_imei: 'imei-1',
      processed: false,
    }));
    expect(update.where).toHaveBeenCalledWith('id', 42);
    expect(update.update).toHaveBeenCalledWith({ processed: true });
    expect(mileageService.processTripWebhook).not.toHaveBeenCalled();
    expect(geofenceHandler.handleGeozoneEvent).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  test('extracts nested vehicle ids consistently', () => {
    expect(router._test.extractImei({ data: { vehicle_id: 'nested-vehicle' } })).toBe('nested-vehicle');
    expect(router._test.extractImei({ data: { deviceId: 'nested-device' } })).toBe('nested-device');
    expect(router._test.extractImei({ vehicle_id: 'top-vehicle' })).toBe('top-vehicle');
  });

  test('still rejects invalid webhook signatures without logging', async () => {
    webhookSecurity.inspectBouncieWebhook.mockReturnValue({
      accepted: false,
      matched: false,
      reason: 'missing',
      mode: 'enforce',
    });

    const res = resMock();
    await router._test.handleBouncieWebhook({ body: { eventType: 'trip-data' } }, res);

    expect(db).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ ok: false });
  });
});
