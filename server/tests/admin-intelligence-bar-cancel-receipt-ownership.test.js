/**
 * /confirm-action saves a cancel receipt whose follow-up steps the recovery sweep took over only if the action has none
 * (services/ib-cancel-effect-bundles.js: the request lost its bundle lease). A normal cancel result is saved as always.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockClaimForConfirm = jest.fn();
const mockRecordResult = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/intelligence-bar/circuit-breaker', () => ({
  getBreaker: jest.fn(() => ({
    isTripped: jest.fn(() => false), fastFailResult: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn(),
  })),
}));
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: jest.fn() }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  TTL_MINUTES: 10,
  createPendingAction: jest.fn(),
  claimForConfirm: (...args) => mockClaimForConfirm(...args),
  recordResult: (...args) => mockRecordResult(...args),
  getActionReceipt: jest.fn(async () => null),
  stepKey: jest.fn(() => 'step-1'),
}));

jest.mock('../services/intelligence-bar/tools', () => ({ TOOLS: [], executeTool: jest.fn() }));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/procurement-tools', () => ({ PROCUREMENT_TOOLS: [], executeProcurementTool: jest.fn() }));
jest.mock('../services/intelligence-bar/revenue-tools', () => ({ REVENUE_TOOLS: [], executeRevenueTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tech-tools', () => ({ TECH_TOOLS: [], executeTechTool: jest.fn() }));
jest.mock('../services/intelligence-bar/review-tools', () => ({ REVIEW_TOOLS: [], executeReviewTool: jest.fn() }));
jest.mock('../services/intelligence-bar/comms-tools', () => ({ COMMS_TOOLS: [], COMMS_READ_TOOLS: [], executeCommsTool: jest.fn() }));
jest.mock('../services/intelligence-bar/tax-tools', () => ({ TAX_TOOLS: [], executeTaxTool: jest.fn() }));
jest.mock('../services/intelligence-bar/leads-tools', () => ({ LEADS_TOOLS: [], executeLeadsTool: jest.fn() }));
jest.mock('../services/intelligence-bar/email-tools', () => ({ EMAIL_TOOLS: [], executeEmailTool: jest.fn() }));
jest.mock('../services/intelligence-bar/estimate-tools', () => ({ ESTIMATE_TOOLS: [], executeEstimateTool: jest.fn() }));
jest.mock('../services/intelligence-bar/banking-tools', () => ({
  BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn(),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const users = {
      admin: { id: 'admin-1', role: 'admin', email: 'contact@wavespestcontrol.com' },
      otheradmin: { id: 'admin-2', role: 'admin', email: 'virginia@wavespestcontrol.com' },
    };
    const user = users[token];
    if (!user) return res.status(401).json({ error: 'Admin authentication required' });
    req.technician = user;
    req.technicianId = user.id;
    req.techRole = user.role;
    return next();
  },
  requireTechOrAdmin: (req, res, next) => next(),
}));



const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');
const { executeTool } = require('../services/intelligence-bar/tools');

const PENDING_ID = '7e1c2f7a-1111-2222-3333-deadbeef0020';
const realFetch = global.fetch;

async function confirm() {
  const app = express();
  app.use(express.json());
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await realFetch(`http://127.0.0.1:${server.address().port}/admin/intelligence-bar/confirm-action`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_action_id: PENDING_ID }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  require('../models/db').mockImplementation(() => new Proxy({}, { get: (_t, prop) => (prop === 'then' ? (res) => Promise.resolve([]).then(res) : () => new Proxy({}, { get: () => () => undefined })) }));
  mockClaimForConfirm.mockResolvedValue({ action: { id: PENDING_ID, tool_name: 'update_appointment_notes', params: { appointment_id: 'svc-1', notes: 'x' } } });
  mockRecordResult.mockResolvedValue(true);
});

describe('/confirm-action receipt for a cancel the recovery sweep took over', () => {
  test('a result flagged recovery_owns_outcome is saved only if the action has none', async () => {
    executeTool.mockResolvedValue({ success: true, appointment_id: 'svc-1', recovery_owns_outcome: true, warning: 'The system took over.' });
    const { status, body } = await confirm();
    expect(status).toBe(200);
    expect(mockRecordResult).toHaveBeenCalledTimes(1);
    expect(mockRecordResult).toHaveBeenCalledWith(PENDING_ID, expect.objectContaining({ recovery_owns_outcome: true }), { onlyIfEmpty: true });
    expect(body.result.recovery_owns_outcome).toBe(true);
  });

  test('an ordinary result is saved exactly as before (no options)', async () => {
    executeTool.mockResolvedValue({ success: true, appointment_id: 'svc-1' });
    await confirm();
    expect(mockRecordResult).toHaveBeenCalledTimes(1);
    expect(mockRecordResult.mock.calls[0]).toHaveLength(2);
  });
});
