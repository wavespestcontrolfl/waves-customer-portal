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

function mockReportTables({ session } = {}) {
  const sessionQuery = {
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(session || null),
  };
  const escalationInsert = jest.fn().mockResolvedValue([]);
  db.mockImplementation((table) => {
    if (table === 'agent_sessions') return sessionQuery;
    if (table === 'ai_escalations') return { insert: escalationInsert };
    throw new Error(`Unexpected table ${table}`);
  });
  return { sessionQuery, escalationInsert };
}

describe('POST /ai/chat/report', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_AI_CONTENT_REPORT;
  });

  afterAll(() => {
    delete process.env.GATE_AI_CONTENT_REPORT;
  });

  test('files an ai_escalations review row linked to the chat session and customer', async () => {
    const { sessionQuery, escalationInsert } = mockReportTables({
      session: { id: 'conv-1', customer_id: 'cust-from-session' },
    });
    const token = jwt.sign({ customerId: 'cust-1' }, process.env.JWT_SECRET);

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
    });
  });

  test('anonymous report with unknown session still lands in the queue', async () => {
    const { escalationInsert } = mockReportTables({ session: null });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'chat-unknown', messageContent: 'Bad AI reply' }),
      });
      expect(res.status).toBe(200);
      expect(escalationInsert).toHaveBeenCalledWith(expect.objectContaining({
        conversation_id: null,
        customer_id: null,
        reason: 'reported_ai_content',
      }));
    });
  });

  test('rejects an empty report without touching the queue', async () => {
    const { escalationInsert } = mockReportTables();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'chat-123' }),
      });
      expect(res.status).toBe(400);
      expect(escalationInsert).not.toHaveBeenCalled();
    });
  });

  test('kill switch GATE_AI_CONTENT_REPORT=false disables the endpoint', async () => {
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

  test('chat responses advertise canReport while the gate is on (default)', async () => {
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', sessionId: 'chat-123' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ reply: 'Hi there', escalated: false, canReport: true });
    });
  });

  test('chat responses drop canReport when the gate is killed', async () => {
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false });
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
