process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.schema = { hasTable: jest.fn().mockResolvedValue(true) };
  return fn;
});
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/ai-assistant/assistant', () => ({
  processMessage: jest.fn(),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/call-route-decisions', () => ({
  preferredRouteDecisionForFeedback: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
}));

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const WavesAssistant = require('../services/ai-assistant/assistant');
const aiRouter = require('../routes/ai-assistant');

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/ai', aiRouter);
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

// The report route uses the REAL customer authenticate middleware, which
// looks the customer up in db('customers') — the mock has to serve that
// chain alongside the report's own tables.
function mockReportTables({ session, customer } = {}) {
  const customersQuery = {
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(
      customer === undefined ? { id: 'cust-1', active: true } : customer,
    ),
  };
  const sessionQuery = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(session || null),
  };
  const escalationInsert = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: 'esc-1' }]),
  });
  const inboxInsert = jest.fn().mockReturnValue({
    onConflict: jest.fn().mockReturnValue({ ignore: jest.fn().mockResolvedValue(undefined) }),
  });
  db.mockImplementation((table) => {
    if (table === 'customers') return customersQuery;
    if (table === 'agent_sessions') return sessionQuery;
    if (table === 'ai_escalations') return { insert: escalationInsert };
    if (table === 'operator_inbox_items') return { insert: inboxInsert };
    throw new Error(`Unexpected table ${table}`);
  });
  return { customersQuery, sessionQuery, escalationInsert, inboxInsert };
}

function customerToken(customerId = 'cust-1') {
  return jwt.sign({ customerId }, process.env.JWT_SECRET);
}

describe('POST /ai/chat/report', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_AI_CONTENT_REPORT;
  });

  afterAll(() => {
    delete process.env.GATE_AI_CONTENT_REPORT;
  });

  test('files an ai_escalations row plus an operator-inbox mirror for the admin hub', async () => {
    const { sessionQuery, escalationInsert, inboxInsert } = mockReportTables({
      session: { id: 'conv-1', customer_id: 'cust-1' },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ sessionId: 'chat-123', messageContent: 'Bad AI reply' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(sessionQuery.where).toHaveBeenCalledWith({
        channel: 'portal_chat',
        channel_identifier: 'chat-123',
      });
      expect(escalationInsert).toHaveBeenCalledWith(expect.objectContaining({
        conversation_id: 'conv-1',
        customer_id: 'cust-1',
        reason: 'reported_ai_content',
        customer_message: '[Reported AI reply] Bad AI reply',
        priority: 'normal',
        status: 'pending',
      }));
      expect(inboxInsert).toHaveBeenCalledWith(expect.objectContaining({
        source: 'ai_report',
        source_id: 'esc-1',
        customer_id: 'cust-1',
        channel: 'portal_chat',
        status: 'open',
        title: 'Customer reported an AI chat reply',
      }));
    });
  });

  test('rejects unauthenticated reports outright', async () => {
    const { escalationInsert } = mockReportTables();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'chat-123', messageContent: 'Bad AI reply' }),
      });
      expect(res.status).toBe(401);
      expect(escalationInsert).not.toHaveBeenCalled();
    });
  });

  test("never links another customer's conversation to the report", async () => {
    const { escalationInsert } = mockReportTables({
      session: { id: 'conv-other', customer_id: 'someone-else' },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ sessionId: 'chat-guessed', messageContent: 'Bad AI reply' }),
      });
      expect(res.status).toBe(200);
      expect(escalationInsert).toHaveBeenCalledWith(expect.objectContaining({
        conversation_id: null,
        customer_id: 'cust-1',
      }));
    });
  });

  test('per-client rate limit caps report submissions at 10 per window', async () => {
    // Own bucket: the limiter keys authenticated requests by JWT subject, so
    // this test's counts don't collide with the other tests' hits.
    const { escalationInsert } = mockReportTables({
      session: null,
      customer: { id: 'rate-limit-cust', active: true },
    });
    const token = customerToken('rate-limit-cust');

    await withServer(async (baseUrl) => {
      const send = () => fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ sessionId: 'chat-flood', messageContent: 'Bad AI reply' }),
      });
      for (let i = 0; i < 10; i += 1) {
        const res = await send();
        expect(res.status).toBe(200);
      }
      const blocked = await send();
      expect(blocked.status).toBe(429);
      expect(escalationInsert).toHaveBeenCalledTimes(10);
    });
  });

  test('rejects an empty report without touching the queue', async () => {
    const { escalationInsert } = mockReportTables();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ sessionId: 'chat-123' }),
      });
      expect(res.status).toBe(400);
      expect(escalationInsert).not.toHaveBeenCalled();
    });
  });

  test('operator-inbox mirror failure does not fail the report', async () => {
    const { escalationInsert, inboxInsert } = mockReportTables();
    inboxInsert.mockImplementation(() => { throw new Error('inbox down'); });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ sessionId: 'chat-123', messageContent: 'Bad AI reply' }),
      });
      expect(res.status).toBe(200);
      expect(escalationInsert).toHaveBeenCalled();
    });
  });

  test('kill switch GATE_AI_CONTENT_REPORT=false reads 404 even without auth', async () => {
    const { escalationInsert } = mockReportTables();
    process.env.GATE_AI_CONTENT_REPORT = 'false';

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'chat-123', messageContent: 'Bad AI reply' }),
      });
      expect(res.status).toBe(404);
      expect(escalationInsert).not.toHaveBeenCalled();
    });
  });
});

describe('POST /ai/chat canReport flag', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_AI_CONTENT_REPORT;
  });

  afterAll(() => {
    delete process.env.GATE_AI_CONTENT_REPORT;
  });

  test('model-generated replies advertise canReport while the gate is on (default)', async () => {
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', sessionId: 'chat-123' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ reply: 'Hi there', escalated: false, generated: true, canReport: true });
    });
  });

  test('canned fallback replies are never reportable', async () => {
    WavesAssistant.processMessage.mockResolvedValue({ reply: "I'm having trouble right now.", escalated: false });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', sessionId: 'chat-123' }),
      });
      const body = await res.json();
      expect(body.canReport).toBe(false);
    });
  });

  test('chat responses drop canReport when the gate is killed', async () => {
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });
    process.env.GATE_AI_CONTENT_REPORT = 'false';

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', sessionId: 'chat-123' }),
      });
      const body = await res.json();
      expect(body.canReport).toBe(false);
    });
  });
});
