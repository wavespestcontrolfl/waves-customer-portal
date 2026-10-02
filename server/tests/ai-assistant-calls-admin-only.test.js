// A technician login gets no customer calls (owner 2026-10-02): the call log
// the Calls tab reads — list, single call (transcript), routing calibration,
// route feedback — is admin-only. The role middlewares are the REAL ones.
let mockRole = 'technician';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config', () => ({ jwt: { secret: 'test-jwt-secret' } }));
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    ...actual,
    adminAuthenticate: (req, _res, next) => {
      req.technicianId = 'staff-1';
      req.techRole = mockRole;
      next();
    },
  };
});
jest.mock('../middleware/auth', () => ({ authenticate: (req, res, next) => next() }));
jest.mock('../services/ai-assistant/assistant', () => ({}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/ai-assistant');

const CALL_ID = '11111111-2222-4333-8444-555555555555';

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/ai', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

function call(base, method, path, body) {
  return fetch(`${base}/api/ai${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

// Every row carries a body slot (null = none): a two-value row would make
// jest pass its `done` callback as the third argument.
const CALL_LOG_ROUTES = [
  ['GET', '/admin/calls', null],
  ['GET', `/admin/calls?id=${CALL_ID}`, null],
  ['GET', '/admin/calls?search=smith', null],
  ['GET', '/admin/calls/route-calibration?days=30', null],
  ['GET', `/admin/calls/${CALL_ID}`, null],
  ['POST', `/admin/calls/${CALL_ID}/route-feedback`, { verdict: 'correct' }],
];

beforeEach(() => {
  jest.clearAllMocks();
  db.mockImplementation(() => { throw new Error('db must not be reached'); });
  db.raw = jest.fn(() => { throw new Error('db must not be reached'); });
  db.schema = { hasTable: jest.fn(async () => { throw new Error('db must not be reached'); }) };
});

describe('the call log is admin-only', () => {
  test.each(CALL_LOG_ROUTES)('%s %s → 403 for a technician, before any data access', async (method, path, body) => {
    mockRole = 'technician';
    await withServer(async (base) => {
      const res = await call(base, method, path, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Admin access required' });
    });
    expect(db).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
    expect(db.schema.hasTable).not.toHaveBeenCalled();
  });

  test.each(CALL_LOG_ROUTES)('%s %s is not refused by the role gate for an admin', async (method, path, body) => {
    mockRole = 'admin';
    await withServer(async (base) => {
      const res = await call(base, method, path, body);
      // The stubbed db makes the handler fail; the role gate must not.
      expect(res.status).not.toBe(403);
    });
  });
});
