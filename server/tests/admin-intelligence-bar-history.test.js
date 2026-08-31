/**
 * search_ib_history through the /query route (W-RECALL):
 *  1. Offered to admin tokens in any admin context; never to technicians
 *     (ADMIN_ONLY + tech pin).
 *  2. Dispatched with the actor id derived from the authenticated request —
 *     never from model input.
 *  3. A technician token that somehow requests the tool is refused.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockExecuteHistoryTool = jest.fn();
const mockDbInsert = jest.fn(async () => undefined);

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));
jest.mock('../models/db', () => jest.fn(() => ({ insert: mockDbInsert })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({
  getBreaker: jest.fn(() => ({
    isTripped: jest.fn(() => false), fastFailResult: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn(),
  })),
}));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/intelligence-bar/tools', () => ({
  TOOLS: [], executeTool: jest.fn(), resolveTechnicianByName: jest.fn(), resolveActiveTechnicianById: jest.fn(),
}));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(), resolveCustomer: jest.fn(),
}));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({
  LEADS_TOOLS: [], executeLeadsTool: jest.fn(), resolveLeadForUpdate: jest.fn(),
  previewBulkLeadUpdate: jest.fn(), BULK_LEAD_UPDATE_CAP: 500,
}));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({
  BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn(),
}));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10, createPendingAction: jest.fn(), claimForConfirm: jest.fn(),
  cancelPendingAction: jest.fn(), recordResult: jest.fn(), attachThread: jest.fn(),
}));
jest.mock('../services/intelligence-bar/threads', () => ({
  threadsEnabled: () => false, appendExchange: jest.fn(), latestThread: jest.fn(),
  getThread: jest.fn(), listThreads: jest.fn(), purgeExpiredThreads: jest.fn(),
}));
jest.mock('../services/intelligence-bar/history-tools', () => {
  const HISTORY_TOOLS = [{
    name: 'search_ib_history',
    description: 'test',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  }];
  return { HISTORY_TOOLS, executeHistoryTool: (...args) => mockExecuteHistoryTool(...args) };
});
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user; req.technicianId = user.id; req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (
    ['admin', 'technician'].includes(req.techRole) ? next() : res.status(403).json({ error: 'Staff access required' })
  ),
}));

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

async function withServer(fn) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

async function postQuery(baseUrl, body, token = 'admin') {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function offeredToolNames() {
  return (mockMessagesCreate.mock.calls[0][0].tools || []).map((t) => t.name);
}

beforeEach(() => jest.clearAllMocks());

test('admin: search_ib_history is offered in a regular admin context', async () => {
  mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'hi' }] });
  await withServer(async (baseUrl) => {
    const { status } = await postQuery(baseUrl, { prompt: 'hello', context: 'customers' });
    expect(status).toBe(200);
    expect(offeredToolNames()).toContain('search_ib_history');
  });
});

test('technician: never offered, and refused if the model tries it anyway', async () => {
  mockMessagesCreate
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'tu1', name: 'search_ib_history', input: { query: 'x' } }] })
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'done' }] });
  await withServer(async (baseUrl) => {
    const { status } = await postQuery(baseUrl, { prompt: 'what did I say', context: 'tech' }, 'tech');
    expect(status).toBe(200);
    expect(offeredToolNames()).not.toContain('search_ib_history');
    expect(mockExecuteHistoryTool).not.toHaveBeenCalled();
  });
});

test('admin tool call is dispatched with the actor id from the request, not the model input', async () => {
  mockExecuteHistoryTool.mockResolvedValue({ query: 'hesen', total: 0, results: [], receipts: [] });
  mockMessagesCreate
    .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'tu1', name: 'search_ib_history', input: { query: 'hesen', actorId: 'someone-else' } }] })
    .mockResolvedValueOnce({ content: [{ type: 'text', text: 'nothing found' }] });
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'what did I decide about hesen', context: 'schedule' });
    expect(status).toBe(200);
    expect(body.response).toBe('nothing found');
    expect(mockExecuteHistoryTool).toHaveBeenCalledTimes(1);
    const [name, input, ctx] = mockExecuteHistoryTool.mock.calls[0];
    expect(name).toBe('search_ib_history');
    expect(input.query).toBe('hesen');
    expect(ctx).toEqual({ actorId: 'admin-1' });
  });
});
