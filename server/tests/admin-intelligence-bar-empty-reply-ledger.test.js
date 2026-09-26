/**
 * POST /admin/intelligence-bar/query — a terminal round with no tool call
 * AND no usable text (a thinking-only or refused reply) already fell
 * through to the `!finalResponse` fallback message, but the ledger row for
 * that exact response stayed a recorded success — the same Codex
 * r10-class gap this ledger exists to catch on every other draft/answer
 * lane. Fixed: that response is now flagged with
 * ledgerCallRejected(response, 'invalid_output').
 *
 * Harness (mocks + helpers) mirrors admin-intelligence-bar-tool-activity.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => jest.fn(() => ({ insert: jest.fn(async () => undefined) })));
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
jest.mock('../services/intelligence-bar/tools', () => ({ TOOLS: [], UPDATABLE_FIELDS: {}, executeTool: jest.fn(), resolveTechnicianByName: jest.fn(), resolveActiveTechnicianById: jest.fn() }));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn(), hasRecentReviewRequest: jest.fn(async () => false), loadReviewRecipient: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({ COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(), resolveCustomer: jest.fn() }));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({ LEADS_TOOLS: [], executeLeadsTool: jest.fn(), resolveLeadForUpdate: jest.fn(), previewBulkLeadUpdate: jest.fn(), BULK_LEAD_UPDATE_CAP: 500 }));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({ BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn() }));
jest.mock('../services/intelligence-bar/pending-actions', () => ({ TTL_MINUTES: 10, createPendingAction: jest.fn(), claimForConfirm: jest.fn(), cancelPendingAction: jest.fn(), recordResult: jest.fn() }));
jest.mock('../services/inspection-credit', () => ({ projectRedeemableOfferAmount: jest.fn(async () => ({ amount: 0 })) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (token !== 'admin') return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (req, res, next) => (req.techRole === 'admin' ? next() : res.status(403).json({ error: 'Staff access required' })),
}));

// Keep the real ledgerCall (GATE_LLM_CALL_LEDGER is unset in tests, so it's
// already a real no-DB no-op) but spy on ledgerCallRejected.
jest.mock('../services/llm-dispatch-metrics', () => {
  const actual = jest.requireActual('../services/llm-dispatch-metrics');
  return { ...actual, ledgerCallRejected: jest.fn() };
});

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');
const { ledgerCallRejected } = require('../services/llm-dispatch-metrics');

function appServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, stack: err.stack }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((resolve) => server.close(resolve)); }
}

async function postQuery(baseUrl, body) {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

beforeEach(() => jest.clearAllMocks());

test('a terminal round with no tool call and no text flags the ledger row and still returns the fallback message', async () => {
  mockMessagesCreate.mockResolvedValueOnce({ content: [] }); // no tool_use, no text — e.g. a refusal
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).toMatch(/complex query that needed too many steps/i);
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'invalid_output');
  });
});

test('a normal text reply is not flagged', async () => {
  mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Here is what I found.' }] });
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).toBe('Here is what I found.');
    expect(ledgerCallRejected).not.toHaveBeenCalled();
  });
});

// Codex r12 on #4884 (same class as the portal assistant): every round a
// tool_use and the loop runs out — the round that ended it is failed.
test('an exhausted tool loop fails the last round and still returns the fallback message', async () => {
  mockMessagesCreate.mockResolvedValue({ content: [{ type: 'tool_use', id: 't1', name: 'no_such_tool', input: {} }] });
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).toMatch(/complex query that needed too many steps/i);
    expect(ledgerCallRejected).toHaveBeenCalledTimes(1);
    expect(ledgerCallRejected).toHaveBeenCalledWith(expect.anything(), 'tool_loop_exhausted');
  });
});
