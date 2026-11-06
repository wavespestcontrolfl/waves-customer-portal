/**
 * POST /admin/intelligence-bar/query: `answerClaude` (GATE_IB_ANSWER_SEND_TO_CLAUDE, owner 2026-11-05).
 *
 * Observable behavior: under a bar answer that searched its capabilities and changed nothing, the owner login gets
 * `answerClaude: { stuck: true, gapId }` so the palette can show "Claude has this as gap #N." or a "Send to Claude"
 * button. Every other request keeps today's payload with no such key. The payload is read from the task checkpoint
 * (the task store is stubbed here, as in the refusal-records suite, whose harness this mirrors).
 *
 * Credible regressions this guards: the key reaching a non-owner admin, the tech context, a request with no search, a
 * request with a card, or a request with either gate off; and the key carrying anything beyond `stuck` and a gap id
 * (never the answer text).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.IB_FULL_ACCESS_EMAILS = 'owner@example.test';

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
// The status the saved gap row comes back with (the upsert's RETURNING); a test sets a closed one.
let mockSavedStatus = 'new';

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
            return { returning: async () => [{ id: '7', occurrences: 1, status: mockSavedStatus, domain: null, xmax: '1' }] };
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
    const logins = {
      owner: { id: 'admin-1', role: 'admin', email: 'owner@example.test' },
      office: { id: 'admin-2', role: 'admin', email: 'office@example.test' },
    };
    const login = logins[token];
    if (!login) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = login;
    req.technicianId = login.id;
    req.techRole = login.role;
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

async function postQuery(baseUrl, body, token = 'owner') {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const IbTasks = require('../services/intelligence-bar/tasks');

const toolUse = (name, input = {}, id = 't1') => ({ type: 'tool_use', id, name, input });
const text = (value) => ({ type: 'text', text: value });
const ASK = 'Switch Pat Placeholder to annual prepay';
const DECLINE_REPLY = 'There is no tool in this bar that does that.';
const OK_REPLY = 'Here is what I found.';

// The payload /query built, as the task store was handed it.
const savedPayload = () => IbTasks.checkpoint.mock.calls.map((call) => call[2].response).filter(Boolean).pop();

function script(replyText, { search = true } = {}) {
  mockMessagesCreate.mockReset();
  if (search) mockMessagesCreate.mockResolvedValueOnce({ content: [toolUse('discover_capabilities', { query: 'switch a customer to annual prepay' })] });
  mockMessagesCreate.mockResolvedValueOnce({ content: [text(replyText)] });
}

async function ask({ token = 'owner', context = 'customers' } = {}) {
  return withServer(async (baseUrl) => {
    const { status, body } = await postQuery(baseUrl, { prompt: ASK, context }, token);
    expect(status).toBe(200);
    return savedPayload() || body;
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGapRows.length = 0;
  mockGapMerges.length = 0;
  mockSavedStatus = 'new';
  process.env.GATE_IB_PLATFORM = 'true';
  process.env.GATE_IB_SEND_TO_CLAUDE = 'true';
  process.env.GATE_IB_ANSWER_SEND_TO_CLAUDE = 'true';
  delete process.env.AGENT_GAP_REPORTS;
});
afterAll(() => {
  for (const name of ['GATE_IB_PLATFORM', 'GATE_IB_SEND_TO_CLAUDE', 'GATE_IB_ANSWER_SEND_TO_CLAUDE', 'IB_FULL_ACCESS_EMAILS']) delete process.env[name];
});

describe('answerClaude on /query', () => {
  test('owner, both gates on, a capability search and no write: stuck, with the gap id the flush saved', async () => {
    script(DECLINE_REPLY);
    const payload = await ask();
    expect(mockGapRows).toHaveLength(1);
    expect(payload.answerClaude).toEqual({ stuck: true, gapId: 7 });
    // Nothing the bar wrote rides on the key.
    expect(JSON.stringify(payload.answerClaude)).not.toContain('prepay');
  });

  test('a gap Claude is already building is named too', async () => {
    mockSavedStatus = 'building';
    script(DECLINE_REPLY);
    expect((await ask()).answerClaude).toEqual({ stuck: true, gapId: 7 });
  });

  test.each(['by_design', 'dismissed'])('a saved gap closed as %s is not named: gapId null, so the button shows', async (status) => {
    mockSavedStatus = status;
    script(DECLINE_REPLY);
    const payload = await ask();
    expect(mockGapRows).toHaveLength(1);
    expect(payload.answerClaude).toEqual({ stuck: true, gapId: null });
  });

  test('a search with no gap row written (an ordinary answer) is stuck with gapId null', async () => {
    script(OK_REPLY);
    const payload = await ask();
    expect(mockGapRows).toHaveLength(0);
    expect(payload.answerClaude).toEqual({ stuck: true, gapId: null });
  });

  test('with the gap kill switch off the line still shows, with gapId null', async () => {
    process.env.AGENT_GAP_REPORTS = 'off';
    script(DECLINE_REPLY);
    expect((await ask()).answerClaude).toEqual({ stuck: true, gapId: null });
  });

  test.each([
    ['the answer gate is off', () => { delete process.env.GATE_IB_ANSWER_SEND_TO_CLAUDE; }],
    ['the answer gate is not exactly true', () => { process.env.GATE_IB_ANSWER_SEND_TO_CLAUDE = 'yes'; }],
    ['the box gate is off', () => { delete process.env.GATE_IB_SEND_TO_CLAUDE; }],
  ])('no key at all when %s', async (_name, change) => {
    change();
    script(DECLINE_REPLY);
    const payload = await ask();
    expect('answerClaude' in payload).toBe(false);
  });

  test('no key for an admin login that is not the owner', async () => {
    script(DECLINE_REPLY);
    expect('answerClaude' in (await ask({ token: 'office' }))).toBe(false);
  });

  test('no key when the request ran no capability search', async () => {
    script(DECLINE_REPLY, { search: false });
    expect('answerClaude' in (await ask())).toBe(false);
  });

  test('no key in the tech context, where the platform collector does not exist', async () => {
    script(DECLINE_REPLY);
    const payload = await ask({ context: 'tech' });
    expect(payload.response).toContain(DECLINE_REPLY);
    expect('answerClaude' in payload).toBe(false);
  });
});
