/**
 * Route wiring for the customer-page-view recorder (services/
 * customer-page-views.js): the appointment / reschedule / reservice /
 * secure-card / inspection data GETs record exactly one view for the right
 * page/subject once the token has resolved (their contract entries do not
 * make the GET read-only), and record nothing for a bad/unknown token. The
 * track GET is contractually read-only, so it never writes; its view comes
 * from POST /:token/view (once, 404 + no write for a bad/expired token). A
 * failing recorder never changes the response. The recorder itself is unit-tested in customer-page-views.test.js.
 *
 * Handlers are driven directly off the router stack (no supertest in this
 * repo); the DB is a permissive chain whose .first() returns a canned row.
 * Everything after the record call may fail against the stub — the recorder
 * fires before any of it, and these tests only pin what it was called with.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'page-views-wiring-secret';
process.env.GATE_LEAD_INSPECTION_LINK = 'true';

const mockRecord = jest.fn(() => Promise.resolve(true));
const mockLogViewFailure = jest.fn();
jest.mock('../services/customer-page-views', () => ({
  recordPageView: (...a) => mockRecord(...a),
  logViewFailure: (...a) => mockLogViewFailure(...a),
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
// The secure-card page GET attests the consent text version its bundle
// renders (codex #5434 r1 P1); other routes ignore the query.
const { CONSENT_VERSION } = jest.requireActual('../services/payment-method-consent-text');
const req = (token, extra = {}) => ({
  params: { token }, query: { consentTextVersion: CONSENT_VERSION }, headers: {}, ip: '203.0.113.5', get: () => 'Mozilla/5.0', ...extra,
});

function getHandler(router, method = 'get', path = '/:token') {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle;
}

async function drive(router, request, method = 'get', path = '/:token', next = jest.fn()) {
  const res = {
    statusCode: 200,
    set: jest.fn(() => res),
    setHeader: jest.fn(() => res),
    status: jest.fn((c) => { res.statusCode = c; return res; }),
    json: jest.fn(() => res),
    send: jest.fn(() => res),
    end: jest.fn(() => res),
  };
  await getHandler(router, method, path)(request, res, next);
  return res;
}

beforeEach(() => {
  mockRecord.mockClear();
  mockLogViewFailure.mockClear();
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

  test('track: the GET stays read-only (no view write, polls included)', async () => {
    mockRows = { scheduled_services: { id: 'svc-6', customer_id: 'cust-6', status: 'confirmed', track_token_expires_at: null } };
    await drive(trackRouter, req(TOKEN));
    await drive(trackRouter, req(TOKEN));
    await new Promise((r) => setImmediate(r));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('track: POST /:token/view records ONE view and answers 204', async () => {
    mockRows = { scheduled_services: { id: 'svc-6', customer_id: 'cust-6', track_token_expires_at: null } };
    const request = req(TOKEN);
    const res = await drive(trackRouter, request, 'post', '/:token/view');
    expect(res.statusCode).toBe(204);
    expect(res.end).toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(mockRecord).toHaveBeenCalledWith({
      req: request, page: 'track', customerId: 'cust-6', subjectType: 'scheduled_service', subjectId: 'svc-6',
    });
  });

  test('track: POST /:token/view with an expired, unknown, or malformed token is a 404 with no write', async () => {
    mockRows = { scheduled_services: { id: 'svc-6', customer_id: 'cust-6', track_token_expires_at: '2000-01-01T00:00:00.000Z' } };
    const expired = await drive(trackRouter, req(TOKEN), 'post', '/:token/view');
    expect(expired.statusCode).toBe(404);
    mockRows = {};
    const unknown = await drive(trackRouter, req(TOKEN), 'post', '/:token/view');
    expect(unknown.statusCode).toBe(404);
    const malformed = await drive(trackRouter, req('nope'), 'post', '/:token/view');
    expect(malformed.statusCode).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('track: POST /:token/view hands a bot to the recorder, which skips it (no write reaches the DB)', async () => {
    // The route defers bot/staff filtering to the recorder (unit-tested in
    // customer-page-views.test.js); pin that the real recorder rejects a bot
    // request so the route cannot write for one.
    const real = jest.requireActual('../services/customer-page-views');
    expect(real.shouldRecord(req(TOKEN, { get: () => 'Slackbot-LinkExpanding 1.0' }))).toBe(false);
    expect(real.shouldRecord(req(TOKEN))).toBe(true);
  });

  test('track: POST /:token/view lookup failure is logged code-only and never forwarded', async () => {
    const err = Object.assign(new Error(`select ... where track_view_token = '${TOKEN}'`), { code: '57014' });
    mockRows = { get scheduled_services() { throw err; } };
    const next = jest.fn();
    const res = await drive(trackRouter, req(TOKEN), 'post', '/:token/view', next);
    expect(res.statusCode).toBe(204);
    expect(next).not.toHaveBeenCalled();
    expect(mockLogViewFailure).toHaveBeenCalledWith('lookup', 'track', 'scheduled_service', err);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('track: the pre-parser guard is mounted ahead of the global /api limiter and body parsers', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../index.js'), 'utf8');
    const guard = src.indexOf("app.use('/api/public/track', require('./middleware/track-public-preparser').trackPublicPreparser);");
    const limiter = src.indexOf("app.use('/api/', limiter);");
    const json = src.indexOf('app.use(express.json(');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(limiter);
    expect(guard).toBeLessThan(json);
  });

  describe('track pre-parser guard', () => {
    const { trackPublicPreparser } = require('../middleware/track-public-preparser');
    const run = (method, path, headers = {}) => {
      const res = {
        headers: {}, statusCode: 200,
        set: jest.fn((k, v) => { res.headers[k] = v; return res; }),
        status: jest.fn((c) => { res.statusCode = c; return res; }),
        json: jest.fn(() => res),
      };
      const request = { method, path, headers: { ...headers } };
      const next = jest.fn();
      trackPublicPreparser(request, res, next);
      return { res, next, request };
    };
    const PRIVACY = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };

    test('stamps privacy headers on every request', () => {
      for (const [m, p] of [['GET', `/${TOKEN}`], ['POST', `/${TOKEN}/stops-ahead`], ['POST', '/bad/view']]) {
        expect(run(m, p).res.headers).toEqual(PRIVACY);
      }
    });

    test('POST /:token/view with a malformed token is a 404 before any parsing', () => {
      const { res, next } = run('POST', '/nope/view', { 'content-type': 'application/json' });
      expect(res.statusCode).toBe(404);
      expect(next).not.toHaveBeenCalled();
    });

    test('POST /:token/view with a valid token drops Content-Type so the body is never parsed', () => {
      const { next, request } = run('POST', `/${TOKEN}/view`, { 'content-type': 'application/json' });
      expect(next).toHaveBeenCalled();
      expect(request.headers['content-type']).toBeUndefined();
    });

    test('other track routes are untouched', () => {
      const a = run('GET', '/nope');
      expect(a.next).toHaveBeenCalled();
      const b = run('POST', `/${TOKEN}/stops-ahead`, { 'content-type': 'application/json' });
      expect(b.next).toHaveBeenCalled();
      expect(b.request.headers['content-type']).toBe('application/json');
    });
  });

  test('track: POST /:token/view is rate-limited like stops-ahead (router-level limiter)', () => {
    // The limiter is a router-level middleware registered before every route,
    // so it precedes the /view layer (same as /stops-ahead).
    const idx = (m, p) => trackRouter.stack.findIndex((l) => l.route && l.route.path === p && l.route.methods[m]);
    const firstRoute = trackRouter.stack.findIndex((l) => l.route);
    expect(firstRoute).toBeGreaterThan(0);
    expect(trackRouter.stack.slice(0, firstRoute).some((l) => !l.route)).toBe(true);
    expect(idx('post', '/:token/view')).toBeGreaterThan(firstRoute - 1);
  });

  test('secure-card: a failed request-row lookup logs page/subject/code only, never the Knex message', async () => {
    const secret = 'SeCrEtBearerToken0123456789abc';
    mockLoadSecure.mockResolvedValue({ state: 'closed' });
    const knexErr = new Error(`select "id" from "appointment_card_requests" where "token" = '${secret}' - timeout`);
    knexErr.code = '57014';
    const savedRows = mockRows;
    mockRows = { appointment_card_requests: null };
    mockDb.mockImplementationOnce(() => { throw knexErr; }); // the GET's follow-up read
    await drive(secureCardRouter, req(TOKEN));
    await new Promise((r) => setImmediate(r));
    mockRows = savedRows;
    expect(mockLogViewFailure).toHaveBeenCalledTimes(1);
    expect(mockLogViewFailure).toHaveBeenCalledWith('lookup', 'secure-card', 'appointment_card_request', knexErr);
    expect(require('../services/logger').warn.mock.calls.flat().join(' ')).not.toContain(secret);
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
