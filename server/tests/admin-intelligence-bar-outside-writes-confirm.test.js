/**
 * Outside-service writes — /confirm-action end to end (IB scope expansion
 * item 1 commit path). The route re-runs each tool's mutation-free preview,
 * refuses unless its fingerprint still matches the card, and only then
 * threads the live preview's resolved ids into the executor as `_verified_*`
 * pins. Every one of the 11 tools is driven through the REAL route + REAL
 * executor here, with only the third-party HTTP (and the Search Console
 * service) mocked, for the three outcomes that matter:
 *
 *   - confirm success: exactly one write, on the id the card showed
 *   - target changed between card and confirm: 409 preview_changed, NO write
 *   - read-only token: 200 success:false code write_access_required
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.ANTHROPIC_API_KEY = 'test-key';

const mockClaimForConfirm = jest.fn();
const mockRecordResult = jest.fn();
const mockResolveAccessibleProperty = jest.fn();
const mockSubmitSitemap = jest.fn();

jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: jest.fn() } })));
jest.mock('../models/db', () => jest.fn(() => ({ insert: async () => undefined, select: async () => [] })));
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
jest.mock('../services/seo/search-console-v2', () => ({
  resolveAccessibleProperty: (...args) => mockResolveAccessibleProperty(...args),
  submitSitemap: (...args) => mockSubmitSitemap(...args),
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
const { executeSentryOpsTool } = require('../services/intelligence-bar/sentry-ops-tools');
const { executeCloudflareOpsTool } = require('../services/intelligence-bar/cloudflare-ops-tools');
const { executeOpsTool } = require('../services/intelligence-bar/ops-tools');
const { executeGithubOpsTool } = require('../services/intelligence-bar/github-ops-tools');
const { executeSeoTool } = require('../services/intelligence-bar/seo-tools');
const { executeGrowthbookTool } = require('../services/intelligence-bar/growthbook-tools');
const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');

const PENDING_ID = '7e1c2f7a-1111-2222-3333-deadbeef0009';
const realFetch = global.fetch;

function jsonRes(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// ── per-service fixtures; `drift` swaps in the "changed after the card" world ──
const sentryIssue = (drift) => ({
  id: '111', shortId: 'WAVES-PORTAL-1A', level: 'error', status: 'unresolved',
  title: drift ? 'A different title now' : 'TypeError: cannot read properties of undefined',
  culprit: 'server/routes/x.js', permalink: 'https://sentry.io/organizations/waves/issues/111/',
});
const sentryMember = { id: 'member-1', email: 'adam@wavespestcontrol.com', name: 'Adam Benetti', user: { id: 'user-1', username: 'adam', name: 'Adam Benetti' } };
const cfZones = (drift) => ({ success: true, result: [{ id: drift ? 'zone-9' : 'zone-1', name: 'wavespestcontrol.com', status: 'active', paused: false }] });
const cfProjects = (drift) => ({
  success: true,
  result: [{ name: 'spoke-venice', latest_deployment: { id: drift ? 'dep-999' : 'dep-111', created_on: '2026-09-28T12:00:00Z', latest_stage: { name: 'deploy', status: 'failure' }, deployment_trigger: { metadata: { branch: 'main' } } } }],
});
const railwayEnv = (drift) => ({
  data: { environment: { id: 'env-1', name: 'production', serviceInstances: { edges: [{ node: { serviceId: 's1', serviceName: 'portal', latestDeployment: { id: drift ? 'd2' : 'd1', status: 'SUCCESS', createdAt: '2026-07-11T10:00:00Z' } } }] } } },
});
const ghPr = (drift) => ({ number: 5230, title: drift ? 'Retitled PR' : 'Synthetic PR', head: { sha: 'abc123def456' }, labels: [{ name: 'existing-label' }] });
const FULL_SHA = 'abc123def456aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
// Feature switches: the gate's live value (drift = changed in Railway after
// the card) beside another variable whose value must never leave the module.
const railwayVars = (drift) => ({ data: { variables: { GATE_STAMPED_ZERO_FREE: drift ? 'weird-value' : 'false', STRIPE_SECRET_KEY: 'sk_live_NEVER' } } });
const gbFeature = (drift) => ({
  feature: {
    id: 'pricing-hub', archived: false, valueType: 'boolean', defaultValue: 'false',
    dateUpdated: drift ? '2026-10-01T09:00:00.000Z' : '2026-09-01T12:00:00.000Z', revision: { version: 7 },
    environments: { production: { enabled: false, defaultValue: 'false', rules: [] } },
  },
});

// Each case: how to preview it, which fetch answers what, what the ONE write
// must look like, and how a permission failure is delivered.
const CASES = [
  {
    tool: 'resolve_sentry_issue', run: executeSentryOpsTool, input: { issue_short_id: 'WAVES-PORTAL-1A' },
    env: { SENTRY_API_TOKEN: 't' },
    read: (u, drift) => (/\/issues\/$/.test(u.pathname) ? jsonRes([sentryIssue(drift)]) : null),
    isWrite: (u, i) => i.method === 'PUT',
    check: (u, i) => { expect(u.pathname).toMatch(/\/issues\/111\/$/); expect(JSON.parse(i.body)).toEqual({ status: 'resolved' }); },
  },
  {
    tool: 'ignore_sentry_issue', run: executeSentryOpsTool, input: { issue_short_id: 'WAVES-PORTAL-1A' },
    env: { SENTRY_API_TOKEN: 't' },
    read: (u, drift) => (/\/issues\/$/.test(u.pathname) ? jsonRes([sentryIssue(drift)]) : null),
    isWrite: (u, i) => i.method === 'PUT',
    check: (u, i) => { expect(u.pathname).toMatch(/\/issues\/111\/$/); expect(JSON.parse(i.body)).toEqual({ status: 'ignored' }); },
  },
  {
    tool: 'assign_sentry_issue', run: executeSentryOpsTool, input: { issue_short_id: 'WAVES-PORTAL-1A', assignee: 'adam' },
    env: { SENTRY_API_TOKEN: 't' },
    read: (u, drift) => (/\/issues\/$/.test(u.pathname) ? jsonRes([sentryIssue(drift)]) : /\/members\/$/.test(u.pathname) ? jsonRes([sentryMember]) : null),
    isWrite: (u, i) => i.method === 'PUT',
    check: (u, i) => { expect(u.pathname).toMatch(/\/issues\/111\/$/); expect(JSON.parse(i.body)).toEqual({ assignedTo: 'user:user-1' }); },
  },
  {
    tool: 'purge_cloudflare_cache', run: executeCloudflareOpsTool, input: { zone_name: 'wavespestcontrol.com' },
    env: { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acct-1' },
    read: (u, drift) => (u.pathname.endsWith('/zones') ? jsonRes(cfZones(drift)) : null),
    isWrite: (u, i) => i.method === 'POST',
    check: (u, i) => { expect(u.pathname).toMatch(/\/zones\/zone-1\/purge_cache$/); expect(JSON.parse(i.body)).toEqual({ purge_everything: true }); },
    deniedBody: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
  },
  {
    tool: 'retry_cloudflare_pages_build', run: executeCloudflareOpsTool, input: { project_name: 'spoke-venice' },
    env: { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acct-1' },
    read: (u, drift) => (u.pathname.endsWith('/pages/projects') ? jsonRes(cfProjects(drift)) : null),
    isWrite: (u, i) => i.method === 'POST',
    check: (u) => { expect(u.pathname).toMatch(/\/pages\/projects\/spoke-venice\/deployments\/dep-111\/retry$/); },
    deniedBody: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] },
  },
  {
    tool: 'redeploy_railway_service', run: executeOpsTool, input: { service_name: 'portal' },
    env: { RAILWAY_TOKEN: 't', RAILWAY_PROJECT_ID: 'proj-1', RAILWAY_ENVIRONMENT_ID: 'env-1' },
    read: (u, drift, i) => (!String(i.body || '').includes('mutation') ? jsonRes(railwayEnv(drift)) : null),
    isWrite: (u, i) => String(i.body || '').includes('mutation'),
    check: (u, i) => { const b = JSON.parse(i.body); expect(b.query).toContain('serviceInstanceRedeploy'); expect(b.variables).toEqual({ serviceId: 's1', environmentId: 'env-1' }); },
  },
  {
    tool: 'restart_railway_service', run: executeOpsTool, input: { service_name: 'portal' },
    env: { RAILWAY_TOKEN: 't', RAILWAY_PROJECT_ID: 'proj-1', RAILWAY_ENVIRONMENT_ID: 'env-1' },
    read: (u, drift, i) => (!String(i.body || '').includes('mutation') ? jsonRes(railwayEnv(drift)) : null),
    isWrite: (u, i) => String(i.body || '').includes('mutation'),
    check: (u, i) => { const b = JSON.parse(i.body); expect(b.query).toContain('deploymentRestart'); expect(b.variables).toEqual({ id: 'd1' }); },
  },
  {
    tool: 'rerun_failed_github_checks', run: executeGithubOpsTool, input: { pr_number: 5230 },
    env: { GITHUB_TOKEN: 't' },
    read: (u, drift) => {
      if (u.pathname.endsWith('/pulls/5230')) return jsonRes(ghPr(drift));
      if (u.pathname.endsWith('/check-runs')) return jsonRes({ check_runs: [{ name: 'tests', status: 'completed', conclusion: 'failure', id: 1, app: { slug: 'github-actions' } }] });
      if (u.pathname.endsWith('/actions/runs')) return jsonRes({ workflow_runs: [{ id: drift ? 777 : 999888, name: 'CI', status: 'completed', conclusion: 'failure' }] });
      if (/\/actions\/runs\/\d+$/.test(u.pathname)) return jsonRes({ id: 999888, head_sha: FULL_SHA, status: 'completed', conclusion: 'failure' });
      return null;
    },
    isWrite: (u, i) => i.method === 'POST',
    check: (u) => { expect(u.pathname).toMatch(/\/actions\/runs\/999888\/rerun-failed-jobs$/); },
  },
  {
    tool: 'add_github_pr_label', run: executeGithubOpsTool, input: { pr_number: 5230, label: 'needs-review' },
    env: { GITHUB_TOKEN: 't' },
    read: (u, drift) => (u.pathname.endsWith('/pulls/5230') ? jsonRes(ghPr(drift)) : u.pathname.endsWith('/labels') ? jsonRes([{ name: 'needs-review' }]) : null),
    isWrite: (u, i) => i.method === 'POST',
    check: (u, i) => { expect(u.pathname).toMatch(/\/issues\/5230\/labels$/); expect(JSON.parse(i.body)).toEqual({ labels: ['needs-review'] }); },
  },
  {
    tool: 'request_codex_review', run: executeGithubOpsTool, input: { pr_number: 5230 },
    env: { GITHUB_TOKEN: 't' },
    read: (u, drift) => (u.pathname.endsWith('/pulls/5230') ? jsonRes(ghPr(drift)) : null),
    isWrite: (u, i) => i.method === 'POST',
    check: (u, i) => { expect(u.pathname).toMatch(/\/issues\/5230\/comments$/); expect(JSON.parse(i.body)).toEqual({ body: '@codex review' }); },
  },
  {
    tool: 'set_railway_gate', run: executeOpsTool, input: { gate_name: 'GATE_STAMPED_ZERO_FREE', value: 'true' },
    env: { RAILWAY_TOKEN: 't', RAILWAY_PROJECT_ID: 'proj-1', RAILWAY_ENVIRONMENT_ID: 'env-1', RAILWAY_SERVICE_ID: 's1' },
    read: (u, drift, i) => {
      const body = String(i.body || '');
      if (body.includes('mutation')) return null;
      return jsonRes(body.includes('variables(') ? railwayVars(drift) : railwayEnv(false));
    },
    isWrite: (u, i) => String(i.body || '').includes('mutation'),
    check: (u, i) => {
      const b = JSON.parse(i.body);
      expect(b.query).toContain('variableUpsert');
      expect(b.variables).toEqual({ input: { projectId: 'proj-1', environmentId: 'env-1', serviceId: 's1', name: 'GATE_STAMPED_ZERO_FREE', value: 'true' } });
    },
  },
  {
    tool: 'set_growthbook_feature_environment', run: executeGrowthbookTool, input: { feature_id: 'pricing-hub', enabled: true },
    env: { GROWTHBOOK_API_KEY: 'secret_test' },
    read: (u, drift) => (u.pathname === '/api/v1/features/pricing-hub' ? jsonRes(gbFeature(drift)) : null),
    isWrite: (u, i) => i.method === 'POST',
    check: (u, i) => {
      expect(u.pathname).toBe('/api/v2/features/pricing-hub/toggle');
      expect(JSON.parse(i.body).environments).toEqual({ production: true });
    },
  },
];

let drift;
let writes;
let denyWrites;
const savedEnv = {};

function installFetch(testCase) {
  global.fetch = jest.fn((url, init = {}) => {
    const u = new URL(String(url));
    if (u.hostname === '127.0.0.1') return realFetch(url, init);
    if (testCase.isWrite(u, init)) {
      writes.push([u, init]);
      return Promise.resolve(denyWrites ? jsonRes(testCase.deniedBody || { message: 'Forbidden' }, 403) : jsonRes({ success: true, result: { id: 'new-1' } }));
    }
    const read = testCase.read(u, drift, init);
    if (!read) return Promise.resolve(jsonRes({ message: `unexpected read ${u.pathname}` }, 500));
    return Promise.resolve(read);
  });
}

function appServer() {
  const app = express();
  app.use(express.json());
  app.use('/admin/intelligence-bar', intelligenceRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

async function confirm(params, token = 'admin') {
  const { server, baseUrl } = appServer();
  try {
    const res = await realFetch(`${baseUrl}/admin/intelligence-bar/confirm-action`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pending_action_id: PENDING_ID }),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function claimFor(toolName, input, previewFn) {
  // Freeze the card: the fingerprint /query would have stored at proposal time.
  drift = false;
  const preview = await previewFn(toolName, { ...input, confirmed: false });
  expect(preview.preview).toBe(true);
  mockClaimForConfirm.mockResolvedValue({
    action: { id: PENDING_ID, tool_name: toolName, params: { ...input, _two_step_preview_fingerprint: previewFingerprint(preview) } },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  drift = false;
  writes = [];
  denyWrites = false;
});

afterEach(() => {
  global.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

function setEnv(env) {
  for (const [k, v] of Object.entries(env)) { if (!(k in savedEnv)) savedEnv[k] = process.env[k]; process.env[k] = v; }
}

describe.each(CASES)('/confirm-action commits $tool', (testCase) => {
  beforeEach(() => { setEnv(testCase.env); installFetch(testCase); });

  test('confirm success: exactly one write, on the id the card showed', async () => {
    await claimFor(testCase.tool, testCase.input, testCase.run);
    const { status, body } = await confirm();
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.outcome).toBe('completed');
    expect(writes).toHaveLength(1);
    testCase.check(...writes[0]);
  });

  test('target changed between card and confirm: 409 preview_changed and NO write', async () => {
    await claimFor(testCase.tool, testCase.input, testCase.run);
    drift = true;
    const { status, body } = await confirm();
    expect(status).toBe(409);
    expect(body.preview_changed).toBe(true);
    expect(writes).toHaveLength(0);
  });

  test('read-only token: clear write-access result, success false, nothing reported as done', async () => {
    await claimFor(testCase.tool, testCase.input, testCase.run);
    denyWrites = true;
    const { status, body } = await confirm();
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.outcome).toBe('failed');
    expect(body.result.code).toBe('write_access_required');
    expect(body.result.error).toMatch(/read-only|cannot deploy|needs write access|cannot make this change|cannot change flags/i);
    expect(writes).toHaveLength(1); // the single attempt that was refused
  });

  test('a non-owner admin cannot commit it (defense in depth), no write', async () => {
    await claimFor(testCase.tool, testCase.input, testCase.run);
    const { status } = await confirm({}, 'otheradmin');
    expect(status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});

describe('/confirm-action commits submit_gsc_sitemap', () => {
  const input = { domain: 'wavespestcontrol.com' };
  const run = (name, i) => executeSeoTool(name, i);

  beforeEach(() => {
    setEnv({ GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"service_account"}' });
    mockResolveAccessibleProperty.mockImplementation(async () => ({
      siteUrl: drift ? 'sc-domain:wavespestcontrol.com' : 'https://wavespestcontrol.com/', permissionLevel: 'siteOwner',
    }));
    mockSubmitSitemap.mockResolvedValue({ ok: true });
  });

  test('confirm success: submits the property + sitemap URL the card showed, once', async () => {
    await claimFor('submit_gsc_sitemap', input, run);
    const { status, body } = await confirm();
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockSubmitSitemap).toHaveBeenCalledTimes(1);
    expect(mockSubmitSitemap).toHaveBeenCalledWith('https://wavespestcontrol.com/', 'https://wavespestcontrol.com/sitemap-index.xml');
  });

  test('property changed between card and confirm: 409 preview_changed and NOTHING submitted', async () => {
    await claimFor('submit_gsc_sitemap', input, run);
    drift = true;
    const { status, body } = await confirm();
    expect(status).toBe(409);
    expect(body.preview_changed).toBe(true);
    expect(mockSubmitSitemap).not.toHaveBeenCalled();
  });

  test('read-only service account: clear write-access result, success false', async () => {
    await claimFor('submit_gsc_sitemap', input, run);
    mockSubmitSitemap.mockResolvedValue({ error: 'The Search Console service account has read access only — it must be a Full user (or owner) of this property to submit sitemaps.', writeAccessRequired: true });
    const { status, body } = await confirm();
    expect(status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.result.code).toBe('write_access_required');
    expect(body.result.error).toMatch(/Full user/);
  });
});

describe('inbound forged pins never reach an outside-write executor', () => {
  test('a stored _verified_* param is stripped; the pin comes only from the live preview', async () => {
    const testCase = CASES[0]; // resolve_sentry_issue
    setEnv(testCase.env);
    installFetch(testCase);
    await claimFor(testCase.tool, testCase.input, testCase.run);
    const { action } = await mockClaimForConfirm();
    action.params._verified_sentry_issue_id = '999-forged';
    const { status } = await confirm();
    expect(status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0][0].pathname).toMatch(/\/issues\/111\/$/);
    expect(writes[0][0].pathname).not.toContain('forged');
  });
});

// Feature switches: a forged pin in the stored params never reaches the
// executor — the gate name and value come only from the live preview.
test('set_railway_gate: a stored forged gate pin is stripped; the write uses the live preview', async () => {
  const testCase = CASES.find((c) => c.tool === 'set_railway_gate');
  setEnv(testCase.env);
  installFetch(testCase);
  await claimFor(testCase.tool, testCase.input, testCase.run);
  const { action } = await mockClaimForConfirm();
  action.params._verified_railway_gate_name = 'GATE_FORGED_OTHER';
  action.params._verified_railway_gate_value = 'false';
  const { status } = await confirm();
  expect(status).toBe(200);
  expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1].body).variables.input).toMatchObject({ name: 'GATE_STAMPED_ZERO_FREE', value: 'true' });
});
