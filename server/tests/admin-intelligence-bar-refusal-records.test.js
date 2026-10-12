/**
 * POST /admin/intelligence-bar/query — refusals are records, not outages.
 *
 *  - A tool's coded refusal (permission_denied, target_clarification_required,
 *    ...) is not a circuit-breaker failure: five of them in a request leave the
 *    breaker alone, while the tool-activity `failed` flag and the model's
 *    is_error view of the result stay exactly as before.
 *  - A request that ends on a coded refusal, or runs out of steps, writes ONE
 *    `blocked` gap row keyed on source + tool + code (never on prose), holding
 *    the tool name and code only. The same refusal on a later request carries
 *    the same fingerprint, so the table's upsert counts it as another sighting.
 *
 * Harness mirrors admin-intelligence-bar-empty-reply-ledger.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockExecuteTool = jest.fn();
const mockBreaker = {
  isTripped: jest.fn(() => false),
  fastFailResult: jest.fn(),
  recordFailure: jest.fn(),
  recordSuccess: jest.fn(),
};
// A fake database: gap rows land in mockGapRows; any other table is an insert sink.
const mockGapRows = [];
const mockGapMerges = [];

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => {
  const gapTable = () => ({
    where: () => ({ forUpdate: () => ({ first: async () => undefined }), update: async () => 1 }),
    insert: (row) => {
      mockGapRows.push(row);
      return {
        onConflict: () => ({
          merge: (fields) => {
            mockGapMerges.push(fields);
            return { returning: async () => [{ id: '7', occurrences: 1, status: 'new', domain: null, xmax: '1' }] };
          },
        }),
      };
    },
  });
  const table = jest.fn((name) => (name === 'agent_gap_reports' ? gapTable() : { insert: jest.fn(async () => undefined) }));
  table.raw = (sql) => ({ __raw: sql });
  const trx = jest.fn((name) => table(name));
  trx.raw = table.raw;
  trx.transaction = async (work) => work(trx);
  table.transaction = async (work) => work(trx);
  return table;
});

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({ getBreaker: jest.fn(() => mockBreaker) }));
// Platform mode keeps a task row per request; the task store is stubbed (its own
// suites need Postgres) and the target resolver reports no target.
jest.mock('../services/intelligence-bar/tasks', () => ({
  begin: jest.fn(async () => ({ task: { id: 'task-1', state: 'running', runner_token: 'r1' }, created: true })),
  checkpoint: jest.fn(async () => undefined),
  get: jest.fn(async () => null),
  snapshot: jest.fn(async () => ({})),
  requestStartedAt: jest.fn(() => new Date()),
}));
jest.mock('../services/intelligence-bar/task-context', () => {
  const actual = jest.requireActual('../services/intelligence-bar/task-context');
  return { ...actual, resolve: jest.fn(async () => ({ targets: [] })), prepareReadInput: jest.fn(async (input) => ({ input })) };
});
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/intelligence-bar/tools', () => ({ TOOLS: [], UPDATABLE_FIELDS: {}, executeTool: (...args) => mockExecuteTool(...args), resolveTechnicianByName: jest.fn(), resolveActiveTechnicianById: jest.fn() }));
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


const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

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

const toolUse = (name, input = {}, id = 't1') => ({ type: 'tool_use', id, name, input });
const text = (value) => ({ type: 'text', text: value });
const SYNTHETIC_ASK = 'Move Pat Placeholder at 100 Example Lane, phone 555-0100, to Friday';

beforeEach(() => {
  jest.clearAllMocks();
  mockMessagesCreate.mockReset();
  mockExecuteTool.mockReset();
  mockGapRows.length = 0;
  mockGapMerges.length = 0;
  delete process.env.GATE_IB_PLATFORM;
  delete process.env.AGENT_GAP_REPORTS;
});
afterAll(() => { delete process.env.GATE_IB_PLATFORM; });

describe('circuit breaker accounting on /query', () => {
  test('five coded refusals in one request leave the breaker alone, and the result still reads as an error to the model', async () => {
    mockExecuteTool.mockResolvedValue({ error: 'Only the owner can do that', code: 'permission_denied' });
    mockMessagesCreate
      .mockResolvedValueOnce({ content: Array.from({ length: 5 }, (_, i) => toolUse('lookup_thing', {}, `t${i}`)) })
      .mockResolvedValueOnce({ content: [text('That is limited to the owner account.')] });
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, { prompt: 'anything', context: 'customers' });
      expect(status).toBe(200);
    });
    expect(mockExecuteTool).toHaveBeenCalledTimes(5);
    expect(mockBreaker.recordFailure).not.toHaveBeenCalled();
    expect(mockBreaker.recordSuccess).not.toHaveBeenCalled();
    const results = mockMessagesCreate.mock.calls[1][0].messages.at(-1).content.filter((block) => block.type === 'tool_result');
    expect(results).toHaveLength(5);
    expect(results.every((block) => block.is_error === true)).toBe(true);
  });

  test('an uncoded failure still counts, and a success still resets', async () => {
    mockExecuteTool
      .mockResolvedValueOnce({ error: 'Database unavailable' })
      .mockResolvedValueOnce({ customers: [] });
    mockMessagesCreate
      .mockResolvedValueOnce({ content: [toolUse('lookup_thing', {}, 'a'), toolUse('lookup_thing', {}, 'b')] })
      .mockResolvedValueOnce({ content: [text('done')] });
    await withServer(async (baseUrl) => { await postQuery(baseUrl, { prompt: 'anything', context: 'customers' }); });
    expect(mockBreaker.recordFailure).toHaveBeenCalledTimes(1);
    expect(mockBreaker.recordSuccess).toHaveBeenCalledTimes(1);
  });
});

describe('refusal gap rows on /query (platform mode)', () => {
  beforeEach(() => { process.env.GATE_IB_PLATFORM = 'true'; });

  test('a request that ends on a coded refusal, with no discovery, writes one blocked row: tool + code, no request text', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce({ content: [toolUse('no_such_tool', { note: SYNTHETIC_ASK })] })
      .mockResolvedValueOnce({ content: [text('Which customer do you mean?')] });
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, { prompt: SYNTHETIC_ASK, context: 'customers' });
      expect(status).toBe(200);
    });
    expect(mockGapRows).toHaveLength(1);
    expect(mockGapRows[0]).toMatchObject({
      source: 'intelligence-bar', kind: 'blocked', closest_tool: 'no_such_tool', status: 'new',
    });
    expect(mockGapRows[0].summary).toContain('capability_unimplemented');
    const stored = JSON.stringify(mockGapRows);
    for (const fragment of ['Pat', 'Placeholder', 'Example Lane', '555-0100', 'Friday']) expect(stored).not.toContain(fragment);
  });

  test('the same refusal on two requests, asked in different words, carries one fingerprint', async () => {
    for (const ask of ['Do the first thing', 'Please do a second, different thing']) {
      mockMessagesCreate
        .mockResolvedValueOnce({ content: [toolUse('no_such_tool')] })
        .mockResolvedValueOnce({ content: [text('Tell me which one.')] });
      await withServer(async (baseUrl) => { await postQuery(baseUrl, { prompt: ask, context: 'customers' }); });
    }
    expect(mockGapRows).toHaveLength(2);
    expect(mockGapRows[0].fingerprint).toBe(mockGapRows[1].fingerprint);
    // The table's upsert owns the count: the merge bumps occurrences.
    expect(mockGapMerges).toHaveLength(2);
    expect(String(mockGapMerges[0].occurrences.__raw)).toContain('occurrences + 1');
  });

  test('five refusals of one ask in a request are one row', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce({ content: Array.from({ length: 5 }, (_, i) => toolUse('no_such_tool', {}, `t${i}`)) })
      .mockResolvedValueOnce({ content: [text('Tell me which one.')] });
    await withServer(async (baseUrl) => { await postQuery(baseUrl, { prompt: 'anything', context: 'customers' }); });
    expect(mockGapRows).toHaveLength(1);
  });

  test('a refusal the model recovered from is not a gap', async () => {
    mockMessagesCreate
      .mockResolvedValueOnce({ content: [toolUse('no_such_tool')] })
      .mockResolvedValueOnce({ content: [toolUse('discover_capabilities', { query: 'list customers' }, 't2')] })
      .mockResolvedValueOnce({ content: [text('Here is what I found.')] });
    await withServer(async (baseUrl) => { await postQuery(baseUrl, { prompt: 'anything', context: 'customers' }); });
    expect(mockGapRows).toHaveLength(0);
  });

  test('a tool loop that runs out of steps writes one blocked row', async () => {
    mockMessagesCreate.mockResolvedValue({ content: [toolUse('no_such_tool')] });
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, { prompt: SYNTHETIC_ASK, context: 'customers' });
      expect(status).toBe(200);
    });
    expect(mockGapRows).toHaveLength(1);
    expect(mockGapRows[0]).toMatchObject({ kind: 'blocked', closest_tool: 'no_such_tool', source: 'intelligence-bar' });
    expect(mockGapRows[0].summary).toMatch(/used all its steps/);
    expect(JSON.stringify(mockGapRows)).not.toContain('Placeholder');
  });

  test('the step limit with a final report still counts as running out of steps', async () => {
    mockMessagesCreate.mockImplementation(async (request) => (request.tool_choice?.type === 'none'
      ? { content: [text('Found the call. The address change is still left.')] }
      : { content: [toolUse('no_such_tool')] }));
    await withServer(async (baseUrl) => { await postQuery(baseUrl, { prompt: 'anything', context: 'customers' }); });
    expect(mockGapRows).toHaveLength(1);
    expect(mockGapRows[0].summary).toMatch(/used all its steps/);
  });

  test('AGENT_GAP_REPORTS=off records nothing', async () => {
    process.env.AGENT_GAP_REPORTS = 'off';
    mockMessagesCreate
      .mockResolvedValueOnce({ content: [toolUse('no_such_tool')] })
      .mockResolvedValueOnce({ content: [text('Tell me which one.')] });
    await withServer(async (baseUrl) => { await postQuery(baseUrl, { prompt: 'anything', context: 'customers' }); });
    expect(mockGapRows).toHaveLength(0);
  });
});
