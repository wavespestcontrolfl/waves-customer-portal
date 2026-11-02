/**
 * GATE_SMS_SPAM_TAG routes (owner 2026-11-02): Mark spam TAGS a sender.
 * Admin-only, 404 while the gate is off, the same 409 shapes as the block
 * route for a customer or an open lead. The service is mocked here; its SQL is
 * proven in sms-spam-tag-postgres.test.js.
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
jest.mock('../services/sms-spam-tag', () => ({
  spamTagLive: jest.fn(() => true),
  tagSpamSender: jest.fn(),
  untagSpamSender: jest.fn(),
}));

const express = require('express');
const spamTag = require('../services/sms-spam-tag');
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

function coded(code, message, details) {
  return Object.assign(new Error(message), { code, details });
}

beforeEach(() => {
  jest.clearAllMocks();
  spamTag.spamTagLive.mockReturnValue(true);
});

describe('gate off', () => {
  test.each([
    ['POST', '/spam-senders', { number: '+19415550100' }],
    ['DELETE', '/spam-senders/%2B19415550100', null],
  ])('%s %s answers 404 and touches nothing', async (method, path, body) => {
    spamTag.spamTagLive.mockReturnValue(false);
    await withServer(async (base) => {
      const res = await call(base, 'admin', method, path, body);
      expect(res.status).toBe(404);
    });
    expect(spamTag.tagSpamSender).not.toHaveBeenCalled();
    expect(spamTag.untagSpamSender).not.toHaveBeenCalled();
  });
});

describe('admin only', () => {
  test.each([
    ['POST', '/spam-senders', { number: '+19415550100' }],
    ['DELETE', '/spam-senders/%2B19415550100', null],
  ])('%s %s answers 403 to a technician', async (method, path, body) => {
    await withServer(async (base) => {
      const res = await call(base, 'tech', method, path, body);
      expect(res.status).toBe(403);
    });
    expect(spamTag.tagSpamSender).not.toHaveBeenCalled();
    expect(spamTag.untagSpamSender).not.toHaveBeenCalled();
  });
});

describe('POST /spam-senders', () => {
  test('tags the sender as the signed-in admin', async () => {
    spamTag.tagSpamSender.mockResolvedValue({ phone: '+19415550100', alreadyTagged: false, readFailed: false });
    await withServer(async (base) => {
      const res = await call(base, 'admin', 'POST', '/spam-senders', { number: '(941) 555-0100', reason: 'pitch' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, alreadyTagged: false, readFailed: false });
    });
    expect(spamTag.tagSpamSender).toHaveBeenCalledWith({
      number: '(941) 555-0100', adminUserId: 'admin-1', reason: 'pitch', source: 'inbox',
    });
  });

  test.each([
    ['CUSTOMER_NUMBER', { customer_id: 'c-1', customer_name: 'Synthetic Customer' }],
    ['LEAD_NUMBER', { lead_id: 'l-1' }],
  ])('%s answers 409 with the block route shape', async (code, details) => {
    spamTag.tagSpamSender.mockRejectedValue(coded(code, 'refused', details));
    await withServer(async (base) => {
      const res = await call(base, 'admin', 'POST', '/spam-senders', { number: '+19415550100' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'refused', code, ...details });
    });
  });

  test('an invalid number answers 400', async () => {
    spamTag.tagSpamSender.mockRejectedValue(coded('INVALID_NUMBER', 'valid number required'));
    await withServer(async (base) => {
      const res = await call(base, 'admin', 'POST', '/spam-senders', { number: 'abc' });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'valid number required' });
    });
  });

  test('an unexpected failure is a 500, not a silent success', async () => {
    spamTag.tagSpamSender.mockRejectedValue(new Error('db down'));
    await withServer(async (base) => {
      const res = await call(base, 'admin', 'POST', '/spam-senders', { number: '+19415550100' });
      expect(res.status).toBe(500);
    });
  });
});

describe('DELETE /spam-senders/:number', () => {
  test('removes the tag as the signed-in admin', async () => {
    spamTag.untagSpamSender.mockResolvedValue({ phone: '+19415550100', removed: true });
    await withServer(async (base) => {
      const res = await call(base, 'admin', 'DELETE', '/spam-senders/%2B19415550100');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, removed: true });
    });
    expect(spamTag.untagSpamSender).toHaveBeenCalledWith({ number: '+19415550100', adminUserId: 'admin-1' });
  });
});
