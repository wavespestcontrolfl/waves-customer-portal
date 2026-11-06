// Security audit run 3 (2026-11-05): POST /api/ai/chat had no per-customer
// limit. GATE_PORTAL_CHAT_CUSTOMER_CAP adds 10 turns a minute (memory) and 60 a
// day (Postgres counter), keyed on the authenticated customer id.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockCounts = new Map();
let mockRawError = null;
jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn().mockResolvedValue(true) };
  fn.raw = jest.fn(async (_sql, [bucket, day]) => {
    if (mockRawError) throw mockRawError;
    const key = `${bucket}|${day}`;
    const count = (mockCounts.get(key) || 0) + 1;
    mockCounts.set(key, count);
    return { rows: [{ count }] };
  });
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
}));
jest.mock('../services/ai-assistant/assistant', () => ({
  processMessage: jest.fn(),
}));
const mockPortalTurn = jest.fn(async (args) => ({
  ...await args.processTurn({ transaction: async (_s, work) => work({}) }),
  requestId: args.requestId,
}));
jest.mock('../services/ai-assistant/portal-turn', () => ({
  portalConversationIdentifier: (identifier) => identifier,
  runPortalTurn: (...args) => mockPortalTurn(...args),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/call-route-decisions', () => ({ preferredRouteDecisionForFeedback: jest.fn() }));
// The test picks the customer per request with the x-test-customer header.
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = req.headers['x-test-customer'] || 'cust-a';
    req.customer = { id: req.customerId, phone: null };
    next();
  },
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const WavesAssistant = require('../services/ai-assistant/assistant');
const aiRouter = require('../routes/ai-assistant');
const {
  checkPortalChatCustomerCap, resetPortalChatMinuteWindows,
  MINUTE_LIMIT_REPLY, DAILY_LIMIT_REPLY,
} = require('../middleware/portal-chat-customer-cap');

function post(baseUrl, customer, body = {}) {
  return fetch(`${baseUrl}/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-test-customer': customer },
    // a fresh sessionId every time: the cap must not key on it
    body: JSON.stringify({ message: 'hello', sessionId: `s-${Math.random()}`, ...body }),
  });
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/ai', aiRouter);
  const server = app.listen(0);
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('portal chat per-customer cap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCounts.clear();
    mockRawError = null;
    resetPortalChatMinuteWindows();
    delete process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP;
    delete process.env.PORTAL_CHAT_DAILY_CAP_PER_CUSTOMER;
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });
  });

  afterAll(() => {
    delete process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP;
    delete process.env.PORTAL_CHAT_DAILY_CAP_PER_CUSTOMER;
  });

  test('gate off (default): no limit, no counter call', async () => {
    const db = require('../models/db');
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 15; i += 1) {
        const res = await post(baseUrl, 'cust-a');
        expect(res.status).toBe(200);
        expect((await res.json()).reply).toBe('Hi there');
      }
    });
    expect(WavesAssistant.processMessage).toHaveBeenCalledTimes(15);
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('gate on: the 11th turn in a minute is answered without a model call', async () => {
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = 'true';
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 10; i += 1) {
        expect((await (await post(baseUrl, 'cust-a')).json()).reply).toBe('Hi there');
      }
      const res = await post(baseUrl, 'cust-a');
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ reply: MINUTE_LIMIT_REPLY, generated: false, escalated: false, canReport: false });
      expect(body.retryable).toBeUndefined();
      // another customer is unaffected
      expect((await (await post(baseUrl, 'cust-b')).json()).reply).toBe('Hi there');
    });
    expect(WavesAssistant.processMessage).toHaveBeenCalledTimes(11);
    expect(mockPortalTurn).toHaveBeenCalledTimes(12); // the refused turn still goes through the coordinator
  });

  test('gate on: a minute-refused turn does not burn the daily budget', async () => {
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = 'true';
    const db = require('../models/db');
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 13; i += 1) await post(baseUrl, 'cust-a');
    });
    expect(db.raw).toHaveBeenCalledTimes(10);
  });

  test('gate on: the 61st turn of the day is refused, keyed on the customer not the sessionId', async () => {
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = 'true';
    const now = Date.now();
    for (let i = 0; i < 60; i += 1) {
      // spread over time so the minute window never trips
      expect((await checkPortalChatCustomerCap('cust-a', now + i * 61000)).allowed).toBe(true);
    }
    const over = await checkPortalChatCustomerCap('cust-a', now + 60 * 61000);
    expect(over).toEqual({ allowed: false, reply: DAILY_LIMIT_REPLY });
    expect(Array.from(mockCounts.keys()).every((k) => k.startsWith('portal-chat:cust-a|'))).toBe(true);
    expect((await checkPortalChatCustomerCap('cust-b', now)).allowed).toBe(true);
  });

  test('gate on: the daily cap answers over the route with no model call', async () => {
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = 'true';
    process.env.PORTAL_CHAT_DAILY_CAP_PER_CUSTOMER = '3';
    await withServer(async (baseUrl) => {
      for (let i = 0; i < 3; i += 1) await post(baseUrl, 'cust-a');
      const res = await post(baseUrl, 'cust-a');
      expect(await res.json()).toMatchObject({ reply: DAILY_LIMIT_REPLY, generated: false });
    });
    expect(WavesAssistant.processMessage).toHaveBeenCalledTimes(3);
  });

  test('gate on: a counter error fails open (minute window still applies)', async () => {
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = 'true';
    mockRawError = new Error('db down');
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'cust-a');
      expect((await res.json()).reply).toBe('Hi there');
    });
  });

  test('a replayed requestId (turn returns its saved result) spends no slot', async () => {
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = 'true';
    const db = require('../models/db');
    mockPortalTurn.mockImplementationOnce(async (args) => ({
      reply: 'saved answer', escalated: false, generated: true, requestId: args.requestId,
    }));
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'cust-a');
      expect((await res.json()).reply).toBe('saved answer');
    });
    expect(db.raw).not.toHaveBeenCalled();
    expect(WavesAssistant.processMessage).not.toHaveBeenCalled();
  });

  test('gate on: a counter that hangs fails open after 2 s', async () => {
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = 'true';
    const db = require('../models/db');
    db.raw.mockImplementationOnce(() => new Promise(() => {}));
    jest.useFakeTimers();
    try {
      const pending = checkPortalChatCustomerCap('cust-a');
      await jest.advanceTimersByTimeAsync(2100);
      expect(await pending).toEqual({ allowed: true });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a validation failure is refused before it can count', async () => {
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = 'true';
    const db = require('../models/db');
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, 'cust-a', { message: '' });
      expect(res.status).toBe(400);
    });
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('the gate is strict true and the shared-cap gate does not drive it', () => {
    const gates = require('../config/feature-gates');
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = '1';
    expect(gates.portalChatCustomerCapLive()).toBe(false);
    process.env.GATE_PORTAL_CHAT_CUSTOMER_CAP = 'true';
    expect(gates.portalChatCustomerCapLive()).toBe(true);
    const src = fs.readFileSync(path.join(__dirname, '../config/feature-gates.js'), 'utf8');
    expect(src).toMatch(/^module\.exports\.portalChatCustomerCapLive = portalChatCustomerCapLive;$/m);
  });
});
