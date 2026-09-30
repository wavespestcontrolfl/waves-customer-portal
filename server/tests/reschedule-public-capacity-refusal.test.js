/**
 * POST /:token — capacity verify failure recovery (Codex round 1 P2 on PR
 * #5267, PRRT_kwDOR3YQi86mzgqa).
 *
 * rescheduleOnce's new mid-route insertion certification (services/
 * rebooker.js) can refuse a commit with capacityError's own code,
 * SLOT_UNAVAILABLE — a changed route fingerprint or an infeasible live fit
 * discovered under lock, AFTER the anti-forgery slot lookup already found
 * the time "offered". Left unmapped, that code falls through
 * ScheduleFlowPage.jsx's generic branch (bare error line, stale slot still
 * selected, no refresh) instead of its ONE real recovery path — clear the
 * selection, refresh the calendar — which only fires on `code ===
 * 'SLOT_TAKEN'`. This proves the route rewrites a SLOT_UNAVAILABLE capacity
 * refusal into the SAME SLOT_TAKEN response shape the plain "that time is
 * no longer offered" anti-forgery miss already returns, and that every
 * OTHER thrown code (a real double-book, a stale plan) still passes through
 * unchanged.
 *
 * Isolated in its own file (mocks routes/booking AND services/rebooker
 * wholesale) — reschedule-public.test.js's other tests never touch either
 * module and must not inherit the mocks.
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

describe('POST /:token — capacity verify failure (SLOT_UNAVAILABLE) maps to the SLOT_TAKEN recovery response', () => {
  test('a capacityError thrown by the single-visit commit surfaces as 409 SLOT_TAKEN with refreshed availability, not the raw SLOT_UNAVAILABLE code', async () => {
    mockReschedule.mockRejectedValue(Object.assign(
      new Error('This time is no longer available. Please choose another appointment.'),
      { code: 'SLOT_UNAVAILABLE', status: 409, statusCode: 409, isOperational: true },
    ));

    const res = await postCommit();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('SLOT_TAKEN');
    // Same recovery shape the anti-forgery miss returns — a fresh
    // availability rebuild the client can render immediately.
    expect(Array.isArray(body.availability?.days)).toBe(true);
    expect(Array.isArray(body.availability?.slots)).toBe(true);
    expect(Array.isArray(body.availability?.nearby)).toBe(true);
  });

  test('the refreshed availability comes from a REAL rebuild (buildAvailabilityForService called again after the failure), not a stale copy', async () => {
    mockReschedule.mockRejectedValue(Object.assign(new Error('gone'), {
      code: 'SLOT_UNAVAILABLE', statusCode: 409, isOperational: true,
    }));

    await postCommit();

    // Once for the pre-commit anti-forgery check, once for the SLOT_TAKEN
    // recovery refresh after the capacity failure.
    expect(mockBuildBookingAvailability).toHaveBeenCalledTimes(2);
  });

  test('a DIFFERENT thrown code (a real double-book) is unaffected — passes through with its own code/message, no rewrite', async () => {
    mockReschedule.mockRejectedValue(Object.assign(
      new Error('That window conflicts with another job on the technician\'s route'),
      { statusCode: 409, code: 'SLOT_TAKEN', isOperational: true },
    ));

    const res = await postCommit();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('SLOT_TAKEN');
    expect(body.error).toBe('That window conflicts with another job on the technician\'s route');
  });

  test('a plan-level conflict (SCOPE_CHANGED) still passes through unchanged, not coerced into SLOT_TAKEN', async () => {
    mockReschedule.mockRejectedValue(Object.assign(
      new Error('The visit changed concurrently'),
      { statusCode: 409, code: 'VISIT_MEMBERSHIP_CHANGED', isOperational: true },
    ));

    const res = await postCommit();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.code).toBe('VISIT_MEMBERSHIP_CHANGED');
  });

  test('a successful commit never touches the SLOT_UNAVAILABLE branch', async () => {
    mockReschedule.mockResolvedValue({ success: true, originalDate: '2099-07-10' });

    const res = await postCommit();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });
});
