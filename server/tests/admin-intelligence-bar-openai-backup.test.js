/**
 * GATE_IB_OPENAI_BACKUP on POST /admin/intelligence-bar/query: a provider error
 * from the Anthropic call finishes the request on OpenAI with tool calling.
 *
 * Harness (mocks + helpers) mirrors admin-intelligence-bar-tool-activity.test.js.
 * The OpenAI Responses API is faked at global.fetch; every other URL (the test
 * server itself) goes to the real fetch.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.OPENAI_API_KEY = 'test-openai-key';

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
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model', OPENAI_REPORT_WRITER: 'gpt-test', TEXT_POLICIES: { highStakes: { fallback: { model: 'gpt-test' } } } }));

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


const realFetch = global.fetch;
let openaiRequests;
let openaiScript; // array of { status?, body } answered in order

const LIMIT_ERROR = Object.assign(new Error('400 {"error":{"message":"You have reached your specified API usage limits."}}'), { status: 400 });

function fakeFetch(url, init) {
  if (!String(url).startsWith('https://api.openai.com/')) return realFetch(url, init);
  openaiRequests.push(JSON.parse(init.body));
  const next = openaiScript.shift() || { status: 500, body: {} };
  return Promise.resolve({ ok: (next.status || 200) < 400, status: next.status || 200, json: async () => next.body });
}

const completed = output => ({ body: { id: 'resp_1', model: 'gpt-test', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } } });
const callOf = (call_id, name, args) => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args), status: 'completed' });
const textOf = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

async function postQuery(baseUrl, body) {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('GATE_IB_OPENAI_BACKUP on /query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMessagesCreate.mockReset();
    delete process.env.GATE_IB_OPENAI_BACKUP;
    openaiRequests = [];
    openaiScript = [];
    global.fetch = jest.fn(fakeFetch);
    mockResolveCommsCustomer.mockResolvedValue({ id: 'c1', first_name: 'Jeff', last_name: 'V' });
    mockExecuteTool.mockImplementation(async () => ({ customers: [{ id: 'c1' }], total_matching: 1 }));
    mockCreatePendingAction.mockResolvedValue({
      id: PENDING_ID, tool_name: 'update_customer', summary: 'update_customer', expires_at: new Date(Date.now() + 600000).toISOString(),
    });
  });
  afterAll(() => { global.fetch = realFetch; delete process.env.GATE_IB_OPENAI_BACKUP; });

  test('a usage-limit 400 finishes on OpenAI: one tool call runs once, the answer says who answered', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    mockMessagesCreate.mockRejectedValue(LIMIT_ERROR);
    openaiScript = [completed([callOf('call_abc', 'query_customers', { search: 'Jeff' })]), completed([textOf('Jeff is customer c1.')])];
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'find Jeff', context: 'customers' });
      expect(status).toBe(200);
      expect(body.response).toBe('Jeff is customer c1.\n\n(answered by the backup model)');
      expect(body.toolCalls).toHaveLength(1);
    });
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1); // the failed Anthropic call is not retried
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
    expect(mockExecuteTool.mock.calls[0][0]).toBe('query_customers');
    expect(mockExecuteTool.mock.calls[0][1]).toEqual({ search: 'Jeff' });
    expect(openaiRequests).toHaveLength(2);
    const [first, second] = openaiRequests;
    expect(first).toMatchObject({ model: 'gpt-test', store: false, tool_choice: 'auto' });
    expect(first.instructions).toContain('Waves Intelligence Bar');
    expect(first.tools.every(tool => tool.type === 'function' && tool.name && tool.parameters.type === 'object')).toBe(true);
    // The second round carries the call and its result under the same id.
    const call = second.input.find(item => item.type === 'function_call');
    const output = second.input.find(item => item.type === 'function_call_output');
    expect(call).toMatchObject({ call_id: 'call_abc', name: 'query_customers', arguments: JSON.stringify({ search: 'Jeff' }) });
    expect(output.call_id).toBe('call_abc');
    expect(JSON.parse(output.output)).toMatchObject({ total_matching: 1 });
  });

  test('confirmation cards work unchanged: a write proposed on the backup returns its card', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    mockMessagesCreate.mockRejectedValue(Object.assign(new Error('overloaded'), { status: 529 }));
    openaiScript = [
      completed([callOf('call_w1', 'update_customer', { customer_id: 'c1', updates: { city: 'Venice' } })]),
      completed([textOf('Proposed. Confirm it on the card below.')]),
    ];
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'set city', context: 'customers' });
      expect(status).toBe(200);
      expect(body.pendingActions).toHaveLength(1);
      expect(body.pendingActions[0].id).toBe(PENDING_ID);
      expect(body.response).toMatch(/\(answered by the backup model\)$/);
    });
    expect(mockExecuteTool).not.toHaveBeenCalled(); // a write is a card, never run by the model loop
    // The model never sees the confirmation id.
    expect(JSON.stringify(openaiRequests)).not.toContain(PENDING_ID);
  });

  test('a failed backup rethrows the ORIGINAL Anthropic error', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    mockMessagesCreate.mockRejectedValue(LIMIT_ERROR);
    openaiScript = [{ status: 500, body: {} }];
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'find Jeff', context: 'customers' });
      expect(status).toBe(400);
      expect(body.error).toBe(LIMIT_ERROR.message);
    });
    expect(openaiRequests).toHaveLength(1);
  });

  test('a request this server built wrongly (400 without a limit message) is not intercepted', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    mockMessagesCreate.mockRejectedValue(Object.assign(new Error('400 tools.3.custom.input_schema: invalid'), { status: 400 }));
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, { prompt: 'find Jeff', context: 'customers' });
      expect(status).toBe(400);
    });
    expect(openaiRequests).toHaveLength(0);
  });

  test('gate off: the provider error propagates and OpenAI is never called', async () => {
    mockMessagesCreate.mockRejectedValue(LIMIT_ERROR);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'find Jeff', context: 'customers' });
      expect(status).toBe(400);
      expect(body.error).toBe(LIMIT_ERROR.message);
    });
    expect(openaiRequests).toHaveLength(0);
  });

  test('a normal Anthropic reply carries no backup line and never touches OpenAI', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    mockMessagesCreate.mockResolvedValue({ content: [{ type: 'text', text: 'All good.' }] });
    await withServer(async (baseUrl) => {
      const { body } = await postQuery(baseUrl, { prompt: 'hi', context: 'customers' });
      expect(body.response).toBe('All good.');
    });
    expect(openaiRequests).toHaveLength(0);
  });

  test('a tool error is not a provider error: the loop carries on with Anthropic', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    mockExecuteTool.mockRejectedValue(Object.assign(new Error('relation does not exist'), { status: 500 }));
    mockMessagesCreate
      .mockResolvedValueOnce({ content: [{ type: 'tool_use', id: 'tu_1', name: 'query_customers', input: {} }] })
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'The lookup failed.' }] });
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'find', context: 'customers' });
      expect(status).toBe(200);
      expect(body.response).toBe('The lookup failed.');
    });
    expect(openaiRequests).toHaveLength(0);
  });

  test('a history holding tool-search blocks starts the backup without them, keeping the client call and its result', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    mockMessagesCreate
      .mockResolvedValueOnce({ content: [
        { type: 'thinking', thinking: 'plan', signature: 'sig' },
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'customers' } },
        { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'query_customers' }] } },
        { type: 'text', text: 'Looking.' },
        { type: 'tool_use', id: 'tu_1', name: 'query_customers', input: { search: 'Jeff' } },
      ] })
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));
    openaiScript = [completed([textOf('Found him.')])];
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'find Jeff', context: 'customers' });
      expect(status).toBe(200);
      expect(body.response).toBe('Found him.\n\n(answered by the backup model)');
    });
    expect(mockExecuteTool).toHaveBeenCalledTimes(1); // the call made before the switch is not repeated
    expect(openaiRequests).toHaveLength(1);
    const input = openaiRequests[0].input;
    expect(JSON.stringify(input)).not.toMatch(/srvtoolu_|tool_search|thinking|plan/);
    expect(input.filter(item => item.type === 'function_call').map(item => item.call_id)).toEqual(['tu_1']);
    expect(input.filter(item => item.type === 'function_call_output').map(item => item.call_id)).toEqual(['tu_1']);
    expect(input.find(item => item.role === 'assistant')).toMatchObject({ content: 'Looking.' });
  });

  test('the last round tells the backup it may not call a tool', async () => {
    process.env.GATE_IB_OPENAI_BACKUP = 'true';
    mockMessagesCreate.mockRejectedValue(LIMIT_ERROR);
    openaiScript = Array.from({ length: 11 }, (_, i) => completed([callOf(`call_${i}`, 'query_customers', { page: i })]));
    openaiScript.push(completed([textOf('Out of steps; here is what I found.')]));
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'loop', context: 'customers' });
      expect(status).toBe(200);
      expect(body.response).toMatch(/Out of steps/);
    });
    expect(openaiRequests).toHaveLength(12);
    expect(openaiRequests.slice(0, -1).every(request => request.tool_choice === 'auto')).toBe(true);
    expect(openaiRequests.at(-1).tool_choice).toBe('none');
    expect(JSON.stringify(openaiRequests.at(-1).input.at(-1))).toMatch(/Step limit reached/);
    expect(mockMessagesCreate).toHaveBeenCalledTimes(1); // once on the backup, always on the backup
  });
});
