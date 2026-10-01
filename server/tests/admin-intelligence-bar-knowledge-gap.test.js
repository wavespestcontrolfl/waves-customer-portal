/**
 * Intelligence Bar knowledge gaps — the operator-chosen path into the weekly
 * knowledge-gaps email.
 *
 * Invariants:
 *  1. An empty search_field_intelligence result puts its query in the /query
 *     payload's knowledgeMisses and writes NOTHING to knowledge_queries: the
 *     search text can carry customer details, so only the operator's tap
 *     saves it.
 *  2. A search with any hit, or a failed search, adds no knowledgeMisses key.
 *  3. POST /knowledge-gap (admin only) saves exactly the text sent, as an
 *     'intelligence_bar' row with coverage 'none'.
 *
 * Harness (mocks + helpers) mirrors admin-intelligence-bar-tool-activity.test.js.
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
const mockDbTable = jest.fn();
const mockResolveCommsCustomer = jest.fn();
const mockLoadReviewRecipient = jest.fn();
const mockResolveTechnician = jest.fn();
const mockResolveTechnicianById = jest.fn();
const mockResolveLeadForUpdate = jest.fn();
const mockPreviewBulkLeadUpdate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => jest.fn((table) => {
  mockDbTable(table);
  return { insert: mockDbInsert };
}));
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

async function postGap(baseUrl, body, token = 'admin') {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/knowledge-gap`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const knowledgeQueryInserts = () => mockDbTable.mock.calls
  .map(([table], i) => (table === 'knowledge_queries' ? mockDbInsert.mock.calls[i]?.[0] : null))
  .filter(Boolean);

describe('knowledgeMisses on /query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function scriptSearch(result) {
    mockExecuteTool.mockImplementation(async () => result);
    scriptModelTurns([
      [{ type: 'tool_use', id: 'tu_1', name: 'search_field_intelligence', input: { query: 'chinch bugs on zoysia' } }],
      [{ type: 'text', text: 'Nothing in the knowledge base on that.' }],
    ]);
  }

  const empty = {
    query: 'chinch bugs on zoysia', fieldIntelligence: [], knowledgeBase: [], bridgedPairs: 0, openContradictions: [],
  };

  test('an empty search returns its query and saves nothing', async () => {
    scriptSearch(empty);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'what works on chinch bugs in zoysia', context: 'dashboard' });
      expect(status).toBe(200);
      expect(body.knowledgeMisses).toEqual(['chinch bugs on zoysia']);
      expect(mockDbTable).not.toHaveBeenCalledWith('knowledge_queries');
      // The model never sees the miss list.
      expect(JSON.stringify(mockMessagesCreate.mock.calls)).not.toContain('knowledgeMisses');
    });
  });

  test.each([
    ['a knowledge-base hit', { ...empty, knowledgeBase: [{ slug: 'chinch', title: 'Chinch bugs' }] }],
    ['a wiki hit', { ...empty, fieldIntelligence: [{ slug: 'chinch', title: 'Chinch bugs' }] }],
    ['an operational hit', { ...empty, operationalKnowledge: [{ source: 'protocol', ref: 'p1', title: 'Chinch' }] }],
    ['a failed search', { error: 'query is required' }],
  ])('%s adds no knowledgeMisses key', async (_label, result) => {
    scriptSearch(result);
    await withServer(async (baseUrl) => {
      const { status, body } = await postQuery(baseUrl, { prompt: 'chinch bugs', context: 'dashboard' });
      expect(status).toBe(200);
      expect('knowledgeMisses' in body).toBe(false);
    });
  });
});

describe('POST /knowledge-gap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('saves the operator-edited text as an Intelligence Bar gap', async () => {
    await withServer(async (baseUrl) => {
      const { status, body } = await postGap(baseUrl, { question: '  chinch bugs\n on   zoysia ' });
      expect(status).toBe(200);
      expect(body).toEqual({ success: true });
      expect(knowledgeQueryInserts()).toEqual([{
        query: 'chinch bugs on zoysia',
        articles_referenced: '[]',
        asked_by: 'intelligence_bar',
        coverage: 'none',
      }]);
    });
  });

  test('technicians are refused', async () => {
    await withServer(async (baseUrl) => {
      const { status } = await postGap(baseUrl, { question: 'chinch bugs on zoysia' }, 'tech');
      expect(status).toBe(403);
      expect(mockDbInsert).not.toHaveBeenCalled();
    });
  });

  test.each([
    ['too short', { question: 'ab' }],
    ['too long', { question: 'x'.repeat(301) }],
    ['not a string', { question: ['chinch bugs'] }],
    ['missing', {}],
  ])('%s is refused', async (_label, payload) => {
    await withServer(async (baseUrl) => {
      const { status } = await postGap(baseUrl, payload);
      expect(status).toBe(400);
      expect(mockDbInsert).not.toHaveBeenCalled();
    });
  });
});
