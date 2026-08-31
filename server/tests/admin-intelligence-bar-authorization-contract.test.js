/**
 * W0B authorization contract — route-level invariants. The mock scaffold
 * mirrors admin-intelligence-bar-ui-confirm.test.js (same trust-boundary
 * fixtures); the contract and cancellation suites are at the bottom.
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
const mockResolveEstimate = jest.fn();
jest.mock('../services/intelligence-bar/estimate-tools', () => ({
  ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn(),
  resolveEstimateByIdentifier: (...a) => mockResolveEstimate(...a),
}));
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
const mockProjectCredit = jest.fn();
jest.mock('../services/inspection-credit', () => ({ projectRedeemableOfferAmount: (...a) => mockProjectCredit(...a) }));
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

describe('W0B cancel_appointment is not card-confirmable', () => {
  beforeEach(() => jest.clearAllMocks());
  test('every cancel proposal is refused and routed to the Dispatch screen — no pending action, no execution', async () => {
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: { appointment_id: 'ap1', reason: 'rain' } }],
      [{ type: 'text', text: 'Use Dispatch.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'cancel it', context: 'schedule' });
      expect(status).toBe(200);
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      expect(mockExecuteTool).not.toHaveBeenCalled();
      expect(body.pendingActions).toEqual([]);
      const secondCallMessages = mockMessagesCreate.mock.calls[1][0].messages;
      const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
      expect(toolResult.error).toMatch(/Dispatch screen/);
      expect(toolResult.error).toMatch(/Nothing was changed/);
    });
  });
});

describe('W0B two-step execution pin', () => {
  const { previewFingerprint } = jest.requireActual('../services/intelligence-bar/authorization-contract');
  const PREVIEW = { preview: true, would_create: { first_name: 'Test', phone: '9415550100' }, generated_at: 'x' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'create_customer', summary: 's', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  test('proposal pins the resolved preview and the card discloses it', async () => {
    mockExecuteTool.mockResolvedValue(PREVIEW);
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'create_customer', input: { first_name: 'Test', phone: '9415550100' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'add', context: 'customers' });
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params._two_step_preview_fingerprint).toBe(previewFingerprint(PREVIEW));
      expect(stored.contract.effects.map((e) => e.label)).toContainEqual('would create: { first name: Test; phone: 9415550100 }');
      expect(body.pendingActions[0].params._two_step_preview_fingerprint).toBeUndefined();
    });
  });

  test('/confirm-action re-runs the preview and executes only when it still matches', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'create_customer', params: { first_name: 'Test', phone: '9415550100', _two_step_preview_fingerprint: previewFingerprint(PREVIEW) } },
    });
    mockExecuteTool
      .mockResolvedValueOnce({ ...PREVIEW, generated_at: 'later' }) // re-preview (volatile field differs — fine)
      .mockResolvedValueOnce({ success: true, customer_id: 'c1' }); // confirmed run
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(200);
      expect(mockExecuteTool).toHaveBeenCalledTimes(2);
      expect(mockExecuteTool.mock.calls[0][1].confirmed).toBeUndefined();
      expect(mockExecuteTool.mock.calls[1][1]).toEqual({ first_name: 'Test', phone: '9415550100', confirmed: true });
    });
  });

  test('/confirm-action refuses when the re-run preview resolves differently', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'create_customer', params: { first_name: 'Test', phone: '9415550100', _two_step_preview_fingerprint: previewFingerprint(PREVIEW) } },
    });
    mockExecuteTool.mockResolvedValueOnce({ ...PREVIEW, would_create: { first_name: 'Test', phone: '9415550199' } });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.preview_changed).toBe(true);
      expect(mockExecuteTool).toHaveBeenCalledTimes(1); // preview only — never the confirmed run
    });
  });
});

describe('W0B proposal-time pins for legacy-bare writes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'x', summary: 's', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  test('trigger_review_request: recipient resolved at proposal, shown on the card, refused at confirm on phone drift', async () => {
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'acct', last_name: '1042', phone: '+19415550000' });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'trigger_review_request', input: { customer_name: 'acct 1042' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'ask for a review', context: 'customers' });
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params._pinned_phone).toBe('+19415550000');
      expect(stored.params.customer_id).toBe('c1'); // canonicalized to the pinned row
      expect(stored.contract.effects.map((e) => e.label)).toContainEqual('Send review request to acct 1042 (…0000)');
      expect(stored.contract.pinned_recipient).toMatchObject({ name: 'acct 1042', phone_last4: '0000' });
      expect(body.pendingActions[0].params.recipient).toBe('acct 1042 (…0000)');
      expect(body.pendingActions[0].params._pinned_phone).toBeUndefined();
    });

    // Confirm: the customer's phone changed since the card → refuse.
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'trigger_review_request', params: { customer_name: 'acct 1042', _pinned_phone: '+19415550000' } },
    });
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'acct', last_name: '1042', phone: '+19415559999' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(409);
      expect((await res.json()).preview_changed).toBe(true);
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });
  });

  test('trigger_review_request: unchanged recipient executes with the pin carried into the executor', async () => {
    mockClaimForConfirm.mockResolvedValue({
      // Name-pinned row (this suite's db stub has no query chain; the
      // customer_id path is exercised in the proposal test above).
      action: { id: PENDING_ID, tool_name: 'trigger_review_request', params: { customer_name: 'acct 1042', _pinned_phone: '+19415550000' } },
    });
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'acct', last_name: '1042', phone: '+19415550000' });
    mockExecuteTool.mockResolvedValue({ success: true });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(200);
      expect(mockExecuteTool).toHaveBeenCalledWith('trigger_review_request', { customer_name: 'acct 1042', _pinned_phone: '+19415550000' });
    });
  });
});

describe('W0B booking is card-confirmable only when credit-free', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'create_appointment', summary: 's', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  test('a customer with open inspection credit is refused → Schedule screen; nothing proposed', async () => {
    mockProjectCredit.mockResolvedValue({ amount: 49 });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'create_appointment', input: { customer_id: 'c1', date: '2026-09-02', service_type: 'Quarterly Pest' } }],
      [{ type: 'text', text: 'Use Schedule.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'book it', context: 'schedule' });
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      expect(body.pendingActions).toEqual([]);
      const secondCallMessages = mockMessagesCreate.mock.calls[1][0].messages;
      const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
      expect(toolResult.error).toMatch(/\$49\.00 of inspection credit/);
      expect(toolResult.error).toMatch(/Schedule screen/);
    });
  });

  test('credit-free booking is proposed with the zero pin carried into the executor', async () => {
    mockProjectCredit.mockResolvedValue({ amount: 0 });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'create_appointment', input: { customer_id: 'c1', date: '2026-09-02' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'book it', context: 'schedule' });
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params._inspection_credit_amount).toBe(0);
      expect(stored.contract.effects.map((e) => e.label)).toContainEqual('No open inspection credit is redeemed by this booking (verified again at commit)');
      expect(body.pendingActions[0].params._inspection_credit_amount).toBeUndefined();
    });
    // Confirm: a credit appeared since the card → route refuses before the executor.
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'create_appointment', params: { customer_id: 'c1', date: '2026-09-02', _inspection_credit_amount: 0 } },
    });
    mockProjectCredit.mockResolvedValue({ amount: 49 });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(409);
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });
    // Unchanged → executes WITH the zero pin (the executor re-verifies inside its transaction).
    mockProjectCredit.mockResolvedValue({ amount: 0 });
    mockExecuteTool.mockResolvedValue({ success: true });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(200);
      expect(mockExecuteTool).toHaveBeenCalledWith('create_appointment', { customer_id: 'c1', date: '2026-09-02', _inspection_credit_amount: 0 });
    });
  });
});

describe('W0B estimate toggle pin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'toggle_show_one_time_option', summary: 's', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  test('phone identifier resolves to the immutable estimate id; omitted enabled is frozen to the flip; Confirm refuses on drift', async () => {
    mockResolveEstimate.mockResolvedValue({ id: 'e1', token: 'tok-1', customer_name: 'acct-3001', show_one_time_option: false });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'toggle_show_one_time_option', input: { estimate_identifier: '9415550100' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'show the one-time option', context: 'estimates' });
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params.estimate_identifier).toBe('e1'); // canonicalized to the uuid
      expect(stored.params.enabled).toBe(true); // frozen flip, not re-derived at commit
      expect(stored.params._estimate_fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.contract.effects.map((e) => e.label)).toContainEqual('Estimate tok-1 (acct-3001): one-time option off → on (customer-facing)');
      expect(body.pendingActions[0].params.change).toBe('show_one_time_option: false → true');
      expect(body.pendingActions[0].params._estimate_fingerprint).toBeUndefined();

      // Confirm: someone already flipped it → drift.
      mockClaimForConfirm.mockResolvedValue({ action: { id: PENDING_ID, tool_name: 'toggle_show_one_time_option', params: { ...stored.params } } });
      mockResolveEstimate.mockResolvedValue({ id: 'e1', token: 'tok-1', show_one_time_option: true });
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(409);
      expect(mockExecuteTool).not.toHaveBeenCalled();

      // Unchanged → executes with the uuid + frozen flag, pin stripped.
      mockResolveEstimate.mockResolvedValue({ id: 'e1', token: 'tok-1', show_one_time_option: false });
      mockExecuteTool.mockResolvedValue({ success: true });
      const ok = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(ok.status).toBe(200);
      expect(mockExecuteTool).toHaveBeenCalledWith('toggle_show_one_time_option', { estimate_identifier: 'e1', enabled: true });
    });
  });
});
