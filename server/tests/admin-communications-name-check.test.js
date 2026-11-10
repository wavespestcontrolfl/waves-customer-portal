/**
 * POST /admin/communications/name-check: the composer's note when a greeting uses another
 * listed spelling of the customer's first name. Read-only; answers the fixes and the fixed text.
 * Only a count is logged, never the words.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/twilio', () => ({}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const role = token === 'admin' ? 'admin' : token === 'tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: `${role}-1`, role };
    req.technicianId = `${role}-1`;
    req.techRole = role;
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/technician-visit-scope', () => ({
  isTechnicianRequest: (req) => req.techRole === 'technician',
  technicianServicesCustomer: jest.fn(async () => false),
  technicianCustomerIdsSubquery: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-media', () => ({
  mediaFromOutboundAttachments: jest.fn(() => []),
  signMediaForClient: jest.fn(async (media) => media),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn() }));
jest.mock('../services/sms-suggest-mode', () => ({
  SUGGEST_WORKFLOW: 'sms_house_voice_suggest',
  HUMAN_REPLY_TYPES: ['manual', 'ai_approved', 'ai_revised'],
  revertDraftsToShadow: jest.fn(async () => 0),
  markSuggestionScheduled: jest.fn(async () => 1),
  parkThreadSuggestions: jest.fn(async () => []),
  reopenScheduledSuggestions: jest.fn(async () => 0),
  ignoreParkedSuggestions: jest.fn(async () => 0),
  lockSuggestThread: jest.fn(async () => {}),
}));
jest.mock('../services/sms-auto-send', () => ({ hasActiveAutoSendClaim: jest.fn(async () => false) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: () => true, gates: {}, logGateStatus: jest.fn() }));
jest.mock('@anthropic-ai/sdk', () => (
  jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } }))
));

const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { technicianServicesCustomer } = require('../services/technician-visit-scope');
const communicationsRouter = require('../routes/admin-communications');
const { technicianMayReach } = require('../middleware/technician-scope');

const CUSTOMER_UUID = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';

function wireCustomer(row) {
  const builder = { where: jest.fn(() => builder), first: jest.fn(() => Promise.resolve(row)) };
  db.mockImplementation(() => builder);
  return builder;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/communications', communicationsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, body, token = 'admin') {
  return fetch(`${baseUrl}/admin/communications/name-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /admin/communications/name-check', () => {
  beforeEach(() => {
    db.mockReset();
    logger.info.mockClear();
    technicianServicesCustomer.mockReset();
    technicianServicesCustomer.mockResolvedValue(false);
  });

  it('answers the fix and the fixed text when a greeting uses another listed spelling', async () => {
    const customers = wireCustomer({ first_name: 'Sara', last_name: 'Testa' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { customer_id: CUSTOMER_UUID, text: 'Hi Sarah, see you Friday.' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        fixes: [{ heard: 'Sarah', spelled: 'Sara' }],
        text: 'Hi Sara, see you Friday.',
      });
    });
    expect(customers.where).toHaveBeenCalledWith({ id: CUSTOMER_UUID });
  });

  it('answers no fix when the greeting already matches the record', async () => {
    wireCustomer({ first_name: 'Sara', last_name: 'Testa' });
    await withServer(async (baseUrl) => {
      const text = 'Hi Sara, see you Friday.';
      const res = await post(baseUrl, { customer_id: CUSTOMER_UUID, text });
      expect(await res.json()).toEqual({ fixes: [], text });
    });
  });

  it('answers no fix for an unknown customer', async () => {
    wireCustomer(undefined);
    await withServer(async (baseUrl) => {
      const text = 'Hi Sarah, see you Friday.';
      const res = await post(baseUrl, { customer_id: CUSTOMER_UUID, text });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ fixes: [], text });
    });
  });

  it('answers 400 for a bad id, a non-string text or an overlong text, and reads nothing', async () => {
    wireCustomer({ first_name: 'Sara', last_name: 'Testa' });
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { customer_id: 'not-a-uuid', text: 'Hi' })).status).toBe(400);
      expect((await post(baseUrl, { text: 'Hi' })).status).toBe(400);
      expect((await post(baseUrl, { customer_id: CUSTOMER_UUID, text: 42 })).status).toBe(400);
      expect((await post(baseUrl, { customer_id: CUSTOMER_UUID, text: 'a'.repeat(2001) })).status).toBe(400);
      expect((await post(baseUrl, { customer_id: CUSTOMER_UUID, text: 'a'.repeat(2000) })).status).toBe(200);
    });
    expect(db).toHaveBeenCalledTimes(1);
  });

  it('requires staff sign-in', async () => {
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { customer_id: CUSTOMER_UUID, text: 'Hi' }, null)).status).toBe(401);
    });
    expect(db).not.toHaveBeenCalled();
  });

  it('treats a customer outside a technician route as unknown', async () => {
    wireCustomer({ first_name: 'Sara', last_name: 'Testa' });
    await withServer(async (baseUrl) => {
      const text = 'Hi Sarah, see you Friday.';
      const res = await post(baseUrl, { customer_id: CUSTOMER_UUID, text }, 'tech');
      expect(await res.json()).toEqual({ fixes: [], text });
    });
    expect(db).not.toHaveBeenCalled();
    technicianServicesCustomer.mockResolvedValue(true);
    await withServer(async (baseUrl) => {
      wireCustomer({ first_name: 'Sara', last_name: 'Testa' });
      const res = await post(baseUrl, { customer_id: CUSTOMER_UUID, text: 'Hi Sarah,' }, 'tech');
      expect((await res.json()).fixes).toEqual([{ heard: 'Sarah', spelled: 'Sara' }]);
    });
  });

  it('logs a count and never the words', async () => {
    wireCustomer({ first_name: 'Sara', last_name: 'Testa' });
    await withServer(async (baseUrl) => {
      await post(baseUrl, { customer_id: CUSTOMER_UUID, text: 'Hi Sarah, the quiet password is swordfish.' });
    });
    const logged = JSON.stringify([
      ...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls,
    ]);
    expect(logged).toMatch(/1 greeting name fix/);
    for (const word of ['Sarah', 'Sara', 'swordfish', 'Testa', CUSTOMER_UUID]) {
      expect(logged).not.toContain(word);
    }
  });

  it('is on the technician allow list for POST only, so the default-deny scope lets it through', () => {
    expect(technicianMayReach('POST', '/api/admin/communications/name-check')).toBe(true);
    expect(technicianMayReach('GET', '/api/admin/communications/name-check')).toBe(false);
  });
});
