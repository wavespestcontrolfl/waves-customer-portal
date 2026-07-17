/**
 * PII taint must survive follow-up turns (Codex P1 on PR #2832). A PII-bearing
 * tool result (SMS thread, email body, payment description with a customer
 * name) enters conversationHistory; a follow-up can echo the name with NO tool
 * call, so redaction keyed only on the current turn's tool calls would persist
 * it to intelligence_bar_queries. The taint rides a marker on the returned
 * history — exactly like the image taint — and is stripped before the history
 * reaches the model.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockInsert = jest.fn(async () => undefined);

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({
  messages: { create: (...args) => mockMessagesCreate(...args) },
})));

jest.mock('../models/db', () => jest.fn(() => ({ insert: (...args) => mockInsert(...args) })));
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
// The mocked model "calls" get_stripe_payment_intents below — stub the module
// so a developer/CI machine with STRIPE_SECRET_KEY exported can never hit the
// real Stripe API from this suite. The tool NAME is what drives PII handling
// in the route, so the taint behavior under test is unaffected.
jest.mock('../services/intelligence-bar/stripe-ops-tools', () => ({
  STRIPE_OPS_TOOLS: [
    { name: 'get_stripe_payment_intents', description: 'stub', input_schema: { type: 'object', properties: {} } },
  ],
  executeStripeOpsTool: jest.fn(async () => ({ payment_intents: [], total_matched: 0 })),
}));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, res, next) => {
    req.technician = { id: 'admin-1', role: 'admin' };
    req.technicianId = 'admin-1';
    req.techRole = 'admin';
    return next();
  },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const intelligenceRouter = require('../routes/admin-intelligence-bar');

const PII_TAINT_MARKER = '[PII-bearing tool context may contain customer PII]';
const REDACT_NOTE = '[redacted — PII-bearing tools used]';

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

async function postQuery(baseUrl, body) {
  const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
    method: 'POST',
    headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe('PII-tool taint persists across follow-up turns', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('PII tool turn: telemetry redacted, returned history carries the taint marker', async () => {
    await withServer(async (baseUrl) => {
      mockMessagesCreate
        .mockResolvedValueOnce({
          content: [{ type: 'tool_use', id: 'tu_1', name: 'get_stripe_payment_intents', input: {} }],
          usage: {},
        })
        .mockResolvedValueOnce({
          content: [{ type: 'text', text: 'Two $33.33 drafts, both for Jane Customer.' }],
          usage: {},
        });

      const body = await postQuery(baseUrl, { context: 'revenue', prompt: 'any stripe drafts?' });

      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        prompt: REDACT_NOTE,
        response: REDACT_NOTE,
      }));

      const assistant = body.conversationHistory[body.conversationHistory.length - 1];
      expect(assistant.role).toBe('assistant');
      expect(assistant.content).toContain(PII_TAINT_MARKER);
      const user = body.conversationHistory[body.conversationHistory.length - 2];
      expect(user.content).toContain(PII_TAINT_MARKER);
    });
  });

  test('follow-up with tainted history and NO tool call: still redacted, marker re-applied, model never sees the marker', async () => {
    await withServer(async (baseUrl) => {
      const taintedHistory = [
        { role: 'user', content: `any stripe drafts?\n${PII_TAINT_MARKER}` },
        { role: 'assistant', content: `Two $33.33 drafts, both for Jane Customer.\n${PII_TAINT_MARKER}` },
      ];
      mockMessagesCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Jane Customer, as I said.' }],
        usage: {},
      });

      const body = await postQuery(baseUrl, {
        context: 'revenue',
        prompt: 'who was that customer again?',
        conversationHistory: taintedHistory,
      });

      // Telemetry stays redacted even though this turn called no tools.
      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        prompt: REDACT_NOTE,
        response: REDACT_NOTE,
      }));

      // The marker is an internal flag — it must be stripped from what the
      // model receives.
      const call = mockMessagesCreate.mock.calls[0][0];
      expect(JSON.stringify(call.messages)).not.toContain(PII_TAINT_MARKER);

      // And the taint keeps riding forward.
      const assistant = body.conversationHistory[body.conversationHistory.length - 1];
      expect(assistant.content).toContain(PII_TAINT_MARKER);
    });
  });

  test('control: no PII tool and clean history persists the real prompt/response', async () => {
    await withServer(async (baseUrl) => {
      mockMessagesCreate.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'Revenue is up 4% this month.' }],
        usage: {},
      });

      const body = await postQuery(baseUrl, { context: 'revenue', prompt: 'how is revenue?' });

      expect(mockInsert).toHaveBeenCalledWith(expect.objectContaining({
        prompt: 'how is revenue?',
        response: 'Revenue is up 4% this month.',
      }));
      const assistant = body.conversationHistory[body.conversationHistory.length - 1];
      expect(assistant.content).not.toContain(PII_TAINT_MARKER);
    });
  });
});
