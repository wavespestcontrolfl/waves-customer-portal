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
      payload: PAYLOAD,
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

// GATE_ARRIVAL_ENGINE_OFF (owner 2026-11-01): a trip-end is the engine-off arrival event.
describe('Bouncie tracking webhook, engine-off arrival (GATE_ARRIVAL_ENGINE_OFF)', () => {
  const ENDED_AT = '2026-11-02T15:00:00.000Z';
  const msBefore = (ms) => new Date(Date.parse(ENDED_AT) - ms).toISOString();
  const TRIP_END_NO_GPS = { eventType: 'tripEnd', imei: 'imei-1', transactionId: 't-1', end: { timestamp: ENDED_AT, timeZone: 'America/New_York', odometer: 100, fuelConsumed: 1 } };
  const TRIP_END_WITH_GPS = { ...TRIP_END_NO_GPS, end: { ...TRIP_END_NO_GPS.end, gps: { lat: 27.51, lon: -82.52, speed: 4 } } };
  let logUpdate;
  let tables;

  function installDb({ lastLocation = null, lastLocationError = null } = {}) {
    logUpdate = tableMock();
    tables = {
      technicians: tableMock({ first: TECH }),
      vehicle_locations: lastLocationError
        ? { where: jest.fn().mockReturnThis(), first: jest.fn().mockRejectedValue(lastLocationError) }
        : tableMock({ first: lastLocation }),
      tech_status: tableMock({ first: TECH_STATUS }),
      bouncie_webhook_log: logUpdate,
    };
    db.mockReset();
    db.mockImplementation((table) => tables[table]);
    db.raw = jest.fn().mockResolvedValue({});
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_ARRIVAL_ENGINE_OFF = 'true';
    pingTechLocation.mockResolvedValue(TECH_STATUS);
    gpsArrivalDetector.maybeMarkArrivedFromGps.mockResolvedValue({ ok: true, arrivalMarked: true, serviceId: 'svc-1' });
    truckClockIn.maybeClockInFromTruck.mockResolvedValue({ action: 'recorded' });
  });

  afterAll(() => {
    delete process.env.GATE_ARRIVAL_ENGINE_OFF;
  });

  test('a trip-end with no GPS uses the fresh last location, and clock-in gets the arrival from that call', async () => {
    installDb({ lastLocation: { lat: '27.4386000', lng: '-82.3719000', heading: 90, reported_at: msBefore(4 * 60 * 1000) } });

    await router._test.processTrackingEvent({ logId: 21, eventType: 'tripEnd', payload: TRIP_END_NO_GPS });

    const expectedPoint = {
      lat: '27.4386000', lng: '-82.3719000', heading: 90, ignition: false, speed_mph: 0, reported_at: ENDED_AT,
      engine_off: true, position_source: 'last_location', last_location_gap_s: 240,
    };
    expect(tables.vehicle_locations.where).toHaveBeenCalledWith({ bouncie_imei: 'imei-1' });
    // Stored coordinates reused exactly: the tech marker does not move.
    expect(pingTechLocation).toHaveBeenCalledWith(expect.objectContaining({
      tech_id: TECH.id, lat: '27.4386000', lng: '-82.3719000', ignition: false, speed_mph: 0, reported_at: ENDED_AT,
    }));
    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).toHaveBeenCalledWith({ techStatus: TECH_STATUS, point: expectedPoint });
    expect(truckClockIn.maybeClockInFromTruck).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'trip-end',
      point: expectedPoint,
      arrival: { ok: true, arrivalMarked: true, serviceId: 'svc-1' },
      logId: 21,
    }));
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('a trip-end with its own GPS uses it as the engine-off position', async () => {
    installDb({ lastLocation: { lat: 1, lng: 2, reported_at: msBefore(60 * 1000) } });

    await router._test.processTrackingEvent({ logId: 22, eventType: 'tripEnd', payload: TRIP_END_WITH_GPS });

    expect(tables.vehicle_locations.first).not.toHaveBeenCalled();
    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).toHaveBeenCalledWith({
      techStatus: TECH_STATUS,
      point: expect.objectContaining({
        lat: 27.51, lng: -82.52, ignition: false, speed_mph: 0, reported_at: ENDED_AT,
        engine_off: true, position_source: 'trip_end_gps', last_location_gap_s: null,
      }),
    });
    expect(truckClockIn.maybeClockInFromTruck).toHaveBeenCalledWith(expect.objectContaining({
      arrival: { ok: true, arrivalMarked: true, serviceId: 'svc-1' },
    }));
  });

  test.each([
    ['older than 10 minutes before the trip-end', msBefore(10 * 60 * 1000 + 1000), 601],
    ['after the trip-end', new Date(Date.parse(ENDED_AT) + 5000).toISOString(), -5],
  ])('a last location %s is not used: only the no-position diagnostic runs', async (_label, reportedAt, gapSeconds) => {
    installDb({ lastLocation: { lat: '27.4386000', lng: '-82.3719000', heading: 0, reported_at: reportedAt } });

    await router._test.processTrackingEvent({ logId: 23, eventType: 'tripEnd', payload: TRIP_END_NO_GPS });

    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).toHaveBeenCalledTimes(1);
    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).toHaveBeenCalledWith({
      techStatus: TECH_STATUS,
      point: {
        ignition: false, speed_mph: 0, reported_at: ENDED_AT, engine_off: true, position_source: null, last_location_gap_s: gapSeconds,
      },
    });
    expect(pingTechLocation).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    expect(truckClockIn.maybeClockInFromTruck).not.toHaveBeenCalled();
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('no last location row, or a failed lookup, is engine_off_no_position input too (and never throws)', async () => {
    installDb({ lastLocation: undefined });
    await router._test.processTrackingEvent({ logId: 24, eventType: 'tripEnd', payload: TRIP_END_NO_GPS });
    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).toHaveBeenLastCalledWith({
      techStatus: TECH_STATUS,
      point: expect.objectContaining({ engine_off: true, position_source: null, last_location_gap_s: null }),
    });

    installDb({ lastLocationError: new Error('pg down') });
    await expect(router._test.processTrackingEvent({ logId: 25, eventType: 'tripEnd', payload: TRIP_END_NO_GPS })).resolves.toBeUndefined();
    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('last location lookup failed: pg down'));
    expect(truckClockIn.maybeClockInFromTruck).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', { ...TRIP_END_NO_GPS, end: { timeZone: 'America/New_York', odometer: 100, fuelConsumed: 1 } }],
    ['malformed', { ...TRIP_END_NO_GPS, end: { ...TRIP_END_NO_GPS.end, timestamp: 'not-a-date' } }],
  ])('a trip-end with a %s timestamp is never an engine-off: no last-location read, no detector call', async (_label, payload) => {
    installDb({ lastLocation: { lat: '27.4386000', lng: '-82.3719000', heading: 0, reported_at: new Date().toISOString() } });

    await router._test.processTrackingEvent({ logId: 29, eventType: 'tripEnd', payload });

    expect(tables.vehicle_locations.first).not.toHaveBeenCalled();
    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).not.toHaveBeenCalled();
    expect(pingTechLocation).not.toHaveBeenCalled();
    expect(truckClockIn.maybeClockInFromTruck).not.toHaveBeenCalled();
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('a trip-end with its own GPS but a malformed timestamp keeps the payload point (no engine-off marker)', async () => {
    installDb();
    const payload = { ...TRIP_END_WITH_GPS, end: { ...TRIP_END_WITH_GPS.end, timestamp: 'not-a-date' } };

    await router._test.processTrackingEvent({ logId: 30, eventType: 'tripEnd', payload });

    const { point } = gpsArrivalDetector.maybeMarkArrivedFromGps.mock.calls[0][0];
    expect(point).toEqual(expect.objectContaining({ lat: 27.51, lng: -82.52, speed_mph: 4, ignition: null }));
    expect(point.engine_off).toBeUndefined();
  });

  test('a trip-data sample is untouched by the gate (same point, no engine-off marker, no last-location read)', async () => {
    installDb({ lastLocation: { lat: 1, lng: 2, reported_at: ENDED_AT } });

    await router._test.processTrackingEvent({ logId: 26, eventType: 'tripData', payload: PAYLOAD });

    expect(tables.vehicle_locations.first).not.toHaveBeenCalled();
    const { point } = gpsArrivalDetector.maybeMarkArrivedFromGps.mock.calls[0][0];
    expect(point).toEqual(expect.objectContaining({ lat: 27.3, lng: -82.5 }));
    expect(point.engine_off).toBeUndefined();
  });

  test('gate off: a trip-end with no GPS does nothing, exactly as before (no read, no detector call)', async () => {
    delete process.env.GATE_ARRIVAL_ENGINE_OFF;
    installDb({ lastLocation: { lat: '27.4386000', lng: '-82.3719000', reported_at: msBefore(60 * 1000) } });

    await router._test.processTrackingEvent({ logId: 27, eventType: 'tripEnd', payload: TRIP_END_NO_GPS });

    expect(tables.vehicle_locations.first).not.toHaveBeenCalled();
    expect(gpsArrivalDetector.maybeMarkArrivedFromGps).not.toHaveBeenCalled();
    expect(pingTechLocation).not.toHaveBeenCalled();
    expect(truckClockIn.maybeClockInFromTruck).not.toHaveBeenCalled();
    expect(logUpdate.update).toHaveBeenCalledWith({ processed: true });
  });

  test('gate off: a trip-end with its own GPS passes the payload point untouched (no engine-off marker)', async () => {
    delete process.env.GATE_ARRIVAL_ENGINE_OFF;
    installDb();

    await router._test.processTrackingEvent({ logId: 28, eventType: 'tripEnd', payload: TRIP_END_WITH_GPS });

    const { point } = gpsArrivalDetector.maybeMarkArrivedFromGps.mock.calls[0][0];
    expect(point).toEqual(expect.objectContaining({ lat: 27.51, lng: -82.52, speed_mph: 4, ignition: null }));
    expect(point.engine_off).toBeUndefined();
  });
});
