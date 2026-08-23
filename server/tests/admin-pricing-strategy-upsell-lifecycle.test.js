// POST /trigger-upsell/:customerId must re-check lifecycle at the action boundary —
// an archived (deleted_at) or inactive customer is never texted, even from a stale row.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 't1'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
const mockFindBestUpsell = jest.fn();
jest.mock('../services/pricing-intelligence', () => ({ findBestUpsell: (...a) => mockFindBestUpsell(...a) }));
const mockSend = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSend(...a) }));

const express = require('express');
const db = require('../models/db');

let router;
beforeAll(() => { router = require('../routes/admin-pricing-strategy'); });

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/pricing-strategy', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

function setupCustomer(row) {
  db.mockImplementation(() => {
    const q = {};
    for (const m of ['where', 'whereNull', 'select', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => row);
    q.insert = jest.fn(async () => [1]);
    return q;
  });
}

describe('POST /trigger-upsell/:customerId lifecycle re-check', () => {
  beforeEach(() => { db.mockReset(); mockFindBestUpsell.mockReset(); mockSend.mockReset(); });

  test.each([
    ['archived', { id: 'c1', phone: '+15550000001', deleted_at: '2026-08-01T00:00:00Z', active: true }],
    ['inactive', { id: 'c1', phone: '+15550000001', deleted_at: null, active: false }],
    ['null-active legacy', { id: 'c1', phone: '+15550000001', deleted_at: null, active: null }],
  ])('%s customer → 409 and no upsell lookup / send', async (_label, row) => {
    setupCustomer(row);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/pricing-strategy/trigger-upsell/c1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('CUSTOMER_NOT_LIVE');
    });
    expect(mockFindBestUpsell).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  test('live customer proceeds to the upsell lookup', async () => {
    setupCustomer({ id: 'c1', phone: '+15550000001', deleted_at: null, active: true });
    mockFindBestUpsell.mockResolvedValue(null);
    await withServer(async (base) => {
      const res = await fetch(`${base}/admin/pricing-strategy/trigger-upsell/c1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(404); // "No upsell opportunity" — lookup ran
    });
    expect(mockFindBestUpsell).toHaveBeenCalledWith('c1');
  });
});
