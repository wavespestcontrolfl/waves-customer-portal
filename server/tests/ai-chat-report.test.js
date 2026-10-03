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
const mockPortalTurn = jest.fn(async (args) => ({
  ...await args.processTurn({ requestRowId: 'portal-request-row' }),
  requestId: args.requestId,
}));
jest.mock('../services/ai-assistant/portal-turn', () => ({
  portalConversationIdentifier: (identifier, propertyId) => (propertyId ? `property:${propertyId}:${identifier}` : identifier),
  runPortalTurn: (...args) => mockPortalTurn(...args),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
jest.mock('../services/call-route-decisions', () => ({
  preferredRouteDecisionForFeedback: jest.fn(),
}));
const mockResolveScope = jest.fn();
jest.mock('../services/account-properties', () => ({
  ...jest.requireActual('../services/account-properties'),
  resolveSessionScope: (...a) => mockResolveScope(...a),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => next(),
  requireTechOrAdmin: (req, res, next) => next(),
  // The call-log routes mount with requireAdmin; the router needs it defined to load.
  requireAdmin: (req, res, next) => next(),
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
function mockReportTables({ session, customer, property } = {}) {
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
  const propertyQuery = {
    where: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(property || null),
  };
  const escalationInsert = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ id: 'esc-1' }]),
  });
  const inboxInsert = jest.fn().mockReturnValue({
    onConflict: jest.fn().mockReturnValue({ ignore: jest.fn().mockResolvedValue(undefined) }),
  });
  db.mockImplementation((table) => {
    if (table === 'customers') return customersQuery;
    if (table === 'customer_properties') return propertyQuery;
    if (table === 'agent_sessions') return sessionQuery;
    if (table === 'ai_escalations') return { insert: escalationInsert };
    if (table === 'operator_inbox_items') return { insert: inboxInsert };
    throw new Error(`Unexpected table ${table}`);
  });
  return { customersQuery, propertyQuery, sessionQuery, escalationInsert, inboxInsert };
}

function customerToken(customerId = 'cust-1', claims = {}) {
  return jwt.sign({ customerId, ...claims }, process.env.JWT_SECRET);
}

describe('POST /ai/chat/report', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_AI_CONTENT_REPORT;
    delete process.env.GATE_APP_PROPERTY_SCOPE;
  });

  afterAll(() => {
    delete process.env.GATE_AI_CONTENT_REPORT;
    delete process.env.GATE_APP_PROPERTY_SCOPE;
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
        customer_id: 'cust-1',
      });
      expect(sessionQuery.orderBy).toHaveBeenCalledWith('created_at', 'desc');
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

  test('a supplied conversation id selects the reported older reply instead of the newer session', async () => {
    const olderId = '11111111-1111-4111-8111-111111111111';
    const newerId = '22222222-2222-4222-8222-222222222222';
    const rows = [
      { id: olderId, customer_id: 'cust-1', channel: 'portal_chat', channel_identifier: 'chat-123', created_at: '2026-10-01' },
      { id: newerId, customer_id: 'cust-1', channel: 'portal_chat', channel_identifier: 'chat-123', created_at: '2026-10-02' },
    ];
    const { sessionQuery, escalationInsert } = mockReportTables();
    sessionQuery.first.mockImplementation(async () => {
      const requestedId = sessionQuery.where.mock.calls.at(-1)[0].id;
      return requestedId ? rows.find((row) => row.id === requestedId) : rows[1];
    });

    await withServer(async (baseUrl) => {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` };
      const selected = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'chat-123', conversationId: olderId, messageContent: 'Older AI reply' }),
      });
      expect(selected.status).toBe(200);
      const legacy = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ sessionId: 'chat-123', messageContent: 'Latest AI reply' }),
      });
      expect(legacy.status).toBe(200);
    });

    expect(sessionQuery.where.mock.calls[0][0]).toEqual({
      id: olderId,
      channel: 'portal_chat',
      channel_identifier: 'chat-123',
      customer_id: 'cust-1',
    });
    expect(sessionQuery.orderBy).toHaveBeenCalledTimes(1);
    expect(escalationInsert.mock.calls.map(([row]) => row.conversation_id)).toEqual([olderId, newerId]);
  });

  test('the authenticated property claim scopes the conversation lookup', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    const { propertyQuery, sessionQuery, escalationInsert } = mockReportTables({
      customer: { id: 'cust-1', account_id: 'account-1', active: true },
      property: { id: 'prop-1', customer_id: 'cust-1', active: true },
      session: { id: 'conv-property-1', customer_id: 'cust-1' },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken('cust-1', {
            accountId: 'account-1',
            propertyId: 'prop-1',
          })}`,
        },
        body: JSON.stringify({
          sessionId: 'shared-session',
          propertyId: 'prop-other',
          messageContent: 'Bad AI reply',
        }),
      });
      expect(res.status).toBe(200);
    });

    expect(propertyQuery.where).toHaveBeenCalledWith({
      id: 'prop-1',
      customer_id: 'cust-1',
      active: true,
    });
    expect(sessionQuery.where).toHaveBeenCalledWith({
      channel: 'portal_chat',
      channel_identifier: 'property:prop-1:shared-session',
      customer_id: 'cust-1',
    });
    expect(escalationInsert).toHaveBeenCalledWith(expect.objectContaining({
      conversation_id: 'conv-property-1',
      customer_id: 'cust-1',
    }));
  });

  test('a supplied conversation from another authenticated property is not linked', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    const conversationId = '33333333-3333-4333-8333-333333333333';
    const { sessionQuery, escalationInsert } = mockReportTables({
      customer: { id: 'cust-1', account_id: 'account-1', active: true },
      property: { id: 'prop-1', customer_id: 'cust-1', active: true },
      session: {
        id: conversationId,
        customer_id: 'cust-1',
        channel: 'portal_chat',
        channel_identifier: 'property:prop-other:shared-session',
      },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken('cust-1', { accountId: 'account-1', propertyId: 'prop-1' })}`,
        },
        body: JSON.stringify({ sessionId: 'shared-session', conversationId, messageContent: 'Bad AI reply' }),
      });
      expect(res.status).toBe(200);
    });

    expect(sessionQuery.where).toHaveBeenCalledWith({
      id: conversationId,
      channel: 'portal_chat',
      channel_identifier: 'property:prop-1:shared-session',
      customer_id: 'cust-1',
    });
    expect(sessionQuery.orderBy).not.toHaveBeenCalled();
    expect(escalationInsert).toHaveBeenCalledWith(expect.objectContaining({ conversation_id: null }));
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

  test("a supplied conversation owned by another customer is not linked or replaced with the latest", async () => {
    const conversationId = '44444444-4444-4444-8444-444444444444';
    const { escalationInsert } = mockReportTables({
      session: {
        id: conversationId,
        customer_id: 'someone-else',
        channel: 'portal_chat',
        channel_identifier: 'chat-guessed',
      },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ sessionId: 'chat-guessed', conversationId, messageContent: 'Bad AI reply' }),
      });
      expect(res.status).toBe(200);
      expect(escalationInsert).toHaveBeenCalledWith(expect.objectContaining({
        conversation_id: null,
        customer_id: 'cust-1',
      }));
    });
  });

  test('rejects an invalid supplied conversation id without touching the queue', async () => {
    const { escalationInsert } = mockReportTables();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ sessionId: 'chat-123', conversationId: '../newest', messageContent: 'Bad AI reply' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid conversationId' });
      expect(escalationInsert).not.toHaveBeenCalled();
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
  const requestId = '11a7ca3e-8392-4e2b-92b0-c3125b3e6c48';

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_AI_CONTENT_REPORT;
    delete process.env.GATE_APP_PROPERTY_SCOPE;
  });

  afterAll(() => {
    delete process.env.GATE_AI_CONTENT_REPORT;
    delete process.env.GATE_APP_PROPERTY_SCOPE;
  });

  test('model-generated replies advertise canReport for authenticated customers (gate default on)', async () => {
    mockReportTables();
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ message: 'hello', sessionId: 'chat-123', requestId }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toEqual({ reply: 'Hi there', escalated: false, generated: true, requestId, canReport: true });
    });
  });

  test('rejects unauthenticated chat before invoking the model', async () => {
    mockReportTables();
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', sessionId: 'chat-123', requestId }),
      });
      const body = await res.json();
      expect(res.status).toBe(401);
      expect(body).toEqual({ error: 'Authentication required' });
      expect(WavesAssistant.processMessage).not.toHaveBeenCalled();
    });
  });

  test('rejects a malformed request id before coordinating or invoking the model', async () => {
    mockReportTables();

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ message: 'hello', sessionId: 'chat-123', requestId: '../repeat' }),
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Invalid requestId' });
    });

    expect(mockPortalTurn).not.toHaveBeenCalled();
    expect(WavesAssistant.processMessage).not.toHaveBeenCalled();
  });

  test('uses only the authenticated customer identity, ignoring body customer claims', async () => {
    mockReportTables({ customer: { id: 'cust-1', active: true, phone: '+19415550100' } });
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({
          message: 'hello',
          sessionId: 'shared-session',
          requestId,
          customerId: 'victim-customer',
        }),
      });
      expect(res.status).toBe(200);
    });

    expect(WavesAssistant.processMessage).toHaveBeenCalledWith({
      message: 'hello',
      channel: 'portal_chat',
      channelIdentifier: 'shared-session',
      customerId: 'cust-1',
      customerPhone: '+19415550100',
      // GATE_PORTAL_CHAT_RESERVICE off: no scope read, the re-service button withheld.
      secondaryProperty: true,
      turn: { requestRowId: 'portal-request-row' },
    });
    expect(mockResolveScope).not.toHaveBeenCalled();
    expect(mockPortalTurn).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      customerId: 'cust-1',
      propertyId: null,
      channelIdentifier: 'shared-session',
    }));
  });

  test('the authenticated property claim scopes the coordinator and conversation, ignoring body property claims', async () => {
    process.env.GATE_APP_PROPERTY_SCOPE = 'true';
    mockReportTables({
      customer: { id: 'cust-1', active: true, phone: '+19415550100' },
      property: { id: 'prop-1', customer_id: 'cust-1', active: true },
    });
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customerToken('cust-1', { propertyId: 'prop-1' })}`,
        },
        body: JSON.stringify({
          message: 'hello', sessionId: 'shared-session', requestId, propertyId: 'prop-other',
        }),
      });
      expect(res.status).toBe(200);
    });

    expect(mockPortalTurn).toHaveBeenCalledWith(expect.objectContaining({
      requestId,
      customerId: 'cust-1',
      propertyId: 'prop-1',
      channelIdentifier: 'property:prop-1:shared-session',
    }));
    expect(WavesAssistant.processMessage).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cust-1',
      channelIdentifier: 'property:prop-1:shared-session',
      turn: { requestRowId: 'portal-request-row' },
    }));
  });

  describe('GATE_PORTAL_CHAT_RESERVICE on: the session property scope decides the re-service button', () => {
    let pageSwitches;
    beforeEach(() => {
      process.env.GATE_PORTAL_CHAT_RESERVICE = 'true';
      pageSwitches = jest.spyOn(require('../services/ai-assistant/tools'), 'reservicePageSwitchesOn').mockReturnValue(true);
    });
    afterEach(() => { delete process.env.GATE_PORTAL_CHAT_RESERVICE; delete process.env.PORTAL_CHAT_SELF_SERVE; pageSwitches.mockRestore(); });

    test('a re-service page switch off: no scope read (the tool would refuse anyway)', async () => {
      pageSwitches.mockReturnValue(false);
      mockReportTables({ customer: { id: 'cust-1', active: true, phone: '+19415550100' } });
      WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });

      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
          body: JSON.stringify({ message: 'ants are back', sessionId: 'sess-rs' }),
        });
        expect(res.status).toBe(200);
      });

      expect(mockResolveScope).not.toHaveBeenCalled();
    });

    test('the chat\'s master switch off: no scope read (the resolver can write)', async () => {
      process.env.PORTAL_CHAT_SELF_SERVE = 'off';
      mockReportTables({ customer: { id: 'cust-1', active: true, phone: '+19415550100' } });
      WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });

      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
          body: JSON.stringify({ message: 'ants are back', sessionId: 'sess-rs' }),
        });
        expect(res.status).toBe(200);
      });

      expect(mockResolveScope).not.toHaveBeenCalled();
      expect(WavesAssistant.processMessage).toHaveBeenCalledWith(expect.objectContaining({ secondaryProperty: true }));
    });

    test.each([
      ['an unscoped session (single home)', async () => ({ enabled: false }), false],
      ['the primary saved property', async () => ({ enabled: true, scoped: true, property: { id: 'p1', is_primary: true } }), false],
      ['a secondary saved property', async () => ({ enabled: true, scoped: true, property: { id: 'p2', is_primary: false } }), true],
      ['a failed scope read', async () => { throw new Error('db down'); }, true],
    ])('%s', async (_label, scope, secondaryProperty) => {
      mockReportTables({ customer: { id: 'cust-1', active: true, phone: '+19415550100' } });
      mockResolveScope.mockImplementation(scope);
      WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });

      await withServer(async (baseUrl) => {
        const res = await fetch(`${baseUrl}/ai/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
          body: JSON.stringify({ message: 'ants are back', sessionId: 'sess-rs' }),
        });
        expect(res.status).toBe(200);
      });

      expect(mockResolveScope).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1' }));
      expect(WavesAssistant.processMessage).toHaveBeenCalledWith(expect.objectContaining({ secondaryProperty }));
    });
  });

  test('canned fallback replies are never reportable', async () => {
    mockReportTables();
    WavesAssistant.processMessage.mockResolvedValue({ reply: "I'm having trouble right now.", escalated: false });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ message: 'hello', sessionId: 'chat-123', requestId }),
      });
      const body = await res.json();
      expect(body.canReport).toBe(false);
    });
  });

  test('chat responses drop canReport when the gate is killed', async () => {
    mockReportTables();
    WavesAssistant.processMessage.mockResolvedValue({ reply: 'Hi there', escalated: false, generated: true });
    process.env.GATE_AI_CONTENT_REPORT = 'false';

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken()}` },
        body: JSON.stringify({ message: 'hello', sessionId: 'chat-123', requestId }),
      });
      const body = await res.json();
      expect(body.canReport).toBe(false);
    });
  });
});
