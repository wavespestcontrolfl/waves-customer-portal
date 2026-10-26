/**
 * GATE_TECH_STAFF_GUARDS, M6 (census 2026-10-25): a technician's En Route / On Site tap on a booking
 * the office has not reviewed no longer approves it. The tap answers 409 and the office gets one
 * notice; an admin login still auto-confirms; gate off = today (a technician's tap confirms).
 *
 * The real tech-track router runs behind a stubbed login. Every writer behind it is mocked, so the
 * observable outcomes are "was the booking confirmed" (the auto-confirm leg ran), "did the status
 * advance" and "was the office notified". Nothing is sent.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);

const mockCaller = { id: 'tech-2', role: 'technician' };
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technician = { id: mockCaller.id, role: mockCaller.role };
      req.technicianId = mockCaller.id;
      req.techRole = mockCaller.role;
      return next();
    },
  };
});
const mockRaise = jest.fn(async () => ({ id: 1 }));
jest.mock('../services/tech-unreviewed-booking-alert', () => ({
  raiseForVisit: (...a) => mockRaise(...a),
  closeForVisit: jest.fn(),
  // The real rule: which bookings still wait for office review.
  awaitingOfficeReview: jest.requireActual('../services/tech-unreviewed-booking-alert').awaitingOfficeReview,
}));
const mockTransition = jest.fn(async () => ({}));
jest.mock('../services/job-status', () => ({ transitionJobStatus: (...a) => mockTransition(...a) }));
const mockMarkEnRoute = jest.fn(async () => ({ ok: true, state: 'en_route', enRouteAt: 'now', smsSent: false }));
const mockMarkOnProperty = jest.fn(async () => ({ ok: true, state: 'on_property', arrivedAt: 'now' }));
jest.mock('../services/track-transitions', () => ({
  markEnRoute: (...a) => mockMarkEnRoute(...a),
  markOnProperty: (...a) => mockMarkOnProperty(...a),
  isFutureScheduledDate: () => false,
  isStaleLiveAttempt: () => false,
}));
const mockActivate = jest.fn(async () => true);
jest.mock('../services/outbound-review-confirm', () => ({
  runOutboundReviewConfirmHook: jest.fn(async () => true),
  runOfficeConfirmActivation: (...a) => mockActivate(...a),
}));
jest.mock('../services/street-level-hold', () => ({ isStreetLevelHoldVisit: jest.fn(async () => false) }));
jest.mock('../services/appointment-reminders', () => ({ handleCancellation: jest.fn(), handleReschedule: jest.fn() }));
jest.mock('../models/db', () => {
  const state = { visit: null, updates: [] };
  const builder = (table) => {
    const b = {
      where() { return b; }, whereNull() { return b; }, forUpdate() { return b; },
      async first() { return table === 'scheduled_services' && state.visit ? { ...state.visit } : undefined; },
      async update(vals) { state.updates.push({ table, vals }); return 1; },
    };
    return b;
  };
  const dbFn = (table) => builder(table);
  dbFn.fn = { now: () => new Date() };
  dbFn.raw = (sql) => sql;
  dbFn.transaction = async (cb) => cb(dbFn);
  dbFn.__state = state;
  return dbFn;
});

const express = require('express');
const db = require('../models/db');
const techTrackRouter = require('../routes/tech-track');

let server; let baseUrl;
beforeAll(() => new Promise((resolve) => {
  const app = express();
  app.use(express.json());
  app.use('/api/tech/services', techTrackRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; resolve(); });
}));
afterAll(() => new Promise((r) => server.close(r)));

const prevGate = process.env.GATE_TECH_STAFF_GUARDS;
const VISIT = '00000000-0000-4000-8000-000000000002';
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function pendingVoiceBooking(technicianId) {
  return {
    id: VISIT, technician_id: technicianId, status: 'pending', scheduled_date: today, visit_id: null,
    track_state: null, en_route_at: null, arrived_at: null, actual_start_time: null, check_in_time: null,
    source_action: 'voice_agent', customer_confirmed: false, customer_id: 'cust-1', window_start: '09:00',
    service_type: 'pest_control', source_call_log_id: null, is_callback: false, estimated_price: 0,
  };
}
const tap = async (leg) => {
  const res = await fetch(`${baseUrl}/api/tech/services/${VISIT}/${leg}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

beforeEach(() => {
  process.env.GATE_TECH_STAFF_GUARDS = 'true';
  mockCaller.id = 'tech-2';
  mockCaller.role = 'technician';
  db.__state.visit = pendingVoiceBooking('tech-2');
  db.__state.updates = [];
  mockRaise.mockClear(); mockTransition.mockClear(); mockActivate.mockClear();
  mockMarkEnRoute.mockClear(); mockMarkOnProperty.mockClear();
});
afterAll(() => {
  if (prevGate === undefined) delete process.env.GATE_TECH_STAFF_GUARDS;
  else process.env.GATE_TECH_STAFF_GUARDS = prevGate;
});

describe.each([['en-route', 'En Route'], ['on-site', 'On Site']])('%s tap on an unreviewed booking', (leg, label) => {
  test('gate on, technician: refused with 409, nothing confirmed, nothing advanced, one office notice', async () => {
    const res = await tap(leg);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('outbound_review_unconfirmed');
    expect(mockActivate).not.toHaveBeenCalled();
    expect(mockTransition).not.toHaveBeenCalled();
    expect(mockMarkEnRoute).not.toHaveBeenCalled();
    expect(mockMarkOnProperty).not.toHaveBeenCalled();
    expect(db.__state.updates).toEqual([]);
    expect(mockRaise).toHaveBeenCalledTimes(1);
    expect(mockRaise).toHaveBeenCalledWith(expect.objectContaining({ id: VISIT, customer_id: 'cust-1' }), label);
  });

  test('gate on, admin login (the owner): still auto-confirms and advances, no notice', async () => {
    mockCaller.id = 'admin-1';
    mockCaller.role = 'admin';
    db.__state.visit = pendingVoiceBooking('admin-1');
    const res = await tap(leg);
    expect(res.status).toBe(200);
    expect(mockActivate).toHaveBeenCalledTimes(1);
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: 'pending', toStatus: 'confirmed' }));
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: 'confirmed', toStatus: leg === 'en-route' ? 'en_route' : 'on_site' }));
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('gate off, technician: today\'s behavior, the tap confirms and advances, no notice', async () => {
    delete process.env.GATE_TECH_STAFF_GUARDS;
    const res = await tap(leg);
    expect(res.status).toBe(200);
    expect(mockActivate).toHaveBeenCalledTimes(1);
    expect(mockTransition).toHaveBeenCalledWith(expect.objectContaining({ fromStatus: 'pending', toStatus: 'confirmed' }));
    expect(mockRaise).not.toHaveBeenCalled();
  });

  test('gate on, technician, a moved booking the office never reviewed (confirmed, not customer-confirmed): refused, one notice', async () => {
    db.__state.visit = { ...pendingVoiceBooking('tech-2'), status: 'confirmed', customer_confirmed: false };
    const res = await tap(leg);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('outbound_review_unconfirmed');
    expect(mockTransition).not.toHaveBeenCalled();
    expect(db.__state.updates).toEqual([]);
    expect(mockRaise).toHaveBeenCalledTimes(1);
  });

  test('gate on, technician, booking already reviewed: the tap advances as usual, no notice', async () => {
    db.__state.visit = { ...pendingVoiceBooking('tech-2'), status: 'confirmed', customer_confirmed: true };
    const res = await tap(leg);
    expect(res.status).toBe(200);
    expect(mockActivate).not.toHaveBeenCalled();
    expect(mockRaise).not.toHaveBeenCalled();
  });
});
