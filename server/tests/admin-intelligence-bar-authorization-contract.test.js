/**

 *









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
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn() }));
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
const mockPreviewCancellation = jest.fn();
jest.mock('../services/intelligence-bar/cancellation-preview', () => {
  const actual = jest.requireActual('../services/intelligence-bar/cancellation-preview');
  return {
    previewCancellationEffects: (...args) => mockPreviewCancellation(...args),
    cancellationFingerprint: actual.cancellationFingerprint,
  };
});
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


/**
 * W0B authorization contract through the route:
 *  1. A proposal stores + returns a server-built contract and its hash.
 *  2. /confirm-action forwards the echoed contract_hash into the claim.
 *  3. A contract_mismatch claim is a 409 with the re-propose message.
 */
const CONTRACT_HASH = 'a'.repeat(64);

describe('W0B authorization contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID,
      tool_name: 'create_customer',
      summary: 'create_customer — first_name: Test',
      expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  test('proposal stores a contract + hash and the client payload carries both', async () => {
    mockExecuteTool.mockResolvedValue({ preview: true, would_create: { first_name: 'Test' } });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'create_customer', input: { first_name: 'Test', phone: '9415550100' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'add a customer', context: 'customers' });
      expect(status).toBe(200);
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.contract).toMatchObject({ version: 1, tool: 'create_customer', tier: 'yellow', action_label: 'Create a customer' });
      expect(stored.contract.effects.map((e) => e.label)).toEqual(expect.arrayContaining(['first name: Test', 'phone: 9415550100']));
      expect(stored.contractHash).toMatch(/^[0-9a-f]{64}$/);
      const card = body.pendingActions[0];
      expect(card.contract).toEqual(stored.contract);
      expect(card.contract_hash).toBe(stored.contractHash);
      // The hash is a client credential companion — never model-visible.
      expect(JSON.stringify(mockMessagesCreate.mock.calls)).not.toContain(stored.contractHash);
    });
  });

  test('/confirm-action forwards the echoed contract_hash into the claim', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'create_customer', params: { first_name: 'Test' }, contract: { tier: 'yellow' } },
    });
    mockExecuteTool.mockResolvedValue({ success: true });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID, contract_hash: CONTRACT_HASH }),
      });
      expect(res.status).toBe(200);
      expect(mockClaimForConfirm).toHaveBeenCalledWith(PENDING_ID, 'admin-1', { contractHash: CONTRACT_HASH });
    });
  });

  test('contract mismatch is a 409 that tells the operator to re-propose, nothing executes', async () => {
    mockClaimForConfirm.mockResolvedValue({ error: 'contract_mismatch' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID, contract_hash: 'b'.repeat(64) }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/no longer matches/);
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });
  });
});

describe('W0B cancellation money effects', () => {
  const PREVIEW = {
    appointment: { id: 'ap1', scheduled_date: '2026-09-02', service_type: 'Quarterly Pest', status: 'scheduled', customer_name: 'acct-3001' },
    fee: { rail: 'card_hold', applies: true, amount: 49, unresolved: false },
    invoices: [{ id: 'inv1', invoice_number: 'INV-1001', status: 'sent', total: 120, amount_paid: 0 }],
  };
  const { cancellationFingerprint } = jest.requireActual('../services/intelligence-bar/cancellation-preview');

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'cancel_appointment', summary: 'cancel', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  test('proposal previews fee + invoice effects, pins a fingerprint, and the contract discloses the charge', async () => {
    mockPreviewCancellation.mockResolvedValue(PREVIEW);
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: { appointment_id: 'ap1', reason: 'rain' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'cancel it', context: 'schedule' });
      expect(status).toBe(200);
      expect(mockExecuteTool).not.toHaveBeenCalled(); // legacy-bare: never executed from the loop
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params._cancellation_fingerprint).toBe(cancellationFingerprint(PREVIEW));
      const labels = stored.contract.effects.map((e) => e.label);
      expect(labels).toContainEqual('Late-cancel fee of $49.00 WILL be charged to the card on file');
      expect(labels).toContainEqual('Void invoice INV-1001 (sent, $120.00) — applied credits/deposits restored');
      expect(body.pendingActions[0].contract.effects.map((e) => e.label)).toEqual(labels);
      // Internal pins never ride to the card.
      expect(body.pendingActions[0].params._cancellation_fingerprint).toBeUndefined();
    });
  });

  test('/confirm-action refuses when the money posture drifted after the card was shown', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: {
        id: PENDING_ID, tool_name: 'cancel_appointment',
        params: { appointment_id: 'ap1', reason: 'rain', _cancellation_fingerprint: cancellationFingerprint(PREVIEW) },
      },
    });
    // Fee window elapsed between proposal and confirm → no fee now.
    mockPreviewCancellation.mockResolvedValue({ ...PREVIEW, fee: { rail: 'card_hold', applies: false, amount: null, unresolved: false } });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.preview_changed).toBe(true);
      expect(mockExecuteTool).not.toHaveBeenCalled();
      expect(mockRecordResult).toHaveBeenCalledWith(PENDING_ID, expect.objectContaining({ preview_changed: true }));
    });
  });

  test('/confirm-action executes when the money posture is unchanged, with the fingerprint stripped', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: {
        id: PENDING_ID, tool_name: 'cancel_appointment',
        params: { appointment_id: 'ap1', reason: 'rain', _cancellation_fingerprint: cancellationFingerprint(PREVIEW) },
      },
    });
    mockPreviewCancellation.mockResolvedValue(PREVIEW);
    mockExecuteTool.mockResolvedValue({ success: true, appointment_id: 'ap1' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(200);
      expect(mockExecuteTool).toHaveBeenCalledWith('cancel_appointment', { appointment_id: 'ap1', reason: 'rain' });
    });
  });
});
