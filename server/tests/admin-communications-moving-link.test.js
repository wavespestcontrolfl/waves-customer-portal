/**
 * POST /admin/communications/moving-link: the SMS composer's "Moving link"
 * helper (GATE_MOVING_FLOW). With a selected customer the full 10-digit phone
 * must match it (as /reservice-link); with none (a new text opened from
 * Customer 360 by phone) the number must belong to exactly one customer. It
 * opens (or reuses) the customer's move and answers the link; it never sends
 * a text itself.
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
    const role = token === 'admin' ? 'admin' : token === 'tech' ? 'technician' : null;
    if (!role) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: `${role}-1`, role };
    req.technicianId = `${role}-1`;
    req.techRole = role;
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (req, res, next) => (
    req.techRole !== 'admin'
      ? res.status(403).json({ error: 'Admin access required' })
      : next()
  ),
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
let mockMovingOn = true;
jest.mock('../config/feature-gates', () => ({
  isEnabled: () => true,
  gates: {},
  logGateStatus: jest.fn(),
  movingFlowLive: () => mockMovingOn,
}));
jest.mock('../services/customer-moves', () => ({
  openMoveForCustomer: jest.fn(async () => ({ id: 'move-1', status: 'open' })),
  movingLinkFor: jest.fn(async () => 'https://wvs.example/m/abc123'),
}));
jest.mock('@anthropic-ai/sdk', () => (
  jest.fn().mockImplementation(() => ({
    messages: { create: jest.fn() },
  }))
));
jest.mock('../services/reschedule-link', () => ({
  buildRescheduleLink: jest.fn(),
  smsLineFor: jest.fn(() => ''),
}));
jest.mock('../services/reservice-scheduler', () => ({
  reserviceSelfServeEnabled: jest.fn(() => true),
  loadEligibleReserviceLanesStrict: jest.fn(async () => []),
}));
jest.mock('../services/reservice-link', () => ({
  buildReserviceLink: jest.fn(),
}));

const express = require('express');
const db = require('../models/db');
const communicationsRouter = require('../routes/admin-communications');
const Moves = require('../services/customer-moves');

const CUSTOMER_UUID = '3f2b8c4e-9d1a-4f6b-8e2c-5a7d9b1c3e5f';

// first() answers the selected-customer lookup; select() the phone lookup.
function wireCustomer(row, phoneMatches = []) {
  db.mockImplementation((table) => {
    if (table !== 'customers') throw new Error(`unexpected table ${table}`);
    const b = {};
    b.where = jest.fn(() => b);
    b.whereNull = jest.fn(() => b);
    b.whereRaw = jest.fn(() => b);
    b.limit = jest.fn(() => b);
    b.first = jest.fn(async () => row);
    b.select = jest.fn(async () => phoneMatches);
    return b;
  });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/communications', communicationsRouter);
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function post(baseUrl, body, token = 'admin') {
  return fetch(`${baseUrl}/admin/communications/moving-link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

describe('POST /admin/communications/moving-link', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    db.mockReset();
    mockMovingOn = true;
  });

  test('404 while GATE_MOVING_FLOW is dark, before any lookup', async () => {
    mockMovingOn = false;
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234', customerId: CUSTOMER_UUID });
      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/not enabled/);
      expect(db).not.toHaveBeenCalled();
      expect(Moves.openMoveForCustomer).not.toHaveBeenCalled();
    });
  });

  test('technicians are refused', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234', customerId: CUSTOMER_UUID }, 'tech');
      expect(res.status).toBe(403);
    });
  });

  test('needs a full phone and a well-formed customer id', async () => {
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { phone: '555', customerId: CUSTOMER_UUID })).status).toBe(400);
      const bad = await post(baseUrl, { phone: '9415551234', customerId: 'not-a-uuid' });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe('Pick the customer first');
      expect(Moves.openMoveForCustomer).not.toHaveBeenCalled();
    });
  });

  test('with no selected customer, a number on exactly one customer resolves to that customer', async () => {
    wireCustomer(null, [{ id: CUSTOMER_UUID, phone: '+19415551234', first_name: 'Chris' }]);
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ url: 'wvs.example/m/abc123', customerId: CUSTOMER_UUID, moveId: 'move-1', firstName: 'Chris' });
      expect(Moves.openMoveForCustomer).toHaveBeenCalledWith(CUSTOMER_UUID, { actorId: 'admin-1' });
    });
  });

  test('with no selected customer, an unknown or shared number makes no link', async () => {
    wireCustomer(null, []);
    await withServer(async (baseUrl) => {
      expect((await post(baseUrl, { phone: '9415551234' })).status).toBe(404);
    });
    wireCustomer(null, [{ id: CUSTOMER_UUID, phone: '+19415551234' }, { id: '5d1c7e2a-8b3f-4a6d-9e1c-2b7f4d8a6c3e', phone: '9415551234' }]);
    await withServer(async (baseUrl) => {
      const shared = await post(baseUrl, { phone: '9415551234' });
      expect(shared.status).toBe(409);
      expect((await shared.json()).error).toMatch(/more than one customer/);
    });
    expect(Moves.openMoveForCustomer).not.toHaveBeenCalled();
  });

  test('the phone must match the selected customer', async () => {
    wireCustomer({ id: CUSTOMER_UUID, phone: '+19415550000', first_name: 'Chris' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '9415551234', customerId: CUSTOMER_UUID });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/must match/);
      expect(Moves.openMoveForCustomer).not.toHaveBeenCalled();
    });
  });

  test('answers the link without the scheme, the move id and the first name', async () => {
    wireCustomer({ id: CUSTOMER_UUID, phone: '+19415551234', first_name: 'Chris Robert' });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, { phone: '(941) 555-1234', customerId: CUSTOMER_UUID });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ url: 'wvs.example/m/abc123', customerId: CUSTOMER_UUID, moveId: 'move-1', firstName: 'Chris' });
      expect(Moves.openMoveForCustomer).toHaveBeenCalledWith(CUSTOMER_UUID, { actorId: 'admin-1' });
    });
  });
});
