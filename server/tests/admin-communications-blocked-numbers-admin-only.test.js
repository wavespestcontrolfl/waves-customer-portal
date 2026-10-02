/**
 * Block list role rule (owner 2026-10-02): any staff login may READ the
 * blocked numbers (the SMS tab labels blocked threads from the list); only an
 * admin may block or unblock — unblocking releases that number's held texts.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('twilio', () => jest.fn(() => ({ calls: { create: jest.fn() } })));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../config', () => ({ twilio: { accountSid: 'AC_test', authToken: 'auth_test' } }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!['admin', 'tech'].includes(token)) return res.status(401).json({ error: 'nope' });
    req.techRole = token === 'admin' ? 'admin' : 'technician';
    req.technicianId = token === 'admin' ? 'admin-1' : 'tech-1';
    req.technician = { id: req.technicianId, role: req.techRole };
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (req.techRole !== 'admin' ? res.status(403).json({ error: 'Admin access required' }) : next()),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(() => Promise.resolve()) }));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(() => Promise.resolve()) }));

const express = require('express');
const db = require('../models/db');
const communicationsRouter = require('../routes/admin-communications');

function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/communications', communicationsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/admin/communications`;
  return fn(base).finally(() => new Promise((r) => server.close(r)));
}

function call(base, role, method, path, body) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${role}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

const BLOCKED = [{ number: '+19415550100', blocked_at: '2026-10-01T00:00:00Z' }];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('block and unblock are admin-only', () => {
  test.each([
    ['POST', '/blocked-numbers', { number: '+19415550100' }],
    ['DELETE', '/blocked-numbers/%2B19415550100', null],
  ])('%s %s → 403 for a technician, and the table is never touched', async (method, path, body) => {
    db.mockImplementation(() => { throw new Error('db must not be reached'); });
    await withServer(async (base) => {
      const res = await call(base, 'tech', method, path, body);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'Admin access required' });
    });
    expect(db).not.toHaveBeenCalled();
  });

  test('an admin unblocks a number', async () => {
    const del = jest.fn(async () => 1);
    const where = jest.fn(() => ({ del }));
    db.mockImplementation((table) => {
      if (table === 'blocked_numbers') return { where };
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (base) => {
      const res = await call(base, 'admin', 'DELETE', '/blocked-numbers/%2B19415550100');
      expect(res.status).not.toBe(403);
    });
    expect(where).toHaveBeenCalledWith({ number: '+19415550100' });
    expect(del).toHaveBeenCalledTimes(1);
  });
});

describe('reading the block list stays staff-wide', () => {
  test.each(['tech', 'admin'])('%s reads the list', async (role) => {
    db.mockImplementation((table) => {
      if (table === 'blocked_numbers') return { orderBy: jest.fn(async () => BLOCKED) };
      throw new Error(`unexpected table ${table}`);
    });
    await withServer(async (base) => {
      const res = await call(base, role, 'GET', '/blocked-numbers');
      expect(res.status).toBe(200);
    });
  });
});
