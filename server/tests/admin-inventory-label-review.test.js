jest.mock('../models/db', () => { const db = jest.fn(); db.raw = jest.fn(); db.schema = { hasTable: jest.fn() }; return db; });
jest.mock('../services/product-label-review', () => ({ getLabelReview: jest.fn(), extractLabelReview: jest.fn(), decideLabelReview: jest.fn(), revokeLabelReview: jest.fn() }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => { if (!req.headers.authorization) return res.status(401).end(); req.technicianId = '22222222-2222-4333-8444-555555555555'; req.testRole = req.headers.authorization; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => req.testRole === 'admin' ? next() : res.status(403).end(),
}));
const express = require('express');
const reviews = require('../services/product-label-review');
const router = require('../routes/admin-inventory');
const { errorHandler } = require('../middleware/errors');
const { labelError } = require('../services/epa-product-label');
const PRODUCT = '11111111-2222-4333-8444-555555555555';
let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/admin/inventory', router);
  app.use(errorHandler);
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/api/admin/inventory`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => { jest.clearAllMocks(); process.env.GATE_LABEL_PIPELINE = 'true'; });
afterEach(() => { delete process.env.GATE_LABEL_PIPELINE; });
const call = (path, { method = 'GET', role = 'admin', body } = {}) => fetch(base + path, {
  method, headers: { ...(role ? { Authorization: role } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
});
test.each([404, 409, 422, 502])('production error handler preserves expected label error %s', async status => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    reviews.getLabelReview.mockRejectedValueOnce(labelError('Review must be refreshed.', status));
    const response = await call(`/${PRODUCT}/label-review`);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: 'Review must be refreshed.' });
  } finally { process.env.NODE_ENV = prior; }
});
test.each(['', 'technician'])('requires authenticated admin for label reads and mutations (%s)', async role => {
  for (const [path, method] of [['/label-pipeline', 'GET'], [`/${PRODUCT}/label-review`, 'GET'], [`/${PRODUCT}/label-review/extract`, 'POST'], [`/${PRODUCT}/label-review/decision`, 'POST'], [`/${PRODUCT}/label-review/revoke`, 'POST']]) {
    expect((await call(path, { role, method, body: method === 'POST' ? {} : undefined })).status).toBe(role ? 403 : 401);
  }
  expect(reviews.getLabelReview).not.toHaveBeenCalled(); expect(reviews.extractLabelReview).not.toHaveBeenCalled();
});
test('gate-off and invalid ids stop before service work', async () => {
  delete process.env.GATE_LABEL_PIPELINE;
  expect(await (await call('/label-pipeline')).json()).toEqual({ enabled: false });
  expect((await call(`/${PRODUCT}/label-review/extract`, { method: 'POST', body: {} })).status).toBe(404);
  process.env.GATE_LABEL_PIPELINE = 'true';
  expect((await call('/invalid/label-review')).status).toBe(400);
  expect(reviews.extractLabelReview).not.toHaveBeenCalled(); expect(reviews.getLabelReview).not.toHaveBeenCalled();
});
test('GET loads evidence without running extraction', async () => {
  reviews.getLabelReview.mockResolvedValue({ enabled: true, review: null });
  expect(await (await call(`/${PRODUCT}/label-review`)).json()).toEqual({ enabled: true, review: null });
  expect(reviews.extractLabelReview).not.toHaveBeenCalled();
});
test('explicit extract and approval forward the authenticated actor', async () => {
  reviews.extractLabelReview.mockResolvedValue({ enabled: true, review: { draft: { id: PRODUCT } } });
  expect((await call(`/${PRODUCT}/label-review/extract`, { method: 'POST', body: {} })).status).toBe(200);
  expect(reviews.extractLabelReview).toHaveBeenCalledWith(PRODUCT, '22222222-2222-4333-8444-555555555555');
  const body = { candidateId: PRODUCT, decision: 'approve', identityConfirmed: true };
  reviews.decideLabelReview.mockResolvedValue({ enabled: true });
  expect((await call(`/${PRODUCT}/label-review/decision`, { method: 'POST', body })).status).toBe(200);
  expect(reviews.decideLabelReview).toHaveBeenCalledWith(PRODUCT, '22222222-2222-4333-8444-555555555555', body);
});
