/**
 * GATE_IB_TOOL_ACTIVITY — operator-facing activity lines on /query.
 *
 * Invariants:
 *  1. Gate off (unset / anything but 1|true|on): the response carries NO
 *     toolActivity key — byte-identical to today's payload.
 *  2. Gate on: one line per tool call — label, status (done / error /
 *     proposed), durationMs, round — and NEVER the tool input, the tool
 *     result, or a pending-action id.
 *
 * Harness (mocks + helpers) mirrors admin-intelligence-bar-ui-confirm.test.js.
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
const mockResolveCommsCustomer = jest.fn();
const mockLoadReviewRecipient = jest.fn();
const mockResolveTechnician = jest.fn();
const mockResolveTechnicianById = jest.fn();
const mockResolveLeadForUpdate = jest.fn();
const mockPreviewBulkLeadUpdate = jest.fn();

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
  // Mirror of the executor's sanitizer allowlist — the proposal's
  // refuse-don't-drop key check (GH r20 P2) reads it.
  UPDATABLE_FIELDS: {
    first_name: 'first_name', last_name: 'last_name', email: 'email',
    phone: 'phone', city: 'city', state: 'state', zip: 'zip',
    address_line1: 'address_line1', address_line2: 'address_line2', waveguard_tier: 'waveguard_tier',
    pipeline_stage: 'pipeline_stage', lead_source: 'lead_source',
    monthly_rate: 'monthly_rate', active: 'active', notes: 'crm_notes',
  },
  executeTool: (...args) => mockExecuteTool(...args),
  resolveTechnicianByName: (...args) => mockResolveTechnician(...args),
  resolveActiveTechnicianById: (...args) => mockResolveTechnicianById(...args),
}));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({
  REVIEW_TOOLS: [], executeReviewTool: jest.fn(), hasRecentReviewRequest: jest.fn(async () => false),
  loadReviewRecipient: (...args) => mockLoadReviewRecipient(...args),
}));
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(),
  resolveCustomer: (...args) => mockResolveCommsCustomer(...args),
}));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({
  LEADS_TOOLS: [], executeLeadsTool: jest.fn(),
  resolveLeadForUpdate: (...args) => mockResolveLeadForUpdate(...args),
  previewBulkLeadUpdate: (...args) => mockPreviewBulkLeadUpdate(...args),
  BULK_LEAD_UPDATE_CAP: 500,
}));
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
// create_appointment proposals project the customer's inspection credit
// (W0B disclosure) — keep it off the db stub here.
jest.mock('../services/inspection-credit', () => ({ projectRedeemableOfferAmount: jest.fn(async () => ({ amount: 0 })) }));
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
    // Stack rides on the response so an unexpected 500 names its cause in the
    // assertion output — this suite's 500s are otherwise invisible (the route
    // logs through the mocked logger).
    res.status(err.status || 500).json({ error: err.message, stack: err.stack });
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

describe('GATE_IB_TOOL_ACTIVITY on /query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_IB_TOOL_ACTIVITY;
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Jeff', last_name: 'V' });
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });
  afterAll(() => { delete process.env.GATE_IB_TOOL_ACTIVITY; });

  function script() {
    mockExecuteTool.mockImplementation(async (name) => {
      if (name === 'query_customers') return { customers: [{ id: 'c1' }], total_matching: 1 };
      if (name === 'get_invoice') return { error: 'invoice not found' };
      return {};
    });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'query_customers', input: { search: 'Jeff', phone: '9415550100' } }],
      [
        { type: 'tool_use', id: 'tu_2', name: 'get_invoice', input: { invoice_id: 'inv-404' } },
        { type: 'tool_use', id: 'tu_3', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } },
      ],
      [{ type: 'text', text: 'Proposed — confirm in the card.' }],
    ]);
  }

  test('gate off: no toolActivity key at all (payload byte-identical to today)', async () => {
    script();
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'set Jeff city', context: 'customers' });
      expect(status).toBe(200);
      expect('toolActivity' in body).toBe(false);
      expect(body.toolCalls).toHaveLength(3);
    });
  });

  test('gate on: one labeled line per tool call with outcome + timing, never inputs, results, or the pending id', async () => {
    process.env.GATE_IB_TOOL_ACTIVITY = 'true';
    script();
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'set Jeff city', context: 'customers' });
      expect(status).toBe(200);
      expect(body.toolActivity).toHaveLength(3);
      expect(body.toolActivity.map((a) => [a.tool, a.label, a.status, a.round])).toEqual([
        ['query_customers', 'Query customers', 'done', 0],
        ['get_invoice', 'Get invoice', 'error', 1],
        ['update_customer', 'Update customer record', 'proposed', 1],
      ]);
      for (const line of body.toolActivity) {
        expect(Object.keys(line).sort()).toEqual(['durationMs', 'label', 'round', 'status', 'tool']);
        expect(typeof line.durationMs).toBe('number');
        expect(line.durationMs).toBeGreaterThanOrEqual(0);
      }
      const serialized = JSON.stringify(body.toolActivity);
      expect(serialized).not.toContain('9415550100'); // tool input
      expect(serialized).not.toContain('Venice');
      expect(serialized).not.toContain('total_matching'); // tool result
      expect(serialized).not.toContain('invoice not found'); // error text
      expect(serialized).not.toContain(PENDING_ID); // confirmation credential
      // Model traffic never carries the activity list either.
      expect(JSON.stringify(mockMessagesCreate.mock.calls)).not.toContain('toolActivity');
    });
  });

  test('gate value is strict: "yes" stays off', async () => {
    process.env.GATE_IB_TOOL_ACTIVITY = 'yes';
    script();
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'set Jeff city', context: 'customers' });
      expect('toolActivity' in body).toBe(false);
    });
  });
});

describe('activityLabel', () => {
  const { activityLabel } = require('../services/intelligence-bar/authorization-contract');
  test('curated write labels first, then the tool name as words', () => {
    expect(activityLabel('send_sms')).toBe('Send a text message');
    expect(activityLabel('query_customers')).toBe('Query customers');
    expect(activityLabel('getKpiSnapshot')).toBe('Get kpi snapshot');
  });
});
