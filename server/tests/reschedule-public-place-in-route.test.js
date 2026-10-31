/**
 * POST /:token — GATE_ROUTE_CHECK_BOOKING_SAVES (owner 2026-10-30, Route Check
 * Everywhere follow-up): the customer reschedule page passes `placeInRoute` to
 * the rebooker, so its existing placement numbers the moved visit (single move)
 * or each moved occurrence (series re-anchor). Pins the option on both calls,
 * gate on and off, and that nothing else about the call changes: no
 * `roadSpender` (so no Google road purchase) and no `overlapAdvisory` (so the
 * placement is not a staff save). The placement itself is covered in
 * rebooker-staff-route-placement.test.js.
 *
 * Isolated like reschedule-public-capacity-refusal.test.js: it mocks
 * routes/booking and services/rebooker wholesale.
 */
const mockDb = jest.fn();
mockDb.raw = (sql) => sql;
jest.mock('../models/db', () => mockDb);
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));

const { etDateString, addETDays } = require('../utils/datetime-et');
const CONFIG = { advance_days_min: 1, advance_days_max: 14 };
// Real near-future dates (bookingRange() is computed off the real clock, and
// commits outside it 400 before ever reaching SmartRebooker.reschedule).
const VISIT_DATE = etDateString(addETDays(new Date(), 20));
const TARGET_DATE = etDateString(addETDays(new Date(), 10));
const SLOT = { start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', end_label: '10:00 AM', technician_id: 'tech-1' };
const mockBuildBookingAvailability = jest.fn().mockResolvedValue({
  days: [{ date: TARGET_DATE, slots: [SLOT] }], slots: [SLOT], nearby: [],
});
jest.mock('../routes/booking', () => ({
  _internals: {
    loadBookingConfig: jest.fn().mockResolvedValue(CONFIG),
    resolveBookingCoords: jest.fn().mockResolvedValue({ lat: 27.4, lng: -82.4 }),
    buildBookingAvailability: (...args) => mockBuildBookingAvailability(...args),
    normalizeBookingServiceKey: jest.fn(() => 'pest_control'),
    bookInsertionOffersLive: jest.fn(() => true),
  },
}));

const mockReschedule = jest.fn();
jest.mock('../services/rebooker', () => ({
  reschedule: (...args) => mockReschedule(...args),
  rescheduleSeries: jest.fn(),
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
  server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.close(done); });

// A plain, ungrouped, non-recurring, active visit far enough out that no
// eligibility/notice-window refusal fires before the commit is reached —
// this test's only interest is what happens AFTER the anti-forgery slot
// lookup succeeds.
const svcRow = () => ({
  id: 'svc-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: VISIT_DATE,
  window_start: '08:00', window_end: '09:00', service_type: 'Pest Control',
  is_recurring: false, visit_id: null, customer_deleted_at: null, cust_first_name: 'Pat',
  customer_active: true,
});

function wireSvc(svc) {
  mockDb.mockImplementation(() => {
    const api = { leftJoin: () => api, where: () => api, orderBy: () => api, first: async () => svc };
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
  mockBuildBookingAvailability.mockResolvedValue({
    days: [{ date: TARGET_DATE, slots: [SLOT] }], slots: [SLOT], nearby: [],
  });
  wireSvc(svcRow());
});


const GATES = ['GATE_ROUTE_CHECK_BOOKING_SAVES', 'GATE_ADMIN_ARRIVAL_WINDOWS', 'GATE_COLLECTIVE_SERIES_ANCHOR', 'GATE_SCHEDULING_CAPACITY'];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(GATES.map(name => [name, process.env[name]]));
  GATES.forEach(name => { delete process.env[name]; });
});
afterEach(() => {
  GATES.forEach(name => {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  });
});
const gateOn = () => {
  process.env.GATE_ROUTE_CHECK_BOOKING_SAVES = 'true';
  process.env.GATE_ADMIN_ARRIVAL_WINDOWS = 'true';
};
const stopCommit = () => Object.assign(new Error('stop after the call'), { statusCode: 409, code: 'SLOT_TAKEN', isOperational: true });
// The series page's consent pins (seriesScopeMismatch): collective anchoring disclosed, the visit's current date echoed.
const postSeriesCommit = () => fetch(`${base}/api/public/reschedule/${TOKEN}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ date: TARGET_DATE, start_time: '09:00', disclosed_collective: true, disclosed_current_date: VISIT_DATE }),
});
const seriesRow = () => ({ ...svcRow(), is_recurring: true });
const optionsOf = (mock) => mock.mock.calls[0][5];

describe('POST /:token — placeInRoute follows GATE_ROUTE_CHECK_BOOKING_SAVES', () => {
  test('single move, gate on: placeInRoute true, and no road spender or staff-save option rides with it', async () => {
    gateOn();
    mockReschedule.mockRejectedValue(stopCommit());
    await postCommit();
    expect(mockReschedule).toHaveBeenCalledTimes(1);
    const options = optionsOf(mockReschedule);
    expect(options.placeInRoute).toBe(true);
    expect(options).toMatchObject({ seriesPolicy: 'single', technicianId: 'tech-1', travelGap: true });
    expect(options.roadSpender).toBeUndefined();
    expect(options.overlapAdvisory).toBeUndefined();
  });

  test('single move, gate off (or without the arrival-window check): placeInRoute false', async () => {
    mockReschedule.mockRejectedValue(stopCommit());
    await postCommit();
    expect(optionsOf(mockReschedule).placeInRoute).toBe(false);
    mockReschedule.mockClear();
    process.env.GATE_ROUTE_CHECK_BOOKING_SAVES = 'true';
    await postCommit();
    expect(optionsOf(mockReschedule).placeInRoute).toBe(false);
  });

  test('series re-anchor, gate on: placeInRoute true on rescheduleSeries; gate off: false', async () => {
    const { rescheduleSeries } = require('../services/rebooker');
    process.env.GATE_COLLECTIVE_SERIES_ANCHOR = 'true';
    wireSvc(seriesRow());
    rescheduleSeries.mockRejectedValue(stopCommit());
    gateOn();
    await postSeriesCommit();
    expect(rescheduleSeries).toHaveBeenCalledTimes(1);
    expect(mockReschedule).not.toHaveBeenCalled();
    const options = rescheduleSeries.mock.calls[0][5];
    expect(options.placeInRoute).toBe(true);
    expect(options).toMatchObject({ sourceSurface: 'customer_web', travelGap: true, technicianId: 'tech-1' });
    expect(options.roadSpender).toBeUndefined();
    expect(options.overlapAdvisory).toBeUndefined();
    rescheduleSeries.mockClear();
    delete process.env.GATE_ROUTE_CHECK_BOOKING_SAVES;
    await postSeriesCommit();
    expect(rescheduleSeries.mock.calls[0][5].placeInRoute).toBe(false);
  });
});
