// The pin check after a visit (GATE_PIN_PARKED_CHECK) on the address review routes.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const role = req.headers.authorization === 'Bearer admin' ? 'admin'
      : req.headers.authorization === 'Bearer tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.techRole = role;
    req.technicianId = role === 'admin' ? 'actor-1' : 'tech-1';
    return next();
  },
  requireAdmin: (req, res, next) => (
    req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Admin access required' })
  ),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/customer-geocode-review', () => ({
  reviewEnabled: jest.fn(),
  getReviewDetail: jest.fn(),
  listReviewQueue: jest.fn(),
}));
jest.mock('../services/customer-geocode-review-actions', () => ({
  resolveCustomerGeocodeReview: jest.fn(),
}));
jest.mock('../services/customer-pin-suggestions', () => ({
  openForCustomer: jest.fn(),
  visibleSuggestion: jest.fn(),
  closeAfterVerify: jest.fn(),
  dismiss: jest.fn(),
}));

const express = require('express');
const reviewStore = require('../services/customer-geocode-review');
const actions = require('../services/customer-geocode-review-actions');
const suggestions = require('../services/customer-pin-suggestions');
const router = require('../routes/admin-customer-geocodes');

const CUSTOMER_ID = '11111111-2222-4333-8444-555555555555';
const SUGGESTION_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const SHOWN = { id: SUGGESTION_ID, visit_date: '2026-10-08', latitude: 27.49, longitude: -82.57, distance_m: 540, stop_minutes: 25, source: 'site_visit', evidence: 'x' };
const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const verifyBody = (extra = {}) => ({
  revision: 'rev-1', action: 'verify_pin', latitude: 27.49, longitude: -82.57, source: 'site_visit', evidence: 'Truck parked here.', confirmed: true, ...extra,
});
let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/customer-geocodes', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { Connection: 'close', ...options.headers } });
  return { status: response.status, body: await response.json() };
}
const post = (path, body) => request(path, { method: 'POST', headers: admin, body: JSON.stringify(body || {}) });

beforeEach(() => {
  jest.resetAllMocks();
  reviewStore.reviewEnabled.mockReturnValue(true);
  reviewStore.getReviewDetail.mockResolvedValue({ enabled: true, customer: { id: CUSTOMER_ID }, review: { status: 'geocoded' }, revision: 'rev-1' });
  actions.resolveCustomerGeocodeReview.mockResolvedValue({ enabled: true, customer: { id: CUSTOMER_ID }, review: { status: 'verified' } });
  suggestions.dismiss.mockResolvedValue({ id: SUGGESTION_ID });
  suggestions.openForCustomer.mockResolvedValue({ id: SUGGESTION_ID });
  suggestions.visibleSuggestion.mockReturnValue(SHOWN);
  delete process.env.GATE_PIN_PARKED_CHECK;
});
afterEach(() => { delete process.env.GATE_PIN_PARKED_CHECK; });

describe('gate off', () => {
  test('the detail response is exactly what it was: no field, no query', async () => {
    const result = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}`, { headers: admin });
    expect(result.status).toBe(200);
    expect(result.body).not.toHaveProperty('pin_suggestion');
    expect(suggestions.openForCustomer).not.toHaveBeenCalled();
  });

  test('a verify_pin does not touch suggestions', async () => {
    expect((await post(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, verifyBody({ pin_suggestion_id: SUGGESTION_ID }))).status).toBe(200);
    expect(suggestions.closeAfterVerify).not.toHaveBeenCalled();
  });

  test('dismiss answers 404 with no service call, even for an admin', async () => {
    const result = await post(`/api/admin/customer-geocodes/${CUSTOMER_ID}/pin-suggestions/${SUGGESTION_ID}/dismiss`);
    expect(result).toEqual({ status: 404, body: { enabled: false } });
    expect(suggestions.dismiss).not.toHaveBeenCalled();
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env.GATE_PIN_PARKED_CHECK = 'true'; });

  test('the detail carries the suggestion the store decides to show', async () => {
    const result = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}`, { headers: admin });
    expect(result.body.pin_suggestion).toEqual(SHOWN);
    expect(suggestions.openForCustomer).toHaveBeenCalledWith(CUSTOMER_ID);
    expect(suggestions.visibleSuggestion).toHaveBeenCalledWith(expect.objectContaining({ customer: { id: CUSTOMER_ID } }), { id: SUGGESTION_ID });
  });

  test('a failed suggestion read leaves the review itself working', async () => {
    suggestions.openForCustomer.mockRejectedValue(new Error('boom'));
    const result = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}`, { headers: admin });
    expect(result.status).toBe(200);
    expect(result.body.pin_suggestion).toBeNull();
  });

  test('the list endpoint is unchanged', async () => {
    reviewStore.listReviewQueue.mockResolvedValue({ records: [], total: 0 });
    const result = await request('/api/admin/customer-geocodes', { headers: admin });
    expect(result.body).toEqual({ enabled: true, records: [], total: 0 });
  });

  test('verify_pin goes through the existing action, then marks the suggestion applied', async () => {
    const result = await post(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, verifyBody({ pin_suggestion_id: SUGGESTION_ID }));
    expect(result.status).toBe(200);
    expect(actions.resolveCustomerGeocodeReview).toHaveBeenCalledWith(
      CUSTOMER_ID, expect.objectContaining({ action: 'verify_pin', latitude: 27.49, pin_suggestion_id: SUGGESTION_ID }), 'actor-1',
    );
    expect(suggestions.closeAfterVerify).toHaveBeenCalledWith(CUSTOMER_ID, { suggestionId: SUGGESTION_ID, actorId: 'actor-1' });
    expect(actions.resolveCustomerGeocodeReview.mock.invocationCallOrder[0]).toBeLessThan(suggestions.closeAfterVerify.mock.invocationCallOrder[0]);
  });

  test('a verify_pin typed by hand still closes the open suggestion (as superseded, with no id)', async () => {
    await post(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, verifyBody());
    expect(suggestions.closeAfterVerify).toHaveBeenCalledWith(CUSTOMER_ID, { suggestionId: null, actorId: 'actor-1' });
  });

  test('a failed verify_pin leaves the suggestion alone', async () => {
    actions.resolveCustomerGeocodeReview.mockRejectedValue(Object.assign(new Error('changed'), { statusCode: 409, code: 'review_changed' }));
    const result = await post(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, verifyBody({ pin_suggestion_id: SUGGESTION_ID }));
    expect(result.status).toBe(409);
    expect(suggestions.closeAfterVerify).not.toHaveBeenCalled();
  });

  test('other actions never close a suggestion', async () => {
    await post(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, { revision: 'rev-1', action: 'revoke' });
    expect(suggestions.closeAfterVerify).not.toHaveBeenCalled();
  });

  test('the suggestion id must be a uuid and is allowed on verify_pin only', async () => {
    expect((await post(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, verifyBody({ pin_suggestion_id: 'nope' }))).status).toBe(400);
    expect((await post(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, { revision: 'rev-1', action: 'revoke', pin_suggestion_id: SUGGESTION_ID })).status).toBe(400);
    expect(actions.resolveCustomerGeocodeReview).not.toHaveBeenCalled();
  });

  describe('dismiss', () => {
    const url = `/api/admin/customer-geocodes/${CUSTOMER_ID}/pin-suggestions/${SUGGESTION_ID}/dismiss`;

    test('is admin only', async () => {
      expect((await request(url, { method: 'POST' })).status).toBe(401);
      expect((await request(url, { method: 'POST', headers: { Authorization: 'Bearer tech' } })).status).toBe(403);
      expect(suggestions.dismiss).not.toHaveBeenCalled();
    });

    test('closes the suggestion as the signed-in admin', async () => {
      const result = await post(url);
      expect(result).toEqual({ status: 200, body: { enabled: true, dismissed: true } });
      expect(suggestions.dismiss).toHaveBeenCalledWith(CUSTOMER_ID, SUGGESTION_ID, 'actor-1');
    });

    test('says so when it was already closed', async () => {
      suggestions.dismiss.mockResolvedValue(null);
      const result = await post(url);
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('suggestion_changed');
    });

    test('rejects ids that are not uuids before any service call', async () => {
      expect((await post(`/api/admin/customer-geocodes/${CUSTOMER_ID}/pin-suggestions/not-a-uuid/dismiss`)).status).toBe(400);
      expect((await post(`/api/admin/customer-geocodes/bad/pin-suggestions/${SUGGESTION_ID}/dismiss`)).status).toBe(400);
      expect(suggestions.dismiss).not.toHaveBeenCalled();
    });

    test('answers 404 while address review itself is off', async () => {
      reviewStore.reviewEnabled.mockReturnValue(false);
      expect((await post(url)).status).toBe(404);
      expect(suggestions.dismiss).not.toHaveBeenCalled();
    });
  });
});
