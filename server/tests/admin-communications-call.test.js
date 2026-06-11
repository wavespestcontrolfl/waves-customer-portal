process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockCallCreate = jest.fn();

jest.mock('twilio', () => jest.fn(() => ({
  calls: { create: mockCallCreate },
})));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../config', () => ({
  twilio: {
    accountSid: 'AC_test',
    authToken: 'auth_test',
  },
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(() => Promise.resolve()),
}));

const express = require('express');
const db = require('../models/db');
const communicationsRouter = require('../routes/admin-communications');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');

function query({ result = [], returning } = {}) {
  const q = {};
  [
    'where',
    'whereNull',
    'whereRaw',
    'orderBy',
    'limit',
    'insert',
  ].forEach((method) => {
    q[method] = jest.fn(() => q);
  });
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/communications', communicationsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('admin communications voice route', () => {
  const originalAdamPhone = process.env.ADAM_PHONE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.ADAM_PHONE = '+19415993489';
    mockCallCreate.mockRejectedValue(new Error('Twilio voice unavailable'));
    db.mockImplementation((table) => {
      if (table === 'customers') return query({ result: [] });
      if (table === 'call_log') return query({ returning: [{ id: 'call-log-1' }] });
      throw new Error(`Unexpected table ${table}`);
    });
  });

  afterEach(() => {
    if (originalAdamPhone === undefined) delete process.env.ADAM_PHONE;
    else process.env.ADAM_PHONE = originalAdamPhone;
  });

  test('failure alert uses actual default caller ID and admin leg recipient', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/call`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: '+15551234567' }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.error).toBe('Twilio voice unavailable');
      expect(alertTwilioFailure).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'voice',
        direction: 'outbound',
        phase: 'send_api',
        from: '+19412975749',
        to: '+19415993489',
        link: '/admin/communications',
      }));
    });
  });

  test('rejects callback attempts that target the admin bridge phone', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/call`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          to: '+1 (941) 599-3489',
          fromNumber: '+19412972606',
          source: 'call-log-callback',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(400);
      expect(body.error).toBe('to must be a customer phone, not the admin bridge phone');
      expect(mockCallCreate).not.toHaveBeenCalled();
      expect(alertTwilioFailure).not.toHaveBeenCalled();
    });
  });
});
