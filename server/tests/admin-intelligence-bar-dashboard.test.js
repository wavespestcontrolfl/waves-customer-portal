process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const mockExecuteDashboardTool = jest.fn();
const mockExecuteSeoTool = jest.fn();

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
jest.mock('../services/intelligence-bar/dashboard-tools', () => ({
  DASHBOARD_TOOLS: [
    { name: 'get_kpi_snapshot', input_schema: { type: 'object', properties: {} } },
  ],
  executeDashboardTool: (...args) => mockExecuteDashboardTool(...args),
}));
jest.mock('../services/intelligence-bar/seo-tools', () => ({
  SEO_TOOLS: [
    { name: 'run_seo_pipeline', input_schema: { type: 'object', properties: {} } },
    { name: 'seo_action_queue', input_schema: { type: 'object', properties: {} } },
  ],
  executeSeoTool: (...args) => mockExecuteSeoTool(...args),
}));
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
  BANKING_TOOLS: [],
  BANKING_QUERY_TOOLS: [],
  executeBankingTool: jest.fn(),
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

describe('dashboard intelligence-bar guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('technician cannot query dashboard intelligence context', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'dashboard', prompt: 'How is revenue?' }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required for dashboard intelligence');
      expect(mockExecuteDashboardTool).not.toHaveBeenCalled();
    });
  });

  test('technician cannot list dashboard quick actions', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/quick-actions?context=dashboard`, {
        headers: { Authorization: 'Bearer tech' },
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required for dashboard intelligence');
      expect(mockExecuteDashboardTool).not.toHaveBeenCalled();
    });
  });

  test('technician cannot execute dashboard actions', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_kpi_snapshot', params: {} }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required for dashboard actions');
      expect(mockExecuteDashboardTool).not.toHaveBeenCalled();
    });
  });

  test('admin can execute dashboard actions', async () => {
    mockExecuteDashboardTool.mockResolvedValue({ ok: true });

    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_kpi_snapshot', params: { period: 'mtd' } }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockExecuteDashboardTool).toHaveBeenCalledWith('get_kpi_snapshot', { period: 'mtd' });
    });
  });

  test('technician cannot execute confirmed SEO actions', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_seo_pipeline',
          params: { domain: 'wavespestcontrol.com' },
          confirmed: true,
          idempotency_key: 'seo-pipeline-test-1',
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required for SEO actions');
      expect(mockExecuteSeoTool).not.toHaveBeenCalled();
    });
  });

  test('admin must explicitly confirm SEO actions', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_seo_pipeline',
          params: { domain: 'wavespestcontrol.com' },
          idempotency_key: 'seo-pipeline-test-2',
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe('Explicit confirmation is required for this action');
      expect(mockExecuteSeoTool).not.toHaveBeenCalled();
    });
  });

  test('admin confirmed SEO actions require idempotency and pass admin context', async () => {
    mockExecuteSeoTool.mockResolvedValue({ status: 'started' });

    await withServer(async (baseUrl) => {
      const missingKey = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_seo_pipeline',
          params: { domain: 'wavespestcontrol.com' },
          confirmed: true,
        }),
      });
      const missingKeyBody = await missingKey.json();
      expect(missingKey.status).toBe(400);
      expect(missingKeyBody.error).toBe('A valid idempotency key is required for this action');

      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'run_seo_pipeline',
          params: { domain: 'wavespestcontrol.com' },
          confirmed: true,
          idempotency_key: 'seo-pipeline-test-3',
        }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockExecuteSeoTool).toHaveBeenCalledWith(
        'run_seo_pipeline',
        expect.objectContaining({
          domain: 'wavespestcontrol.com',
          idempotencyKey: 'seo-pipeline-test-3',
          requestedBy: 'admin-1',
        }),
        expect.objectContaining({
          isAdmin: true,
          technicianId: 'admin-1',
          confirmed: true,
        }),
      );
    });
  });
});
