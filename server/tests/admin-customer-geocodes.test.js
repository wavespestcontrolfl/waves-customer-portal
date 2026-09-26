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

const express = require('express');
const reviewStore = require('../services/customer-geocode-review');
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
});

test('dark gate makes GET inert without service calls', async () => {
  reviewStore.reviewEnabled.mockReturnValue(false);
  expect(await request('/api/admin/customer-geocodes?limit=bad', { headers: admin }))
    .toEqual({ status: 200, body: { enabled: false } });
  expect(reviewStore.listReviewQueue).not.toHaveBeenCalled();
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
