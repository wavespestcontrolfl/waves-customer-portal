/**
 * Owner ruling 2026-09-28 (Intelligence Bar full-access model): red-tier
 * (confirmed-endpoint) tools are absent from the tool list offered to the
 * model for any admin request without full access, and present only for
 * the full-access (contact@wavespestcontrol.com, or IB_FULL_ACCESS_EMAILS)
 * login. Either way, execution from the model loop still requires the
 * owner-only /execute confirm flow (unchanged, covered by
 * intelligence-bar-write-gate-contract.test.js and the /execute guard
 * tests in admin-intelligence-bar-banking.test.js /
 * admin-intelligence-bar-dashboard.test.js) — this suite covers OFFERING
 * only, via the route's own getToolsForContext.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

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
jest.mock('../services/intelligence-bar/seo-tools', () => ({
  SEO_TOOLS: [
    { name: 'get_seo_rankings', input_schema: { type: 'object', properties: {} } },
    { name: 'run_seo_pipeline', input_schema: { type: 'object', properties: {} } },
    { name: 'approve_seo_action', input_schema: { type: 'object', properties: {} } },
  ],
  executeSeoTool: jest.fn(),
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
  BANKING_TOOLS: [
    { name: 'get_stripe_balance', input_schema: { type: 'object', properties: {} } },
    { name: 'request_instant_payout', input_schema: { type: 'object', properties: {} } },
    { name: 'request_standard_payout', input_schema: { type: 'object', properties: {} } },
    { name: 'cancel_pending_payout', input_schema: { type: 'object', properties: {} } },
  ],
  BANKING_QUERY_TOOLS: [
    { name: 'get_stripe_balance', input_schema: { type: 'object', properties: {} } },
  ],
  executeBankingTool: jest.fn(),
}));

const { getToolsForContext } = require('../routes/admin-intelligence-bar');

const RED_TIER_NAMES = ['run_seo_pipeline', 'approve_seo_action', 'request_instant_payout', 'request_standard_payout', 'cancel_pending_payout'];

function names(tools) {
  return tools.map((t) => t.name);
}

describe('Intelligence Bar tool offering — full access (owner ruling 2026-09-28)', () => {
  test('an ordinary admin (full access = false) never sees red-tier SEO tools', () => {
    const offered = names(getToolsForContext('seo', true, false));
    expect(offered).toContain('get_seo_rankings');
    for (const redName of ['run_seo_pipeline', 'approve_seo_action']) {
      expect(offered).not.toContain(redName);
    }
  });

  test('the full-access login DOES see red-tier SEO tools in the offered list', () => {
    const offered = names(getToolsForContext('seo', true, true));
    expect(offered).toContain('get_seo_rankings');
    expect(offered).toContain('run_seo_pipeline');
    expect(offered).toContain('approve_seo_action');
  });

  test('an ordinary admin (full access = false) never sees red-tier banking tools', () => {
    const offered = names(getToolsForContext('banking', true, false));
    expect(offered).toContain('get_stripe_balance');
    for (const redName of ['request_instant_payout', 'request_standard_payout', 'cancel_pending_payout']) {
      expect(offered).not.toContain(redName);
    }
  });

  test('the full-access login DOES see red-tier banking tools in the offered list', () => {
    const offered = names(getToolsForContext('banking', true, true));
    expect(offered).toContain('get_stripe_balance');
    expect(offered).toContain('request_instant_payout');
    expect(offered).toContain('request_standard_payout');
    expect(offered).toContain('cancel_pending_payout');
  });

  test('a technician (isAdmin=false) never sees any red-tier tool regardless of the fullAccess flag', () => {
    // The route always resolves isAdmin from req.techRole and pins
    // technicians to the isolated tech context before this is ever called
    // with fullAccess=true, but the function itself must fail closed too.
    const offered = names(getToolsForContext('tech', false, true));
    for (const redName of RED_TIER_NAMES) {
      expect(offered).not.toContain(redName);
    }
  });

  test('no other context ever offers a red-tier tool, full access or not', () => {
    for (const context of ['schedule', 'dashboard', 'procurement', 'revenue', 'reviews', 'comms', 'tax', 'leads', 'email', 'estimates', 'dashboard']) {
      const offeredNoAccess = names(getToolsForContext(context, true, false));
      const offeredFullAccess = names(getToolsForContext(context, true, true));
      for (const redName of RED_TIER_NAMES) {
        expect(offeredNoAccess).not.toContain(redName);
        expect(offeredFullAccess).not.toContain(redName);
      }
    }
  });
});
