/**
 * 07-19 admin audit (P1-1, execution scope): a technician executing an allowed
 * tech tool through /execute or /confirm-action must run against their OWN
 * technician scope. The direct-execution endpoints previously passed a null
 * tech context to executeToolByName, so a tool like get_my_route omitted its
 * technician filter and returned every technician's stops (customer names,
 * addresses, notes, next customer's phone). This suite mocks a NON-EMPTY
 * TECH_TOOLS set and asserts the authenticated tech context reaches
 * executeTechTool, and that a non-tech tool stays denied.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockExecuteTool = jest.fn();
const mockExecuteTechTool = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: jest.fn() },
})));
jest.mock('../models/db', () => jest.fn(() => ({ insert: jest.fn(async () => undefined) })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({
  getBreaker: jest.fn(() => ({
    isTripped: jest.fn(() => false), fastFailResult: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn(),
  })),
}));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));

jest.mock('../services/intelligence-bar/tools', () => ({ TOOLS: [], executeTool: (...a) => mockExecuteTool(...a) }));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
// The tool under test: a non-empty tech toolset with a scope-sensitive read.
jest.mock('../services/intelligence-bar/tech-tools', () => ({
  TECH_TOOLS: [{ name: 'get_my_route', description: 'route', input_schema: { type: 'object', properties: {} } }],
  executeTechTool: (...a) => mockExecuteTechTool(...a),
}));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({ COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({ LEADS_TOOLS: [], executeLeadsTool: jest.fn() }));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({ BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn() }));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10,
  createPendingAction: jest.fn(),
  claimForConfirm: jest.fn(async () => ({ action: { id: 'pa-1', tool_name: 'get_my_route', params: {} } })),
  cancelPendingAction: jest.fn(),
  recordResult: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = { admin: { id: 'admin-1', role: 'admin' }, tech: { id: 'tech-1', role: 'technician', name: 'Adam' } };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.technicianName = user.name || null;
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
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}
async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try { return await fn(baseUrl); } finally { await new Promise((r) => server.close(r)); }
}
const post = (baseUrl, path, body, token) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

beforeEach(() => { jest.clearAllMocks(); delete process.env.GATE_IB_UI_CONFIRM; });

describe('technician tech-tool execution is scoped to the technician', () => {
  test('/execute get_my_route runs with the authenticated tech context (not null)', async () => {
    mockExecuteTechTool.mockResolvedValue({ stops: [] });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/intelligence-bar/execute', { action: 'get_my_route', params: {} }, 'tech');
      expect(res.status).toBe(200);
      expect(mockExecuteTechTool).toHaveBeenCalledTimes(1);
      const [name, , techContext] = mockExecuteTechTool.mock.calls[0];
      expect(name).toBe('get_my_route');
      expect(techContext).toEqual({ techId: 'tech-1', techName: 'Adam' });
    });
  });

  test('/execute still denies a non-tech tool for a technician', async () => {
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/intelligence-bar/execute', { action: 'query_customers', params: {} }, 'tech');
      expect(res.status).toBe(403);
      expect(mockExecuteTool).not.toHaveBeenCalled();
      expect(mockExecuteTechTool).not.toHaveBeenCalled();
    });
  });

  test('/confirm-action get_my_route runs with the authenticated tech context', async () => {
    mockExecuteTechTool.mockResolvedValue({ stops: [] });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/intelligence-bar/confirm-action', { pending_action_id: 'pa-1' }, 'tech');
      expect(res.status).toBe(200);
      const [name, , techContext] = mockExecuteTechTool.mock.calls[0];
      expect(name).toBe('get_my_route');
      expect(techContext).toEqual({ techId: 'tech-1', techName: 'Adam' });
    });
  });

  test('/execute get_my_route runs UNSCOPED for an admin (empty tech context)', async () => {
    // techContextForExecution returns null for admin; executeToolByName passes
    // `techContext || {}` to executeTechTool, so admin runs with no tech filter.
    mockExecuteTechTool.mockResolvedValue({ stops: [] });
    await withServer(async (baseUrl) => {
      const res = await post(baseUrl, '/admin/intelligence-bar/execute', { action: 'get_my_route', params: {} }, 'admin');
      expect(res.status).toBe(200);
      expect(mockExecuteTechTool.mock.calls[0][2]).toEqual({});
    });
  });
});
