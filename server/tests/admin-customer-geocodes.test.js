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
jest.mock('../services/customer-geocode-review', () => ({
  reviewEnabled: jest.fn(),
  getReviewDetail: jest.fn(),
  listReviewQueue: jest.fn(),
}));
jest.mock('../services/customer-geocode-review-actions', () => ({
  resolveCustomerGeocodeReview: jest.fn(),
}));

const express = require('express');
const reviewStore = require('../services/customer-geocode-review');
const actions = require('../services/customer-geocode-review-actions');
const router = require('../routes/admin-customer-geocodes');

const CUSTOMER_ID = '11111111-2222-4333-8444-555555555555';
let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/customer-geocodes', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  server = await new Promise(resolve => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  if (server) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Connection: 'close', ...options.headers },
  });
  return { status: response.status, body: await response.json() };
}

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };

beforeEach(() => {
  jest.resetAllMocks();
  reviewStore.reviewEnabled.mockReturnValue(true);
});

test('router requires an authenticated administrator', async () => {
  expect((await request('/api/admin/customer-geocodes')).status).toBe(401);
  expect((await request('/api/admin/customer-geocodes', { headers: { Authorization: 'Bearer tech' } })).status).toBe(403);
  for (const [authorization, status] of [['', 401], ['Bearer tech', 403]]) {
    const result = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, {
      method: 'POST',
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: 'rev-1', action: 'retry' }),
    });
    expect(result.status).toBe(status);
  }
  expect(actions.resolveCustomerGeocodeReview).not.toHaveBeenCalled();
});

test('dark gate makes GET inert and POST unavailable without service calls', async () => {
  reviewStore.reviewEnabled.mockReturnValue(false);
  expect(await request('/api/admin/customer-geocodes?limit=bad', { headers: admin }))
    .toEqual({ status: 200, body: { enabled: false } });
  expect(await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, {
    method: 'POST', headers: admin, body: JSON.stringify({}),
  })).toEqual({ status: 404, body: { enabled: false } });
  expect(reviewStore.listReviewQueue).not.toHaveBeenCalled();
  expect(actions.resolveCustomerGeocodeReview).not.toHaveBeenCalled();
});

test('list applies bounded pagination and returns the UI contract', async () => {
  reviewStore.listReviewQueue.mockResolvedValue({ records: [{ customer: { id: CUSTOMER_ID } }], total: 1 });
  const result = await request('/api/admin/customer-geocodes?limit=25&offset=50', { headers: admin });
  expect(result).toEqual({
    status: 200,
    body: { enabled: true, records: [{ customer: { id: CUSTOMER_ID } }], total: 1 },
  });
  expect(reviewStore.listReviewQueue).toHaveBeenCalledWith({ limit: 25, offset: 50 });
});

test('detail returns 404 for a missing customer', async () => {
  reviewStore.getReviewDetail.mockResolvedValue(null);
  expect(await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}`, { headers: admin }))
    .toEqual({ status: 404, body: { error: 'Customer not found' } });
});

test('verify_pin strictly requires confirmation, complete evidence and a complete address object', async () => {
  const valid = {
    revision: 'rev-1', action: 'verify_pin', latitude: 27.5, longitude: -82.5,
    address: { address_line1: '100 Test St', address_line2: '', city: 'Sarasota', state: 'FL', zip: '34236' },
    source: 'site_visit', evidence: 'Confirmed at the service location', confirmed: true,
  };
  for (const patch of [
    { confirmed: false },
    { confirmed: 'true' },
    { latitude: '27.5' },
    { longitude: '-82.5' },
    { evidence: ' ' },
    { source: 'provider_guess' },
    { address: { address_line1: '100 Test St' } },
    { address: { ...valid.address, email: 'fixture@example.test' } },
    { actorId: 'another-actor' },
  ]) {
    const bad = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, {
      method: 'POST', headers: admin, body: JSON.stringify({ ...valid, ...patch }),
    });
    expect(bad.status).toBe(400);
    expect(actions.resolveCustomerGeocodeReview).not.toHaveBeenCalled();
  }

  const unknown = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, {
    method: 'POST', headers: admin, body: JSON.stringify({
      revision: 'rev-1', action: 'retry', confirmed: true,
    }),
  });
  expect(unknown).toEqual({
    status: 400,
    body: { error: '"value" does not match any of the allowed types' },
  });
  expect(actions.resolveCustomerGeocodeReview).not.toHaveBeenCalled();
});

test('resolve passes normalized verified input and actor ownership to the action service', async () => {
  actions.resolveCustomerGeocodeReview.mockResolvedValue({
    customer: { id: CUSTOMER_ID }, review: { status: 'verified' }, revision: 'rev-2', next_visit_date: null,
  });
  const payload = {
    revision: 'rev-1', action: 'verify_pin',
    address: { address_line1: '100 Test St', address_line2: '', city: 'Sarasota', state: 'fl', zip: '34236' },
    latitude: 27.3364, longitude: -82.5307, source: 'site_visit', evidence: 'Observed marker', confirmed: true,
  };
  const result = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, {
    method: 'POST', headers: admin, body: JSON.stringify(payload),
  });
  expect(result.status).toBe(200);
  expect(result.body.enabled).toBe(true);
  expect(actions.resolveCustomerGeocodeReview).toHaveBeenCalledWith(
    CUSTOMER_ID,
    expect.objectContaining({ address: expect.objectContaining({ state: 'FL' }) }),
    'actor-1',
  );
});

test('resolve maps changed-data conflicts without hiding the error code', async () => {
  actions.resolveCustomerGeocodeReview.mockRejectedValue(Object.assign(
    new Error('Customer location data changed.'), { statusCode: 409, code: 'review_changed' },
  ));
  const result = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, {
    method: 'POST', headers: admin, body: JSON.stringify({ revision: 'rev-1', action: 'revoke' }),
  });
  expect(result).toEqual({
    status: 409,
    body: { error: 'Customer location data changed.', code: 'review_changed' },
  });
});

test('resolve trusts the service address conflict and does not mislabel an unknown 23505', async () => {
  actions.resolveCustomerGeocodeReview.mockRejectedValueOnce(Object.assign(
    new Error('That address already exists as another property on this customer.'),
    { statusCode: 409, code: 'address_matches_existing_property' },
  ));
  const conflict = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, {
    method: 'POST', headers: admin, body: JSON.stringify({ revision: 'rev-1', action: 'revoke' }),
  });
  expect(conflict).toEqual({
    status: 409,
    body: {
      error: 'That address already exists as another property on this customer.',
      code: 'address_matches_existing_property',
    },
  });

  actions.resolveCustomerGeocodeReview.mockRejectedValueOnce(Object.assign(
    new Error('Unrelated unique constraint failed.'), { code: '23505', constraint: 'unrelated_unique' },
  ));
  const unknown = await request(`/api/admin/customer-geocodes/${CUSTOMER_ID}/resolve`, {
    method: 'POST', headers: admin, body: JSON.stringify({ revision: 'rev-1', action: 'revoke' }),
  });
  expect(unknown).toEqual({ status: 500, body: { error: 'Unrelated unique constraint failed.' } });
});
