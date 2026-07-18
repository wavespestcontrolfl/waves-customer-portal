/**
 * Infra tools (Railway/Sentry/Cloudflare/Twilio/Stripe/GitHub/stores/
 * GrowthBook) load on EVERY admin context, not just the dashboard — any
 * admin page can ask about deploys, errors, webhook health, or Stripe
 * payment drafts. They stay strictly admin-only: technician tokens never
 * see them in a tool list and never execute them, and the tech portal
 * context stays fully isolated.
 *
 * The infra tool modules load REAL here (unconfigured = benign dark state);
 * only the business tool modules are stubbed.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => jest.fn(() => ({ insert: async () => undefined })));
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
  BANKING_TOOLS: [], BANKING_QUERY_TOOLS: [], executeBankingTool: jest.fn(),
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

// One representative tool per infra module.
const INFRA_MARKERS = [
  'get_railway_status',
  'get_sentry_top_issues',
  'get_cloudflare_zones',
  'get_twilio_alerts',
  'get_stripe_payment_intents',
  'get_recent_merged_prs',
  'get_app_store_status',
  'get_growthbook_features',
  'get_google_ads_serving_status',
  'get_integration_token_health',
  'get_email_suppressions',
  'get_dataforseo_balance',
  'get_gbp_status',
  'get_ga4_snapshot',
  'get_meta_ads_delivery_status',
  'get_truck_status',
  'get_apify_status',
  'get_social_channel_status',
  'get_managed_agent_runs',
];

// Every context an admin page can send. 'customers' exercises the base
// fallback branch.
const ADMIN_CONTEXTS = [
  'customers', 'schedule', 'dispatch', 'dashboard', 'seo', 'blog',
  'procurement', 'inventory', 'revenue', 'reviews', 'comms', 'tax',
  'leads', 'email', 'banking', 'estimates',
];

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
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

function finalTextTurn() {
  return { content: [{ type: 'text', text: 'done' }], usage: {} };
}

async function queryModelCall(baseUrl, token, context) {
  mockMessagesCreate.mockResolvedValueOnce(finalTextTurn());
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context, prompt: 'anything' }),
  });
  expect(res.status).toBe(200);
  return mockMessagesCreate.mock.calls[mockMessagesCreate.mock.calls.length - 1][0];
}

describe('infra tools load on every admin context, admin-only', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('admin tool lists include every infra module in every context', async () => {
    await withServer(async (baseUrl) => {
      for (const context of ADMIN_CONTEXTS) {
        const call = await queryModelCall(baseUrl, 'admin', context);
        const names = call.tools.map(t => t.name);
        for (const marker of INFRA_MARKERS) {
          expect(names).toContain(marker);
        }
      }
    });
  });

  test('admin system prompt carries the infra guidance in every context', async () => {
    await withServer(async (baseUrl) => {
      for (const context of ['revenue', 'customers', 'dashboard']) {
        const call = await queryModelCall(baseUrl, 'admin', context);
        expect(call.system[0].text).toContain('INFRASTRUCTURE (all READ-ONLY)');
        expect(call.system[0].text).toContain('get_stripe_payment_intents');
      }
    });
  });

  test('technician tool lists and prompt never include infra — any context', async () => {
    await withServer(async (baseUrl) => {
      for (const context of ['customers', 'schedule', 'revenue', 'comms', 'email']) {
        const call = await queryModelCall(baseUrl, 'tech', context);
        const names = call.tools.map(t => t.name);
        for (const marker of INFRA_MARKERS) {
          expect(names).not.toContain(marker);
        }
        expect(call.system[0].text).not.toContain('INFRASTRUCTURE (all READ-ONLY)');
      }
    });
  });

  test('tech portal context stays isolated — no infra tools, no infra prompt', async () => {
    await withServer(async (baseUrl) => {
      const call = await queryModelCall(baseUrl, 'tech', 'tech');
      expect(call.tools.map(t => t.name)).toEqual([]);
      expect(call.system[0].text).not.toContain('INFRASTRUCTURE (all READ-ONLY)');
    });
  });

  test('technician tool_use of an infra tool is refused in the query loop', async () => {
    await withServer(async (baseUrl) => {
      mockMessagesCreate
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'get_stripe_payment_intents', input: {} }],
          usage: {},
        })
        .mockResolvedValueOnce(finalTextTurn());

      const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'revenue', prompt: 'any stripe drafts?' }),
      });
      expect(res.status).toBe(200);

      const secondCall = mockMessagesCreate.mock.calls[1][0];
      const toolResults = secondCall.messages[secondCall.messages.length - 1].content;
      expect(toolResults[0].is_error).toBe(true);
      expect(toolResults[0].content).toContain('Admin access required');
    });
  });

  test('technician cannot reach an infra tool via /execute', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'get_stripe_payment_intents', params: {} }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toContain('Admin access required');
    });
  });
});
