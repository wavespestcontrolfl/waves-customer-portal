/**
 * Cloudflare ops tools — unit tests with a mocked Cloudflare API.
 * Verifies the read-only contract: benign shape when unconfigured (must not
 * trip the shared admin breaker), zone/Pages mapping, edge-error math, and
 * that every failure surfaces as { error } instead of throwing.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const CF_ENV_KEYS = ['CF_API_TOKEN', 'CF_ACCOUNT_ID', 'CF_API_BASE'];

const savedEnv = {};
let executeCloudflareOpsTool;

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeAll(() => {
  for (const key of CF_ENV_KEYS) savedEnv[key] = process.env[key];
});

afterAll(() => {
  for (const key of CF_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  jest.resetModules();
  for (const key of CF_ENV_KEYS) delete process.env[key];
  global.fetch = jest.fn();
  ({ executeCloudflareOpsTool } = require('../services/intelligence-bar/cloudflare-ops-tools'));
});

describe('intelligence bar Cloudflare ops tools', () => {
  test('unconfigured state is benign — no error field and no network call', async () => {
    const result = await executeCloudflareOpsTool('get_cloudflare_zones', {});
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(result.message).toMatch(/CF_API_TOKEN/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('unknown tool name returns an error result', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    const result = await executeCloudflareOpsTool('purge_cache', {});
    expect(result.error).toMatch(/Unknown tool/);
  });

  test('get_cloudflare_zones maps status and filters by name', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [
        { name: 'wavespestcontrol.com', status: 'active', paused: false },
        { name: 'bradentonpestcontrol.com', status: 'active', paused: true },
      ],
    }));

    const result = await executeCloudflareOpsTool('get_cloudflare_zones', { zone_name: 'bradenton' });
    expect(result.error).toBeUndefined();
    expect(result.zones).toEqual([
      { zone: 'bradentonpestcontrol.com', status: 'active', paused: true },
    ]);
  });

  test('get_cloudflare_pages_builds requires CF_ACCOUNT_ID and counts failures', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    let result = await executeCloudflareOpsTool('get_cloudflare_pages_builds', {});
    expect(result.error).toMatch(/CF_ACCOUNT_ID/);

    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [
        {
          name: 'wavespestcontrol-astro',
          latest_deployment: {
            latest_stage: { name: 'deploy', status: 'success' },
            deployment_trigger: { metadata: { branch: 'main' } },
            created_on: '2026-07-11T10:00:00Z',
          },
        },
        { name: 'spoke-venice', latest_deployment: { latest_stage: { name: 'build', status: 'failure' }, created_on: '2026-07-11T09:00:00Z' } },
        { name: 'spoke-parrish', latest_deployment: null },
      ],
    }));

    result = await executeCloudflareOpsTool('get_cloudflare_pages_builds', {});
    expect(result.error).toBeUndefined();
    expect(result.total).toBe(3);
    expect(result.failing_builds).toBe(1);
    expect(result.projects[0]).toEqual({
      project: 'wavespestcontrol-astro',
      latest_stage: 'deploy',
      latest_status: 'success',
      branch: 'main',
      deployed_at: '2026-07-11T10:00:00Z',
    });
    expect(result.projects[2].latest_status).toBe('NONE');
  });

  test('get_cloudflare_edge_errors resolves the zone then computes the rate', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [{ id: 'zone-1', name: 'wavespestcontrol.com' }] }))
      .mockResolvedValueOnce(jsonResponse({
        data: { viewer: { zones: [{ total: [{ count: 2000 }], errors: [{ count: 15 }] }] } },
      }));

    const result = await executeCloudflareOpsTool('get_cloudflare_edge_errors', { zone_name: 'wavespestcontrol.com', minutes: 60 });
    expect(result.error).toBeUndefined();
    expect(result.requests).toBe(2000);
    expect(result.edge_5xx).toBe(15);
    expect(result.error_rate_pct).toBe(0.75);
  });

  test('get_cloudflare_edge_errors with an unknown zone returns an error result', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true, result: [] }));

    const result = await executeCloudflareOpsTool('get_cloudflare_edge_errors', { zone_name: 'nope.com' });
    expect(result.error).toMatch(/No Cloudflare zone/);
  });

  test('permission rejection surfaces a scope hint as { error }, never a throw', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 403));

    const result = await executeCloudflareOpsTool('get_cloudflare_zones', {});
    expect(result.error).toMatch(/scope/);
  });
});

// Outside-write tools (IB scope expansion item 1, owner ruling 2026-09-28):
// full-access gating lives in the ROUTE (getToolsForContext,
// intelligence-bar-full-access-tool-offering.test.js), not here — these
// tests cover the module contract: missing-token refusal (already exercised
// above for the read tools, shared by these), a human-readable preview
// naming the real zone/project, and the commit path's refusal.
describe('intelligence bar Cloudflare write tools (preview only)', () => {
  test('purge_cloudflare_cache: unconfigured state is benign, no network call', async () => {
    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'wavespestcontrol.com' });
    expect(result.error).toBeUndefined();
    expect(result.configured).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  // Codex r5 on #5275: an unmatched target (possibly customer text) reaches
  // the operator's refusal, never the module error log.
  test('purge_cloudflare_cache: an unmatched zone name is refused without logging the raw target', async () => {
    const logger = require('../services/logger');
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true, result: [{ id: 'zone-1', name: 'wavespestcontrol.com', status: 'active', paused: false }] }));
    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'Synthia Tester 12 Elm St' });
    expect(result.error).toMatch(/Synthia Tester 12 Elm St/);
    expect(JSON.stringify(logger.error.mock.calls)).not.toMatch(/Synthia Tester/);
  });

  test('purge_cloudflare_cache: unconfirmed builds a preview naming the real zone by its pinned id, never purges', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true, result: [{ id: 'zone-1', name: 'wavespestcontrol.com', status: 'active', paused: false }] }));

    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'wavespestcontrol.com' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    // The pinned canonical identity (id + exact name), not just the name.
    expect(result.zone).toEqual({ id: 'zone-1', zone: 'wavespestcontrol.com', status: 'active', paused: false });
    expect(result.note).toContain('wavespestcontrol.com');
  });

  test('purge_cloudflare_cache: a substring is never enough — it never picks a zone that merely contains the input', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [
        { id: 'zone-1', name: 'bradentonflpestcontrol.com', status: 'active', paused: false },
        { id: 'zone-2', name: 'bradenton-lawn-care.com', status: 'active', paused: false },
      ],
    }));

    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'bradenton' });
    expect(result.error).toMatch(/No Cloudflare zone found exactly named "bradenton"/);
    // Suggests the near matches — never silently picks one.
    expect(result.error).toContain('bradentonflpestcontrol.com');
    expect(result.error).toContain('bradenton-lawn-care.com');
  });

  test('purge_cloudflare_cache: wildcard characters in the input are literal, never widen the match', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [
        { id: 'zone-1', name: 'wavespestcontrol.com', status: 'active', paused: false },
        { id: 'zone-2', name: 'bradentonflpestcontrol.com', status: 'active', paused: false },
      ],
    }));

    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: '%.com' });
    expect(result.error).toMatch(/No Cloudflare zone found exactly named "%\.com"/);
  });

  test('purge_cloudflare_cache: several zones exactly named the same thing is a refusal, never an arbitrary pick', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [
        { id: 'zone-1', name: 'wavespestcontrol.com', status: 'active', paused: false },
        { id: 'zone-2', name: 'WavesPestControl.com', status: 'active', paused: false },
      ],
    }));

    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'wavespestcontrol.com' });
    expect(result.error).toMatch(/Multiple Cloudflare zones are exactly named/);
  });

  test('retry_cloudflare_pages_build: unconfirmed names the actual project and its current status', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [{
        name: 'spoke-venice',
        latest_deployment: {
          id: 'dep-111',
          latest_stage: { name: 'build', status: 'failure' },
          deployment_trigger: { metadata: { branch: 'main' } },
          created_on: '2026-07-11T09:00:00Z',
        },
      }],
    }));

    const result = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.project).toBe('spoke-venice');
    expect(result.deployment.latest_status).toBe('failure');
    // The pinned exact deployment id — codex r3 P1 on #5275: deployed_at is
    // stripped from the fingerprint as a volatile `_at` field, so this id is
    // the only thing that binds the approval to WHICH deployment.
    expect(result.deployment.id).toBe('dep-111');
    expect(result.note).toContain('spoke-venice');
  });

  // Codex r3 P1 on #5275: deployed_at is volatile (stripped by the
  // fingerprint's `_at`-suffix rule), so a NEW deployment landing between
  // preview and confirm — with the SAME stage/status/branch text — must
  // still be caught as drift. Only the deployment id makes that possible.
  test('retry_cloudflare_pages_build: the preview fingerprint changes when the deployment id changes, even with identical stage/status/branch text', async () => {
    const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    const project = (depId, createdOn) => ({
      success: true,
      result: [{
        name: 'spoke-venice',
        latest_deployment: {
          id: depId,
          latest_stage: { name: 'build', status: 'failure' },
          deployment_trigger: { metadata: { branch: 'main' } },
          created_on: createdOn,
        },
      }],
    });
    global.fetch.mockResolvedValueOnce(jsonResponse(project('dep-111', '2026-07-11T09:00:00Z')));
    const before = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice' });
    // A brand-new failed deployment on the same branch — identical stage,
    // status and branch text, only the id (and the volatile timestamp) differ.
    global.fetch.mockResolvedValueOnce(jsonResponse(project('dep-222', '2026-07-12T09:00:00Z')));
    const after = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice' });
    expect(previewFingerprint(after)).not.toBe(previewFingerprint(before));

    // But a re-fetch of the SAME deployment (only its volatile field would
    // differ, and it doesn't even here) still fingerprints identically.
    global.fetch.mockResolvedValueOnce(jsonResponse(project('dep-111', '2026-07-11T09:00:00Z')));
    const again = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice' });
    expect(previewFingerprint(again)).toBe(previewFingerprint(before));
  });

  test('retry_cloudflare_pages_build: unknown project returns an error result, no confirm', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true, result: [] }));

    const result = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'nope' });
    expect(result.error).toMatch(/No Cloudflare Pages project/);
  });

  test('retry_cloudflare_pages_build: a substring is never enough — it never picks a project that merely contains the input', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [
        { name: 'spoke-venice', latest_deployment: { latest_stage: { status: 'success' } } },
        { name: 'spoke-venice-preview', latest_deployment: { latest_stage: { status: 'success' } } },
      ],
    }));

    const result = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice' });
    // Exact match on 'spoke-venice' exists (the other row only CONTAINS it),
    // so this one still resolves — proves substring rows don't get pulled
    // in as false ambiguity.
    expect(result.error).toBeUndefined();
    expect(result.project).toBe('spoke-venice');
  });

  test('retry_cloudflare_pages_build: wildcard characters in the input are literal, never widen the match', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [{ name: 'spoke-venice', latest_deployment: { latest_stage: { status: 'success' } } }],
    }));

    const result = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-%' });
    expect(result.error).toMatch(/No Cloudflare Pages project found exactly named "spoke-%"/);
  });

  test('retry_cloudflare_pages_build: several projects exactly named the same thing is a refusal', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [
        { name: 'spoke-venice', latest_deployment: null },
        { name: 'Spoke-Venice', latest_deployment: null },
      ],
    }));

    const result = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice' });
    expect(result.error).toMatch(/Multiple Cloudflare Pages projects are exactly named/);
  });

});

describe('intelligence bar Cloudflare write tools (confirmed commit)', () => {
  const { outsideWritePins } = require('../services/intelligence-bar/outside-write-pins');
  const zonesResponse = () => jsonResponse({
    success: true,
    result: [
      { id: 'zone-1', name: 'wavespestcontrol.com', status: 'active', paused: false },
      { id: 'zone-2', name: 'bradentonflpestcontrol.com', status: 'active', paused: false },
    ],
  });
  const projectsResponse = (depId = 'dep-111') => jsonResponse({
    success: true,
    result: [{
      name: 'spoke-venice',
      latest_deployment: {
        id: depId, created_on: '2026-09-28T12:00:00Z',
        latest_stage: { name: 'deploy', status: 'failure' },
        deployment_trigger: { metadata: { branch: 'main' } },
      },
    }],
  });

  test('purge_cloudflare_cache: confirm POSTs purge_everything to the PINNED zone id only', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(zonesResponse());
    const preview = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'wavespestcontrol.com' });
    global.fetch.mockClear();
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true, result: { id: 'zone-1' } }));

    const pins = outsideWritePins('purge_cloudflare_cache', preview);
    expect(pins).toEqual({ _verified_cloudflare_zone_id: 'zone-1' });
    // A confirmed call carrying a DIFFERENT raw zone_name still hits zone-1.
    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'bradentonflpestcontrol.com', ...pins, confirmed: true });
    expect(result).toEqual({ success: true, tool: 'purge_cloudflare_cache', zone_id: 'zone-1' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toMatch(/\/zones\/zone-1\/purge_cache$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ purge_everything: true });
  });

  test('retry_cloudflare_pages_build: confirm retries the PINNED deployment id in the PINNED project', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(projectsResponse('dep-111'));
    const preview = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice' });
    global.fetch.mockClear();
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true, result: { id: 'dep-222' } }));

    const pins = outsideWritePins('retry_cloudflare_pages_build', preview);
    expect(pins).toEqual({ _verified_cloudflare_project_name: 'spoke-venice', _verified_cloudflare_deployment_id: 'dep-111' });
    const result = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'other', ...pins, confirmed: true });
    expect(result).toEqual({
      success: true, tool: 'retry_cloudflare_pages_build', project: 'spoke-venice',
      retried_deployment_id: 'dep-111', new_deployment_id: 'dep-222',
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = global.fetch.mock.calls[0];
    expect(String(url)).toMatch(/\/accounts\/acct-1\/pages\/projects\/spoke-venice\/deployments\/dep-111\/retry$/);
    expect(init.method).toBe('POST');
  });

  test('a newer deployment landing between preview and confirm changes the preview (target-changed) — the pin follows the preview, not "latest"', async () => {
    const { previewFingerprint } = require('../services/intelligence-bar/authorization-contract');
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(projectsResponse('dep-111')).mockResolvedValueOnce(projectsResponse('dep-999'));
    const first = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice' });
    const second = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice' });
    expect(previewFingerprint(first)).not.toBe(previewFingerprint(second));
  });

  test.each([
    ['purge_cloudflare_cache', { zone_name: 'wavespestcontrol.com' }],
    ['retry_cloudflare_pages_build', { project_name: 'spoke-venice' }],
  ])('%s: confirmed without a verified pin refuses and never calls Cloudflare', async (name, input) => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    const result = await executeCloudflareOpsTool(name, { ...input, confirmed: true });
    expect(result.code).toBe('missing_verified_pin');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['purge_cloudflare_cache', { _verified_cloudflare_zone_id: 'zone-1' }],
    ['retry_cloudflare_pages_build', { _verified_cloudflare_project_name: 'spoke-venice', _verified_cloudflare_deployment_id: 'dep-111' }],
  ])('%s: a read-only token (403) returns a clear write-access result and changes nothing', async (name, pins) => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, 403));
    const result = await executeCloudflareOpsTool(name, { zone_name: 'wavespestcontrol.com', project_name: 'spoke-venice', ...pins, confirmed: true });
    expect(result.code).toBe('write_access_required');
    expect(result.error).toMatch(/read-only.*write scope/i);
    expect(result.success).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a 2xx envelope with success:false and an auth error code is also mapped to write access', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'wavespestcontrol.com', _verified_cloudflare_zone_id: 'zone-1', confirmed: true });
    expect(result.code).toBe('write_access_required');
  });

  test('a non-permission failure stays a plain error and the log carries status only', async () => {
    const logger = require('../services/logger');
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({}, 500));
    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'wavespestcontrol.com', _verified_cloudflare_zone_id: 'zone-1', confirmed: true });
    expect(result.error).toMatch(/HTTP 500/);
    expect(result.code).toBeUndefined();
    expect(JSON.stringify(logger.error.mock.calls)).toContain('status=500');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('cf-token');
  });
});
