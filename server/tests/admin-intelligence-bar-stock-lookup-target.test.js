/**
 * adjust_stock target from the bar's own lookup (owner IB history 2026-10-06):
 * the operator used a short product name, query_stock found exactly one
 * product, adjust_stock was proposed with that id, and the proposal was
 * refused, so the stock was never written. The route now hands
 * resolveInventoryWriteTarget the products its OWN lookups showed the model
 * alone, from EARLIER rounds of this request only (a read in the same round
 * had not reached the model yet). A refusal tells the model nothing was
 * written and leaves no card; an accepted target still shows the card with
 * the product and on hand before and after (owner 2026-10-05).
 *
 * Harness mirrors admin-intelligence-bar-phantom-card.test.js.
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
// Real tool definitions and the real productsShownAlone; the reads, the
// preview and the target rule are scripted so the test watches only what the
// route hands the rule.
const mockExecuteProcurementTool = jest.fn();
const mockResolveInventoryWriteTarget = jest.fn();
jest.mock('../services/intelligence-bar/procurement-tools', () => {
  const actual = jest.requireActual('../services/intelligence-bar/procurement-tools');
  return {
    PROCUREMENT_TOOLS: actual.PROCUREMENT_TOOLS,
    productsShownAlone: actual.productsShownAlone,
    executeProcurementTool: (...args) => mockExecuteProcurementTool(...args),
    resolveInventoryWriteTarget: (...args) => mockResolveInventoryWriteTarget(...args),
  };
});
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

const PENDING_ID = '7e1c2f7a-1111-2222-3333-deadbeef0003';

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

const PRODUCT_ID = '5b0c8f1e-0000-4000-8000-000000000001';
const PREVIEW = {
  preview: true, tool: 'adjust_stock', product: { id: PRODUCT_ID, name: 'Synthetic Guard CS' }, movement_type: 'restock',
  stock_before: 62, change: 256, stock_after: 318, unit: 'fl_oz', entered_quantity: 2, entered_unit: 'gal', _version: 'v1',
};
const lookup = (id = 'tu_lookup') => ({ type: 'tool_use', id, name: 'query_stock', input: { search: 'guard' } });
const adjust = (id = 'tu_adjust') => ({ type: 'tool_use', id, name: 'adjust_stock', input: { product_id: PRODUCT_ID, movement_type: 'restock', quantity: 2, unit: 'gal' } });

beforeEach(() => {
  jest.clearAllMocks();
  mockCreatePendingAction.mockResolvedValue({
    id: PENDING_ID, tool_name: 'adjust_stock', summary: 'adjust_stock', expires_at: new Date(Date.now() + 600000).toISOString(),
  });
  mockExecuteProcurementTool.mockImplementation(async (name) => (name === 'query_stock'
    ? { products: [{ id: PRODUCT_ID, name: 'Synthetic Guard CS', on_hand: 62 }], total: 1 }
    : PREVIEW));
});

const modelSaw = () => mockMessagesCreate.mock.calls.map(([request]) => JSON.stringify(request.messages)).join('\n');

test('a lookup in an earlier round reaches the target rule, and the card names the product and on hand before and after', async () => {
  mockResolveInventoryWriteTarget.mockResolvedValue({ productId: PRODUCT_ID });
  scriptModelTurns([[lookup()], [adjust()], [{ type: 'text', text: 'Confirm the card to add it.' }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'Add 2 gallons of the Guard to inventory', context: 'procurement', pageData: { route: '/admin/inventory' } });
    expect(status).toBe(200);
    const [args] = mockResolveInventoryWriteTarget.mock.calls[0];
    expect([...args.lookedUpProductIds]).toEqual([PRODUCT_ID]);
    expect(body.pendingActions).toHaveLength(1);
    const labels = (body.pendingActions[0].contract?.effects || []).map((effect) => effect.label);
    expect(labels).toContain('Synthetic Guard CS: restock 2 gal; on hand 62 → 318 fl_oz');
    expect(mockCreatePendingAction.mock.calls[0][0].params.product_id).toBe(PRODUCT_ID);
  });
});

test('a lookup in the SAME round as the proposal does not count (the model had not seen it)', async () => {
  mockResolveInventoryWriteTarget.mockResolvedValue({ error: 'Choose the exact product or restock request for this action.', code: 'target_clarification_required' });
  scriptModelTurns([[lookup(), adjust()], [{ type: 'text', text: 'Which product?' }]]);
  await withServer(async (baseUrl) => {
    const { status } = await postQuery(baseUrl, { prompt: 'Add 2 gallons of the Guard to inventory', context: 'procurement', pageData: { route: '/admin/inventory' } });
    expect(status).toBe(200);
    const [args] = mockResolveInventoryWriteTarget.mock.calls[0];
    expect([...args.lookedUpProductIds]).toEqual([]);
  });
});

test('a refused target leaves no card and tells the model plainly that nothing was written', async () => {
  mockResolveInventoryWriteTarget.mockResolvedValue({ error: 'Choose the exact product or restock request for this action.', code: 'target_clarification_required' });
  scriptModelTurns([[adjust()], [{ type: 'text', text: 'Which product did you mean?' }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'Add 2 gallons of the Guard to inventory', context: 'procurement', pageData: { route: '/admin/inventory' } });
    expect(status).toBe(200);
    expect(body.pendingActions || []).toEqual([]);
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
    expect(modelSaw()).toContain('Nothing was written and no confirmation card was created.');
    expect(modelSaw()).toContain('"is_error":true');
  });
});
