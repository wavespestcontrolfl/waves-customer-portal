/**
 * GET /admin/communications/reschedule-link — the SMS composer's
 * "Reschedule Link" helper. Covers customer resolution (customerId wins,
 * phone fallback), the upcoming-visit picker (status gate + ET day frame),
 * and the link/appointment response shape. Link building itself is covered
 * by reschedule-public.test.js — buildRescheduleLink is mocked here.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn(async (cb) => cb(fn));
  return fn;
});
jest.mock('../services/twilio', () => ({}));
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
  alertTwilioFailure: jest.fn(),
}));
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
jest.mock('../services/sms-auto-send', () => ({
  hasActiveAutoSendClaim: jest.fn(async () => false),
}));
jest.mock('../config/feature-gates', () => ({
  isEnabled: () => true,
  gates: {},
  logGateStatus: jest.fn(),
}));
jest.mock('@anthropic-ai/sdk', () => (
  jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  }))
));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: jest.fn(),
  smsLineFor: jest.fn((url) => (url ? `Need a different time? Reschedule online: ${url}\n\n` : '')),
}));

const express = require('express');
const db = require('../models/db');
const communicationsRouter = require('../routes/admin-communications');
const { buildRescheduleLink } = require('../services/reschedule-link');

const CUSTOMER_UUID = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';

function makeFirstBuilder(row = null) {
  const b = {};
  b.where = jest.fn(() => b);
  b.whereIn = jest.fn(() => b);
  b.orderBy = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(row));
  return b;
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

function get(baseUrl, qs) {
  return fetch(`${baseUrl}/admin/communications/reschedule-link${qs}`, {
    headers: { Authorization: 'Bearer admin' },
  });
}

describe('GET /admin/communications/reschedule-link', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
  });

  test('400 when neither phone nor customerId is provided', async () => {
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '');
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/phone or customerId/);
      expect(db).not.toHaveBeenCalledWith('scheduled_services');
    });
  });

  test('404 when no customer matches the phone', async () => {
    const customers = makeFirstBuilder(null);
    db.mockImplementation((table) => (table === 'customers' ? customers : makeFirstBuilder(null)));
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=%2B15551234567');
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/No customer/);
      // Last-10-digit LIKE match — the same resolution /ai-draft uses.
      expect(customers.where).toHaveBeenCalledWith('phone', 'like', '%5551234567');
    });
  });

  test('404 when the customer has no upcoming reschedulable visit; picker uses the status gate + ET day frame', async () => {
    const customers = makeFirstBuilder({ id: CUSTOMER_UUID });
    const services = makeFirstBuilder(null);
    db.mockImplementation((table) => (table === 'customers' ? customers : services));
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=5551234567');
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/No upcoming appointment/);
      expect(services.whereIn).toHaveBeenCalledWith('status', ['pending', 'confirmed', 'rescheduled']);
      // DATE column compared against the ET 'YYYY-MM-DD' day string — never a
      // hand-built timestamp (the timestamptz window trap doesn't apply, but
      // the frame must still be ET, not UTC).
      const dateWhere = services.where.mock.calls.find((c) => c[0] === 'scheduled_date');
      expect(dateWhere).toBeDefined();
      expect(dateWhere[1]).toBe('>=');
      expect(dateWhere[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(buildRescheduleLink).not.toHaveBeenCalled();
    });
  });

  test('a valid customerId wins over the phone fallback', async () => {
    const customers = makeFirstBuilder({ id: CUSTOMER_UUID });
    const services = makeFirstBuilder(null);
    db.mockImplementation((table) => (table === 'customers' ? customers : services));
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, `?phone=5551234567&customerId=${CUSTOMER_UUID}`);
      expect(res.status).toBe(404); // no visit — but resolution path is what's under test
      expect(customers.where).toHaveBeenCalledWith({ id: CUSTOMER_UUID });
      expect(customers.where).not.toHaveBeenCalledWith('phone', 'like', '%5551234567');
    });
  });

  test('a malformed customerId falls back to phone instead of reaching the uuid column', async () => {
    const customers = makeFirstBuilder({ id: CUSTOMER_UUID });
    const services = makeFirstBuilder(null);
    db.mockImplementation((table) => (table === 'customers' ? customers : services));
    await withServer(async (baseUrl) => {
      await get(baseUrl, '?phone=5551234567&customerId=not-a-uuid');
      expect(customers.where).not.toHaveBeenCalledWith({ id: 'not-a-uuid' });
      expect(customers.where).toHaveBeenCalledWith('phone', 'like', '%5551234567');
    });
  });

  test('200 returns the link, the SMS clause, and the visit the link points to', async () => {
    const customers = makeFirstBuilder({ id: CUSTOMER_UUID });
    const services = makeFirstBuilder({
      id: 'svc-1',
      // pg can hand DATE columns back as a JS Date — the route must
      // normalize to 'YYYY-MM-DD'.
      scheduled_date: new Date('2026-08-04T00:00:00Z'),
      window_start: '08:00:00',
      service_type: 'lawn care',
      status: 'confirmed',
    });
    db.mockImplementation((table) => (table === 'customers' ? customers : services));
    buildRescheduleLink.mockResolvedValue({
      url: 'https://wvs.example/r/abc123',
      line: 'Need a different time? Reschedule online: https://wvs.example/r/abc123\n\n',
    });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=5551234567');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        url: 'https://wvs.example/r/abc123',
        line: 'Need a different time? Reschedule online: https://wvs.example/r/abc123\n\n',
        appointment: {
          id: 'svc-1',
          scheduledDate: '2026-08-04',
          windowStart: '08:00',
          serviceType: 'lawn care',
          status: 'confirmed',
        },
      });
      expect(buildRescheduleLink).toHaveBeenCalledWith('svc-1', { customerId: CUSTOMER_UUID });
    });
  });

  test('404 when the visit has no usable link (legacy tokenless row)', async () => {
    const customers = makeFirstBuilder({ id: CUSTOMER_UUID });
    const services = makeFirstBuilder({
      id: 'svc-legacy',
      scheduled_date: '2026-08-04',
      window_start: null,
      service_type: 'pest control',
      status: 'pending',
    });
    db.mockImplementation((table) => (table === 'customers' ? customers : services));
    buildRescheduleLink.mockResolvedValue({ url: null, line: '' });
    await withServer(async (baseUrl) => {
      const res = await get(baseUrl, '?phone=5551234567');
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/no reschedule link/);
    });
  });

  test('401 without an admin token', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/communications/reschedule-link?phone=5551234567`);
      expect(res.status).toBe(401);
    });
  });
});
