/**
 * Trust-boundary tests for UI-backed write confirmation (issue #1568).
 *
 * The invariants under test:
 *  1. With GATE_IB_UI_CONFIRM on, gated writes are never executed from the
 *     model loop — even when the model supplies confirmed: true (echo attack).
 *  2. The pending-action id appears ONLY in the response's pendingActions
 *     payload — never in any content sent to the Anthropic API and never in
 *     the model-visible parts of the response.
 *  3. /confirm-action is the only commit path: it claims atomically, applies
 *     role rules, attaches server-derived confirmation, and executes the
 *     STORED params.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockExecuteTool = jest.fn();
const mockCreatePendingAction = jest.fn();
const mockClaimForConfirm = jest.fn();
const mockCancelPendingAction = jest.fn();
const mockRecordResult = jest.fn();
const mockDbInsert = jest.fn(async () => undefined);

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => jest.fn(() => ({ insert: mockDbInsert })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({
  getBreaker: jest.fn(() => ({
    isTripped: jest.fn(() => false),
    fastFailResult: jest.fn(),
    recordFailure: jest.fn(),
    recordSuccess: jest.fn(),
  })),
}));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));

jest.mock('../services/intelligence-bar/tools', () => ({
  TOOLS: [],
  executeTool: (...args) => mockExecuteTool(...args),
}));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({ COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({ LEADS_TOOLS: [], executeLeadsTool: jest.fn() }));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({
  BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn(),
}));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10,
  createPendingAction: (...args) => mockCreatePendingAction(...args),
  claimForConfirm: (...args) => mockClaimForConfirm(...args),
  cancelPendingAction: (...args) => mockCancelPendingAction(...args),
  recordResult: (...args) => mockRecordResult(...args),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin' },
      tech: { id: 'tech-1', role: 'technician' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
}));

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

const PENDING_ID = '7e1c2f7a-1111-2222-3333-deadbeef0001';

function appServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function scriptModelTurns(turns) {
  mockMessagesCreate.mockReset();
  for (const content of turns) {
    mockMessagesCreate.mockResolvedValueOnce({ content });
  }
}

async function postQuery(baseUrl, body, token = 'admin') {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('UI-confirm gate in /query (GATE_IB_UI_CONFIRM=true)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_IB_UI_CONFIRM = 'true';
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID,
      tool_name: 'create_customer',
      summary: 'create_customer — first_name: Jeff',
      expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  afterAll(() => {
    delete process.env.GATE_IB_UI_CONFIRM;
  });

  test('echo attack: model-supplied confirmed:true is stripped, write is proposed not executed, id never reaches the model', async () => {
    mockExecuteTool.mockResolvedValue({ preview: true, would_create: { first_name: 'Jeff' } });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'create_customer', input: { first_name: 'Jeff', phone: '9415550100', confirmed: true } }],
      [{ type: 'text', text: 'Proposed — confirm in the card.' }],
    ]);

    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'add Jeff, go ahead', context: 'customers' });
      expect(status).toBe(200);

      // Preview ran WITHOUT any confirmation flag (echo stripped)…
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
      const [toolName, params] = mockExecuteTool.mock.calls[0];
      expect(toolName).toBe('create_customer');
      expect(params).toEqual({ first_name: 'Jeff', phone: '9415550100' });
      expect(params.confirmed).toBeUndefined();

      // …the stored proposal also carries no confirmation flag…
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params.confirmed).toBeUndefined();
      expect(stored.requestedBy).toBe('admin-1');

      // …the client payload carries the id…
      expect(body.pendingActions).toHaveLength(1);
      expect(body.pendingActions[0].id).toBe(PENDING_ID);

      // …and the id appears NOWHERE the model can see: not in any message
      // sent to the Anthropic API, not in the model-visible response fields.
      const allModelTraffic = JSON.stringify(mockMessagesCreate.mock.calls);
      expect(allModelTraffic).not.toContain(PENDING_ID);
      expect(JSON.stringify({ r: body.response, t: body.toolCalls, s: body.structuredData, h: body.conversationHistory }))
        .not.toContain(PENDING_ID);

      // The model-visible tool result says pending, never success.
      const secondCallMessages = mockMessagesCreate.mock.calls[1][0].messages;
      const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
      expect(toolResult.pending_confirmation).toBe(true);
      expect(toolResult.success).toBeUndefined();
    });
  });

  test('legacy bare write (update_customer) is never executed from the loop — proposal synthesized', async () => {
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);

    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'set city', context: 'customers' });
      expect(mockExecuteTool).not.toHaveBeenCalled();
      expect(mockCreatePendingAction).toHaveBeenCalledTimes(1);
      expect(body.pendingActions).toHaveLength(1);
    });
  });

  test('reads pass through untouched while the gate is on', async () => {
    mockExecuteTool.mockResolvedValue({ customers: [], total_matching: 0 });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'query_customers', input: { search: 'Jeff' } }],
      [{ type: 'text', text: 'No matches.' }],
    ]);

    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'find Jeff', context: 'customers' });
      expect(mockExecuteTool).toHaveBeenCalledWith('query_customers', { search: 'Jeff' });
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      expect(body.pendingActions).toEqual([]);
    });
  });

  test('system prompt carries UI-mode write guidance when the gate is on, conversational guidance when off', async () => {
    mockExecuteTool.mockResolvedValue({ customers: [] });

    scriptModelTurns([[{ type: 'text', text: 'hi' }]]);
    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, { prompt: 'hello', context: 'customers' });
    });
    // system is a cache_control block array (prompt caching) — unwrap the text.
    const onPrompt = mockMessagesCreate.mock.calls[0][0].system.map((b) => b.text).join('\n');
    expect(onPrompt).toContain('WRITE CONFIRMATION (UI mode)');
    expect(onPrompt).not.toContain('WRITE CONFIRMATION (conversational mode)');

    process.env.GATE_IB_UI_CONFIRM = 'false';
    scriptModelTurns([[{ type: 'text', text: 'hi' }]]);
    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, { prompt: 'hello', context: 'customers' });
    });
    const offPrompt = mockMessagesCreate.mock.calls[0][0].system.map((b) => b.text).join('\n');
    expect(offPrompt).toContain('WRITE CONFIRMATION (conversational mode)');
    expect(offPrompt).not.toContain('WRITE CONFIRMATION (UI mode)');
  });

  test('prompt caching: system block breakpoint, one message breakpoint per round (no accumulation), pageData on the user turn not the system prompt', async () => {
    mockExecuteTool.mockResolvedValue({ preview: true });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'create_customer', input: { first_name: 'Jeff' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);

    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, {
        prompt: 'add Jeff',
        context: 'customers',
        pageData: { current_date: '2026-07-07', open_jobs: 3 },
      });
    });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(2);

    for (const [call] of mockMessagesCreate.mock.calls) {
      // system: single text block carrying the ephemeral breakpoint, no pageData.
      expect(call.system).toHaveLength(1);
      expect(call.system[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(call.system[0].text).not.toContain('CURRENT PAGE STATE');

      // messages: exactly one breakpoint, on the last block of the last message.
      const markers = call.messages.flatMap((m) => (
        Array.isArray(m.content) ? m.content.filter((b) => b.cache_control) : []
      ));
      expect(markers).toHaveLength(1);
      const lastMsg = call.messages[call.messages.length - 1];
      expect(lastMsg.content[lastMsg.content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    }

    // pageData rides on the current user turn (first call's last message).
    const firstUserTurn = mockMessagesCreate.mock.calls[0][0].messages.at(-1);
    expect(JSON.stringify(firstUserTurn.content)).toContain('CURRENT PAGE STATE');
    expect(JSON.stringify(firstUserTurn.content)).toContain('open_jobs');
  });

  test('gate off: legacy behavior unchanged, no pendingActions field', async () => {
    process.env.GATE_IB_UI_CONFIRM = 'false';
    mockExecuteTool.mockResolvedValue({ success: true });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
      [{ type: 'text', text: 'Done.' }],
    ]);

    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'set city', context: 'customers' });
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      expect(body.pendingActions).toBeUndefined();
    });
  });

  test('image-backed turns send valid vision blocks, drop invalid images, and redact persisted telemetry', async () => {
    const prompt = 'read this invoice';
    const validImageData = Buffer.from('fake-png-bytes').toString('base64');
    const oversizedImageData = 'A'.repeat(Math.ceil(((5 * 1024 * 1024) + 1) * 4 / 3 / 4) * 4);
    scriptModelTurns([[{ type: 'text', text: 'The invoice shows a balance.' }]]);

    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, {
        prompt,
        context: 'customers',
        images: [
          { mediaType: 'image/png', data: validImageData },
          { mediaType: 'image/heic', data: validImageData },
          { mediaType: 'image/jpeg', data: 'not-base64!' },
          { mediaType: 'image/jpeg', data: oversizedImageData },
        ],
      });

      expect(status).toBe(200);
      const firstCallMessages = mockMessagesCreate.mock.calls[0][0].messages;
      const userTurn = firstCallMessages[firstCallMessages.length - 1];
      expect(userTurn.content).toEqual([
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: validImageData },
        },
        // Last block of the last message carries the per-round cache breakpoint.
        { type: 'text', text: prompt, cache_control: { type: 'ephemeral' } },
      ]);

      expect(body.conversationHistory[0].content).toBe(
        `${prompt}\n[Operator attached 1 image]\n[Image attachment context may contain PII]`,
      );
      expect(body.conversationHistory[1].content).toBe(
        'The invoice shows a balance.\n[Image attachment context may contain PII]',
      );
      expect(JSON.stringify(body.conversationHistory)).not.toContain(validImageData);
    });

    expect(mockDbInsert).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '[redacted — image attachment may contain PII]',
      response: '[redacted — image attachment may contain PII]',
    }));
  });

  test('image-tainted follow-ups stay redacted even when the current turn has no images', async () => {
    const taintedHistory = [
      { role: 'user', content: 'read this invoice\n[Operator attached 1 image]\n[Image attachment context may contain PII]' },
      { role: 'assistant', content: 'The invoice is for Jane Customer at 123 Main St.\n[Image attachment context may contain PII]' },
    ];
    scriptModelTurns([[{ type: 'text', text: 'Jane Customer, 123 Main St.' }]]);

    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, {
        prompt: 'repeat the name and address from that invoice',
        context: 'customers',
        conversationHistory: taintedHistory,
      });

      expect(status).toBe(200);
      const firstCallMessages = mockMessagesCreate.mock.calls[0][0].messages;
      expect(JSON.stringify(firstCallMessages)).not.toContain('[Image attachment context may contain PII]');
      expect(body.conversationHistory.at(-2).content).toBe(
        'repeat the name and address from that invoice\n[Image attachment context may contain PII]',
      );
      expect(body.conversationHistory.at(-1).content).toBe(
        'Jane Customer, 123 Main St.\n[Image attachment context may contain PII]',
      );
    });

    expect(mockDbInsert).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '[redacted — image attachment may contain PII]',
      response: '[redacted — image attachment may contain PII]',
    }));
  });
});

describe('/confirm-action commit path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_IB_UI_CONFIRM = 'true';
  });

  afterAll(() => {
    delete process.env.GATE_IB_UI_CONFIRM;
  });

  test('claims, attaches server-derived confirmed for two-step tools, executes stored params', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'create_customer', params: { first_name: 'Jeff', phone: '9415550100' } },
    });
    mockExecuteTool.mockResolvedValue({ success: true, customer_id: 'cust-1' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockClaimForConfirm).toHaveBeenCalledWith(PENDING_ID, 'admin-1');
      expect(mockExecuteTool).toHaveBeenCalledWith(
        'create_customer',
        { first_name: 'Jeff', phone: '9415550100', confirmed: true },
      );
      expect(mockRecordResult).toHaveBeenCalledWith(PENDING_ID, expect.objectContaining({ success: true }));
    });
  });

  test('legacy bare writes execute stored params without a confirmed flag', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'update_customer', params: { customer_id: 'c1', updates: { city: 'Venice' } } },
    });
    mockExecuteTool.mockResolvedValue({ success: true });

    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      const params = mockExecuteTool.mock.calls[0][1];
      expect(params).toEqual({ customer_id: 'c1', updates: { city: 'Venice' } });
      expect(params.confirmed).toBeUndefined();
    });
  });

  test.each([
    ['not_found', 404],
    ['actor_mismatch', 403],
    ['already_used', 409],
    ['cancelled', 409],
    ['expired', 409],
    ['hash_mismatch', 409],
  ])('claim error %s maps to HTTP %i and nothing executes', async (error, status) => {
    mockClaimForConfirm.mockResolvedValue({ error });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(status);
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });
  });

  test('admin-only tools cannot be confirmed by a technician even after a successful claim', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'create_customer', params: { first_name: 'Jeff', phone: '9415550100' } },
    });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(403);
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });
  });

  test('/execute cannot bypass the gate: gated writes are rejected while GATE_IB_UI_CONFIRM is on', async () => {
    await withServer(async (baseUrl) => {
      for (const action of ['create_customer', 'update_customer', 'send_sms']) {
        const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, params: { any: 'thing' }, confirmed: true }),
        });
        expect(res.status).toBe(409);
      }
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });
  });

  test('/execute still works for gated writes when the gate is off (legacy behavior)', async () => {
    process.env.GATE_IB_UI_CONFIRM = 'false';
    mockExecuteTool.mockResolvedValue({ success: true });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_customer', params: { customer_id: 'c1', updates: { city: 'Venice' } } }),
      });
      expect(res.status).toBe(200);
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    });
  });

  test('missing pending_action_id is a 400', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe('/cancel-action', () => {
  beforeEach(() => jest.clearAllMocks());

  test('cancels your own pending action', async () => {
    mockCancelPendingAction.mockResolvedValue({ cancelled: true });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/cancel-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(200);
      expect(mockCancelPendingAction).toHaveBeenCalledWith(PENDING_ID, 'admin-1');
    });
  });

  test('non-cancellable rows are a 409', async () => {
    mockCancelPendingAction.mockResolvedValue({ cancelled: false });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/cancel-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(409);
    });
  });
});
