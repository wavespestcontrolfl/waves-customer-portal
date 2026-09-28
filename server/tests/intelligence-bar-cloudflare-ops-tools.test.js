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

  test('purge_cloudflare_cache: unconfirmed builds a preview naming the real zone, never purges', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true, result: [{ id: 'zone-1', name: 'wavespestcontrol.com', status: 'active', paused: false }] }));

    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'wavespestcontrol.com' });
    expect(result.error).toBeUndefined();
    expect(result.preview).toBe(true);
    expect(result.zone).toEqual({ zone: 'wavespestcontrol.com', status: 'active', paused: false });
    expect(result.note).toContain('wavespestcontrol.com');
  });

  test('purge_cloudflare_cache: confirmed:true refuses — the commit path is not built in this PR', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    const result = await executeCloudflareOpsTool('purge_cloudflare_cache', { zone_name: 'wavespestcontrol.com', confirmed: true });
    expect(result.error).toMatch(/not enabled yet/);
    expect(result.code).toBe('not_yet_implemented');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('retry_cloudflare_pages_build: unconfirmed names the actual project and its current status', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(jsonResponse({
      success: true,
      result: [{
        name: 'spoke-venice',
        latest_deployment: {
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
    expect(result.note).toContain('spoke-venice');
  });

  test('retry_cloudflare_pages_build: unknown project returns an error result, no confirm', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    global.fetch.mockResolvedValueOnce(jsonResponse({ success: true, result: [] }));

    const result = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'nope' });
    expect(result.error).toMatch(/No Cloudflare Pages project/);
  });

  test('retry_cloudflare_pages_build: confirmed:true refuses — the commit path is not built in this PR', async () => {
    process.env.CF_API_TOKEN = 'cf-token';
    process.env.CF_ACCOUNT_ID = 'acct-1';
    const result = await executeCloudflareOpsTool('retry_cloudflare_pages_build', { project_name: 'spoke-venice', confirmed: true });
    expect(result.error).toMatch(/not enabled yet/);
    expect(result.code).toBe('not_yet_implemented');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
