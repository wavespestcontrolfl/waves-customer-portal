/**
 * Email tools are admin-only across the Intelligence Bar (Codex P1 on
 * PR #2689). The dedicated /api/admin/email surface is requireAdmin; this
 * router is requireTechOrAdmin, so technician tokens must neither SEE the
 * email tools (getToolsForContext) nor EXECUTE them (/query loop, /execute).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockExecuteEmailTool = jest.fn();

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
jest.mock('../services/intelligence-bar/email-tools', () => {
  const EMAIL_TOOLS = [
    { name: 'get_inbox_summary', input_schema: { type: 'object', properties: {} } },
    { name: 'search_emails', input_schema: { type: 'object', properties: {} } },
    { name: 'send_email_reply', input_schema: { type: 'object', properties: {} } },
    { name: 'get_vendor_invoices', input_schema: { type: 'object', properties: {} } },
  ];
  const SHARED = new Set(['get_inbox_summary', 'search_emails', 'send_email_reply']);
  return {
    EMAIL_TOOLS,
    EMAIL_SHARED_TOOLS: EMAIL_TOOLS.filter(t => SHARED.has(t.name)),
    executeEmailTool: (...args) => mockExecuteEmailTool(...args),
  };
});
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

const EMAIL_TOOL_NAMES = ['get_inbox_summary', 'search_emails', 'send_email_reply', 'get_vendor_invoices'];

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

async function queryToolNames(baseUrl, token, context) {
  mockMessagesCreate.mockResolvedValueOnce(finalTextTurn());
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ context, prompt: 'anything' }),
  });
  expect(res.status).toBe(200);
  const call = mockMessagesCreate.mock.calls[mockMessagesCreate.mock.calls.length - 1][0];
  return call.tools.map(t => t.name);
}

describe('email tools are admin-only in the intelligence bar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('admin tool lists include the shared email subset (but not email-page-only tools outside the email context)', async () => {
    await withServer(async (baseUrl) => {
      const dispatch = await queryToolNames(baseUrl, 'admin', 'dispatch');
      expect(dispatch).toEqual(expect.arrayContaining(['get_inbox_summary', 'search_emails', 'send_email_reply']));
      expect(dispatch).not.toContain('get_vendor_invoices');

      const email = await queryToolNames(baseUrl, 'admin', 'email');
      expect(email).toEqual(expect.arrayContaining(EMAIL_TOOL_NAMES));
    });
  });

  test('technician tool lists never include any email tool — any context', async () => {
    await withServer(async (baseUrl) => {
      for (const context of ['dispatch', 'email', 'comms', 'leads', 'customers']) {
        const names = await queryToolNames(baseUrl, 'tech', context);
        for (const emailTool of EMAIL_TOOL_NAMES) {
          expect(names).not.toContain(emailTool);
        }
      }
    });
  });

  test('technician tool_use of an email tool is refused in the query loop and never executes', async () => {
    await withServer(async (baseUrl) => {
      mockMessagesCreate
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'search_emails', input: { search: 'christine' } }],
          usage: {},
        })
        .mockResolvedValueOnce(finalTextTurn());

      const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'dispatch', prompt: 'find her email' }),
      });
      expect(res.status).toBe(200);
      expect(mockExecuteEmailTool).not.toHaveBeenCalled();

      // The tool_result fed back to the model is the admin-required error
      const secondCall = mockMessagesCreate.mock.calls[1][0];
      const toolResults = secondCall.messages[secondCall.messages.length - 1].content;
      expect(toolResults[0].is_error).toBe(true);
      expect(toolResults[0].content).toContain('Admin access required');
    });
  });

  test('technician cannot execute an email tool via /execute', async () => {
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'search_emails', params: { search: 'invoice' } }),
      });
      const body = await res.json();
      expect(res.status).toBe(403);
      expect(body.error).toBe('Admin access required for this action');
      expect(mockExecuteEmailTool).not.toHaveBeenCalled();
    });
  });

  test('admin can execute an email read via /execute', async () => {
    mockExecuteEmailTool.mockResolvedValue({ results: [], total: 0 });
    await withServer(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/admin/intelligence-bar/execute`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'search_emails', params: { search: 'invoice' } }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockExecuteEmailTool).toHaveBeenCalledWith('search_emails', { search: 'invoice' });
    });
  });
});
