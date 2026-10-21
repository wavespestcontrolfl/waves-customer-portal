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
const mockDbWhereInSelect = jest.fn(async () => []);
const mockResolveCommsCustomer = jest.fn();
const mockLoadReviewRecipient = jest.fn();
const mockResolveTechnician = jest.fn();
const mockResolveTechnicianById = jest.fn();
// The create_appointment price + billing verdict (ADMIN-BUG-R12, owner
// 2026-09-27): unpriced and billable by default, so these proposals reach
// their card; the priced and refusal cases set their own.
const mockIbBookingProposal = jest.fn(async () => ({ price: null, source: null, serviceId: null, serviceName: null }));
// Whether another visit already overlaps the time (owner 2026-10-05): no timed window = no pin by default.
const mockIbBookingOverlapProposal = jest.fn(async () => null);
const mockResolveLeadForUpdate = jest.fn();
const mockPreviewBulkLeadUpdate = jest.fn();
const mockComputeCancelImpact = jest.fn();
const CARD_CANCEL_REFUSED_MESSAGE_MOCK = 'TEST: not a simple visit, cancel it from Dispatch.';

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

// The review-request card pins the recipient the sender resolves, which waits
// for a contact's own opt-in YES. `global.mockOptinHeldKeys` = the held keys.
jest.mock('../services/recipient-optin', () => ({
  ...jest.requireActual('../services/recipient-optin'),
  resolveServiceContactSmsRecipient: jest.fn(async (customer) => require('../services/customer-contact')
    .getServiceContactSmsRecipient(customer, { heldPhoneKeys: global.mockOptinHeldKeys || null })),
}));
jest.mock('../models/db', () => jest.fn(() => ({
  insert: mockDbInsert,
  whereIn: (...whereArgs) => ({
    // Live-rows-only resolution (pre-push r11 P1): the route chains
    // whereNull('deleted_at') before select.
    whereNull: () => ({ select: () => mockDbWhereInSelect(...whereArgs) }),
    select: () => mockDbWhereInSelect(...whereArgs),
  }),
})));
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
  ibBookingOverlapProposal: (...args) => mockIbBookingOverlapProposal(...args),
  CARD_CANCEL_REFUSED_MESSAGE: CARD_CANCEL_REFUSED_MESSAGE_MOCK,
}));
jest.mock('../services/appointment-cancel-impact', () => ({
  computeCancelAppointmentImpact: (...args) => mockComputeCancelImpact(...args),
  cancelWithEffectsRefusal: (...args) => jest.requireActual('../services/appointment-cancel-impact').cancelWithEffectsRefusal(...args),
}));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({
  REVIEW_TOOLS: [], executeReviewTool: jest.fn(), reviewAskBlockedReason: jest.fn(async () => null),
  loadReviewRecipient: (...args) => mockLoadReviewRecipient(...args),
}));
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(),
  resolveCustomer: (...args) => mockResolveCommsCustomer(...args),
  sendSmsProposalRefusal: jest.fn(async () => null),
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

/**
 * Source-level invariant (pre-push audit P1). The merge drift pins are
 * route-owned: /confirm-action assigns _approved_versions/_approved_effects
 * from the LIVE re-run preview and from nowhere else. Stored action.params
 * originate in the model's tool input and merge_customers' input_schema does
 * not set additionalProperties:false, so the handler drops any inbound copy
 * before its own assignment. This asserts the ordering rather than driving
 * the route (the lifecycle module is not mocked in this harness); the
 * behavioural half — that executeMerge honours exactly the pins it is
 * handed — is covered in intelligence-bar-customer-lifecycle.test.js.
 */
describe('merge drift pins are route-owned', () => {
  const source = require('fs').readFileSync(require.resolve('../routes/admin-intelligence-bar.js'), 'utf8');
  test('/confirm-action deletes any inbound _approved_* before assigning its own', () => {
    const handler = source.split('const execParams = { ...action.params };')[1];
    expect(handler).toBeDefined();
    const dropVersions = handler.indexOf('delete execParams._approved_versions;');
    const dropEffects = handler.indexOf('delete execParams._approved_effects;');
    const assign = handler.indexOf('execParams._approved_versions = {');
    expect(dropVersions).toBeGreaterThan(-1);
    expect(dropEffects).toBeGreaterThan(-1);
    expect(dropVersions).toBeLessThan(assign);
    expect(dropEffects).toBeLessThan(assign);
  });
  test('the live re-run preview is the only source of the pins', () => {
    // Exactly one assignment of each, both off livePreview.
    expect(source.match(/execParams\._approved_versions = /g)).toHaveLength(1);
    expect(source.match(/execParams\._approved_effects = /g)).toHaveLength(1);
    expect(source).toContain('execParams._approved_versions = { winner: String(livePreview.winner_version), loser: String(livePreview.loser_version) };');
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
      expect(toolResult.error).toMatch(/can't cancel this visit from here yet/);
      expect(toolResult.error).toMatch(/Nothing was changed/);
    });
  });
});

/**
 * PR B of the ib-cancel-pinned-effects lane (owner ruling 2026-09-28): the
 * refusal above is gate-OFF behavior only (GATE_IB_CANCEL_APPOINTMENT unset
 * in every other suite in this file). With the gate live, the proposal
 * computes the SAME deterministic impact tools.js's commit path recomputes
 * (appointment-cancel-impact.js, mocked wholesale here — its own
 * orchestration is covered by appointment-cancel-impact.test.js), refuses a
 * non-simple visit or an unreadable/missing one, and otherwise pins the
 * impact for the card and the contract hash. Confirm dispatches only a
 * pending row that actually carries that pin.
 */
describe('W0B cancel_appointment card-confirm (GATE_IB_CANCEL_APPOINTMENT)', () => {
  const APPOINTMENT_ID = 'appt-synthetic-1';
  const SIMPLE_IMPACT = {
    appointment: { id: APPOINTMENT_ID, status: 'confirmed', scheduled_date: '2026-10-05', service_type: 'pest_control', customer_name: 'Synthia Tester' },
    fee: { applies: false, amount: null, unresolved: false, rail: 'none', blocked_by_invoice: false },
    invoices: [],
    inspection_credit_reversal: [],
    card_cancel_refusals: [],
  };
  const NON_SIMPLE_IMPACT = { ...SIMPLE_IMPACT, card_cancel_refusals: ['card_payment_on_invoice'] };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_IB_CANCEL_APPOINTMENT = 'true';
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'cancel_appointment', summary: 's', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });
  afterEach(() => { delete process.env.GATE_IB_CANCEL_APPOINTMENT; });

  test('a simple visit proposes with preview.cancellation + the frozen pin, and the contract hash covers it', async () => {
    mockComputeCancelImpact.mockResolvedValue(SIMPLE_IMPACT);
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: { appointment_id: APPOINTMENT_ID, reason: 'rain' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'cancel it', context: 'schedule' });
      expect(status).toBe(200);
      // actorId threads the proposing operator so technician_notice reads
      // consistently at confirm (same admin, common case).
      expect(mockComputeCancelImpact).toHaveBeenCalledWith(APPOINTMENT_ID, { actorId: 'admin-1' });
      expect(mockCreatePendingAction).toHaveBeenCalledTimes(1);
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params._frozen_cancellation_impact).toEqual(SIMPLE_IMPACT);
      // The exact structured effect set rides the contract (and so its
      // hash) — tools.js's commit path recomputes and compares this same
      // shape, so two different impacts can never hash alike.
      expect(stored.contract.pinned_cancellation).toEqual(SIMPLE_IMPACT);
      expect(stored.contract.effects.some((e) => /Cancel pest_control/.test(e.label))).toBe(true);
      const card = body.pendingActions[0];
      expect(card.id).toBe(PENDING_ID);
      // `_`-prefixed pins are server-side execution guards, never shown.
      expect(card.params._frozen_cancellation_impact).toBeUndefined();
    });
  });

  test('appointment not found → refused, nothing proposed', async () => {
    mockComputeCancelImpact.mockResolvedValue(null);
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: { appointment_id: 'missing', reason: 'x' } }],
      [{ type: 'text', text: 'gone' }],
    ]);
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, { prompt: 'cancel it', context: 'schedule' });
      expect(status).toBe(200);
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      const secondCallMessages = mockMessagesCreate.mock.calls[1][0].messages;
      const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
      expect(toolResult.error).toBe('Appointment not found — nothing was proposed.');
    });
  });

  test.each([
    ['completed', 'completed'],
    ['cancelled (already cancelled — a NEW proposal is not the replay path)', 'cancelled'],
    ['skipped', 'skipped'],
    ['no_show', 'no_show'],
  ])('a terminal appointment (%s) is refused at proposal, before minting a pending action', async (_label, status) => {
    mockComputeCancelImpact.mockResolvedValue({ ...SIMPLE_IMPACT, appointment: { ...SIMPLE_IMPACT.appointment, status } });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: { appointment_id: APPOINTMENT_ID, reason: 'x' } }],
      [{ type: 'text', text: 'already terminal' }],
    ]);
    await withServer(async (baseUrl) => {
      const { status: httpStatus } = await postQuery(baseUrl, { prompt: 'cancel it', context: 'schedule' });
      expect(httpStatus).toBe(200);
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      const secondCallMessages = mockMessagesCreate.mock.calls[1][0].messages;
      const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
      expect(toolResult.error).toBe(`This appointment is already ${status} and can't be cancelled.`);
    });
  });

  test('an impact that throws → refused, nothing proposed', async () => {
    mockComputeCancelImpact.mockRejectedValue(new Error('rail read failed'));
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: { appointment_id: APPOINTMENT_ID, reason: 'x' } }],
      [{ type: 'text', text: 'gone' }],
    ]);
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, { prompt: 'cancel it', context: 'schedule' });
      expect(status).toBe(200);
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      const secondCallMessages = mockMessagesCreate.mock.calls[1][0].messages;
      const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
      expect(toolResult.error).toMatch(/could not be verified/);
    });
  });

  test('a non-simple visit (card_cancel_refusals non-empty) is refused with the Dispatch message, nothing minted', async () => {
    mockComputeCancelImpact.mockResolvedValue(NON_SIMPLE_IMPACT);
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: { appointment_id: APPOINTMENT_ID, reason: 'x' } }],
      [{ type: 'text', text: 'go to dispatch' }],
    ]);
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, { prompt: 'cancel it', context: 'schedule' });
      expect(status).toBe(200);
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      const secondCallMessages = mockMessagesCreate.mock.calls[1][0].messages;
      const toolResult = JSON.parse(secondCallMessages[secondCallMessages.length - 1].content[0].content);
      // Shares tools.js's CARD_CANCEL_REFUSED_MESSAGE wording exactly —
      // no second copy of that sentence at the proposal site.
      expect(toolResult.error).toBe(CARD_CANCEL_REFUSED_MESSAGE_MOCK);
    });
  });

  test('/confirm-action dispatches with the pin reaching cancelAppointment as _frozen_cancellation_impact', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'cancel_appointment', params: { appointment_id: APPOINTMENT_ID, reason: 'rain', _frozen_cancellation_impact: SIMPLE_IMPACT } },
    });
    mockExecuteTool.mockResolvedValue({ success: true, appointment_id: APPOINTMENT_ID });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(200);
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
      const [toolName, input] = mockExecuteTool.mock.calls[0];
      expect(toolName).toBe('cancel_appointment');
      expect(input._frozen_cancellation_impact).toEqual(SIMPLE_IMPACT);
      expect(input.appointment_id).toBe(APPOINTMENT_ID);
    });
  });

  test('a legacy pending row with no frozen pin is refused — never dispatched unpinned', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'cancel_appointment', params: { appointment_id: APPOINTMENT_ID, reason: 'rain' } },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/can't cancel this visit from here yet/);
      expect(mockExecuteTool).not.toHaveBeenCalled();
      expect(mockRecordResult).toHaveBeenCalledWith(PENDING_ID, expect.objectContaining({ error: expect.stringMatching(/can't cancel this visit from here yet/) }));
    });
  });

  test('gate off refuses even a pinned row (covers rows minted while the gate was on, then turned off)', async () => {
    delete process.env.GATE_IB_CANCEL_APPOINTMENT;
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'cancel_appointment', params: { appointment_id: APPOINTMENT_ID, reason: 'rain', _frozen_cancellation_impact: SIMPLE_IMPACT } },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.error).toMatch(/can't cancel this visit from here yet/);
      expect(mockExecuteTool).not.toHaveBeenCalled();
    });
  });
});

/**
 * GATE_IB_CANCEL_WITH_EFFECTS (owner decision 2026-10-12): with both gates live the proposal computes the impact
 * WITH effects, cards an invoice / credit / linked visit with the customer text and the "cancel without a text"
 * choice, and refuses a fee due, a refund or charge case, and the make-up / grouped / follow-up visits with their own
 * codes. Gate off, the refusal above stands. (The commit is tools.js cancelWithEffects; its own suite is
 * intelligence-bar-cancel-with-effects.test.js.)
 */
describe('W0B cancel_appointment WITH effects (GATE_IB_CANCEL_WITH_EFFECTS)', () => {
  const APPOINTMENT_ID = 'appt-synthetic-1';
  const EFFECTS_IMPACT = {
    appointment: { id: APPOINTMENT_ID, status: 'confirmed', scheduled_date: '2026-10-05', service_type: 'pest_control', customer_name: 'Synthia Tester' },
    fee: { applies: false, amount: null, unresolved: false, rail: 'none', blocked_by_invoice: false },
    invoices: [{ id: 'inv-1', invoice_number: 'INV-1001', status: 'sent', total: 120, credit_applied: 20, deposit_credit: 0, payment_intent: true }],
    inspection_credit_reversal: [{ id: 'offer-1', amount: 75, would_reverse: true, deferred: false }],
    card_cancel_refusals: [],
    customer_notice: 'none',
    technician_notice: 'none',
    with_effects: true,
    notify_customer: true,
    customer_text: {
      would_send: true, body: 'Hi Synthia, your visit on Monday is cancelled.', template_body: null, reason: null,
      recipients: [
        { recipient_key: 'abc123abc123abc1', phone_last4: '0101', role: 'primary', first_name: 'Synthia', body: 'Hi Synthia, your visit on Monday is cancelled.' },
        { recipient_key: 'def456def456def4', phone_last4: '0202', role: 'service', first_name: 'Sam', body: 'Hi Sam, your visit on Monday is cancelled.' },
      ],
    },
    linked_invoices: [
      { id: 'inv-1', invoice_number: 'INV-1001', status: 'sent', total: 120 },
      { id: 'inv-0', invoice_number: 'INV-0999', status: 'void', total: 10 },
    ],
    linked_visits: [
      { id: 'svc-visit-2', status: 'confirmed', scheduled_date: '2026-11-02', service_type: 'pest_control', technician_id: 'tech-9', technician_name: 'Tess Technician', technician_notice: 'may_notify' },
      { id: 'svc-visit-3', status: 'confirmed', scheduled_date: '2026-11-09', service_type: 'lawn_care', technician_id: null, technician_name: null, technician_notice: 'none' },
    ],
  };
  const labels = (stored) => stored.contract.effects.map((e) => e.label);
  const propose = async (input) => {
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'cancel_appointment', input: { appointment_id: APPOINTMENT_ID, ...input } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    let toolResult;
    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, { prompt: 'cancel it', context: 'schedule' });
      const second = mockMessagesCreate.mock.calls[1]?.[0].messages;
      toolResult = second ? JSON.parse(second[second.length - 1].content[0].content) : null;
    });
    return toolResult;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GATE_IB_CANCEL_APPOINTMENT = 'true';
    process.env.GATE_IB_CANCEL_WITH_EFFECTS = 'true';
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'cancel_appointment', summary: 's', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });
  afterEach(() => { delete process.env.GATE_IB_CANCEL_APPOINTMENT; delete process.env.GATE_IB_CANCEL_WITH_EFFECTS; });

  test('an invoice + credit + linked visit is carded: every effect and the customer text are on the card', async () => {
    mockComputeCancelImpact.mockResolvedValue(EFFECTS_IMPACT);
    await propose({ reason: 'rain' });
    expect(mockComputeCancelImpact).toHaveBeenCalledWith(APPOINTMENT_ID, { actorId: 'admin-1', withEffects: true, notifyCustomer: true });
    expect(mockCreatePendingAction).toHaveBeenCalledTimes(1);
    const stored = mockCreatePendingAction.mock.calls[0][0];
    expect(stored.params.notify_customer).toBe(true);
    // The approved recipients and wording ride the frozen pin and the contract hash.
    expect(stored.contract.pinned_cancellation.customer_text.recipients.map((r) => r.recipient_key)).toEqual(['abc123abc123abc1', 'def456def456def4']);
    expect(stored.params._frozen_cancellation_impact).toEqual(EFFECTS_IMPACT);
    expect(stored.contract.pinned_cancellation).toEqual(EFFECTS_IMPACT);
    const l = labels(stored);
    expect(l).toContain('Runs the Dispatch cancel for this one visit only (not the series)');
    expect(l.some((x) => /Void invoice INV-1001 \(sent, \$120\.00\); \$20\.00 account credit restored.*open card payment attempt is cancelled first \(no charge, no refund\)/.test(x))).toBe(true);
    expect(l).toContain('Invoice INV-0999 (void) stays as it is — nothing to void');
    expect(l.some((x) => /\$75\.00 inspection credit this booking earned is taken back/.test(x))).toBe(true);
    expect(l).toContain('Also cancels the linked follow-up visit (pest_control) on 2026-11-02, with no text for it');
    // One line for each linked visit whose technician gets a cancel notice; none for an unassigned one.
    expect(l).toContain('Tech Tess Technician will get a cancel notice for 2026-11-02 pest_control (tech home card + push)');
    expect(l.filter((x) => /^Tech .* will get a cancel notice/.test(x))).toHaveLength(1);
    expect(stored.contract.notifies_technician).toBe(true);
    // One line per approved recipient, with the exact text that recipient gets.
    expect(l).toContain('Text to the primary contact ending 0101, if they can receive texts: "Hi Synthia, your visit on Monday is cancelled."');
    expect(l).toContain('Text to the service contact ending 0202, if they can receive texts: "Hi Sam, your visit on Monday is cancelled."');
    expect(l).toContain('To cancel without a text, ask for "cancel without a text" and a new card is shown');
    // The old "pinned set only" promise is false for a replay and must not be on this card.
    expect(l.some((x) => /Only the invoices listed above are voided/.test(x))).toBe(false);
    expect(stored.contract.notifies_customer).toBe(true);
    expect(stored.contract.irreversible).toBe(true);
  });

  test('"cancel without a text" -> notify_customer false: the card says no text, and the choice is pinned', async () => {
    const silent = { ...EFFECTS_IMPACT, notify_customer: false, customer_text: { would_send: false, body: null, template_body: null, recipients: [], reason: 'cancelled_without_text' } };
    mockComputeCancelImpact.mockResolvedValue(silent);
    await propose({ reason: 'rain', notify_customer: false });
    expect(mockComputeCancelImpact).toHaveBeenCalledWith(APPOINTMENT_ID, { actorId: 'admin-1', withEffects: true, notifyCustomer: false });
    const stored = mockCreatePendingAction.mock.calls[0][0];
    expect(stored.params.notify_customer).toBe(false);
    const l = labels(stored);
    expect(l).toContain('No cancellation text goes to the customer (cancelled without a text, as asked)');
    expect(l.some((x) => /customer is texted/.test(x))).toBe(false);
    expect(stored.contract.notifies_customer).toBe(false);
  });

  test('a fee due is refused with cancel_fee_due_unsupported, nothing minted', async () => {
    mockComputeCancelImpact.mockResolvedValue({ ...EFFECTS_IMPACT, card_cancel_refusals: ['card_fee_agreement'], fee: { applies: true, amount: 49, unresolved: false, rail: 'card_hold', blocked_by_invoice: false } });
    const result = await propose({ reason: 'x' });
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
    expect(result.code).toBe('cancel_fee_due_unsupported');
    expect(result.error).toMatch(/can't cancel a visit with a fee due yet; the Dispatch screen handles the fee/);
  });

  test('a paid invoice (money held) is refused by_owner_rule: refunds and card charges stay closed', async () => {
    mockComputeCancelImpact.mockResolvedValue({ ...EFFECTS_IMPACT, card_cancel_refusals: ['invoice_holds_money'] });
    const result = await propose({ reason: 'x' });
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
    expect(result.code).toBe('by_owner_rule');
  });

  test('a series cancel is never offered: the card is always this visit only', async () => {
    mockComputeCancelImpact.mockResolvedValue(EFFECTS_IMPACT);
    await propose({ reason: 'x', scope: 'series' });
    const stored = mockCreatePendingAction.mock.calls[0][0];
    expect(labels(stored)).toContain('Runs the Dispatch cancel for this one visit only (not the series)');
    const { cancelWithEffectsRefusal } = jest.requireActual('../services/appointment-cancel-impact');
    expect(cancelWithEffectsRefusal(EFFECTS_IMPACT)).toBeNull();
  });

  test('only GATE_IB_CANCEL_WITH_EFFECTS without GATE_IB_CANCEL_APPOINTMENT is still the old refusal', async () => {
    delete process.env.GATE_IB_CANCEL_APPOINTMENT;
    const result = await propose({ reason: 'x' });
    expect(mockComputeCancelImpact).not.toHaveBeenCalled();
    expect(result.code).toBe('cancel_with_effects_unsupported');
  });

  test('GATE_IB_CANCEL_WITH_EFFECTS off: an invoice refuses exactly as before', async () => {
    delete process.env.GATE_IB_CANCEL_WITH_EFFECTS;
    mockComputeCancelImpact.mockResolvedValue({ ...EFFECTS_IMPACT, with_effects: undefined, card_cancel_refusals: ['invoice_linked'] });
    const result = await propose({ reason: 'x' });
    expect(mockComputeCancelImpact).toHaveBeenCalledWith(APPOINTMENT_ID, { actorId: 'admin-1' });
    expect(mockCreatePendingAction).not.toHaveBeenCalled();
    expect(result.error).toBe(CARD_CANCEL_REFUSED_MESSAGE_MOCK);
  });

  test('/confirm-action dispatches a with-effects pin while the gate is on', async () => {
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'cancel_appointment', params: { appointment_id: APPOINTMENT_ID, notify_customer: true, _frozen_cancellation_impact: EFFECTS_IMPACT } },
    });
    mockExecuteTool.mockResolvedValue({ success: true, appointment_id: APPOINTMENT_ID });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      expect(res.status).toBe(200);
      expect(mockExecuteTool).toHaveBeenCalledTimes(1);
      expect(mockExecuteTool.mock.calls[0][1].notify_customer).toBe(true);
    });
  });

  test('/confirm-action refuses a with-effects pin once the effects gate is off, nothing executed', async () => {
    delete process.env.GATE_IB_CANCEL_WITH_EFFECTS;
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'cancel_appointment', params: { appointment_id: APPOINTMENT_ID, notify_customer: true, _frozen_cancellation_impact: EFFECTS_IMPACT } },
    });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pending_action_id: PENDING_ID }),
      });
      const body = await res.json();
      expect(res.status).toBe(409);
      expect(body.code).toBe('cancel_with_effects_unsupported');
      expect(mockExecuteTool).not.toHaveBeenCalled();
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
      expect(mockExecuteTool.mock.calls[0][1].confirmed).toBe(false);
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
    // The full-row reload returns whatever the name/id resolution found —
    // the review-request pin reads service-contact columns off THIS row.
    mockLoadReviewRecipient.mockImplementation(async (id) => {
      const r = await mockResolveCommsCustomer.mock.results.at(-1)?.value;
      return r && String(r.id) === String(id) ? r : null;
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

  test('trigger_review_request: a contact who has not replied YES to the opt-in ask is not pinned — the account holder is', async () => {
    global.mockOptinHeldKeys = new Set(['9415551111']);
    mockResolveCommsCustomer.mockResolvedValue({
      id: 'c1', first_name: 'acct', last_name: '1042', phone: '+19415550000',
      service_contact_name: 'acct 1042 tenant', service_contact_phone: '+19415551111',
      service_contacts_consent_at: '2026-08-01T12:00:00Z',
    });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'trigger_review_request', input: { customer_name: 'acct 1042' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    try {
      await withServer(async (baseUrl) => {
        await postQuery(baseUrl, { prompt: 'ask for a review', context: 'customers' });
        const stored = mockCreatePendingAction.mock.calls[0][0];
        expect(stored.params._pinned_phone).toBe('+19415550000');
        expect(stored.contract.pinned_recipient).toMatchObject({ customer_id: 'c1', phone_last4: '0000' });
      });
    } finally {
      global.mockOptinHeldKeys = null;
    }
  });

  test('trigger_review_request: a consented service contact is the pinned recipient — its phone AND name ride the card', async () => {
    mockResolveCommsCustomer.mockResolvedValue({
      id: 'c1', first_name: 'acct', last_name: '1042', phone: '+19415550000',
      service_contact_name: 'acct 1042 tenant', service_contact_phone: '+19415551111',
      service_contacts_consent_at: '2026-08-01T12:00:00Z',
    });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'trigger_review_request', input: { customer_name: 'acct 1042' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, { prompt: 'ask for a review', context: 'customers' });
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params._pinned_phone).toBe('+19415551111');
      expect(stored.contract.pinned_recipient).toMatchObject({ customer_id: 'c1', phone_last4: '1111', role: 'service contact' });
      expect(stored.contract.pinned_recipient.name).toMatch(/tenant/);
      expect(stored.contract.effects.map((e) => e.label)).toContainEqual(expect.stringMatching(/^Send review request to acct 1042 tenant \(…1111\)/));
    });
  });

  test('trigger_review_request: a closed outreach gate is resolved at proposal — refused, never a card (GH r17 P1: the FULL stack, not just the cooldown)', async () => {
    const reviewTools = require('../services/intelligence-bar/review-tools');
    reviewTools.reviewAskBlockedReason.mockResolvedValueOnce('Customer received a review request in the last 30 days.');
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'acct', last_name: '1042', phone: '+19415550000' });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'trigger_review_request', input: { customer_name: 'acct 1042' } }],
      [{ type: 'text', text: 'Already sent.' }],
    ]);
    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, { prompt: 'ask for a review', context: 'customers' });
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      const toolResult = mockMessagesCreate.mock.calls[1][0].messages.at(-1).content[0];
      expect(JSON.parse(toolResult.content).error).toMatch(/last 30 days/);
    });
  });

  test('trigger_review_request: a gate that closed since the card → confirm refuses (409 preview_changed)', async () => {
    const reviewTools = require('../services/intelligence-bar/review-tools');
    reviewTools.reviewAskBlockedReason.mockResolvedValueOnce('Customer is in an active review cadence — manage outreach from the cadence instead of a one-off send.');
    mockClaimForConfirm.mockResolvedValue({
      action: { id: PENDING_ID, tool_name: 'trigger_review_request', params: { customer_name: 'acct 1042', _pinned_phone: '+19415550000' } },
    });
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'acct', last_name: '1042', phone: '+19415550000' });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
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
      expect(mockExecuteTool).toHaveBeenCalledWith('trigger_review_request', { customer_name: 'acct 1042', _pinned_phone: '+19415550000' }, expect.objectContaining({ confirmed: true, isAdmin: true, technicianId: 'admin-1' }));
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
      expect(toolResult.error).toMatch(/\$49\.00 of open inspection-credit offer/);
      expect(toolResult.error).toMatch(/can't book this visit from here yet/);
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
      // Nothing about credit shows on the card when none applies.
      expect(stored.contract.effects.map((e) => e.label).some((l) => /inspection credit|credit lock/i.test(l))).toBe(false);
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
      expect(mockExecuteTool).toHaveBeenCalledWith('create_appointment', { customer_id: 'c1', date: '2026-09-02', _inspection_credit_amount: 0 }, expect.objectContaining({ confirmed: true, isAdmin: true, technicianId: 'admin-1' }));
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
      // The approved CURRENT value rides to the executor for the
      // conditional UPDATE (pre-push r11 P1).
      expect(mockExecuteTool).toHaveBeenCalledWith('toggle_show_one_time_option', { estimate_identifier: 'e1', enabled: true, _expected_flag_value: false }, expect.objectContaining({ confirmed: true, isAdmin: true, technicianId: 'admin-1' }));
    });
  });
});

describe('W0B id-shaped proposals pin like name-shaped ones (codex r3)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'x', summary: 's', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  test('send_sms with customer_id only: recipient resolved, pinned, and phone-match required', async () => {
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'acct', last_name: '1042', phone: '+19415550000' });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'send_sms', input: { customer_id: 'c1', message: 'On my way' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'text them', context: 'customers' });
      expect(mockResolveCommsCustomer).toHaveBeenCalledWith({ customer_id: 'c1' });
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params.phone).toBe('+19415550000');
      expect(stored.params._require_phone_match).toBe(true);
      expect(stored.contract.effects.map((e) => e.label)).toContainEqual('Text acct 1042 (…0000)');
      expect(body.pendingActions[0].params.recipient).toBe('acct 1042 (…0000)');
    });
  });

  test('update_lead_status with lead_id: lead loaded, current status pinned and shown', async () => {
    mockResolveLeadForUpdate.mockResolvedValue({ id: 'l1', first_name: 'acct', last_name: '2077', status: 'contacted' });
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'update_lead_status', input: { lead_id: 'l1', new_status: 'won' } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'mark it won', context: 'leads' });
      expect(mockResolveLeadForUpdate).toHaveBeenCalled();
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.params._expected_status).toBe('contacted');
      expect(stored.contract.effects).toContainEqual(expect.objectContaining({ label: 'Lead acct 2077: status contacted → won', before: 'contacted', after: 'won' }));
      expect(body.pendingActions[0].params.lead).toBe('acct 2077 — contacted → won');
    });
  });
});

describe('W0B bulk_update_customers names every pinned target (codex r7)', () => {
  const IDS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'bulk_update_customers', summary: 's', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });

  test('all ids resolve: full name list rides the contract with a targets fingerprint', async () => {
    mockDbWhereInSelect.mockResolvedValue([
      { id: IDS[0], first_name: 'acct', last_name: '9001' },
      { id: IDS[1], first_name: 'acct', last_name: '9002' },
    ]);
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'bulk_update_customers', input: { customer_ids: IDS, updates: { city: 'Venice' } } }],
      [{ type: 'text', text: 'Proposed.' }],
    ]);
    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, { prompt: 'update them', context: 'customers' });
      expect(mockDbWhereInSelect).toHaveBeenCalledWith('id', IDS);
      const stored = mockCreatePendingAction.mock.calls[0][0];
      expect(stored.contract.effects.map((e) => e.label)).toContainEqual('All 2 customer names are listed under "Show more"');
      expect((stored.contract.more_effects || []).map((e) => e.label)).toEqual(expect.arrayContaining(['acct 9001', 'acct 9002']));
      expect(stored.contract.targets_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  test('an unresolvable id FAILS CLOSED: refused at proposal, nothing pinned', async () => {
    mockDbWhereInSelect.mockResolvedValue([{ id: IDS[0], first_name: 'acct', last_name: '9001' }]);
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'bulk_update_customers', input: { customer_ids: IDS, updates: { city: 'Venice' } } }],
      [{ type: 'text', text: 'Could not propose.' }],
    ]);
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'update them', context: 'customers' });
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      expect((body.pendingActions || []).length).toBe(0);
    });
  });

  test('a malformed id never reaches the uuid column: clean refusal, no query', async () => {
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'bulk_update_customers', input: { customer_ids: ['not-a-uuid'], updates: { city: 'Venice' } } }],
      [{ type: 'text', text: 'Could not propose.' }],
    ]);
    await withServer(async (baseUrl) => {
      await postQuery(baseUrl, { prompt: 'update them', context: 'customers' });
      expect(mockDbWhereInSelect).not.toHaveBeenCalled();
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
    });
  });
});
