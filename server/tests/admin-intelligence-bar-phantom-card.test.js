/**
 * Phantom-card guard on POST /admin/intelligence-bar/query (2026-09-25
 * production case): the model can write "awaiting your Confirm on the card
 * below" in plain prose with no tool call at all, so the turn creates no
 * pending action and no card ever renders for the operator to click.
 *
 * Deterministic and truthful either way: only compares what THIS reply
 * claims against what THIS turn actually produced (pendingActions), so a
 * reply that merely references an EARLIER card (already sent, still open
 * from a prior turn) is left alone.
 *
 * Harness mirrors admin-intelligence-bar-tool-activity.test.js.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockExecuteTool = jest.fn();
const mockCreatePendingAction = jest.fn();
const mockDbInsert = jest.fn(async () => undefined);
const mockResolveCommsCustomer = jest.fn();

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
  UPDATABLE_FIELDS: { city: 'city' },
  executeTool: (...args) => mockExecuteTool(...args),
  resolveTechnicianByName: jest.fn(),
  resolveActiveTechnicianById: jest.fn(),
}));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn(), resolveInventoryWriteTarget: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn(), hasRecentReviewRequest: jest.fn(async () => false), loadReviewRecipient: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(),
  resolveCustomer: (...args) => mockResolveCommsCustomer(...args),
}));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({ LEADS_TOOLS: [], executeLeadsTool: jest.fn(), resolveLeadForUpdate: jest.fn(), previewBulkLeadUpdate: jest.fn(), BULK_LEAD_UPDATE_CAP: 500 }));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({ BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn() }));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10,
  createPendingAction: (...args) => mockCreatePendingAction(...args),
  claimForConfirm: jest.fn(),
  cancelPendingAction: jest.fn(),
  recordResult: jest.fn(),
}));
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

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

const PENDING_ID = '7e1c2f7a-1111-2222-3333-deadbeef0002';

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

function scriptModelTurns(turns) {
  mockMessagesCreate.mockReset();
  for (const content of turns) mockMessagesCreate.mockResolvedValueOnce({ content });
}

async function postQuery(baseUrl, body) {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const NOTICE = 'No confirmation card was created for this reply';
// Tool-agnostic (finding 3): the notice never names a specific tool's own
// fields (the old wording's "product and amount" example didn't fit every
// write tool), so it reads the same regardless of which tool's card was
// claimed.
const FULL_NOTICE = 'No confirmation card was created for this reply, so nothing will change. Ask again and say exactly what to change.';

beforeEach(() => {
  jest.clearAllMocks();
  mockCreatePendingAction.mockResolvedValue({
    id: PENDING_ID, tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString(),
  });
});

test('a reply claiming a confirmation card with NO tool call gets the phantom-card notice appended', async () => {
  scriptModelTurns([[{ type: 'text', text: 'Prepared — restock 1 bottle (500 g) of Alpine WSG, awaiting your Confirm on the card below.' }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'add a bottle of Alpine WSG', context: 'estimates' });
    expect(status).toBe(200);
    expect(body.pendingActions).toEqual([]);
    expect(body.response).toContain(NOTICE);
    // Exact tool-agnostic wording (finding 3) — never a specific tool's own
    // field names or example.
    expect(body.response).toContain(FULL_NOTICE);
    // The persisted/analytics-logged turn matches what the operator sees.
    const insertedRow = mockDbInsert.mock.calls[0]?.[0];
    expect(insertedRow?.response).toContain(NOTICE);
  });
});

test('the notice is tool-agnostic even when the claimed card belongs to a non-inventory tool', async () => {
  scriptModelTurns([[{ type: 'text', text: "Prepared — I've set that up, confirm on the card below." }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'update the customer address', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).toContain(FULL_NOTICE);
  });
});

test('a reply with ordinary text and no card claim is untouched', async () => {
  scriptModelTurns([[{ type: 'text', text: 'Here is what I found for that customer.' }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).toBe('Here is what I found for that customer.');
    expect(body.response).not.toContain(NOTICE);
  });
});

test('a reply that only references an EARLIER, already-sent card is left alone', async () => {
  scriptModelTurns([[{ type: 'text', text: 'That confirmation card was already sent earlier in this conversation — use that card to proceed.' }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).not.toContain(NOTICE);
  });
});

test('a genuine new-card claim is flagged even when an EARLIER sentence in the same reply mentions an old card (per-sentence evaluation)', async () => {
  scriptModelTurns([[{ type: 'text', text: "The earlier card expired. I've prepared a new confirmation card below." }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).toContain(NOTICE);
  });
});

test('a reply claiming a card that THIS turn actually created gets no notice', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Jeff', last_name: 'V' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: 'Prepared — confirm on the card below.' }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Jeff city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).not.toContain(NOTICE);
  });
});
