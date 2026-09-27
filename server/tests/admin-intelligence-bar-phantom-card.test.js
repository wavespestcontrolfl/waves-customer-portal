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

const NOTICE = "This reply didn't create a confirmation card";
// Tool-agnostic (finding 3): the notice never names a specific tool's own
// fields (the old wording's "product and amount" example didn't fit every
// write tool), so it reads the same regardless of which tool's card was
// claimed.
const FULL_NOTICE = "This reply didn't create a confirmation card. If you want a change, ask again and say exactly what to change.";

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

// Any card claim in a turn that created no pending action gets the notice,
// including one that points at an earlier card: the notice only says this
// reply created none, which is true either way (Codex round-4 P2: no
// "earlier card" exception can tell which card a claim describes).
test.each([
  'Please use the earlier confirmation card to proceed.',
  'Please use the confirmation card I sent earlier.',
  "I've prepared a new confirmation card to replace the previous card.",
  "I've prepared the confirmation cards below.",
  'Use the Confirm button below.',
  'Click the confirmation button below.',
])('a card claim in a turn with no pending action gets the notice (%s)', async (text) => {
  scriptModelTurns([[{ type: 'text', text }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).toContain(NOTICE);
  });
});

test('a bare mention of "the earlier card" with no card claim at all is untouched', async () => {
  scriptModelTurns([[{ type: 'text', text: 'The earlier card expired.' }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).not.toContain(NOTICE);
  });
});

test('ordinary prose that never claims a card at all is untouched', async () => {
  scriptModelTurns([[{ type: 'text', text: 'Please use the card I sent earlier.' }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).not.toContain(NOTICE);
  });
});

// Codex round-2 P2: the old EARLIER_CARD_REFERENCE_RE keyed off the bare word
// "already" anywhere near "card" — which excluded a genuine NEW-card claim
// just because the model also said "already" ("I've already prepared the
// confirmation card below."). The narrowed regex only excludes phrasing that
// explicitly identifies a PRIOR card, so this now correctly gets flagged.
test('"I\'ve already prepared the confirmation card below" is a genuine new-card claim and gets flagged', async () => {
  scriptModelTurns([[{ type: 'text', text: "I've already prepared the confirmation card below." }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).toContain(NOTICE);
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

test('a claim after a semicolon is its own clause: the earlier-card mention before it does not hide it', async () => {
  scriptModelTurns([[{ type: 'text', text: "The earlier card expired; I've prepared a new confirmation card." }]]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
    expect(status).toBe(200);
    expect(body.response).toContain(NOTICE);
  });
});

test('a reply with multi-card language gets a truthful count line, not a claim about whether it matched', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: "I've prepared the confirmation cards below for both changes." }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).toContain('1 confirmation card was created for this reply.');
  });
});

test('every card claim in a reply counts toward multi-card language: two singular claims against one created card get the truthful line', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: "I've prepared one confirmation card below for the address and one confirmation card below for the phone." }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).toContain('1 confirmation card was created for this reply.');
  });
});

// Codex rounds 10-13 each found a new way for prose-based card COUNTING to
// misfire: round 11's "two confirmation cards below; use both cards below
// to continue" summed to 4 against 2 real cards; round 13's "I've prepared
// two confirmation cards for the customer updates and another confirmation
// card for inventory" undercounted to 2 when the claim actually names 3.
// Structural fix (this round): stop trying to parse an exact claimed count
// out of prose at all. Multi-card language just switches the guard from
// silence to a plain, always-true statement of the real count — so it
// reads the same whether the reply's own phrasing was right or wrong.
test('the round-11 finding\'s reply ("two" and "both" describing the same 2 cards) still gets the neutral truthful line', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  mockCreatePendingAction
    .mockResolvedValueOnce({ id: 'pending-1', tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString() })
    .mockResolvedValueOnce({ id: 'pending-2', tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString() });
  scriptModelTurns([
    [
      { type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } },
      { type: 'tool_use', id: 'tu_2', name: 'update_customer', input: { customer_id: 'c2', updates: { city: 'Sarasota' } } },
    ],
    [{ type: 'text', text: "I've prepared two confirmation cards below; use both cards below to continue." }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city and state', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(2);
    expect(body.response).not.toContain(NOTICE);
    expect(body.response).toContain('2 confirmation cards were created for this reply.');
  });
});

// Codex round-13 P2: the old MAX-across-buckets logic read "two ... and
// another" as 2 (the plural bucket's max), never summing past it, so a
// reply naming 3 cards for a turn that made only 2 was never flagged. The
// structural fix has no count to get wrong — it just states the truth.
test('the round-13 finding\'s reply ("two ... and another") gets the truthful count for what this turn actually created', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  mockCreatePendingAction
    .mockResolvedValueOnce({ id: 'pending-1', tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString() })
    .mockResolvedValueOnce({ id: 'pending-2', tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString() });
  scriptModelTurns([
    [
      { type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } },
      { type: 'tool_use', id: 'tu_2', name: 'update_customer', input: { customer_id: 'c2', updates: { city: 'Sarasota' } } },
    ],
    [{ type: 'text', text: "I've prepared two confirmation cards for the customer updates and another confirmation card for inventory." }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city and state', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(2);
    expect(body.response).toContain('2 confirmation cards were created for this reply.');
  });
});

test('a mismatch still gets the truthful count: "two confirmation cards ... both confirmation cards" against one created card', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: 'Two confirmation cards are ready below; use both confirmation cards to continue.' }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).toContain('1 confirmation card was created for this reply.');
  });
});

// Codex round-12 P2: a button claim ("two confirmation buttons below") is
// read as multi-card language exactly like a plural card claim.
test('a plural confirmation-button claim reads as multi-card language like a plural card claim', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: "I've prepared two confirmation buttons below." }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).toContain('1 confirmation card was created for this reply.');
  });
});

// "another" is multi-card language on its own (a second, different card),
// same as "both" — both created cards get the truthful line.
test('"a card ... and another card ... both cards" is multi-card language and gets the truthful count', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  mockCreatePendingAction
    .mockResolvedValueOnce({ id: 'pending-1', tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString() })
    .mockResolvedValueOnce({ id: 'pending-2', tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString() });
  scriptModelTurns([
    [
      { type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } },
      { type: 'tool_use', id: 'tu_2', name: 'update_customer', input: { customer_id: 'c2', updates: { city: 'Sarasota' } } },
    ],
    [{ type: 'text', text: 'Here is a confirmation card for the city change and another confirmation card for the state change; tap both confirmation cards to continue.' }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city and state', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(2);
    expect(body.response).toContain('2 confirmation cards were created for this reply.');
  });
});

// Two singular card-phrase mentions (even of what is plainly the SAME
// card) are still more than one CARD_PHRASE_RE match, so this also reads as
// multi-card language and gets the same neutral, truthful line — the
// simplification this round makes deliberately stops trying to tell "two
// mentions of one card" apart from "two different cards" in prose, since
// telling the truth about the real count costs nothing either way.
test('two singular mentions of the same one card still get the truthful line (no longer specially exempted)', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: "I've prepared a confirmation card below; tap the confirmation card below to confirm." }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).not.toContain(NOTICE);
    expect(body.response).toContain('1 confirmation card was created for this reply.');
  });
});

test('an unnumbered card mentioned twice also gets the truthful line (two CARD_PHRASE_RE matches)', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: "I've prepared a confirmation card. Use the card below to confirm." }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).toContain('1 confirmation card was created for this reply.');
  });
});

// A claim with exactly one singular card phrase — the common case — gets
// no noise at all: no zero-card notice (a card WAS created) and no
// truthful-count line either (nothing ambiguous to clarify).
test('a claim with exactly one singular card phrase and a created card gets no notice at all', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: "I've prepared a confirmation card below." }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).not.toContain(NOTICE);
    expect(body.response).not.toContain('confirmation card was created');
    expect(body.response).not.toContain('confirmation cards were created');
  });
});

// A claim with no card/button noun phrase at all ("click Confirm") and a
// created card also gets no notice.
test('a bare claim with no noun phrase ("click Confirm") and a created card gets no notice', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: 'Click Confirm below to proceed.' }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).not.toContain(NOTICE);
    expect(body.response).not.toContain('confirmation card was created');
  });
});

test('a reply claiming a card that THIS turn actually created gets no notice', async () => {
  mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Test', last_name: 'Customer' });
  mockExecuteTool.mockImplementation(async () => ({
    preview: true, tool: 'update_customer', product: null, effects: 'Updates the customer record.',
  }));
  scriptModelTurns([
    [{ type: 'tool_use', id: 'tu_1', name: 'update_customer', input: { customer_id: 'c1', updates: { city: 'Venice' } } }],
    [{ type: 'text', text: 'Prepared — confirm on the card below.' }],
  ]);
  await withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: 'set Test Customer city to Venice', context: 'customers' });
    expect(status).toBe(200);
    expect(body.pendingActions).toHaveLength(1);
    expect(body.response).not.toContain(NOTICE);
  });
});
