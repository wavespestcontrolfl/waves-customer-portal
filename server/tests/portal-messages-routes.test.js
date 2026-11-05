/**
 * The customer's Messages routes (GATE_PORTAL_MESSAGES): signed-in only, 404 while dark, input checks, and
 * every route works on the signed-in customer's own row (never an id from the request). The thread rules
 * are pinned against Postgres in portal-messages-postgres.test.js; here the service is stubbed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockService = {
  customerThread: jest.fn(),
  customerUnread: jest.fn(),
  markRead: jest.fn(),
};
jest.mock('../services/portal-messages', () => ({
  ...jest.requireActual('../services/portal-messages'),
  customerThread: (...a) => mockService.customerThread(...a),
  customerUnread: (...a) => mockService.customerUnread(...a),
  markRead: (...a) => mockService.markRead(...a),
}));
const CUSTOMER = { id: '11111111-1111-4111-8111-111111111111', first_name: 'Pat', last_name: 'Synthetic' };
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => {
    if (req.headers.authorization !== 'Bearer customer') return res.status(401).json({ error: 'Authentication required' });
    req.customer = CUSTOMER;
    req.customerId = CUSTOMER.id;
    return next();
  },
}));

const express = require('express');
const router = require('../routes/portal-messages');
const { PortalMessageError } = jest.requireActual('../services/portal-messages');

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/portal-messages', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}/api/portal-messages`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const signedIn = { Authorization: 'Bearer customer', 'Content-Type': 'application/json' };
const OTHER = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';

describe('customer portal messages routes', () => {
  beforeEach(() => { jest.clearAllMocks(); process.env.GATE_PORTAL_MESSAGES = 'true'; });
  afterAll(() => { delete process.env.GATE_PORTAL_MESSAGES; });

  test('refuse a signed-out caller, and answer 404 for everything while the gate is off', async () => {
    await withServer(async (base) => {
      expect((await fetch(base)).status).toBe(401);
      process.env.GATE_PORTAL_MESSAGES = 'false';
      for (const [path, method] of [['', 'GET'], ['/unread-count', 'GET'], ['/read', 'POST']]) {
        const res = await fetch(`${base}${path}`, { method, headers: signedIn, ...(method === 'POST' ? { body: '{}' } : {}) });
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ enabled: false });
      }
    });
    expect(Object.values(mockService).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });

  test('every route uses the signed-in row, whatever customer id the request carries', async () => {
    mockService.customerThread.mockResolvedValue({ messages: [], hasMore: false, unread: 0 });
    mockService.customerUnread.mockResolvedValue(2);
    mockService.markRead.mockResolvedValue({ unread: 0 });
    await withServer(async (base) => {
      expect(await (await fetch(`${base}?customerId=${OTHER}`, { headers: signedIn })).json()).toEqual({ messages: [], hasMore: false, unread: 0 });
      expect(await (await fetch(`${base}/unread-count`, { headers: signedIn })).json()).toEqual({ count: 2 });
      const foreign = await fetch(`${base}/read`, { method: 'POST', headers: signedIn, body: JSON.stringify({ throughId: MSG, customerId: OTHER }) });
      expect(foreign.status).toBe(400); // unknown fields are refused, not ignored
      expect(await (await fetch(`${base}/read`, { method: 'POST', headers: signedIn, body: JSON.stringify({ throughId: MSG }) })).json()).toEqual({ unread: 0 });
    });
    expect(mockService.customerThread).toHaveBeenCalledWith(CUSTOMER.id, { before: null });
    expect(mockService.customerUnread).toHaveBeenCalledWith(CUSTOMER.id);
    expect(mockService.markRead).toHaveBeenCalledTimes(1);
    expect(mockService.markRead).toHaveBeenCalledWith(CUSTOMER.id, MSG);
  });

  test('input checks: a bad page time or a bad read id is a 400', async () => {
    await withServer(async (base) => {
      expect((await fetch(`${base}?before=yesterday`, { headers: signedIn })).status).toBe(400);
      expect((await fetch(`${base}/read`, { method: 'POST', headers: signedIn, body: JSON.stringify({ throughId: 'x' }) })).status).toBe(400);
      expect((await fetch(`${base}/read`, { method: 'POST', headers: signedIn, body: '{}' })).status).toBe(400);
    });
    expect(mockService.customerThread).not.toHaveBeenCalled();
    expect(mockService.markRead).not.toHaveBeenCalled();
  });

  test('a page time is passed on as ISO; a service refusal keeps its status and words', async () => {
    mockService.customerThread.mockResolvedValue({ messages: [], hasMore: false, unread: 0 });
    mockService.markRead.mockRejectedValueOnce(new PortalMessageError('not_found', 404));
    await withServer(async (base) => {
      await fetch(`${base}?before=2026-11-04T20:00:00Z`, { headers: signedIn });
      const res = await fetch(`${base}/read`, { method: 'POST', headers: signedIn, body: JSON.stringify({ throughId: MSG }) });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found', code: 'not_found' });
    });
    expect(mockService.customerThread).toHaveBeenCalledWith(CUSTOMER.id, { before: '2026-11-04T20:00:00.000Z' });
  });
});
