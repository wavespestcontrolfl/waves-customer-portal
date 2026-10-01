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
    { name: 'submit_gsc_sitemap', input_schema: { type: 'object', properties: {} } },
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

  // Codex r4 on #5275: the global infra prompt advertises the sitemap submit
  // with the other outside-service writes, so it must be offered everywhere
  // they are — and never twice on the seo page (duplicate names are rejected).
  test('the full-access login is offered submit_gsc_sitemap on non-SEO pages, exactly once on the seo page', () => {
    expect(names(getToolsForContext('customers', true, true))).toContain('submit_gsc_sitemap');
    const seo = names(getToolsForContext('seo', true, true));
    expect(seo.filter((n) => n === 'submit_gsc_sitemap')).toHaveLength(1);
    expect(new Set(seo).size).toBe(seo.length);
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

// Outside-service writes (IB scope expansion item 1, owner ruling
// 2026-09-28): Sentry/Cloudflare/Railway/GitHub/Search Console write tools
// are yellow-tier (a card, via WRITE_TWO_STEP_TOOL_NAMES) but STILL
// full-access-only, unlike every other yellow-tier tool. These modules are
// NOT mocked above (sentry/cloudflare/ops/github-ops-tools load for real),
// so this exercises the actual INFRA_TOOLS the route composes, on a context
// with no per-module fullAccess-aware export to fall back on (unlike SEO/
// banking's own QUERY_TOOLS) — getToolsForContext's own filter is the ONLY
// thing keeping these off a non-full-access list.
const OUTSIDE_WRITE_NAMES = [
  'resolve_sentry_issue', 'ignore_sentry_issue', 'assign_sentry_issue',
  'purge_cloudflare_cache', 'retry_cloudflare_pages_build',
  'redeploy_railway_service', 'restart_railway_service',
  'rerun_failed_github_checks', 'add_github_pr_label', 'request_codex_review',
];
const OUTSIDE_READ_MARKERS = ['get_sentry_top_issues', 'get_cloudflare_zones', 'get_railway_status', 'get_recent_merged_prs'];

describe('Intelligence Bar tool offering — outside-service writes (owner ruling 2026-09-28)', () => {
  test('an ordinary admin (full access = false) sees the infra READS but none of the outside-write tools', () => {
    const offered = names(getToolsForContext('customers', true, false));
    for (const readName of OUTSIDE_READ_MARKERS) expect(offered).toContain(readName);
    for (const writeName of OUTSIDE_WRITE_NAMES) expect(offered).not.toContain(writeName);
  });

  test('the full-access login sees every outside-write tool, alongside the reads', () => {
    const offered = names(getToolsForContext('customers', true, true));
    for (const readName of OUTSIDE_READ_MARKERS) expect(offered).toContain(readName);
    for (const writeName of OUTSIDE_WRITE_NAMES) expect(offered).toContain(writeName);
  });

  test('a technician (isAdmin=false) never sees an outside-write tool regardless of the fullAccess flag', () => {
    const offered = names(getToolsForContext('tech', false, true));
    for (const writeName of OUTSIDE_WRITE_NAMES) expect(offered).not.toContain(writeName);
  });

  test('submit_gsc_sitemap follows the same full-access rule as the other outside writes, on every page', () => {
    expect(names(getToolsForContext('customers', true, false))).not.toContain('submit_gsc_sitemap');
    expect(names(getToolsForContext('seo', true, false))).not.toContain('submit_gsc_sitemap');
    expect(names(getToolsForContext('tech', false, true))).not.toContain('submit_gsc_sitemap');
  });
});
