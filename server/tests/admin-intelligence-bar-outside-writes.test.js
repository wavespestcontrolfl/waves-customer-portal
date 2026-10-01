/**
 * Outside-service writes (IB scope expansion item 1, owner ruling
 * 2026-09-28): Sentry/Cloudflare/Railway/GitHub write tools are
 * full-access-only, unlike every other yellow-tier (card-confirm) write —
 * enforced in the /query loop's dispatch guard even for a forced tool_use
 * that was never actually offered in the tool list (the offering side is
 * covered by intelligence-bar-full-access-tool-offering.test.js).
 *
 * sentry-ops-tools loads for REAL here (unconfigured = benign dark state,
 * same convention as admin-intelligence-bar-infra-all-contexts.test.js) so
 * this exercises the actual module, not a stub.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockMessagesCreate = jest.fn();
const mockCreatePendingAction = jest.fn();
const mockRecordToolEvent = jest.fn();

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
jest.mock('../services/intelligence-bar/tool-events', () => ({ recordToolEvent: (...args) => mockRecordToolEvent(...args) }));
jest.mock('../config/models', () => ({ FLAGSHIP: 'test-model' }));
jest.mock('../services/intelligence-bar/pending-actions', () => ({
  createPendingAction: (...args) => mockCreatePendingAction(...args),
  claimForConfirm: jest.fn(),
  recordResult: jest.fn(),
  getActionReceipt: jest.fn(),
  stepKey: jest.fn(() => 'step-1'),
}));

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
      // Full IB access (owner ruling 2026-09-28) is keyed off this email —
      // the default allow-list when IB_FULL_ACCESS_EMAILS is unset.
      admin: { id: 'admin-1', role: 'admin', email: 'contact@wavespestcontrol.com' },
      otheradmin: { id: 'admin-2', role: 'admin', email: 'virginia@wavespestcontrol.com' },
      tech: { id: 'tech-1', role: 'technician', email: 'tech@wavespestcontrol.com' },
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

function toolUseTurn(name, input) {
  return { content: [{ type: 'tool_use', id: 'tu_1', name, input }], usage: {} };
}
function finalTextTurn() {
  return { content: [{ type: 'text', text: 'done' }], usage: {} };
}

describe('outside-service write tools are full-access-only in the /query dispatch (owner ruling 2026-09-28)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreatePendingAction.mockResolvedValue({
      id: 'pending-1', status: 'pending', summary: {}, contract: {}, contract_hash: 'hash',
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
  });

  test('a non-owner admin forcing resolve_sentry_issue is refused, and no card is ever proposed', async () => {
    await withServer(async (baseUrl) => {
      mockMessagesCreate
        .mockResolvedValueOnce(toolUseTurn('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' }))
        .mockResolvedValueOnce(finalTextTurn());

      const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer otheradmin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'customers', prompt: 'resolve that sentry issue' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.pendingActions || []).toHaveLength(0);

      const secondCall = mockMessagesCreate.mock.calls[1][0];
      const toolResults = secondCall.messages[secondCall.messages.length - 1].content;
      expect(toolResults[0].is_error).toBe(true);
      expect(toolResults[0].content).toContain('This action is limited to the owner account.');
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
    });
  });

  test('a technician forcing resolve_sentry_issue is refused by the role guard first, still no card', async () => {
    await withServer(async (baseUrl) => {
      mockMessagesCreate
        .mockResolvedValueOnce(toolUseTurn('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' }))
        .mockResolvedValueOnce(finalTextTurn());

      const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer tech', 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'customers', prompt: 'resolve that sentry issue' }),
      });
      expect(res.status).toBe(200);
      const secondCall = mockMessagesCreate.mock.calls[1][0];
      const toolResults = secondCall.messages[secondCall.messages.length - 1].content;
      expect(toolResults[0].is_error).toBe(true);
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
    });
  });

  test('the full-access owner is NOT refused with the owner-only message — the tool runs (dark/unconfigured here)', async () => {
    await withServer(async (baseUrl) => {
      mockMessagesCreate
        .mockResolvedValueOnce(toolUseTurn('resolve_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A' }))
        .mockResolvedValueOnce(finalTextTurn());

      const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'customers', prompt: 'resolve that sentry issue' }),
      });
      expect(res.status).toBe(200);
      const secondCall = mockMessagesCreate.mock.calls[1][0];
      const toolResults = secondCall.messages[secondCall.messages.length - 1].content;
      // No SENTRY_API_TOKEN in this test env — the module's own dark-config
      // guard answers benignly, proving the owner-only refusal never fired.
      expect(String(toolResults[0].content)).not.toContain('limited to the owner account');
      const parsed = JSON.parse(toolResults[0].content);
      expect(parsed.configured).toBe(false);
      // Codex r1 on #5275, P2: an unconfigured integration is a refusal,
      // never a confirmation card that could only fail on Confirm.
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
      expect((await res.json()).pendingActions || []).toHaveLength(0);
    });
  });

  // Codex r1 on #5275, P1: assign_sentry_issue takes an account email and its
  // scope is 'none' (not a PII tool) — the legacy path must still log field
  // names only for every outside write.
  test('outside-write tool inputs are logged as field names only (assignee email never reaches logs)', async () => {
    const logger = require('../services/logger');
    await withServer(async (baseUrl) => {
      mockMessagesCreate
        .mockResolvedValueOnce(toolUseTurn('assign_sentry_issue', { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'someone@example.com' }))
        .mockResolvedValueOnce(finalTextTurn());
      await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: 'customers', prompt: 'assign that sentry issue' }),
      });
      const call = logger.info.mock.calls.find(([msg]) => String(msg).includes('Tool call: assign_sentry_issue'));
      expect(call).toBeDefined();
      expect(call[1]).toEqual({ fields: ['issue_short_id', 'assignee'], confirmed: false });
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain('someone@example.com');
    });
  });

  // Codex r3 P1 on #5275: a github-ops no-op refusal embeds the PR title in
  // `error`, and that string used to reach tool_health_events.error_message
  // verbatim via recordToolEvent. github-ops-tools loads for REAL here (not
  // stubbed above), so this exercises the actual no-op refusal path.
  test('an outside-write no-op refusal (no failed checks to rerun) redacts the tool_health_events copy but keeps the operator-visible message', async () => {
    const savedToken = process.env.GITHUB_TOKEN;
    const savedFetch = global.fetch;
    process.env.GITHUB_TOKEN = 'ghp_x';
    let githubCall = 0;
    const githubResponses = [
      { ok: true, status: 200, json: async () => ({ number: 5230, title: 'Secret PR title that must not reach tool_health_events', head: { sha: 'abc123def456' } }) },
      { ok: true, status: 200, json: async () => ({ check_runs: [{ name: 'tests', status: 'completed', conclusion: 'success', id: 111 }] }) },
    ];
    // Only the GitHub API calls are faked; the outer request below to this
    // test's own local server must still reach the real fetch.
    global.fetch = jest.fn((url, opts) => (
      String(url).includes('api.github.com') ? Promise.resolve(githubResponses[githubCall++]) : savedFetch(url, opts)
    ));
    try {
      await withServer(async (baseUrl) => {
        mockMessagesCreate
          .mockResolvedValueOnce(toolUseTurn('rerun_failed_github_checks', { pr_number: 5230 }))
          .mockResolvedValueOnce(finalTextTurn());

        const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: 'customers', prompt: 'rerun the failed checks on PR 5230' }),
        });
        expect(res.status).toBe(200);

        // The operator (and the model) still see the full, useful message.
        const secondCall = mockMessagesCreate.mock.calls[1][0];
        const toolResults = secondCall.messages[secondCall.messages.length - 1].content;
        expect(toolResults[0].content).toContain('Secret PR title that must not reach tool_health_events');

        // The health-event sink is redacted instead.
        expect(mockRecordToolEvent).toHaveBeenCalledWith(expect.objectContaining({
          toolName: 'rerun_failed_github_checks',
          success: false,
          errorMessage: expect.stringMatching(/redacted/),
        }));
        const healthCall = mockRecordToolEvent.mock.calls.find(([c]) => c.toolName === 'rerun_failed_github_checks');
        expect(healthCall[0].errorMessage).not.toContain('Secret PR title');
      });
    } finally {
      global.fetch = savedFetch;
      if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = savedToken;
    }
  });

  test('the owner-only refusal also covers every other outside-write tool name', async () => {
    await withServer(async (baseUrl) => {
      for (const name of ['purge_cloudflare_cache', 'redeploy_railway_service', 'rerun_failed_github_checks', 'set_railway_gate', 'set_growthbook_feature_environment']) {
        mockMessagesCreate
          .mockResolvedValueOnce(toolUseTurn(name, { zone_name: 'wavespestcontrol.com', service_name: 'portal', pr_number: 1 }))
          .mockResolvedValueOnce(finalTextTurn());

        const res = await fetch(`${baseUrl}/admin/intelligence-bar/query`, {
          method: 'POST',
          headers: { Authorization: 'Bearer otheradmin', 'Content-Type': 'application/json' },
          body: JSON.stringify({ context: 'customers', prompt: 'do it' }),
        });
        expect(res.status).toBe(200);
        const secondCall = mockMessagesCreate.mock.calls[mockMessagesCreate.mock.calls.length - 1][0];
        const toolResults = secondCall.messages[secondCall.messages.length - 1].content;
        expect(toolResults[0].is_error).toBe(true);
        expect(toolResults[0].content).toContain('This action is limited to the owner account.');
      }
      expect(mockCreatePendingAction).not.toHaveBeenCalled();
    });
  });
});
