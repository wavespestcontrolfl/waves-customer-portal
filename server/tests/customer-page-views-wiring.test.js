/**
 * Route wiring for the customer-page-view recorder (services/
 * customer-page-views.js): each token page's data GET records exactly one
 * view for the right page/subject once the token has resolved, records
 * nothing for a bad/unknown token, and a failing recorder never changes the
 * response. The recorder itself is unit-tested in customer-page-views.test.js.
 *
 * Handlers are driven directly off the router stack (no supertest in this
 * repo); the DB is a permissive chain whose .first() returns a canned row.
 * Everything after the record call may fail against the stub — the recorder
 * fires before any of it, and these tests only pin what it was called with.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'page-views-wiring-secret';
process.env.GATE_LEAD_INSPECTION_LINK = 'true';

const mockRecord = jest.fn(() => Promise.resolve(true));
jest.mock('../services/customer-page-views', () => ({
  recordPageView: (...a) => mockRecord(...a),
}));

let mockRows = {};
const mockDb = jest.fn((table) => {
  const row = () => (mockRows[String(table).split(' ')[0]] ?? null);
  const chain = new Proxy(function chainFn() {}, {
    get(_t, prop) {
      if (prop === 'first') return jest.fn(async () => row());
      if (prop === 'then') return (resolve) => resolve(row() ? [row()] : []);
      return jest.fn(() => chain);
    },
  });
  return chain;
});
mockDb.raw = jest.fn((s) => s);
mockDb.fn = { now: jest.fn() };
mockDb.schema = { hasTable: jest.fn(async () => true) };
mockDb.transaction = jest.fn(async () => { throw new Error('no tx in stub'); });
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/weather-forecast', () => ({ getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/photos', () => ({ deletePhoto: jest.fn(), getViewUrl: jest.fn() }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn(), geocodeAddressWithStatus: jest.fn() }));
jest.mock('../routes/booking', () => ({ _internals: {} }));
jest.mock('../services/reservice-scheduler', () => ({
  ...jest.requireActual('../services/reservice-scheduler'),
  reserviceSelfServeEnabled: () => true,
  reserviceLanesForCustomer: jest.fn(async () => []),
}));
const mockLoadSecure = jest.fn();
jest.mock('../services/appointment-card-request', () => ({
  loadSecureCardPageData: (...a) => mockLoadSecure(...a),
  completeSecureCardCapture: jest.fn(),
  replaceSecureCardIntent: jest.fn(),
}));

const appointmentRouter = require('../routes/appointment-public');
const rescheduleRouter = require('../routes/reschedule-public');
const reserviceRouter = require('../routes/reservice-public');
const secureCardRouter = require('../routes/secure-card-public');
const trackRouter = require('../routes/track-public');
const inspectionRouter = require('../routes/inspection-public');
const { mintLeadConsultationToken } = require('../utils/lead-consultation-token');

const TOKEN = 'a'.repeat(64);
const req = (token, extra = {}) => ({
  params: { token }, query: {}, headers: {}, ip: '203.0.113.5', get: () => 'Mozilla/5.0', ...extra,
});

function getHandler(router) {
  const layer = router.stack.find((l) => l.route && l.route.path === '/:token' && l.route.methods.get);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function drive(router, request) {
  const res = {
    statusCode: 200,
    set: jest.fn(() => res),
    setHeader: jest.fn(() => res),
    status: jest.fn((c) => { res.statusCode = c; return res; }),
    json: jest.fn(() => res),
    send: jest.fn(() => res),
  };
  await getHandler(router)(request, res, jest.fn());
  return res;
}

beforeEach(() => {
  mockRecord.mockClear();
  mockRecord.mockImplementation(() => Promise.resolve(true));
  mockRows = {};
});

describe('customer page view wiring', () => {
  test('appointment: records the visit view once the token resolves', async () => {
    mockRows = { scheduled_services: { id: 'svc-1', customer_id: 'cust-1', status: 'confirmed', scheduled_date: '2099-01-01' } };
    const request = req(TOKEN);
    await drive(appointmentRouter, request);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith({
      req: request, page: 'appointment', customerId: 'cust-1', subjectType: 'scheduled_service', subjectId: 'svc-1',
    });
  });

  test('reschedule: records the visit view once the token resolves', async () => {
    mockRows = { scheduled_services: { id: 'svc-2', customer_id: 'cust-2', status: 'confirmed', scheduled_date: '2099-01-01' } };
    const request = req(TOKEN);
    await drive(rescheduleRouter, request);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith({
      req: request, page: 'reschedule', customerId: 'cust-2', subjectType: 'scheduled_service', subjectId: 'svc-2',
    });
  });

  test('reservice: records a customer-scoped view', async () => {
    mockRows = { customers: { id: 'cust-3', first_name: 'Test' } };
    const request = req(TOKEN);
    await drive(reserviceRouter, request);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith({
      req: request, page: 'reservice', customerId: 'cust-3', subjectType: 'customer', subjectId: 'cust-3',
    });
  });

  test('secure-card: resolves the request row and records against its visit', async () => {
    mockLoadSecure.mockResolvedValue({ state: 'closed' });
    mockRows = { appointment_card_requests: { id: 'req-1', customer_id: 'cust-4', scheduled_service_id: 'svc-4', kind: 'appointment' } };
    const request = req(TOKEN);
    const res = await drive(secureCardRouter, request);
    expect(res.json).toHaveBeenCalledWith({ state: 'closed' });
    await new Promise((r) => setImmediate(r)); // the follow-up read is off the response path
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith({
      req: request, page: 'secure-card', customerId: 'cust-4', subjectType: 'scheduled_service', subjectId: 'svc-4',
    });
  });

  test('secure-card: a standalone Auto Pay setup row is keyed on the request itself', async () => {
    mockLoadSecure.mockResolvedValue({ state: 'ready' });
    mockRows = { appointment_card_requests: { id: 'req-5', customer_id: 'cust-5', scheduled_service_id: null, kind: 'customer' } };
    await drive(secureCardRouter, req(TOKEN));
    await new Promise((r) => setImmediate(r));
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      page: 'secure-card', customerId: 'cust-5', subjectType: 'appointment_card_request', subjectId: 'req-5',
    }));
  });

  test('track: records the visit view (60-minute window so the 30s poll is not a view)', async () => {
    mockRows = { scheduled_services: { id: 'svc-6', customer_id: 'cust-6', status: 'confirmed', track_token_expires_at: null } };
    const request = req(TOKEN);
    await drive(trackRouter, request);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith({
      req: request, page: 'track', customerId: 'cust-6', subjectType: 'scheduled_service', subjectId: 'svc-6', dedupeMinutes: 60,
    });
  });

  test('track: an expired token records nothing', async () => {
    mockRows = { scheduled_services: { id: 'svc-6', customer_id: 'cust-6', track_token_expires_at: '2000-01-01T00:00:00.000Z' } };
    const res = await drive(trackRouter, req(TOKEN));
    expect(res.statusCode).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('inspection: records a lead-scoped view attributed to no unproven customer', async () => {
    const leadId = '11111111-1111-4111-8111-111111111111';
    mockRows = { leads: { id: leadId, customer_id: null, status: 'new' } };
    const request = req(mintLeadConsultationToken(leadId));
    await drive(inspectionRouter, request);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith({
      req: request, page: 'inspection', customerId: null, subjectType: 'lead', subjectId: leadId,
    });
  });

  test.each([
    ['appointment', appointmentRouter],
    ['reschedule', rescheduleRouter],
    ['reservice', reserviceRouter],
    ['secure-card', secureCardRouter],
    ['track', trackRouter],
  ])('%s: a malformed token or unknown row records nothing', async (_name, router) => {
    mockLoadSecure.mockResolvedValue(null);
    const bad = await drive(router, req('nope'));
    expect(bad.statusCode).toBe(404);
    mockRows = {};
    const unknown = await drive(router, req(TOKEN));
    expect(unknown.statusCode).toBe(404);
    await new Promise((r) => setImmediate(r));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('inspection: a garbage token or unknown lead records nothing', async () => {
    await drive(inspectionRouter, req('garbage'));
    mockRows = {};
    await drive(inspectionRouter, req(mintLeadConsultationToken('22222222-2222-4222-8222-222222222222')));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a recorder that rejects never changes the response', async () => {
    mockRecord.mockImplementation(() => Promise.reject(new Error('db down')));
    mockLoadSecure.mockResolvedValue({ state: 'closed' });
    mockRows = { appointment_card_requests: { id: 'req-1', customer_id: 'c', scheduled_service_id: 's', kind: 'appointment' } };
    const res = await drive(secureCardRouter, req(TOKEN));
    expect(res.statusCode).toBe(200);
    expect(res.json).toHaveBeenCalledWith({ state: 'closed' });
  });
});
