// Technician texting scope (owner 2026-10-02; codex #5568 r2 P1): a technician
// reads and sends texts only with customers on their own current/recent route.
// Real role middlewares; adminAuthenticate is stubbed to pick the role; the
// ownership predicate is mocked so denial paths return before any other query.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
let mockServices = false;
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((x) => x);
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, res, next) => {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (token !== 'tech' && token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
      req.technician = { id: `${token}-1`, role: token === 'tech' ? 'technician' : 'admin' };
      req.technicianId = req.technician.id;
      req.techRole = req.technician.role;
      return next();
    },
  };
});
jest.mock('../services/technician-visit-scope', () => ({
  isTechnicianRequest: (req) => req.techRole === 'technician',
  technicianServicesCustomer: jest.fn(async (req) => (req.techRole !== 'technician' ? true : mockServices)),
  technicianCustomerIdsSubquery: jest.fn(() => 'SCOPED_CUSTOMER_IDS'),
  technicianCurrentVisitFilter: jest.fn((req, q) => q),
}));
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => (function Anthropic() { return { messages: { create: jest.fn() } }; }));
const mockSendPrep = jest.fn(async () => ({ ok: true }));
jest.mock('../services/prep-guide-sender', () => ({ ...jest.requireActual('../services/prep-guide-sender'), sendPrepToCustomer: (...a) => mockSendPrep(...a) }));
const mockMarkRead = jest.fn(async () => ({ updated: 1, notificationsCleared: 0 }));
jest.mock('../services/inbound-sms-read', () => ({ markInboundSmsRead: (...a) => mockMarkRead(...a), countUnreadInboundSms: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const scope = require('../services/technician-visit-scope');
const router = require('../routes/admin-communications');

const CUSTOMER = '11111111-2222-4333-8444-555555555555';

function chain(firstResult = null) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNot', 'orWhere', 'orWhereNotIn', 'leftJoin', 'join', 'joinRaw', 'select', 'orderBy', 'orderByRaw', 'limit', 'offset', 'modify', 'clone', 'clearSelect', 'clearOrder', 'whereRaw', 'groupBy', 'count']) q[m] = jest.fn(() => q);
  q.first = jest.fn(async () => firstResult);
  q.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  return q;
}

async function call(method, path, token, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/communications', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockServices = false;
  db.mockImplementation(() => { throw new Error('db must not be reached'); });
});

describe('the guard', () => {
  const resStub = () => { const r = { status: jest.fn(function (c) { this.code = c; return this; }), json: jest.fn(function (b) { this.body = b; return this; }) }; return r; };
  test('an admin passes without a lookup', async () => {
    const res = resStub();
    await expect(router._technicianCustomerGuard({ techRole: 'admin' }, res, null)).resolves.toBe(true);
    expect(scope.technicianServicesCustomer).not.toHaveBeenCalled();
  });
  test('a technician with no customer is refused (403), with a foreign customer 404, with their own passes', async () => {
    let res = resStub();
    await expect(router._technicianCustomerGuard({ techRole: 'technician' }, res, null)).resolves.toBe(false);
    expect(res.code).toBe(403);
    expect(res.body.code).toBe('TECHNICIAN_SCOPE');
    res = resStub();
    await expect(router._technicianCustomerGuard({ techRole: 'technician' }, res, CUSTOMER)).resolves.toBe(false);
    expect(res.code).toBe(404);
    mockServices = true;
    res = resStub();
    await expect(router._technicianCustomerGuard({ techRole: 'technician' }, res, CUSTOMER)).resolves.toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('routes', () => {
  test('GET /stats is admin-only', async () => {
    expect((await call('GET', '/api/admin/communications/stats', 'tech')).status).toBe(403);
  });

  test('GET /log?customerId= for a customer off the route → 404 before any query', async () => {
    const res = await call('GET', `/api/admin/communications/log?customerId=${CUSTOMER}`, 'tech');
    expect(res.status).toBe(404);
    expect(db).not.toHaveBeenCalled();
  });

  test('POST /send-prep for a customer off the route → 404 before the sender runs; on-route sends', async () => {
    expect((await call('POST', '/api/admin/communications/send-prep', 'tech', { customerId: CUSTOMER, pestType: 'flea', channel: 'sms' })).status).toBe(404);
    expect(mockSendPrep).not.toHaveBeenCalled();
    mockServices = true;
    expect((await call('POST', '/api/admin/communications/send-prep', 'tech', { customerId: CUSTOMER, pestType: 'flea', channel: 'sms' })).status).not.toBe(404);
    expect(mockSendPrep).toHaveBeenCalledTimes(1);
  });

  test('POST /messages/read on a message outside the route → 404 before the read runs', async () => {
    db.mockImplementation(() => chain({ id: 'm1' }));
    const res = await call('POST', '/api/admin/communications/messages/read', 'tech', { messageIds: ['m1'] });
    expect(res.status).toBe(404);
    expect(mockMarkRead).not.toHaveBeenCalled();
    expect(scope.technicianCustomerIdsSubquery).toHaveBeenCalled();
  });

  test('POST /messages/read on own-route messages reads; an admin skips the ownership query', async () => {
    db.mockImplementation(() => chain(null));
    expect((await call('POST', '/api/admin/communications/messages/read', 'tech', { messageIds: ['m1'] })).status).toBe(200);
    expect(mockMarkRead).toHaveBeenCalledTimes(1);
    db.mockImplementation(() => { throw new Error('db must not be reached'); });
    expect((await call('POST', '/api/admin/communications/messages/read', 'admin', { messageIds: ['m1'] })).status).toBe(200);
  });

  test('GET /agent-draft for a technician requires an on-route customer', async () => {
    expect((await call('GET', `/api/admin/communications/agent-draft?phone=9415550100`, 'tech')).status).toBe(403);
    expect((await call('GET', `/api/admin/communications/agent-draft?customerId=${CUSTOMER}`, 'tech')).status).toBe(404);
  });
});
