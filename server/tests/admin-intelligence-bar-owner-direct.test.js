/**
 * Owner-direct mode in the /query loop (owner ruling 2026-10-01,
 * GATE_IB_OWNER_DIRECT). For the owner login an internal edit is proposed
 * and then committed in the same turn through the one commit path — no
 * confirmation card. Everything else keeps its card: other logins, the gate
 * off, and customer messages / money / bulk changes even for the owner.
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
// The create_appointment price + billing verdict (ADMIN-BUG-R12, owner
// 2026-09-27): unpriced and billable by default, so these proposals reach
// their card; the priced and refusal cases set their own.
const mockIbBookingProposal = jest.fn(async () => ({ price: null, source: null, serviceId: null, serviceName: null }));
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
  ibBookingProposal: (...args) => mockIbBookingProposal(...args),
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
      owner: { id: 'owner-1', role: 'admin', email: 'contact@wavespestcontrol.com' },
      admin: { id: 'admin-1', role: 'admin', email: 'office@example.test' },
      tech: { id: 'tech-1', role: 'technician', email: 'contact@wavespestcontrol.com' },
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

const CONTRACT_HASH_RE = /^[0-9a-f]{16,}$/i;

function pendingRow(toolName) {
  return { id: PENDING_ID, tool_name: toolName, summary: `${toolName} — synthetic`, status: 'pending',
    expires_at: new Date(Date.now() + 600000).toISOString() };
}

// The executor sees `confirmed` on the input (two-step tools) or on its
// options (legacy bare writes such as update_customer): either is the write.
const confirmedCall = ([, input, , options]) => input?.confirmed === true || options?.confirmed === true;

// The tool_result the model saw after its write call (second model request).
function writeResultSeenByModel() {
  const messages = mockMessagesCreate.mock.calls[1][0].messages;
  return JSON.parse(messages[messages.length - 1].content[0].content);
}

const CREATE_CUSTOMER = [
  [{ type: 'tool_use', id: 'tu_1', name: 'create_customer', input: { first_name: 'Synthetic', last_name: 'Fixture', phone: '9415550100' } }],
  [{ type: 'text', text: 'Added Synthetic Fixture.' }],
];

describe('owner-direct in /query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_IB_OWNER_DIRECT = 'true';
    mockCreatePendingAction.mockResolvedValue(pendingRow('create_customer'));
    mockCancelPendingAction.mockResolvedValue({ cancelled: true });
    mockRecordResult.mockResolvedValue(true);
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'create_customer', params: { first_name: 'Synthetic', last_name: 'Fixture', phone: '9415550100' } },
    });
    // Unconfirmed = the mutation-free preview; confirmed = the write.
    mockExecuteTool.mockImplementation(async (...call) => (confirmedCall(call)
      ? { success: true, customer_id: 'c-new' }
      : { preview: true, would_create: { first_name: 'Synthetic', last_name: 'Fixture' } }));
  });

  afterAll(() => {
    delete process.env.GATE_IB_OWNER_DIRECT;
  });

  test('owner + gate: an internal edit commits in the same turn, with no card', async () => {
    scriptModelTurns(CREATE_CUSTOMER);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'add a customer Synthetic Fixture 941-555-0100', context: 'customers' }, 'owner');
      expect(status).toBe(200);
      expect(body.pendingActions).toEqual([]);
      expect(body.response).toBe('Added Synthetic Fixture.');

      // Proposed first (pins + audit row), then claimed by the same actor
      // with the hash the proposal minted — the Confirm click's own path.
      expect(mockCreatePendingAction).toHaveBeenCalledTimes(1);
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.requestedBy).toBe('owner-1');
      expect(mockClaimForConfirm).toHaveBeenCalledTimes(1);
      const [claimedId, claimedBy, claimOptions] = mockClaimForConfirm.mock.calls[0];
      expect(claimedId).toBe(PENDING_ID);
      expect(claimedBy).toBe('owner-1');
      expect(claimOptions.contractHash).toMatch(CONTRACT_HASH_RE);
      expect(claimOptions.contractHash).toBe(stored.contractHash);

      // The write ran once, confirmed by the server, and left its receipt.
      const confirmedCalls = mockExecuteTool.mock.calls.filter(confirmedCall);
      expect(confirmedCalls).toHaveLength(1);
      expect(confirmedCalls[0][0]).toBe('create_customer');
      expect(mockRecordResult).toHaveBeenCalledWith(PENDING_ID, { success: true, customer_id: 'c-new' });
      expect(mockCancelPendingAction).not.toHaveBeenCalled();

      const seen = writeResultSeenByModel();
      expect(seen).toMatchObject({ executed: true, outcome: 'completed', result: { success: true, customer_id: 'c-new' } });
      expect(seen.pending_confirmation).toBeUndefined();
      // The pending-action id never reaches the model.
      expect(JSON.stringify(mockMessagesCreate.mock.calls[1][0])).not.toContain(PENDING_ID);
    });
  });

  test('owner + gate: the prompt carries the owner block; other logins never see it', async () => {
    const systemText = () => mockMessagesCreate.mock.calls[0][0].system.map(part => part.text).join('\n');
    await withServer(async (baseUrl) => {
      scriptModelTurns([[{ type: 'text', text: 'ok' }]]);
      await postQuery(baseUrl, { prompt: 'hello', context: 'customers' }, 'owner');
      expect(systemText()).toContain('OWNER MODE');
      expect(systemText()).toContain('update_lead_contact');

      scriptModelTurns([[{ type: 'text', text: 'ok' }]]);
      await postQuery(baseUrl, { prompt: 'hello', context: 'customers' }, 'admin');
      expect(systemText()).not.toContain('OWNER MODE');

      delete process.env.GATE_IB_OWNER_DIRECT;
      scriptModelTurns([[{ type: 'text', text: 'ok' }]]);
      await postQuery(baseUrl, { prompt: 'hello', context: 'customers' }, 'owner');
      expect(systemText()).not.toContain('OWNER MODE');
    });
  });

  test.each([
    ['another admin login, gate on', 'admin', 'true'],
    ['the owner login, gate off', 'owner', undefined],
    ['the owner login, gate set to a non-true value', 'owner', 'false'],
  ])('%s: the same edit still waits on its card', async (_label, token, gate) => {
    if (gate === undefined) delete process.env.GATE_IB_OWNER_DIRECT;
    else process.env.GATE_IB_OWNER_DIRECT = gate;
    scriptModelTurns(CREATE_CUSTOMER);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'add a customer Synthetic Fixture', context: 'customers' }, token);
      expect(body.pendingActions).toHaveLength(1);
      expect(body.pendingActions[0].id).toBe(PENDING_ID);
      expect(mockClaimForConfirm).not.toHaveBeenCalled();
      expect(mockExecuteTool.mock.calls.some(confirmedCall)).toBe(false);
      expect(writeResultSeenByModel().pending_confirmation).toBe(true);
    });
  });

  test('owner + gate: a billing field on update_customer keeps the card; a contact field commits', async () => {
    // The update_customer proposal resolves the target to a name for the card.
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Synthetic', last_name: 'Fixture' });
    mockCreatePendingAction.mockResolvedValue(pendingRow('update_customer'));
    mockClaimForConfirm.mockResolvedValue({ action: { id: PENDING_ID, tool_name: 'update_customer', params: { customer_id: 'c1', updates: { first_name: 'Jay' } } } });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { monthly_rate: 49 } } }],
      [{ type: 'text', text: 'Tap Confirm.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'set the monthly rate to 49', context: 'customers' }, 'owner');
      expect(body.pendingActions).toHaveLength(1);
      expect(mockClaimForConfirm).not.toHaveBeenCalled();

      jest.clearAllMocks();
      mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Synthetic', last_name: 'Fixture' });
      mockCreatePendingAction.mockResolvedValue(pendingRow('update_customer'));
      mockClaimForConfirm.mockResolvedValue({ action: { id: PENDING_ID, tool_name: 'update_customer', params: { customer_id: 'c1', updates: { first_name: 'Jay' } } } });
      scriptModelTurns([
        [{ type: 'tool_use', id: 'tu_2', name: 'update_customer', input: { customer_id: 'c1', updates: { first_name: 'Jay' } } }],
        [{ type: 'text', text: 'Renamed to Jay.' }],
      ]);
      // A legacy bare write is never run at proposal; its one executor call
      // is the commit itself (no confirmed flag on the input or options).
      mockExecuteTool.mockResolvedValue({ success: true, updated: ['first_name'] });
      const direct = await postQuery(baseUrl, { prompt: 'change the first name to Jay', context: 'customers' }, 'owner');
      expect(direct.body.pendingActions).toEqual([]);
      expect(mockClaimForConfirm).toHaveBeenCalledTimes(1);
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
      expect(mockExecuteTool.mock.calls[0].slice(0, 2)).toEqual(['update_customer', { customer_id: 'c1', updates: { first_name: 'Jay' } }]);
      expect(writeResultSeenByModel()).toMatchObject({ executed: true, outcome: 'completed' });
    });
  });

  test('owner + gate: an approval that cannot be claimed is cancelled and reported as not done', async () => {
    mockClaimForConfirm.mockResolvedValue({ error: 'expired' });
    scriptModelTurns(CREATE_CUSTOMER);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'add a customer Synthetic Fixture', context: 'customers' }, 'owner');
      expect(status).toBe(200);
      expect(body.pendingActions).toEqual([]);
      expect(mockCancelPendingAction).toHaveBeenCalledWith(PENDING_ID, 'owner-1');
      expect(mockExecuteTool.mock.calls.some(confirmedCall)).toBe(false);
      const seen = writeResultSeenByModel();
      expect(seen.executed).toBe(false);
      expect(seen.error).toBe('Pending action expired');
    });
  });

  test('owner + gate: a write the domain refuses is reported as not done, and its receipt is kept', async () => {
    mockExecuteTool.mockImplementation(async (...call) => (confirmedCall(call)
      ? { error: 'A customer with this phone already exists' }
      : { preview: true }));
    scriptModelTurns(CREATE_CUSTOMER);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'add a customer Synthetic Fixture', context: 'customers' }, 'owner');
      expect(body.pendingActions).toEqual([]);
      expect(mockRecordResult).toHaveBeenCalledWith(PENDING_ID, { error: 'A customer with this phone already exists' });
      // Claimed and consumed: nothing left to cancel.
      expect(mockCancelPendingAction).not.toHaveBeenCalled();
      expect(writeResultSeenByModel()).toMatchObject({ executed: false, error: 'A customer with this phone already exists' });
    });
  });

  test('owner + gate: the emergency write freeze still stops a direct edit', async () => {
    process.env.IB_WRITES_DISABLED = 'true';
    try {
      scriptModelTurns(CREATE_CUSTOMER);
      await withServer(async (baseUrl) => {
        const { body } = await postQuery(baseUrl, { prompt: 'add a customer Synthetic Fixture', context: 'customers' }, 'owner');
        expect(body.pendingActions).toEqual([]);
        expect(mockCreatePendingAction).not.toHaveBeenCalled();
        expect(mockClaimForConfirm).not.toHaveBeenCalled();
        expect(mockExecuteTool.mock.calls.some(confirmedCall)).toBe(false);
      });
    } finally {
      delete process.env.IB_WRITES_DISABLED;
    }
  });
});

describe('/confirm-action still answers as before the commit path was extracted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_IB_OWNER_DIRECT;
  });

  const confirm = (baseUrl, body, token = 'admin') => fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  test('missing id is a 400; a claim error keeps its status and wording', async () => {
    await withServer(async (baseUrl) => {
      const missing = await confirm(baseUrl, {});
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ error: 'pending_action_id is required' });
      for (const [error, status, message] of [['not_found', 404, 'Pending action not found'], ['actor_mismatch', 403, 'Pending action actor mismatch'],
        ['already_used', 409, 'Pending action already used'],
        ['contract_mismatch', 409, 'The confirmation card no longer matches the proposed action. Ask again to get a fresh card.']]) {
        mockClaimForConfirm.mockResolvedValue({ error });
        const res = await confirm(baseUrl, { pending_action_id: PENDING_ID, contract_hash: ' abc ' });
        expect([error, res.status]).toEqual([error, status]);
        expect(await res.json()).toEqual({ error: message });
      }
      expect(mockClaimForConfirm).toHaveBeenLastCalledWith(PENDING_ID, 'admin-1', { contractHash: 'abc' });
    });
  });

  test('a confirmed write answers 200 with the outcome; a preview_changed result answers 409', async () => {
    mockClaimForConfirm.mockResolvedValue({ action: { id: PENDING_ID, tool_name: 'create_customer', params: { first_name: 'Synthetic' } } });
    mockRecordResult.mockResolvedValue(true);
    await withServer(async (baseUrl) => {
      mockExecuteTool.mockResolvedValue({ success: true, customer_id: 'c-new' });
      const ok = await confirm(baseUrl, { pending_action_id: PENDING_ID });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ success: true, outcome: 'completed', tool: 'create_customer', result: { success: true, customer_id: 'c-new' } });

      mockExecuteTool.mockResolvedValue({ error: 'changed', preview_changed: true });
      const drifted = await confirm(baseUrl, { pending_action_id: PENDING_ID });
      expect(drifted.status).toBe(409);
      expect((await drifted.json()).success).toBe(false);
    });
  });
});
