jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../services/bouncie-mileage', () => ({
  processTripWebhook: jest.fn().mockResolvedValue({ id: 'trip-1' }),
}));
jest.mock('../services/tech-status', () => ({
  pingTechLocation: jest.fn(),
}));
jest.mock('../services/gps-arrival-detector', () => ({
  maybeMarkArrivedFromGps: jest.fn(),
}));
jest.mock('../services/truck-clock-in', () => ({
  maybeClockInFromTruck: jest.fn(),
}));
jest.mock('../services/bouncie-webhook-security', () => ({
  inspectBouncieWebhook: jest.fn(),
  stringifyBounciePayload: jest.fn((payload) => JSON.stringify(payload)),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { pingTechLocation } = require('../services/tech-status');
const gpsArrivalDetector = require('../services/gps-arrival-detector');
const truckClockIn = require('../services/truck-clock-in');
const { inspectBouncieWebhook } = require('../services/bouncie-webhook-security');
const router = require('../routes/webhooks-bouncie');

const TECH = { id: '00000000-0000-4000-8000-000000000001', name: 'Tech Alpha', bouncie_imei: 'imei-1', active: true };
const TECH_STATUS = { tech_id: TECH.id, current_job_id: 'svc-1', lat: 27.3, lng: -82.5 };
const PAYLOAD = {
  eventType: 'tripData',
  imei: 'imei-1',
  data: [{ timestamp: '2026-10-25T13:00:00.000Z', gps: { lat: 27.3, lon: -82.5 }, speed: 0 }],
};

function tableMock({ first, update } = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(first),
    update: jest.fn().mockResolvedValue(update ?? 1),
  };
}

describe('Bouncie tracking webhook, truck clock-in hook', () => {
  let logUpdate;
  beforeEach(() => {
    jest.clearAllMocks();
    db.raw = jest.fn().mockResolvedValue({});
    logUpdate = tableMock();
    db.mockReturnValueOnce(tableMock({ first: TECH })).mockReturnValueOnce(logUpdate);
    pingTechLocation.mockResolvedValue(TECH_STATUS);
    gpsArrivalDetector.maybeMarkArrivedFromGps.mockResolvedValue({ ok: true, arrivalMarked: true, serviceId: 'svc-1' });
    truckClockIn.maybeClockInFromTruck.mockResolvedValue({ action: 'recorded' });
  });

  test('runs after the arrival detector and receives its result, the tech and the event type', async () => {
    const order = [];
    gpsArrivalDetector.maybeMarkArrivedFromGps.mockImplementation(async () => {
      order.push('detector');
      return { ok: true, arrivalMarked: true, serviceId: 'svc-1' };
    });
    truckClockIn.maybeClockInFromTruck.mockImplementation(async () => { order.push('truck'); });

    await router._test.processTrackingEvent({ logId: 7, eventType: 'tripData', payload: PAYLOAD });

    expect(order).toEqual(['detector', 'truck']);
    expect(truckClockIn.maybeClockInFromTruck).toHaveBeenCalledWith({
      tech: TECH,
      eventType: 'trip-data',
      point: expect.objectContaining({ lat: 27.3, lng: -82.5 }),
      arrival: { ok: true, arrivalMarked: true, serviceId: 'svc-1' },
      logId: 7,
    });
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('a trip-start passes its event type through', async () => {
    await router._test.processTrackingEvent({
      logId: 8,
      eventType: 'tripStart',
      payload: { eventType: 'tripStart', imei: 'imei-1', start: { timestamp: '2026-10-25T12:30:00.000Z', gps: { lat: 27.4331, lon: -82.4057 } } },
    });
    expect(truckClockIn.maybeClockInFromTruck).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'trip-start' }));
  });

  test('a thrown error in the hook is logged, leaves the detector result intact and the event processed', async () => {
    truckClockIn.maybeClockInFromTruck.mockRejectedValue(new Error('shadow table missing'));

    await expect(router._test.processTrackingEvent({ logId: 9, eventType: 'tripData', payload: PAYLOAD })).resolves.toBeUndefined();

    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('truck clock-in failed: shadow table missing'));
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
    expect(logUpdate.update).not.toHaveBeenCalledWith(expect.objectContaining({ error: expect.anything() }));
  });

  test('a detector failure still reaches the hook (arrival null) and does not skip it', async () => {
    gpsArrivalDetector.maybeMarkArrivedFromGps.mockRejectedValue(new Error('detector down'));

    await router._test.processTrackingEvent({ logId: 10, eventType: 'tripData', payload: PAYLOAD });

    expect(truckClockIn.maybeClockInFromTruck).toHaveBeenCalledWith(expect.objectContaining({ arrival: null }));
  });

  test('the POST handler still answers 200 when the hook throws', async () => {
    truckClockIn.maybeClockInFromTruck.mockRejectedValue(new Error('boom'));
    inspectBouncieWebhook.mockReturnValue({ accepted: true, matched: true, from: 'test' });
    db.mockReset();
    db.raw = jest.fn().mockResolvedValue({});
    const insertChain = {
      insert: jest.fn().mockReturnThis(),
      onConflict: jest.fn().mockReturnThis(),
      ignore: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 11 }]),
    };
    const logUpdate2 = tableMock();
    db
      .mockReturnValueOnce(insertChain)
      .mockReturnValueOnce(tableMock({ first: TECH }))
      .mockReturnValueOnce(logUpdate2);

    const layer = router.stack.find((l) => l.route && l.route.path === '/' && l.route.methods.post);
    const handler = layer.route.stack[0].handle;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await handler({ headers: {}, body: PAYLOAD }, res);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true });
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).toHaveBeenCalledTimes(1);
    expect(truckClockIn.maybeClockInFromTruck).toHaveBeenCalledTimes(1);
  });
});
