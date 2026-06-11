process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockExecuteBankingTool = jest.fn();

jest.mock('../models/db', () => jest.fn());
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

jest.mock('../services/intelligence-bar/tools', () => ({ TOOLS: [], executeTool: jest.fn() }));
jest.mock('../services/intelligence-bar/schedule-tools', () => ({ SCHEDULE_TOOLS: [], executeScheduleTool: jest.fn() }));
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({ DASHBOARD_TOOLS: [], executeDashboardTool: jest.fn() }));
jest.mock('../services/intelligence-bar/seo-tools', () => ({ SEO_TOOLS: [], executeSeoTool: jest.fn() }));
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
  BANKING_TOOLS: [
    { name: 'request_instant_payout', input_schema: { type: 'object', properties: {} } },
    { name: 'request_standard_payout', input_schema: { type: 'object', properties: {} } },
    { name: 'get_stripe_balance', input_schema: { type: 'object', properties: {} } },
  ],
  BANKING_QUERY_TOOLS: [
    { name: 'get_stripe_balance', input_schema: { type: 'object', properties: {} } },
  ],
  executeBankingTool: (...args) => mockExecuteBankingTool(...args),
}));
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
  app.use(express.json());
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  const server = app.listen(0);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl };
}

async function withServer(fn) {
  const { server, baseUrl } = appServer();
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('banking intelligence-bar action guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('technician cannot query banking intelligence context', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'banking', prompt: 'What is the balance?' }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required for banking intelligence');
      expect(mockExecuteBankingTool).not.toHaveBeenCalled();
    });
  });

  test('technician cannot execute banking actions', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_instant_payout', confirmed: true, params: { amount: 50 } }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required for banking actions');
      expect(mockExecuteBankingTool).not.toHaveBeenCalled();
    });
  });

  test('admin instant payout action requires explicit confirmation', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_instant_payout', params: { amount: 50 } }),
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe('Explicit confirmation is required for this action');
      expect(mockExecuteBankingTool).not.toHaveBeenCalled();
    });
  });

  test('admin confirmed instant payout action executes through banking tool', async () => {
    mockExecuteBankingTool.mockResolvedValue({ payout_id: 'po_123' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request_instant_payout',
          confirmed: true,
          idempotency_key: 'ipo_confirm_123',
          params: { amount: 50 },
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockExecuteBankingTool).toHaveBeenCalledWith('request_instant_payout', {
        amount: 50,
        idempotencyKey: 'ipo_confirm_123',
        requestedBy: 'admin-1',
      });
    });
  });

  test('admin standard payout action requires explicit confirmation', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_standard_payout', params: { amount: 50 } }),
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe('Explicit confirmation is required for this action');
      expect(mockExecuteBankingTool).not.toHaveBeenCalled();
    });
  });

  test('admin confirmed standard payout action requires a valid idempotency key', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'request_standard_payout', confirmed: true, params: { amount: 50 } }),
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe('A valid idempotency key is required for this action');
      expect(mockExecuteBankingTool).not.toHaveBeenCalled();
    });
  });

  test('admin confirmed standard payout action executes with actor and idempotency key', async () => {
    mockExecuteBankingTool.mockResolvedValue({ payout_id: 'po_standard' });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'request_standard_payout',
          confirmed: true,
          params: { amount: 75, idempotency_key: 'spo_confirm_123' },
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockExecuteBankingTool).toHaveBeenCalledWith('request_standard_payout', {
        amount: 75,
        idempotency_key: 'spo_confirm_123',
        idempotencyKey: 'spo_confirm_123',
        requestedBy: 'admin-1',
      });
    });
  });
});
