/**
 * Public reschedule link, GATE_RESCHEDULE_CAP_ALL (dark; security audit run 3,
 * owner 2026-11-05):
 *   1. one link commits at most 3 moves of a visit per ET day, every customer;
 *   2. a repeat move inside 15 minutes sends no notice of its own (the
 *      confirmation sweep sends one with the latest time);
 *   3. an unpinned visit address is geocoded once and the pin saved.
 *
 * Own file: it mocks routes/booking, services/rebooker, appointment-reminders
 * and the geocoder wholesale.
 */
const mockDb = jest.fn();
mockDb.raw = (sql) => sql;
mockDb.fn = { now: () => 'now()' };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));

const { etDateString, addETDays } = require('../utils/datetime-et');
const CONFIG = { advance_days_min: 1, advance_days_max: 14 };
const VISIT_DATE = etDateString(addETDays(new Date(), 20));
const TARGET_DATE = etDateString(addETDays(new Date(), 10));
const SLOT = { start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', end_label: '10:00 AM', technician_id: 'tech-1' };
const mockBuildBookingAvailability = jest.fn();
const mockResolveBookingCoords = jest.fn();
jest.mock('../routes/booking', () => ({
  _internals: {
    loadBookingConfig: jest.fn().mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 }),
    resolveBookingCoords: (...args) => mockResolveBookingCoords(...args),
    buildBookingAvailability: (...args) => mockBuildBookingAvailability(...args),
    normalizeBookingServiceKey: jest.fn(() => 'pest_control'),
    bookInsertionOffersLive: jest.fn(() => false),
  },
}));

const mockReschedule = jest.fn();
jest.mock('../services/rebooker', () => ({
  reschedule: (...args) => mockReschedule(...args),
  rescheduleSeries: jest.fn(),
}));
const mockHandleReschedule = jest.fn();
jest.mock('../services/appointment-reminders', () => ({
  handleReschedule: (...args) => mockHandleReschedule(...args),
}));
jest.mock('../services/owner-alerts', () => ({ recordOwnerAlert: jest.fn() }));
const mockEmitDispatchJobUpdate = jest.fn().mockResolvedValue(null);
jest.mock('../services/dispatch-assignment', () => ({
  emitDispatchJobUpdate: (...args) => mockEmitDispatchJobUpdate(...args),
}));
jest.mock('../services/reschedule-link-promises', () => ({ resolveUsedLink: jest.fn() }));
const mockGeocodeWithStatus = jest.fn();
jest.mock('../services/geocoder', () => ({
  geocodeAddressWithStatus: (...args) => mockGeocodeWithStatus(...args),
}));
const mockPersistServicePin = jest.fn();
const mockServiceRepairEnabled = jest.fn();
jest.mock('../services/geocoder-service-locations', () => ({
  SNAPSHOT_COLUMNS: ['id', 'lat', 'lng'],
  persistServicePin: (...args) => mockPersistServicePin(...args),
  serviceRepairEnabled: () => mockServiceRepairEnabled(),
}));

const express = require('express');
const reschedulePublicRouter = require('../routes/reschedule-public');
const TOKEN = 'a'.repeat(64);
let server;
let base;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api/public/reschedule', reschedulePublicRouter);
  app.use(require('../middleware/errors').errorHandler);
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

const svcRow = (overrides = {}) => ({
  id: 'svc-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: VISIT_DATE,
  window_start: '08:00', window_end: '09:00', service_type: 'Pest Control',
  is_recurring: false, visit_id: null, customer_deleted_at: null, cust_first_name: 'Pat',
  customer_active: true, latitude: 27.4, longitude: -82.4,
  ...overrides,
});

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
const pick = (createdAt, overrides = {}) => ({
  initiated_by: 'customer_self_serve',
  original_date: VISIT_DATE, new_date: TARGET_DATE,
  original_window: '08:00-09:00', new_window: '13:00-14:00',
  created_at: createdAt,
  ...overrides,
});

// scheduled_services answers .first() with the visit; reschedule_log honors
// the equality filter and the `created_at >= since` bound the code sends.
function wireDb({ svc = svcRow(), log = [] } = {}) {
  mockDb.mockImplementation((table) => {
    const eq = {};
    let since = null;
    const api = {};
    api.leftJoin = () => api;
    api.orderBy = () => api;
    api.where = (arg, op, val) => {
      if (arg && typeof arg === 'object') Object.assign(eq, arg);
      else if (op === '>=') since = val;
      return api;
    };
    api.first = async () => svc;
    api.select = async () => (table === 'reschedule_log'
      ? log.filter((row) => (!since || new Date(row.created_at) >= since) && row.initiated_by === eq.initiated_by)
      : []);
    return api;
  });
}

const postCommit = () => fetch(`${base}/api/public/reschedule/${TOKEN}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ date: TARGET_DATE, start_time: '09:00' }),
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GATE_RESCHEDULE_CAP_ALL;
  delete process.env.GATE_RESCHEDULE_MOVE_LIMITS;
  mockBuildBookingAvailability.mockResolvedValue({
    days: [{ date: TARGET_DATE, slots: [SLOT] }], slots: [SLOT], nearby: [],
  });
  mockResolveBookingCoords.mockResolvedValue({ lat: 27.4, lng: -82.4 });
  mockReschedule.mockResolvedValue({ originalDate: VISIT_DATE });
  mockHandleReschedule.mockResolvedValue({});
  mockServiceRepairEnabled.mockReturnValue(false);
  wireDb();
});

afterEach(() => { delete process.env.GATE_RESCHEDULE_CAP_ALL; });

describe('day cap on the commit', () => {
  test('gate off: a visit already moved 5 times today still commits (unchanged)', async () => {
    wireDb({ log: Array.from({ length: 5 }, () => pick(new Date())) });
    const res = await postCommit();
    expect(res.status).toBe(200);
    expect(mockReschedule).toHaveBeenCalledTimes(1);
  });

  test('gate on: the 4th move of the day is refused with MOVE_LIMIT and nothing moves', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    wireDb({ log: [pick(new Date()), pick(new Date()), pick(new Date())] });
    const res = await postCommit();
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('MOVE_LIMIT');
    expect(body.error).toBe(reschedulePublicRouter._test.MOVE_LIMIT_MESSAGE);
    expect(mockReschedule).not.toHaveBeenCalled();
    expect(mockHandleReschedule).not.toHaveBeenCalled();
  });

  test('gate on: the 3rd move of the day still commits', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    wireDb({ log: [pick(new Date()), pick(new Date())] });
    const res = await postCommit();
    expect(res.status).toBe(200);
    expect(mockReschedule).toHaveBeenCalledTimes(1);
  });

  test('gate on: moves from before midnight ET do not count', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    wireDb({ log: [pick(minutesAgo(60 * 30)), pick(minutesAgo(60 * 29)), pick(minutesAgo(60 * 28))] });
    const res = await postCommit();
    expect(res.status).toBe(200);
  });

  test('gate on: an idempotent replay of the move that just committed still succeeds at the cap', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    wireDb({
      svc: svcRow({ scheduled_date: TARGET_DATE, window_start: '09:00' }),
      log: [pick(new Date()), pick(new Date()), pick(new Date())],
    });
    const res = await postCommit();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.replayed).toBe(true);
  });

  test('gate on: the locked recheck inside the rebooker refuses a commit that raced past the unlocked count', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    wireDb({ log: [pick(new Date())] });
    const res = await postCommit();
    expect(res.status).toBe(200);
    const options = mockReschedule.mock.calls[0][5];
    const lockedRow = { scheduled_date: VISIT_DATE, window_start: '08:00', technician_id: null, is_recurring: false };
    const trxFor = (rows) => (table) => {
      const api = {};
      api.where = (arg, op, val) => {
        api.eq = arg; api.since = op === '>=' ? val : api.since;
        return api;
      };
      api.forUpdate = () => api;
      api.first = async () => lockedRow;
      api.select = async () => (table === 'reschedule_log' ? rows : []);
      return api;
    };
    // Two earlier commits landed meanwhile: the third pick of the day is still fine...
    await expect(options.moveGuard({ trx: trxFor([pick(new Date()), pick(new Date())]) })).resolves.toBeUndefined();
    // ...and a fourth is refused on the locked row.
    await expect(options.moveGuard({ trx: trxFor([pick(new Date()), pick(new Date()), pick(new Date())]) }))
      .rejects.toMatchObject({ statusCode: 409, code: 'MOVE_LIMIT' });
  });
});

describe('day cap on the page', () => {
  test('gate on at the cap: GET answers not_reschedulable with reason move_limit and no times', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    wireDb({ log: [pick(new Date()), pick(new Date()), pick(new Date())] });
    const res = await fetch(`${base}/api/public/reschedule/${TOKEN}`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.state).toBe('not_reschedulable');
    expect(body.reason).toBe('move_limit');
    expect(body.availability).toBeNull();
    expect(mockBuildBookingAvailability).not.toHaveBeenCalled();
  });

  test('gate off: the same visit and history is reschedulable', async () => {
    wireDb({ log: [pick(new Date()), pick(new Date()), pick(new Date())] });
    const res = await fetch(`${base}/api/public/reschedule/${TOKEN}`);
    const body = await res.json();
    expect(body.state).toBe('reschedulable');
  });
});

describe('notice coalescing after the commit', () => {
  test('gate off: handleReschedule gets exactly two arguments, as before', async () => {
    wireDb({ log: [pick(minutesAgo(5)), pick(new Date())] });
    await postCommit();
    expect(mockHandleReschedule).toHaveBeenCalledTimes(1);
    expect(mockHandleReschedule.mock.calls[0]).toHaveLength(2);
  });

  test('gate on, first move: the notice goes out as before', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    wireDb({ log: [pick(new Date())] });
    await postCommit();
    expect(mockHandleReschedule.mock.calls[0]).toHaveLength(2);
  });

  test('gate on, second move inside 15 minutes: the notice is deferred to the confirmation sweep', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    wireDb({ log: [pick(minutesAgo(5)), pick(new Date())] });
    await postCommit();
    expect(mockHandleReschedule).toHaveBeenCalledTimes(1);
    expect(mockHandleReschedule.mock.calls[0][2]).toEqual({ deferNoticeMinutes: 15 });
  });

  test('gate on, earlier move 20 minutes back: the notice goes out as before', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    wireDb({ log: [pick(minutesAgo(20)), pick(new Date())] });
    await postCommit();
    expect(mockHandleReschedule.mock.calls[0]).toHaveLength(2);
  });
});

describe('geocode once for an unpinned visit', () => {
  const { buildAvailabilityForService } = reschedulePublicRouter._test;
  const unpinned = () => svcRow({
    latitude: null, longitude: null, address_line1: '1 Test St', city: 'Sarasota', state: 'FL', zip: '34236',
    estimated_duration_minutes: 60, service_type: 'Quarterly Pest Control Service', service_key_snapshot: 'quarterly_pest',
  });
  const build = (svc) => buildAvailabilityForService(svc, { rangeFrom: '2026-12-01', rangeTo: '2026-12-01', config: CONFIG });

  test('gate off: every build still calls the route-local lookup (unchanged)', async () => {
    await build(unpinned());
    await build(unpinned());
    expect(mockResolveBookingCoords).toHaveBeenCalledTimes(2);
    expect(mockGeocodeWithStatus).not.toHaveBeenCalled();
  });

  test('gate on: the memoized geocoder answers and the route-local paid lookup is never called', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    mockGeocodeWithStatus.mockResolvedValue({ location: { lat: 27.3, lng: -82.5 }, permanent: false });
    await build(unpinned());
    await build(unpinned());
    await build(unpinned());
    expect(mockGeocodeWithStatus).toHaveBeenCalledTimes(3);
    expect(mockGeocodeWithStatus).toHaveBeenCalledWith('1 Test St, Sarasota, FL, 34236');
    expect(mockResolveBookingCoords).not.toHaveBeenCalled();
    expect(mockBuildBookingAvailability.mock.calls[0][0]).toMatchObject({ lat: 27.3, lng: -82.5 });
  });

  test('gate on: a pinned visit does no lookup at all', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    await build(svcRow());
    expect(mockGeocodeWithStatus).not.toHaveBeenCalled();
    expect(mockResolveBookingCoords).not.toHaveBeenCalled();
  });

  test('gate on: a refused address (permanent) builds nothing and does not pay again', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    mockGeocodeWithStatus.mockResolvedValue({ location: null, permanent: true, reason: 'partial_match' });
    expect(await build(unpinned())).toBeNull();
    expect(mockResolveBookingCoords).not.toHaveBeenCalled();
    expect(mockBuildBookingAvailability).not.toHaveBeenCalled();
  });

  test('gate on: a transient failure falls back to the old lookup', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    mockGeocodeWithStatus.mockResolvedValue({ location: null, permanent: false, reason: 'provider_unavailable' });
    await build(unpinned());
    expect(mockResolveBookingCoords).toHaveBeenCalledTimes(1);
  });

  test('gate on, repair gates off: the pin is not written and the row is not read', async () => {
    process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
    mockGeocodeWithStatus.mockResolvedValue({ location: { lat: 27.3, lng: -82.5 }, permanent: false });
    await build(unpinned());
    expect(mockPersistServicePin).not.toHaveBeenCalled();
    expect(mockDb).not.toHaveBeenCalledWith('scheduled_services');
  });

  describe('repair gates on', () => {
    beforeEach(() => {
      process.env.GATE_RESCHEDULE_CAP_ALL = 'true';
      mockServiceRepairEnabled.mockReturnValue(true);
      mockGeocodeWithStatus.mockResolvedValue({ location: { lat: 27.3, lng: -82.5 }, permanent: false });
      mockPersistServicePin.mockResolvedValue(true);
    });
    const stamped = (overrides = {}) => ({
      id: 'svc-1', lat: null, lng: null, service_address_line1: '1 Test St', service_address_city: 'Sarasota',
      service_address_state: 'FL', service_address_zip: '34236', ...overrides,
    });

    test('the geocoded pin is saved through persistServicePin and the board hears of it', async () => {
      wireDb({ svc: stamped() });
      await build(unpinned());
      expect(mockPersistServicePin).toHaveBeenCalledTimes(1);
      expect(mockPersistServicePin.mock.calls[0][1]).toMatchObject({ id: 'svc-1' });
      expect(mockPersistServicePin.mock.calls[0][2]).toEqual({ lat: 27.3, lng: -82.5 });
      expect(mockEmitDispatchJobUpdate).toHaveBeenCalledWith({ jobId: 'svc-1' });
    });

    test('a pin saved while the geocode was in flight stands: only an unpinned row is written', async () => {
      wireDb({ svc: stamped({ lat: 27.1, lng: -82.1 }) });
      await build(unpinned());
      expect(mockPersistServicePin).not.toHaveBeenCalled();
    });

    test('a visit with no stamped address of its own is not pinned (the customer pin is the sweep\'s)', async () => {
      wireDb({ svc: stamped({ service_address_line1: null }) });
      await build(unpinned());
      expect(mockPersistServicePin).not.toHaveBeenCalled();
    });

    test('a stamp that is not the address geocoded is not pinned', async () => {
      wireDb({ svc: stamped({ service_address_zip: '34237' }) });
      await build(unpinned());
      expect(mockPersistServicePin).not.toHaveBeenCalled();
    });

    test('a failed save never fails the build', async () => {
      wireDb({ svc: stamped() });
      mockPersistServicePin.mockRejectedValue(new Error('lock timeout'));
      expect(await build(unpinned())).not.toBeNull();
      expect(mockBuildBookingAvailability).toHaveBeenCalledTimes(1);
    });
  });
});
