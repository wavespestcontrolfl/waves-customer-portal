/**
 * Gap reports (server/services/agent-gap-reports.js) wiring for the tech
 * context on /query — server/routes/admin-intelligence-bar.js.
 *
 * The tech portal has no discover_capabilities loop (platformEnabled is
 * always false there), so its collector is created independent of
 * platformEnabled, with source 'tech-bar', and the route passes the raw
 * prompt as flush()'s `ask` fallback. Admin, non-platform requests keep
 * today's behavior: no collector at all.
 *
 * Harness mirrors admin-intelligence-bar-tool-activity.test.js — a real
 * router mounted on an in-memory Express app, every tool module mocked, a
 * scripted Anthropic client.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockCreateGapCollector = jest.fn();
const mockDbInsert = jest.fn(async () => undefined);

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
jest.mock('../services/agent-gap-reports', () => ({
  gapReportPromptLine: jest.fn(() => ''),
  createGapCollector: (...args) => mockCreateGapCollector(...args),
}));

jest.mock('../services/intelligence-bar/tools', () => ({
  TOOLS: [], UPDATABLE_FIELDS: {}, executeTool: jest.fn(async () => ({})),
  resolveTechnicianByName: jest.fn(), resolveActiveTechnicianById: jest.fn(),
}));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn(async () => ({})) }));
jest.mock('../services/intelligence-bar/review-tools', () => ({
  REVIEW_TOOLS: [], executeReviewTool: jest.fn(), hasRecentReviewRequest: jest.fn(async () => false), loadReviewRecipient: jest.fn(),
}));
jest.mock('../services/intelligence-bar/comms-tools', () => ({
  COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn(), resolveCustomer: jest.fn(),
}));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({
  LEADS_TOOLS: [], executeLeadsTool: jest.fn(), resolveLeadForUpdate: jest.fn(), previewBulkLeadUpdate: jest.fn(), BULK_LEAD_UPDATE_CAP: 500,
}));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({ BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn() }));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10, createPendingAction: jest.fn(), claimForConfirm: jest.fn(), cancelPendingAction: jest.fn(), recordResult: jest.fn(),
}));
jest.mock('../services/inspection-credit', () => ({ projectRedeemableOfferAmount: jest.fn(async () => ({ amount: 0 })) }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician' } };
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
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message, stack: err.stack }));
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

function scriptModelReply(text) {
  mockMessagesCreate.mockReset();
  mockMessagesCreate.mockResolvedValueOnce({ content: [{ type: 'text', text }] });
}

async function postQuery(baseUrl, body, token = 'admin') {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('gap reports on /query', () => {
  let lastCollector;
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_IB_PLATFORM;
    lastCollector = null;
    mockCreateGapCollector.mockImplementation((opts) => {
      lastCollector = { opts, flush: jest.fn(async () => {}), discovery: jest.fn(), toolResult: jest.fn() };
      return lastCollector;
    });
  });

  test('a tech request gets a tech-bar collector, independent of platformEnabled, and flush gets the raw prompt as ask', async () => {
    scriptModelReply("Sorry, I can't do that from here.");
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, { prompt: 'add a note to my next stop', context: 'tech' }, 'tech');
      expect(status).toBe(200);
    });
    expect(mockCreateGapCollector).toHaveBeenCalledTimes(1);
    expect(mockCreateGapCollector).toHaveBeenCalledWith({ source: 'tech-bar' });
    expect(lastCollector.flush).toHaveBeenCalledWith({
      reply: "Sorry, I can't do that from here.",
      ask: 'add a note to my next stop',
    });
  });

  test('an ordinary admin, non-platform request creates no collector at all (unchanged behavior)', async () => {
    scriptModelReply('Here are the three customers you asked about.');
    await withServer(async (baseUrl) => {
      const { status } = await postQuery(baseUrl, { prompt: 'find Jeff', context: 'customers' }, 'admin');
      expect(status).toBe(200);
    });
    expect(mockCreateGapCollector).not.toHaveBeenCalled();
  });
});
