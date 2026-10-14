/**
 * Codex r1 on #6297 (security P1): /execute logged check_address params in
 * plain text. The tool has scope 'none', so it is not in PII_TOOL_NAMES, and
 * only the /query loop knew it carries a customer's street address. The
 * direct route now logs field names only, as it does for PII tools.
 *
 * Harness mirrors admin-ib-tech-execution-scope.test.js.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockExecuteTool = jest.fn();

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
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/address-validation', () => ({
  STATUSES: jest.requireActual('../services/address-validation').STATUSES,
  validateAddress: jest.fn(async () => ({ status: 'not_attempted', normalized: null })),
}));
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


const logger = require('../services/logger');

beforeEach(() => jest.clearAllMocks());

test('/execute check_address logs field names only, never the address', async () => {
  const params = { address: '100 Example Way', city: 'Sarasota', state: 'FL', zip: '34200' };
  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, '/admin/intelligence-bar/execute', { action: 'check_address', params }, 'admin');
    expect(res.status).toBe(200);
    expect((await res.json()).result.status).toBe('not_attempted');
  });
  const executed = logger.info.mock.calls.find(([message]) => /Executed action: check_address/.test(message));
  expect(executed).toBeDefined();
  expect(executed[1]).toEqual({ fields: expect.arrayContaining(['address', 'city', 'state', 'zip']) });
  expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/100 Example Way|34200/);
});
